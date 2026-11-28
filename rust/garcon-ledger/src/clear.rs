use std::{cell::Cell, pin::pin, rc::Rc};

use futures::{TryStreamExt, future::LocalBoxFuture};
use garcon_base::{
    domain_error::DomainError, event_loop::EventLoopSteps, keyed_lock::KeyedLock,
    unhandled_rejection_policy::UnhandledRejectionPolicy,
};
use garcon_contract::{
    chat_clear::{ClearChatRequest, ClearChatResponse, ClearChatTarget},
    error_codes::ErrorCode,
    preambles::PendingPreambleBoundary,
};
use tokio_util::sync::CancellationToken;

use crate::{
    contracts::{LedgerRow, LedgerRowDraft, TranscriptView},
    preamble_history::{
        PreambleHistoryCollector, PreambleHistoryEvidence, retained_preamble_history_metadata,
    },
    service::TranscriptLedgerService,
    sqlite_operations::LedgerResult,
    store::{StageViewInput, TranscriptReadSignal},
    view_mutation::{ReopenProducer, TranscriptMutationExecution, settle_owned_mutation},
    view_reader::TranscriptViewAdoption,
};

mod before_message;

pub struct ClearChatEntry {
    pub agent_id: String,
    pub executor_id: Option<String>,
    pub pending_preamble_boundary: Option<PendingPreambleBoundary>,
}

pub trait TranscriptClearRegistry {
    fn get_chat(&self, chat_id: &str) -> Option<ClearChatEntry>;
    fn clear_pending_preamble_boundary(&self, chat_id: &str) -> LedgerResult<()>;
    fn flush(&self) -> LocalBoxFuture<'_, LedgerResult<()>>;
}

pub type PromoteClearedView<'a> = Box<dyn FnOnce(bool) -> LedgerResult<ClearChatResponse> + 'a>;

pub trait TranscriptClearExecution: TranscriptMutationExecution {
    /// Reads the current pending-input predicate and invokes promote while holding the queue lock.
    fn with_chat_execution_control<'a>(
        &'a self,
        chat_id: &'a str,
        promote: PromoteClearedView<'a>,
    ) -> LocalBoxFuture<'a, LedgerResult<ClearChatResponse>>;
}

pub type OwnershipTransferPending = dyn Fn(&str) -> bool;
pub type SupportsLiteralExecution = dyn Fn(&str, Option<&str>) -> bool;

pub struct TranscriptClearOptions {
    pub ledger: Rc<TranscriptLedgerService>,
    pub adoption: Rc<dyn TranscriptViewAdoption>,
    pub registry: Rc<dyn TranscriptClearRegistry>,
    pub ownership_transfer_pending: Rc<OwnershipTransferPending>,
    pub supports_literal_execution: Rc<SupportsLiteralExecution>,
    pub execution: Rc<dyn TranscriptClearExecution>,
    pub reopen_producer: Rc<ReopenProducer>,
    pub chat_mutation_lock: Rc<KeyedLock>,
    pub unhandled_rejections: Rc<UnhandledRejectionPolicy>,
}

pub struct TranscriptClearService(TranscriptClearOptions);

impl TranscriptClearService {
    pub fn new(options: TranscriptClearOptions) -> Self {
        Self(options)
    }

    pub async fn clear(
        self: &Rc<Self>,
        request: ClearChatRequest,
        signal: CancellationToken,
    ) -> LedgerResult<ClearChatResponse> {
        self.require_chat(request.chat_id.as_str())?;
        let service = Rc::clone(self);
        settle_owned_mutation(
            Box::pin(async move {
                let key = format!("chat:{}", request.chat_id);
                service
                    .0
                    .chat_mutation_lock
                    .run_exclusive(
                        &key,
                        || service.clear_locked(&request, TranscriptReadSignal::new(&signal)),
                        None,
                    )
                    .await?
            }),
            Rc::clone(&self.0.unhandled_rejections),
        )
        .await
    }

    async fn clear_locked(
        &self,
        request: &ClearChatRequest,
        signal: TranscriptReadSignal<'_>,
    ) -> LedgerResult<ClearChatResponse> {
        let chat_id = request.chat_id.as_str();
        let entry = self.require_chat(chat_id)?;
        if (self.0.ownership_transfer_pending)(chat_id) {
            return Err(DomainError::new_ownership_transfer_pending().into());
        }
        if !(self.0.supports_literal_execution)(&entry.agent_id, entry.executor_id.as_deref()) {
            return Err(DomainError::new(
                ErrorCode::OPERATION_UNSUPPORTED,
                "Clearing displayed history is not available for this agent.",
                422,
                false,
            )
            .into());
        }
        let release = self
            .0
            .execution
            .reserve_transcript_snapshot(chat_id)
            .map_err(|cause| {
                DomainError::new(
                    ErrorCode::CHAT_RUNNING,
                    "Wait for the current chat operation to finish before clearing history.",
                    409,
                    true,
                )
                .with_cause(cause)
            })?;
        let promoted = Cell::new(false);
        let result = self
            .clear_reserved(request, &entry, signal, &promoted)
            .await;
        let result = release().await.and(result);
        result.map_err(|cause| {
            if promoted.get() {
                DomainError::new(
                    ErrorCode::TRANSCRIPT_CLEAR_OUTCOME_UNKNOWN,
                    "Clear may have completed. Refresh the chat before taking another action.",
                    503,
                    false,
                )
                .with_cause(cause)
                .into()
            } else {
                cause
            }
        })
    }

