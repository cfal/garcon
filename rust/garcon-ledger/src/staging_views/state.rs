use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    rc::Rc,
    sync::LazyLock,
};

use garcon_base::{
    event_loop::yield_to_event_loop,
    log::{Logger, ScopedLogger, create_logger},
};
use garcon_js::utf16;
use indexmap::IndexMap;
use rusqlite::params;
use serde::Serialize;

use crate::{
    connection_setup::view_record,
    contracts::{LedgerRowDraft, TranscriptViewId},
    errors::LedgerError,
    sqlite_operations::{
        LedgerResult, as_error, bind_ordinal, run_timed_transaction, run_transaction,
    },
    store::TranscriptLedgerStore,
    write_timings::{WritePhase, measure_ledger_write},
};

use super::{encode_draft, insert_encoded_rows, materialize_rows};

const BULK_WRITE_ROWS: usize = 500;
const BULK_WRITE_BYTES: usize = 2 * 1024 * 1024;
const BULK_DELETE_ROWS: usize = 2000;
static LOGGER: LazyLock<ScopedLogger> = LazyLock::new(|| create_logger("ledger:staging"));

#[derive(Default)]
pub(crate) struct StagingViews {
    active: RefCell<IndexMap<String, HashSet<String>>>,
    generations: RefCell<HashMap<String, u64>>,
}

pub(crate) struct StagingRetention<'a> {
    staging: &'a StagingViews,
    chat_id: &'a str,
    view_id: &'a TranscriptViewId,
    generation: u64,
    armed: bool,
}

impl StagingRetention<'_> {
    pub fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for StagingRetention<'_> {
    fn drop(&mut self) {
        if self.armed && self.staging.generation(self.chat_id) == self.generation {
            self.staging.release(self.chat_id, self.view_id);
        }
    }
}

impl StagingViews {
    pub fn fits_one_transaction(&self, drafts: &[LedgerRowDraft]) -> bool {
        drafts.len() <= BULK_WRITE_ROWS
    }

    pub fn retained(&self, chat_id: &str) -> HashSet<String> {
        self.active
            .borrow()
            .get(chat_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn generation(&self, chat_id: &str) -> u64 {
        self.generations.borrow().get(chat_id).copied().unwrap_or(0)
    }

    pub fn abandon(&self, chat_id: &str) {
        *self
            .generations
            .borrow_mut()
            .entry(chat_id.into())
            .or_default() += 1;
        self.active.borrow_mut().shift_remove(chat_id);
    }

    pub fn abandon_all(&self) {
        let active = std::mem::take(&mut *self.active.borrow_mut());
        for (chat_id, _) in active {
            self.abandon(&chat_id);
        }
    }

    pub fn retain(&self, chat_id: &str, view_id: &TranscriptViewId) {
        self.active
            .borrow_mut()
            .entry(chat_id.into())
            .or_default()
            .insert(view_id.to_string());
    }

    pub fn release(&self, chat_id: &str, view_id: &TranscriptViewId) {
        let mut active = self.active.borrow_mut();
        let Some(views) = active.get_mut(chat_id) else {
            return;
        };
        views.remove(view_id.as_str());
        if views.is_empty() {
            active.shift_remove(chat_id);
        }
    }

    pub fn release_on_drop<'a>(
        &'a self,
        chat_id: &'a str,
        view_id: &'a TranscriptViewId,
    ) -> StagingRetention<'a> {
        StagingRetention {
            staging: self,
            chat_id,
            view_id,
            generation: self.generation(chat_id),
            armed: true,
        }
    }

    pub fn begin(
        &self,
        store: &TranscriptLedgerStore,
        chat_id: &str,
        view_id: &TranscriptViewId,
        content_start_ordinal: u64,
        created_at: &str,
    ) -> LedgerResult<()> {
        store.write(chat_id, |entry| {
            entry
                .db
                .prepare_cached(
                    "
        INSERT INTO transcript_views(view_id, status, created_at, content_start_ordinal)
        VALUES (?, 'staging', ?, ?)
      ",
                )
                .map_err(as_error)?
                .execute(params![
                    view_id.as_str(),
                    created_at,
                    bind_ordinal(content_start_ordinal)
                ])
                .map_err(as_error)?;
            Ok(())
        })?;
        self.retain(chat_id, view_id);
        Ok(())
    }

