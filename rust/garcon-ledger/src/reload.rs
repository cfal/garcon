use std::rc::Rc;

use futures::future::LocalBoxFuture;
use garcon_base::{
    domain_error::DomainError, event_loop::EventLoopSteps, keyed_lock::KeyedLock,
    unhandled_rejection_policy::UnhandledRejectionPolicy,
};
use garcon_contract::{
    error_codes::ErrorCode,
    preambles::PendingPreambleBoundary,
    ws_events::{ChatReloadPhase, ChatReloadProgress},
};
use garcon_interface::{
    native_history::AgentHistoryImport, producer::AgentEstablishedSession, services::AgentSettings,
    transcript::AgentChatReference,
};
use garcon_js::clock::{Clock, SystemClock, to_iso_string};
use tokio_util::sync::CancellationToken;

use crate::{
    adoption::{CarryoverQuarantine, RegisteredTranscriptChat},
    contracts::{LedgerRowData, LedgerRowDraft, TranscriptView},
    native_history_seed::{NativeHistorySeedInput, import_native_history_drafts},
    preamble_history::PreambleHistoryCollector,
    projection::frozen_conversation_drafts,
    service::TranscriptLedgerService,
    sqlite_operations::LedgerResult,
    store::{StageViewInput, TranscriptReadSignal},
    view_mutation::{ReopenProducer, TranscriptMutationExecution, settle_owned_mutation},
    view_reader::TranscriptViewAdoption,
};

pub struct ReloadChatEntry<C> {
    pub transcript: RegisteredTranscriptChat<C>,
    pub pending_preamble_boundary: Option<PendingPreambleBoundary>,
}

pub trait TranscriptReloadRegistry<C> {
    fn get_chat(&self, chat_id: &str) -> Option<ReloadChatEntry<C>>;
    fn clear_pending_preamble_boundary(
        &self,
        chat_id: &str,
    ) -> LedgerResult<Option<ReloadChatEntry<C>>>;
    fn flush(&self) -> LocalBoxFuture<'_, LedgerResult<()>>;
}

pub struct NativeHistoryIntegration {
    pub agent_id: String,
    pub settings: Rc<dyn AgentSettings>,
    pub native_history_import: Option<Rc<dyn AgentHistoryImport>>,
}

pub trait TranscriptReloadIntegrations {
    fn require(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> LedgerResult<NativeHistoryIntegration>;
}

pub type CarryoverRevision<C> = dyn Fn(&C, Option<&CarryoverQuarantine>) -> String;
pub type ReloadProgress = dyn Fn(ChatReloadProgress) -> LedgerResult<()>;

pub struct TranscriptReloadServiceOptions<C> {
    pub ledger: Rc<TranscriptLedgerService>,
    pub adoption: Rc<dyn TranscriptViewAdoption>,
    pub registry: Rc<dyn TranscriptReloadRegistry<C>>,
    pub integrations: Rc<dyn TranscriptReloadIntegrations>,
    pub execution: Rc<dyn TranscriptMutationExecution>,
    pub reopen_producer: Rc<ReopenProducer>,
    pub carryover_revision: Rc<CarryoverRevision<C>>,
    pub chat_mutation_lock: Rc<KeyedLock>,
    pub unhandled_rejections: Rc<UnhandledRejectionPolicy>,
    pub clock: Option<Rc<dyn Clock>>,
}

#[derive(Default)]
pub struct TranscriptReloadOptions {
    pub signal: CancellationToken,
    pub on_progress: Option<Rc<ReloadProgress>>,
}

pub struct TranscriptReloadService<C> {
    options: TranscriptReloadServiceOptions<C>,
    clock: Rc<dyn Clock>,
}

impl<C: 'static> TranscriptReloadService<C> {
    pub fn new(mut options: TranscriptReloadServiceOptions<C>) -> Self {
        let clock = options.clock.take().unwrap_or_else(|| Rc::new(SystemClock));
        Self { options, clock }
    }

    pub async fn reload(
        self: &Rc<Self>,
        chat_id: &str,
        options: TranscriptReloadOptions,
    ) -> LedgerResult<TranscriptView> {
        let chat_id = chat_id.to_owned();
        let service = Rc::clone(self);
        settle_owned_mutation(
            Box::pin(async move {
                let signal = TranscriptReadSignal::new(&options.signal);
                service
                    .options
                    .adoption
                    .ensure(&chat_id, Some(signal))
                    .await?;
                let key = format!("chat:{chat_id}");
                service
                    .options
                    .chat_mutation_lock
                    .run_exclusive(
                        &key,
                        || service.reload_locked(&chat_id, signal, options.on_progress.as_deref()),
                        None,
                    )
                    .await?
            }),
            Rc::clone(&self.options.unhandled_rejections),
        )
        .await
    }

    async fn reload_locked(
        &self,
        chat_id: &str,
        signal: TranscriptReadSignal<'_>,
        on_progress: Option<&ReloadProgress>,
    ) -> LedgerResult<TranscriptView> {
        let release = self
            .options
            .execution
            .reserve_transcript_snapshot(chat_id)
            .map_err(|cause| {
                DomainError::new(
                    ErrorCode::CHAT_RUNNING,
                    "Wait for the current chat operation to finish before reloading.",
                    409,
                    true,
                )
                .with_cause(cause)
            })?;
        let result = async {
            if self
                .options
                .execution
                .has_pending_turn_input(chat_id)
                .await?
            {
                return Err(DomainError::new(
                    ErrorCode::CHAT_RUNNING,
                    "Run or remove queued messages before reloading from native history.",
                    409,
                    false,
                )
                .into());
            }
            signal.check()?;
            self.reload_reserved(chat_id, signal, on_progress).await
        }
        .await;
        release().await.and(result)
    }