    async fn clear_reserved(
        &self,
        request: &ClearChatRequest,
        entry: &ClearChatEntry,
        signal: TranscriptReadSignal<'_>,
        promoted: &Cell<bool>,
    ) -> LedgerResult<ClearChatResponse> {
        let chat_id = request.chat_id.as_str();
        let ledger = &self.0.ledger;
        let store = ledger.store();
        self.0.adoption.ensure(chat_id, Some(signal)).await?;
        assert_empty_queue(self.0.execution.has_pending_turn_input(chat_id).await?)?;
        let current = store.current_view(chat_id)?.ok_or_else(session_not_found)?;
        self.assert_unchanged(request)?;
        signal.check()?;
        ledger.close_producer(chat_id)?;

        let result = async {
            let staging = match request.target {
                ClearChatTarget::All => {
                    self.stage_cleared_view(chat_id, &current, entry, signal)
                        .await?
                }
                ClearChatTarget::BeforeMessage { ordinal } => {
                    self.stage_before_message(chat_id, &current, entry, ordinal, signal)
                        .await?
                }
            };
            let result = self
                .0
                .execution
                .with_chat_execution_control(
                    chat_id,
                    Box::new(|pending| {
                        signal.check()?;
                        assert_empty_queue(pending)?;
                        self.assert_unchanged(request)?;
                        let replacement = ledger.replace_current_view(
                            chat_id,
                            &current.view_id,
                            &staging.view_id,
                        )?;
                        promoted.set(true);
                        Ok(ClearChatResponse {
                            success: true,
                            chat_id: request.chat_id.clone(),
                            transcript_view_id: replacement.view_id.to_string(),
                        })
                    }),
                )
                .await;
            if !promoted.get() {
                store.discard_staging_view(chat_id, &staging.view_id).await;
            }
            result
        }
        .await;
        (self.0.reopen_producer)(chat_id).and(result)
    }

    async fn stage_cleared_view(
        &self,
        chat_id: &str,
        current: &TranscriptView,
        entry: &ClearChatEntry,
        signal: TranscriptReadSignal<'_>,
    ) -> LedgerResult<TranscriptView> {
        let store = self.0.ledger.store();
        let session = store.current_session(chat_id)?;
        let mut collector = PreambleHistoryCollector::default();
        if session.is_some() {
            let watermark = store.high_watermark(chat_id)?;
            let mut pages = pin!(store.row_pages_through(
                chat_id,
                &watermark,
                current.content_start_ordinal,
                Some(signal)
            ));
            let mut steps = EventLoopSteps::new("ledger-clear");
            while let Some(page) = pages.try_next().await? {
                steps
                    .try_for_each(page, |row| collector.add_row(&row))
                    .await?;
            }
        }
        self.flush_boundary(chat_id, entry).await?;
        let mut drafts = Vec::new();
        if let Some(session) = session {
            drafts.push(session_draft(session, &collector.finish()?));
        }
        store
            .stage_view(
                chat_id,
                StageViewInput {
                    view_id: store.new_view_id()?,
                    content_start_ordinal: 1,
                    rows: &drafts,
                },
            )
            .await
    }

    async fn flush_boundary(&self, chat_id: &str, entry: &ClearChatEntry) -> LedgerResult<()> {
        if let Some(pending) = entry.pending_preamble_boundary.as_ref()
            && self
                .0
                .ledger
                .has_preamble_boundary_proof(chat_id, pending)?
        {
            self.0.registry.clear_pending_preamble_boundary(chat_id)?;
        }
        // Flush before deleting the sole durable proof that a boundary was consumed.
        self.0.registry.flush().await
    }

    fn require_chat(&self, chat_id: &str) -> LedgerResult<ClearChatEntry> {
        self.0
            .registry
            .get_chat(chat_id)
            .ok_or_else(|| session_not_found().into())
    }

    fn assert_unchanged(&self, request: &ClearChatRequest) -> LedgerResult<()> {
        let watermark = self
            .0
            .ledger
            .store()
            .high_watermark(request.chat_id.as_str())?;
        if watermark.view_id.as_str() != request.transcript_view_id
            || watermark.ordinal != request.last_ordinal
        {
            return Err(DomainError::new(
                ErrorCode::STALE_TRANSCRIPT_VIEW,
                "Chat history changed. Review it and confirm Clear again.",
                409,
                false,
            )
            .into());
        }
        Ok(())
    }
}

fn session_not_found() -> DomainError {
    DomainError::new(
        ErrorCode::SESSION_NOT_FOUND,
        "Session not found",
        404,
        false,
    )
}

fn assert_empty_queue(pending: bool) -> LedgerResult<()> {
    if pending {
        return Err(DomainError::new(
            ErrorCode::CHAT_RUNNING,
            "Run or remove queued messages before clearing history.",
            409,
            false,
        )
        .into());
    }
    Ok(())
}

fn session_draft(session: LedgerRow, evidence: &[PreambleHistoryEvidence]) -> LedgerRowDraft {
    LedgerRowDraft {
        at: session.at,
        data: session.data,
        provider_meta: retained_preamble_history_metadata(evidence),
    }
}
