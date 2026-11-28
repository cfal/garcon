use std::rc::Rc;

use rusqlite::params;
use serde::Serialize;

use crate::{
    connection_setup::{to_view, view_record},
    contracts::{LedgerRowDraft, TranscriptView, TranscriptViewId, TranscriptViewStatus},
    errors::LedgerError,
    sqlite_operations::{LedgerResult, next_ordinal, run_timed_transaction},
    staging_views::promote_staging_view,
    write_timings::measure_ledger_write,
};

use super::{
    InitializeViewInput, TranscriptLedgerStore, assert_current, require_current,
    validate_content_start_ordinal,
};

pub struct StageViewInput<'a> {
    pub view_id: TranscriptViewId,
    pub content_start_ordinal: u64,
    pub rows: &'a [LedgerRowDraft],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewContext<'a> {
    chat_id: &'a str,
    view_id: &'a TranscriptViewId,
}

impl TranscriptLedgerStore {
    pub async fn seed_current_view(
        &self,
        chat_id: &str,
        input: InitializeViewInput<'_>,
    ) -> LedgerResult<TranscriptView> {
        validate_content_start_ordinal(input.content_start_ordinal, input.rows.len())?;
        if self.staging.fits_one_transaction(input.rows) {
            return self.initialize_current_view(chat_id, input);
        }
        let view_id = match input.view_id {
            Some(id) => id,
            None => (self.create_view_id)()?,
        };
        let generation = self.staging.generation(chat_id);
        if let Some(current) = self.current_view(chat_id)? {
            return Ok(current);
        }
        let created_at = (self.now)()?;
        self.staging.begin(
            self,
            chat_id,
            &view_id,
            input.content_start_ordinal,
            &created_at,
        )?;
        let retention = self.staging.release_on_drop(chat_id, &view_id);
        let result = async {
            self.staging
                .insert_rows(self, chat_id, &view_id, input.rows, generation)
                .await?;
            let tracker = self.activity_tracker();
            self.write(chat_id, |entry| {
                if entry.current.is_some() {
                    return Ok(None);
                }
                let context = ViewContext {
                    chat_id,
                    view_id: &view_id,
                };
                measure_ledger_write(
                    "ledger seed promotion",
                    context,
                    tracker.as_ref(),
                    |timings, _| {
                        run_timed_transaction(
                            &entry.db,
                            || promote_staging_view(&entry.db, &view_id),
                            timings,
                        )
                    },
                )?;
                let view = TranscriptView {
                    view_id: view_id.clone(),
                    status: TranscriptViewStatus::Current,
                    created_at,
                    content_start_ordinal: input.content_start_ordinal,
                };
                entry.current = Some(view.clone());
                entry.next_ordinal = input.rows.len() as u64 + 1;
                Ok(Some(view))
            })
        }
        .await;
        if matches!(&result, Ok(Some(_))) {
            self.staging.release(chat_id, &view_id);
        } else {
            self.staging
                .discard(self, chat_id, &view_id, generation)
                .await;
        }
        retention.disarm();
        match result? {
            Some(view) => Ok(view),
            None => self.read(chat_id, |entry| Ok(require_current(entry)?.clone())),
        }
    }

    pub async fn stage_view(
        &self,
        chat_id: &str,
        input: StageViewInput<'_>,
    ) -> LedgerResult<TranscriptView> {
        validate_content_start_ordinal(input.content_start_ordinal, input.rows.len())?;
        let generation = self.staging.generation(chat_id);
        self.read(chat_id, |entry| require_current(entry).map(|_| ()))?;
        let created_at = (self.now)()?;
        self.staging.begin(
            self,
            chat_id,
            &input.view_id,
            input.content_start_ordinal,
            &created_at,
        )?;
        let retention = self.staging.release_on_drop(chat_id, &input.view_id);
        if let Err(error) = self
            .staging
            .insert_rows(self, chat_id, &input.view_id, input.rows, generation)
            .await
        {
            self.staging
                .discard(self, chat_id, &input.view_id, generation)
                .await;
            retention.disarm();
            return Err(error);
        }
        retention.disarm();
        Ok(TranscriptView {
            view_id: input.view_id,
            status: TranscriptViewStatus::Staging,
            created_at,
            content_start_ordinal: input.content_start_ordinal,
        })
    }

    pub async fn discard_staging_view(&self, chat_id: &str, view_id: &TranscriptViewId) {
        let generation = self.staging.generation(chat_id);
        let retention = self.staging.release_on_drop(chat_id, view_id);
        self.staging
            .discard(self, chat_id, view_id, generation)
            .await;
        retention.disarm();
    }

    /// Publishes the staged view in one transaction and retires the old rows on the controller's `LocalSet`.
    pub fn replace_current_view(
        self: &Rc<Self>,
        chat_id: &str,
        expected_current_view_id: &TranscriptViewId,
        staging_view_id: &TranscriptViewId,
    ) -> LedgerResult<TranscriptView> {
        let tracker = self.activity_tracker();
        let current = self.write(chat_id, |entry| {
            assert_current(entry, expected_current_view_id)?;
            let mut staging = view_record(&entry.db, staging_view_id, "staging")?
                .ok_or_else(|| LedgerError::Schema("Transcript staging view is missing".into()))?;
            let staging_next_ordinal = next_ordinal(&entry.db, staging_view_id.as_str())?;
            measure_ledger_write(
                "ledger replacement promotion",
                ViewContext { chat_id, view_id: staging_view_id },
                tracker.as_ref(),
                |timings, _| {
                    run_timed_transaction(&entry.db, || {
                        let demoted = entry.db.prepare_cached(
                            "UPDATE transcript_views SET status = 'staging' WHERE status = 'current' AND view_id = ?"
                        )?.execute(params![expected_current_view_id.as_str()])?;
                        if demoted != 1 {
                            return Err(LedgerError::Schema("Transcript current view demotion failed".into()).into());
                        }
                        promote_staging_view(&entry.db, staging_view_id)
                    }, timings)
                },
            )?;
            staging.status = "current".into();
            let promoted = to_view(&staging)?;
            entry.current = Some(promoted.clone());
            entry.next_ordinal = staging_next_ordinal;
            Ok(promoted)
        })?;
        self.staging.release(chat_id, staging_view_id);
        self.staging.retain(chat_id, expected_current_view_id);
        self.staging.start_discard(
            self.clone(),
            chat_id.into(),
            expected_current_view_id.clone(),
        );
        Ok(current)
    }
}

#[cfg(test)]
mod tests;
