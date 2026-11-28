use std::future::{Future, ready};

use futures::{Stream, TryStreamExt, stream::try_unfold};
use garcon_base::{errors::error_metadata, event_loop::yield_to_event_loop};
use garcon_js::is_safe_integer;
use rusqlite::{Connection, params, params_from_iter};

use crate::{
    codec::{StoredLedgerRow, decode_stored_ledger_row},
    contracts::{LedgerRow, TranscriptViewId},
    errors::{UNDECODABLE_LEDGER_ROW, UndecodableLedgerRowError},
    sqlite_operations::{LedgerResult, as_error, bind_ordinal, read_stored_row},
    staging_views::{BoundedPage, read_bounded_page, read_bounded_stored_page},
};

use super::{
    TranscriptLedgerStore,
    anchors::{TranscriptReadSignal, TranscriptWatermark},
    assert_current, require_current, type_error,
};

const STORED_COLUMNS: &str = "view_id, ordinal, kind, at, client_message_id, payload_json";

pub(super) fn validate_page_limit(limit: u64) -> LedgerResult<()> {
    if !(1..=1000).contains(&limit) {
        return Err(type_error(
            "Transcript page limit must be between 1 and 1000",
        ));
    }
    Ok(())
}

impl TranscriptLedgerStore {
    pub fn rows_after(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        after: u64,
        kind: Option<&str>,
    ) -> LedgerResult<Vec<LedgerRow>> {
        validate_replay_cursor(after)?;
        self.read(chat_id, |entry| {
            assert_current(entry, view_id)?;
            if after >= entry.next_ordinal {
                return Err(type_error(
                    "Transcript replay cursor is ahead of the current view",
                ));
            }
            use rusqlite::types::Value;
            let mut bind = vec![Value::Text(view_id.to_string()), bind_ordinal(after)];
            let filter = if let Some(kind) = kind {
                bind.push(Value::Text(kind.to_owned()));
                " AND kind = ?"
            } else {
                ""
            };
            let sql = format!(
                "SELECT {STORED_COLUMNS} FROM transcript_rows
                WHERE view_id = ? AND ordinal > ?{filter} ORDER BY ordinal"
            );
            read_rows(&entry.db, &sql, params_from_iter(bind))
        })
    }

    pub fn replay_rows(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        after: u64,
        through: u64,
        limit: u64,
    ) -> LedgerResult<Vec<LedgerRow>> {
        validate_replay_cursor(after)?;
        if !is_safe_integer(through as f64) || through < after {
            return Err(type_error(
                "Transcript replay watermark must not precede its cursor",
            ));
        }
        validate_page_limit(limit)?;
        self.read(chat_id, |entry| {
            assert_current(entry, view_id)?;
            if through >= entry.next_ordinal {
                return Err(type_error(
                    "Transcript replay watermark is ahead of the current view",
                ));
            }
            let sql = format!(
                "SELECT {STORED_COLUMNS} FROM transcript_rows
                WHERE view_id = ? AND ordinal > ? AND ordinal <= ? ORDER BY ordinal LIMIT ?"
            );
            read_rows(
                &entry.db,
                &sql,
                params![
                    view_id.as_str(),
                    bind_ordinal(after),
                    bind_ordinal(through),
                    bind_ordinal(limit)
                ],
            )
        })
    }

    pub fn current_rows(&self, chat_id: &str) -> LedgerResult<Vec<LedgerRow>> {
        self.read(chat_id, |entry| {
            let view = require_current(entry)?;
            let sql = format!(
                "SELECT {STORED_COLUMNS} FROM transcript_rows WHERE view_id = ? ORDER BY ordinal"
            );
            read_rows(&entry.db, &sql, [view.view_id.as_str()])
        })
    }