    pub async fn insert_rows(
        &self,
        store: &TranscriptLedgerStore,
        chat_id: &str,
        view_id: &TranscriptViewId,
        drafts: &[LedgerRowDraft],
        generation: u64,
    ) -> LedgerResult<()> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Context<'a> {
            chat_id: &'a str,
            view_id: &'a TranscriptViewId,
            first_ordinal: u64,
            rows: usize,
            payload_code_units: usize,
        }

        let mut client_message_ids = HashSet::new();
        let mut index = 0;
        while index < drafts.len() {
            if index > 0 {
                yield_to_event_loop().await;
            }
            self.assert_generation(chat_id, generation)?;
            let first_ordinal = index as u64 + 1;
            let context = Context {
                chat_id,
                view_id,
                first_ordinal,
                rows: 0,
                payload_code_units: 0,
            };
            let tracker = store.activity_tracker();
            measure_ledger_write(
                "ledger staging batch",
                context,
                tracker.as_ref(),
                |timings, context| {
                    let mut batch = Vec::new();
                    timings.phase(WritePhase::Encode);
                    while index < drafts.len()
                        && batch.len() < BULK_WRITE_ROWS
                        && context.payload_code_units < BULK_WRITE_BYTES
                    {
                        let encoded = encode_draft(&drafts[index], &mut client_message_ids)?;
                        context.payload_code_units += utf16::len(&encoded.encoded.payload_json);
                        context.rows += 1;
                        batch.push(encoded);
                        index += 1;
                    }
                    timings.phase(WritePhase::Validate);
                    materialize_rows(view_id, &batch, first_ordinal)?;
                    timings.phase(WritePhase::Write);
                    store.write(chat_id, |entry| {
                        if view_record(&entry.db, view_id, "staging")?.is_none() {
                            return Err(LedgerError::Schema(
                                "Transcript staging view was discarded".into(),
                            )
                            .into());
                        }
                        run_timed_transaction(
                            &entry.db,
                            || insert_encoded_rows(&entry.db, view_id, &batch, first_ordinal),
                            timings,
                        )
                    })
                },
            )?;
        }
        Ok(())
    }

    pub async fn discard(
        &self,
        store: &TranscriptLedgerStore,
        chat_id: &str,
        view_id: &TranscriptViewId,
        generation: u64,
    ) {
        while self.discard_step(store, chat_id, view_id, generation) {
            yield_to_event_loop().await;
        }
    }

    pub fn start_discard(
        self: &Rc<Self>,
        store: Rc<TranscriptLedgerStore>,
        chat_id: String,
        view_id: TranscriptViewId,
    ) {
        let generation = self.generation(&chat_id);
        if self.discard_step(&store, &chat_id, &view_id, generation) {
            let staging = self.clone();
            tokio::task::spawn_local(async move {
                yield_to_event_loop().await;
                staging
                    .discard(&store, &chat_id, &view_id, generation)
                    .await;
            });
        }
    }

    fn discard_step(
        &self,
        store: &TranscriptLedgerStore,
        chat_id: &str,
        view_id: &TranscriptViewId,
        generation: u64,
    ) -> bool {
        let result = self
            .assert_generation(chat_id, generation)
            .and_then(|()| self.delete_batch(store, chat_id, view_id));
        if let Err(error) = &result
            && !matches!(
                error.downcast_ref::<LedgerError>(),
                Some(LedgerError::BulkOperationAbandoned { .. })
            )
        {
            LOGGER.warn(&format!("Transcript staging view cleanup failed; it is removed on the next open {chat_id} {error}"));
        }
        if matches!(result, Ok(false)) {
            return true;
        }
        if self.generation(chat_id) == generation {
            self.release(chat_id, view_id);
        }
        false
    }

    fn delete_batch(
        &self,
        store: &TranscriptLedgerStore,
        chat_id: &str,
        view_id: &TranscriptViewId,
    ) -> LedgerResult<bool> {
        let tracker = store.activity_tracker();
        let finish = tracker
            .as_ref()
            .map(|tracker| tracker.track_activity("ledger view discard"));
        let result = store.write(chat_id, |entry| {
            if view_record(&entry.db, view_id, "staging")?.is_none() {
                return Ok(true);
            }
            run_transaction(&entry.db, || {
                let deleted = entry
                    .db
                    .prepare_cached(
                        "
            DELETE FROM transcript_rows
            WHERE view_id = ? AND ordinal IN (
              SELECT ordinal FROM transcript_rows WHERE view_id = ? ORDER BY ordinal LIMIT ?
            )
          ",
                    )?
                    .execute(params![
                        view_id.as_str(),
                        view_id.as_str(),
                        BULK_DELETE_ROWS as i64
                    ])?;
                if deleted >= BULK_DELETE_ROWS {
                    return Ok(false);
                }
                entry
                    .db
                    .prepare_cached(
                        "DELETE FROM transcript_views WHERE status = 'staging' AND view_id = ?",
                    )?
                    .execute([view_id.as_str()])?;
                Ok(true)
            })
        });
        if let Some(finish) = finish {
            finish();
        }
        result
    }

    pub fn assert_generation(&self, chat_id: &str, expected: u64) -> LedgerResult<()> {
        if self.generation(chat_id) == expected {
            Ok(())
        } else {
            Err(LedgerError::BulkOperationAbandoned {
                chat_id: chat_id.into(),
            }
            .into())
        }
    }
}
