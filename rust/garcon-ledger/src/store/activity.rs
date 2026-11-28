use std::{borrow::Cow, cell::RefCell, error::Error, sync::Arc, time::Duration};

use garcon_base::{
    domain_error::DomainError,
    errors::{DiagnosticError, NamedError},
};
use garcon_contract::{chat_activity::ChatRunOutcome, error_codes::ErrorCode};
use garcon_js::json::from_str;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::value::RawValue;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::{
    contracts::TranscriptViewId,
    errors::{LedgerError, UNDECODABLE_LEDGER_ROW},
    sqlite_operations::{LedgerResult, SqliteError, bind_ordinal},
};

use super::{TranscriptLedgerStore, assert_current};

const MAX_ACTIVITY_READS: usize = 9; // One running, eight queued.

pub(super) struct ActivityReads {
    active: RefCell<Vec<(String, CancellationToken)>>,
    worker: Arc<Semaphore>,
}

impl Default for ActivityReads {
    fn default() -> Self {
        Self {
            active: RefCell::default(),
            worker: Arc::new(Semaphore::new(1)),
        }
    }
}

impl ActivityReads {
    fn admit(&self, chat_id: &str) -> LedgerResult<ActivityRead<'_>> {
        let mut active = self.active.borrow_mut();
        if active.len() >= MAX_ACTIVITY_READS {
            return Err(DomainError::new(
                ErrorCode::TRANSCRIPT_WORK_BUSY,
                "Ledger activity capacity is full. Try again later.",
                503,
                true,
            )
            .into());
        }
        let token = CancellationToken::new();
        active.push((chat_id.into(), token.clone()));
        Ok(ActivityRead { reads: self, token })
    }

    pub(super) fn retire(&self, chat_id: &str) {
        self.active.borrow_mut().retain(|(id, token)| {
            if id == chat_id {
                token.cancel();
                false
            } else {
                true
            }
        });
    }

    pub(super) fn close(&self) {
        for (_, token) in self.active.take() {
            token.cancel();
        }
    }
}

struct ActivityRead<'a> {
    reads: &'a ActivityReads,
    token: CancellationToken,
}

impl Drop for ActivityRead<'_> {
    fn drop(&mut self) {
        self.token.cancel();
        self.reads
            .active
            .borrow_mut()
            .retain(|(_, token)| !token.is_cancelled());
    }
}

impl TranscriptLedgerStore {
    pub async fn last_run_outcome(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
    ) -> LedgerResult<Option<ChatRunOutcome>> {
        let epoch = self.anchor_read_epoch.get();
        let generation = self.staging.generation(chat_id);
        let verify_exists = || -> LedgerResult<()> {
            self.existing_current_view(chat_id)?
                .map(|_| ())
                .ok_or_else(|| {
                    LedgerError::ViewNotInitialized {
                        chat_id: chat_id.into(),
                    }
                    .into()
                })
        };
        verify_exists()?;
        let (before_ordinal, path) = self.read(chat_id, |entry| {
            assert_current(entry, view_id)?;
            Ok((
                entry.next_ordinal,
                std::path::Path::new(&entry.directory).join("ledger.sqlite"),
            ))
        })?;
        let admission = self.activity_reads.admit(chat_id)?;
        let retired = || -> Box<dyn Error> {
            if epoch != self.anchor_read_epoch.get() {
                "Ledger activity is closed".into()
            } else {
                "Ledger activity read was retired".into()
            }
        };
        let permit = tokio::select! {
            biased;
            () = admission.token.cancelled() => return Err(retired()),
            permit = self.activity_reads.worker.clone().acquire_owned() => permit?,
        };
        let view_name = view_id.as_str().to_owned();
        let token = admission.token.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            read_ledger_run_outcome(&path, &view_name, before_ordinal, &token)
        });
        let result = tokio::select! {
            biased;
            () = admission.token.cancelled() => return Err(retired()),
            result = worker => result?,
        };
        let recheck = || {
            if epoch != self.anchor_read_epoch.get() {
                return Err(LedgerError::BulkOperationAbandoned {
                    chat_id: chat_id.into(),
                }
                .into());
            }
            self.staging.assert_generation(chat_id, generation)?;
            verify_exists()?;
            self.read(chat_id, |entry| assert_current(entry, view_id).map(|_| ()))
        };
        match result {
            Ok(outcome) => {
                recheck()?;
                Ok(outcome)
            }
            Err(error) => {
                let error = error.into_worker_error();
                if error.code.as_deref().is_some_and(|code| {
                    matches!(
                        code,
                        UNDECODABLE_LEDGER_ROW | "SQLITE_NOTADB" | "SQLITE_CORRUPT"
                    ) || code.starts_with("SQLITE_CORRUPT_")
                }) {
                    recheck()?;
                    return self.read(chat_id, |_| Err(error.into()));
                }
                Err(error.into())
            }
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum ReadOutcomeError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error("Stored transcript row is invalid")]
    Undecodable,
    #[error("Transcript activity view was replaced")]
    Replaced,
}