    pub fn row_pages_through<'a>(
        &'a self,
        chat_id: &'a str,
        watermark: &'a TranscriptWatermark,
        from: u64,
        signal: Option<TranscriptReadSignal<'a>>,
    ) -> impl Stream<Item = LedgerResult<Vec<LedgerRow>>> + 'a {
        self.stream_pages(chat_id, watermark, from, signal, read_bounded_page, |row| {
            row.ordinal
        })
    }

    pub async fn rows_through(
        &self,
        chat_id: &str,
        watermark: &TranscriptWatermark,
    ) -> LedgerResult<Vec<LedgerRow>> {
        self.row_pages_through(chat_id, watermark, 1, None)
            .try_fold(Vec::new(), |mut rows, page| {
                rows.extend(page);
                ready(Ok(rows))
            })
            .await
    }

    pub async fn with_stored_rows_through<T, Work>(
        &self,
        chat_id: &str,
        watermark: &TranscriptWatermark,
        work: impl FnOnce(Vec<StoredLedgerRow>) -> Work,
        signal: Option<TranscriptReadSignal<'_>>,
    ) -> LedgerResult<T>
    where
        Work: Future<Output = LedgerResult<T>>,
    {
        let rows = self
            .stream_pages(
                chat_id,
                watermark,
                1,
                signal,
                read_bounded_stored_page,
                |row| row.ordinal.0 as u64,
            )
            .try_fold(Vec::new(), |mut rows, page| {
                rows.extend(page);
                ready(Ok(rows))
            })
            .await?;
        if let Some(signal) = signal {
            signal.check()?;
        }
        match work(rows).await {
            Err(error)
                if error.is::<UndecodableLedgerRowError>()
                    || error_metadata(error.as_ref()).code == Some(UNDECODABLE_LEDGER_ROW) =>
            {
                self.read(chat_id, |entry| {
                    assert_current(entry, &watermark.view_id)?;
                    Err(error)
                })
            }
            result => result,
        }
    }

    fn stream_pages<'a, Row: 'a>(
        &'a self,
        chat_id: &'a str,
        watermark: &'a TranscriptWatermark,
        from: u64,
        signal: Option<TranscriptReadSignal<'a>>,
        read_page: fn(&Connection, &TranscriptViewId, u64, u64) -> LedgerResult<BoundedPage<Row>>,
        ordinal: fn(&Row) -> u64,
    ) -> impl Stream<Item = LedgerResult<Vec<Row>>> + 'a {
        try_unfold(None::<(u64, bool)>, move |prior| async move {
            let check_signal = || signal.map_or(Ok(()), TranscriptReadSignal::check);
            let after = if let Some((previous, exhausted)) = prior {
                check_signal()?;
                if exhausted {
                    self.read(chat_id, |entry| {
                        assert_current(entry, &watermark.view_id).map(|_| ())
                    })?;
                    return Ok(None);
                }
                yield_to_event_loop().await;
                previous
            } else {
                if !is_safe_integer(watermark.ordinal as f64) {
                    return Err(type_error("Transcript watermark ordinal is invalid"));
                }
                if from == 0 || !is_safe_integer(from as f64) {
                    return Err(type_error("Transcript starting ordinal is invalid"));
                }
                from - 1
            };
            check_signal()?;
            let page = self.read(chat_id, |entry| {
                assert_current(entry, &watermark.view_id)?;
                read_page(&entry.db, &watermark.view_id, after, watermark.ordinal)
            })?;
            // A page can be non-exhausted only after gathering at least one row.
            let next = page.rows.last().map_or(after, ordinal);
            Ok(Some((page.rows, Some((next, page.exhausted)))))
        })
    }
}

fn validate_replay_cursor(after: u64) -> LedgerResult<()> {
    if !is_safe_integer(after as f64) {
        return Err(type_error(
            "Transcript replay cursor must be a non-negative integer",
        ));
    }
    Ok(())
}

fn read_rows(
    db: &Connection,
    sql: &str,
    args: impl rusqlite::Params,
) -> LedgerResult<Vec<LedgerRow>> {
    let mut statement = db.prepare_cached(sql).map_err(as_error)?;
    let stored = statement
        .query_map(args, read_stored_row)
        .map_err(as_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(as_error)?;
    stored
        .iter()
        .map(decode_stored_ledger_row)
        .collect::<Result<_, _>>()
        .map_err(as_error)
}