    async fn reload_reserved(
        &self,
        chat_id: &str,
        signal: TranscriptReadSignal<'_>,
        on_progress: Option<&ReloadProgress>,
    ) -> LedgerResult<TranscriptView> {
        let ledger = &self.options.ledger;
        let store = ledger.store();
        let entry = self.options.registry.get_chat(chat_id);
        let current = store.current_view(chat_id)?;
        let session = store.current_session(chat_id)?;
        let (Some(mut entry), Some(current)) = (entry, current) else {
            return Err(session_not_found().into());
        };
        let integration = self.options.integrations.require(
            &entry.transcript.agent_id,
            entry.transcript.executor_id.as_deref(),
        )?;
        let (Some(session), Some(importer)) = (session, integration.native_history_import) else {
            return Err(DomainError::new(
                ErrorCode::HISTORY_LOAD_FAILED,
                "This chat has no native history available to reload.",
                422,
                false,
            )
            .into());
        };
        let LedgerRowData::Session {
            detail: established,
        } = session.data
        else {
            return Err(
                crate::errors::LedgerError::Schema("Invalid current session row".into()).into(),
            );
        };
        let watermark = store.high_watermark(chat_id)?;
        let current_rows = store.rows_through(chat_id, &watermark).await?;
        let mut steps = EventLoopSteps::new("ledger-reload");
        let mut collector = PreambleHistoryCollector::default();
        let mut frozen = Vec::new();
        for row in current_rows {
            signal.check()?;
            if row.ordinal < current.content_start_ordinal {
                frozen.extend(frozen_conversation_drafts(std::slice::from_ref(&row)));
            } else {
                collector.add_row(&row)?;
            }
            steps.next().await;
        }
        let evidence = collector.finish()?;
        if let Some(pending) = entry.pending_preamble_boundary.as_ref()
            && ledger.has_preamble_boundary_proof(chat_id, pending)?
        {
            entry = self
                .options
                .registry
                .clear_pending_preamble_boundary(chat_id)?
                .ok_or_else(session_not_found)?;
        }
        self.options.registry.flush().await?;
        ledger.close_producer(chat_id)?;
        let mut staging = None;
        let result = async {
            let content_start_ordinal = frozen.len() as u64 + 1;
            frozen.push(LedgerRowDraft {
                at: session.at,
                provider_meta: None,
                data: LedgerRowData::Session {
                    detail: established.clone(),
                },
            });
            if let Some(progress) = on_progress {
                progress(ChatReloadProgress {
                    phase: ChatReloadPhase::Reading,
                    rows: 0,
                })?;
            }
            let chat = self.chat_reference(
                chat_id,
                entry.transcript,
                &established,
                &integration.agent_id,
                integration.settings.as_ref(),
            )?;
            let now = || Ok(to_iso_string(self.clock.now_ms())?);
            let reading = |rows: usize| -> LedgerResult<()> {
                if let Some(progress) = on_progress {
                    progress(ChatReloadProgress {
                        phase: ChatReloadPhase::Reading,
                        rows: rows as u64,
                    })?;
                }
                Ok(())
            };
            let imported = import_native_history_drafts(NativeHistorySeedInput {
                chat,
                importer: importer.as_ref(),
                signal,
                now: &now,
                on_rows_read: Some(&reading),
                preamble_evidence: &evidence,
            })
            .await?;
            if let Some(progress) = on_progress {
                progress(ChatReloadProgress {
                    phase: ChatReloadPhase::Saving,
                    rows: imported.len() as u64,
                })?;
            }
            steps.for_each(imported, |row| frozen.push(row)).await;
            let staged = store
                .stage_view(
                    chat_id,
                    StageViewInput {
                        view_id: store.new_view_id()?,
                        content_start_ordinal,
                        rows: &frozen,
                    },
                )
                .await?;
            staging = Some(staged.view_id.clone());
            let replacement =
                ledger.replace_current_view(chat_id, &current.view_id, &staged.view_id)?;
            staging = None;
            Ok(replacement)
        }
        .await;
        if let Some(staging_id) = staging {
            store.discard_staging_view(chat_id, &staging_id).await;
        }
        (self.options.reopen_producer)(chat_id).and(result)
    }

    fn chat_reference(
        &self,
        chat_id: &str,
        entry: RegisteredTranscriptChat<C>,
        session: &AgentEstablishedSession,
        agent_id: &str,
        settings: &dyn AgentSettings,
    ) -> LedgerResult<AgentChatReference> {
        let revision =
            (self.options.carryover_revision)(&entry.carryover, entry.quarantine.as_ref());
        let raw_settings = match entry.settings_by_agent.get(agent_id) {
            Some(saved) => saved.clone(),
            None => settings.defaults()?,
        };
        let settings = settings.parse(raw_settings)?;
        if session
            .native_session
            .as_ref()
            .is_some_and(|native| native.owner_id != agent_id)
        {
            return Err(format!("Native session owner mismatch for {chat_id}").into());
        }
        Ok(AgentChatReference {
            chat_id: chat_id.into(),
            agent_id: agent_id.into(),
            agent_session_id: Some(session.agent_session_id.clone()),
            project_path: entry.project_path,
            model: entry.model,
            native_session: session.native_session.clone(),
            native_seed_receipt: session.native_seed_receipt.clone(),
            carry_over_revision: revision,
            settings,
        })
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