impl ReadOutcomeError {
    fn into_worker_error(self) -> NamedError {
        // TaskWorker transfers only the message and code, not the error class.
        let (message, code) = match self {
            Self::Sqlite(error) => {
                let error = SqliteError::new(error);
                (
                    error.to_string(),
                    error.diagnostic_metadata().code.map(str::to_owned),
                )
            }
            Self::Undecodable => (self.to_string(), Some(UNDECODABLE_LEDGER_ROW.to_owned())),
            Self::Replaced => (self.to_string(), None),
        };
        NamedError {
            name: "Error".into(),
            message,
            code,
        }
    }
}

fn read_ledger_run_outcome(
    path: &std::path::Path,
    view_id: &str,
    before_ordinal: u64,
    token: &CancellationToken,
) -> Result<Option<ChatRunOutcome>, ReadOutcomeError> {
    let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_millis(5000))?;
    let cancel = token.clone();
    db.progress_handler(1000, Some(move || cancel.is_cancelled()))?;
    let tx = db.unchecked_transaction()?;
    let current: Option<String> = tx
        .query_row(
            "SELECT view_id FROM transcript_views WHERE status = 'current'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if current.as_deref() != Some(view_id) {
        return Err(ReadOutcomeError::Replaced);
    }
    let mut query = tx.prepare(
        "
        SELECT kind,
          CASE WHEN kind IN ('run-ended', 'provider-row') AND NOT json_valid(payload_json)
            THEN payload_json END,
          CASE WHEN kind = 'run-ended' AND json_valid(payload_json)
            THEN json_extract(payload_json, '$.value.outcome') END,
          CASE WHEN kind = 'provider-row' AND json_valid(payload_json)
            THEN json_extract(payload_json, '$.value.type') END
        FROM transcript_rows WHERE view_id = ? AND ordinal < ?
        ORDER BY ordinal DESC
    ",
    )?;
    let mut rows = query.query(params![view_id, bind_ordinal(before_ordinal)])?;
    while let Some(row) = rows.next()? {
        use rusqlite::types::ValueRef;
        let kind = row.get_ref(0)?.as_str().unwrap_or_default();
        if kind == "user-input" {
            return Ok(None);
        }
        let carrier = match kind {
            "provider-row" => ("type", 3),
            "run-ended" => ("outcome", 2),
            _ => continue,
        };
        let field = match row.get_ref(1)? {
            ValueRef::Text(raw) => {
                let raw = std::str::from_utf8(raw).map_err(|_| ReadOutcomeError::Undecodable)?;
                read_deep_activity_field(raw, carrier.0)?.map(Cow::Owned)
            }
            _ => match row.get_ref(carrier.1)? {
                ValueRef::Text(text) => std::str::from_utf8(text).ok().map(Cow::Borrowed),
                _ => None,
            },
        };
        if kind == "provider-row" {
            if field.as_deref() == Some("user-message") {
                return Ok(None);
            }
            continue;
        }
        return match field.as_deref() {
            Some("finished") => Ok(Some(ChatRunOutcome::Finished)),
            Some("failed") => Ok(Some(ChatRunOutcome::Failed)),
            Some("interrupted") => Ok(Some(ChatRunOutcome::Interrupted)),
            _ => Err(ReadOutcomeError::Undecodable),
        };
    }
    Ok(None)
}

