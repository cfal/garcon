use std::error::Error;

use garcon_base::{event_loop::EventLoopSteps, keyed_lock::LockAborted};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::{
    anchor_page::{
        AnchorScanInput, AnchorScanResult, read_anchor_batch, read_anchor_page_in_steps,
    },
    contracts::TranscriptViewId,
    errors::LedgerError,
    sqlite_operations::LedgerResult,
    ticket_outcome_query::find_ticket_outcome_ordinal,
};

use super::{TranscriptLedgerStore, assert_current, require_current};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWatermark {
    pub view_id: TranscriptViewId,
    pub ordinal: u64,
}

#[derive(Clone, Copy)]
pub struct TranscriptReadSignal<'a> {
    token: &'a CancellationToken,
    reason: Option<&'a dyn Fn() -> Box<dyn Error>>,
}

impl<'a> TranscriptReadSignal<'a> {
    pub fn new(token: &'a CancellationToken) -> Self {
        Self {
            token,
            reason: None,
        }
    }

    pub fn with_reason(
        token: &'a CancellationToken,
        reason: &'a dyn Fn() -> Box<dyn Error>,
    ) -> Self {
        Self {
            token,
            reason: Some(reason),
        }
    }

    pub fn check(self) -> LedgerResult<()> {
        if self.token.is_cancelled() {
            return Err(self.abort_error());
        }
        Ok(())
    }

    pub fn token(self) -> &'a CancellationToken {
        self.token
    }

    pub(crate) fn abort_error(self) -> Box<dyn Error> {
        self.reason
            .map_or_else(|| LockAborted.into(), |reason| reason())
    }
}

impl TranscriptLedgerStore {
    pub async fn anchor_page(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        input: AnchorScanInput,
        signal: Option<TranscriptReadSignal<'_>>,
    ) -> LedgerResult<AnchorScanResult> {
        self.anchor_page_in_steps(
            chat_id,
            view_id,
            input,
            signal,
            EventLoopSteps::new("ledger anchor page"),
        )
        .await
    }

    async fn anchor_page_in_steps(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        input: AnchorScanInput,
        signal: Option<TranscriptReadSignal<'_>>,
        steps: EventLoopSteps,
    ) -> LedgerResult<AnchorScanResult> {
        let epoch = self.anchor_read_epoch.get();
        let generation = self.staging.generation(chat_id);
        let precheck = || -> LedgerResult<()> {
            if let Some(signal) = signal {
                signal.check()?;
            }
            if self.anchor_read_epoch.get() != epoch {
                return Err(LedgerError::BulkOperationAbandoned {
                    chat_id: chat_id.into(),
                }
                .into());
            }
            self.staging.assert_generation(chat_id, generation)?;
            // The ordinary read would create a database if this chat were deleted.
            self.existing_current_view(chat_id)?.ok_or_else(|| {
                LedgerError::ViewNotInitialized {
                    chat_id: chat_id.into(),
                }
            })?;
            Ok(())
        };
        read_anchor_page_in_steps(
            &input,
            |progress, due| {
                precheck()?;
                self.read(chat_id, |entry| {
                    assert_current(entry, view_id)?;
                    read_anchor_batch(&entry.db, view_id, &input, progress, due)
                })
            },
            || {
                precheck()?;
                self.read(chat_id, |entry| assert_current(entry, view_id).map(|_| ()))
            },
            steps,
        )
        .await
    }

    pub fn high_watermark(&self, chat_id: &str) -> LedgerResult<TranscriptWatermark> {
        self.read(chat_id, |entry| {
            let current = require_current(entry)?;
            Ok(TranscriptWatermark {
                view_id: current.view_id.clone(),
                ordinal: entry.next_ordinal - 1,
            })
        })
    }

    pub fn ticket_outcome_ordinal(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        request_ordinal: u64,
    ) -> LedgerResult<Option<u64>> {
        self.read(chat_id, |entry| {
            assert_current(entry, view_id)?;
            find_ticket_outcome_ordinal(&entry.db, view_id.as_str(), request_ordinal)
        })
    }
}

#[cfg(test)]
mod tests;