fn read_deep_activity_field(raw: &str, field: &str) -> Result<Option<String>, ReadOutcomeError> {
    // RawValue validates nested JSON iteratively without building a recursive Value.
    type Object = std::collections::HashMap<String, Box<RawValue>>;
    let root: Box<RawValue> = from_str(raw).map_err(|_| ReadOutcomeError::Undecodable)?;
    if !root.get().starts_with('{') {
        return Ok(None);
    }
    let mut root: Object = from_str(root.get()).map_err(|_| ReadOutcomeError::Undecodable)?;
    let Some(value) = root
        .remove("value")
        .filter(|value| value.get().starts_with('{'))
    else {
        return Ok(None);
    };
    let mut value: Object = from_str(value.get()).map_err(|_| ReadOutcomeError::Undecodable)?;
    value
        .remove(field)
        .filter(|value| value.get().starts_with('"'))
        .map(|value| from_str(value.get()).map_err(|_| ReadOutcomeError::Undecodable))
        .transpose()
}

#[cfg(test)]
mod tests {
    use std::{
        future::{Future, poll_fn},
        task::Poll,
    };

    use super::*;
    use crate::{
        contracts::{LedgerRowData, LedgerRowDraft, RunOrigin, RunOutcome},
        store::{InitializeViewInput, TranscriptLedgerStoreOptions},
    };

    #[tokio::test]
    async fn activity_captures_the_ordinal_before_queueing_and_close_retires_pending_reads() {
        let root = tempfile::tempdir().unwrap();
        let store = TranscriptLedgerStore::new(
            root.path().to_str().unwrap(),
            TranscriptLedgerStoreOptions::default(),
        )
        .unwrap();
        let terminal = |outcome| LedgerRowDraft {
            at: "2026-11-28T09:00:00.000Z".into(),
            provider_meta: None,
            data: LedgerRowData::RunEnded {
                outcome,
                origin: RunOrigin::Provider,
                error: None,
            },
        };
        let view = store
            .initialize_current_view(
                "chat",
                InitializeViewInput {
                    view_id: None,
                    content_start_ordinal: 1,
                    rows: &[terminal(RunOutcome::Finished)],
                },
            )
            .unwrap()
            .view_id;
        let worker = store.activity_reads.worker.acquire().await.unwrap();
        let mut outcome = std::pin::pin!(store.last_run_outcome("chat", &view));
        poll_fn(|cx| {
            assert!(outcome.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        store
            .append("chat", &view, &[terminal(RunOutcome::Failed)])
            .unwrap();
        drop(worker);
        assert_eq!(outcome.await.unwrap(), Some(ChatRunOutcome::Finished));
        assert_eq!(
            store.last_run_outcome("chat", &view).await.unwrap(),
            Some(ChatRunOutcome::Failed)
        );

        let worker = store.activity_reads.worker.acquire().await.unwrap();
        let mut retired = std::pin::pin!(store.last_run_outcome("chat", &view));
        poll_fn(|cx| {
            assert!(retired.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        store.close_chat("chat").unwrap();
        assert_eq!(
            retired.await.unwrap_err().to_string(),
            "Ledger activity read was retired"
        );
        drop(worker);
        assert_eq!(
            store.last_run_outcome("chat", &view).await.unwrap(),
            Some(ChatRunOutcome::Failed)
        );
    }
}
