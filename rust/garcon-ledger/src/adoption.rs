//! The only owner of genesis adoption for a registered chat.

use std::{error::Error, rc::Rc};

use futures::{StreamExt, future::LocalBoxFuture};
use garcon_base::{
    errors::{NamedError, error_metadata},
    event_loop::EventLoopSteps,
    keyed_lock::{KeyedLock, LockAborted},
};
use garcon_contract::{
    agent_integration::AgentSettingsEnvelope,
    chat_types::ChatMessage,
    transcript_seed::{
        NativeSeedReceipt, SanitizeCarriedContextResult, sanitize_recorded_carried_context,
    },
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    host::AgentLogger,
    native_history::{AgentHistoryImport, AgentHistoryImportRequest},
    producer::AgentEstablishedSession,
    services::AgentSettings,
    transcript::{AgentChatReference, AgentNativeSessionRef},
};
use garcon_js::{
    clock::{Clock, SystemClock, to_iso_string},
    json::Opaque,
};
use indexmap::IndexMap;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::{
    contracts::{LedgerRowData, LedgerRowDraft, TranscriptView},
    garcon_command_request::notice,
    imported_drafts::{ImportedRow, frozen_drafts, imported_drafts},
    sqlite_operations::LedgerResult,
    store::{InitializeViewInput, TranscriptLedgerStore, TranscriptReadSignal},
    view_reader::TranscriptViewAdoption,
};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TranscriptSessionCache {
    pub agent_session_id: Option<String>,
    pub native_session: Option<AgentNativeSessionRef>,
    pub native_seed_receipt: Option<NativeSeedReceipt>,
}

#[derive(Debug, Clone)]
pub struct CarryoverQuarantine {
    pub artifact_id: String,
    pub error_code: String,
}

#[derive(Clone)]
pub struct RegisteredTranscriptChat<C> {
    pub agent_id: String,
    pub executor_id: Option<String>,
    pub ownership_epoch: String,
    pub project_path: String,
    pub model: String,
    pub settings_by_agent: IndexMap<String, AgentSettingsEnvelope>,
    pub session: TranscriptSessionCache,
    pub carryover: C,
    pub quarantine: Option<CarryoverQuarantine>,
}

pub trait TranscriptAdoptionRegistry<C> {
    fn get_chat(&self, chat_id: &str) -> Option<RegisteredTranscriptChat<C>>;
    fn update_session_cache(
        &self,
        chat_id: &str,
        value: TranscriptSessionCache,
    ) -> LedgerResult<()>;
}

pub struct LegacyHistoryIntegration {
    pub agent_id: String,
    pub settings: Rc<dyn AgentSettings>,
    pub importer: Option<Rc<dyn AgentHistoryImport>>,
}

pub trait TranscriptAdoptionIntegrations {
    fn require(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> LedgerResult<LegacyHistoryIntegration>;
}

pub trait TranscriptFrozenHistory<C> {
    fn revision(&self, carryover: &C, quarantine: Option<&CarryoverQuarantine>) -> String;

    fn load_all<'a>(
        &'a self,
        carryover: &'a C,
        signal: CancellationToken,
    ) -> LocalBoxFuture<'a, LedgerResult<Vec<ChatMessage>>>;
}

pub type TranscriptAdoptedListener = dyn Fn(&str) -> LedgerResult<()>;

pub struct TranscriptAdoptionOptions<C> {
    pub store: Rc<TranscriptLedgerStore>,
    pub registry: Rc<dyn TranscriptAdoptionRegistry<C>>,
    pub integrations: Rc<dyn TranscriptAdoptionIntegrations>,
    pub frozen_history: Rc<dyn TranscriptFrozenHistory<C>>,
    pub on_adopted: Option<Rc<TranscriptAdoptedListener>>,
    pub logger: Option<Rc<dyn AgentLogger>>,
    pub clock: Option<Rc<dyn Clock>>,
}

pub struct TranscriptAdoptionService<C> {
    options: TranscriptAdoptionOptions<C>,
    locks: KeyedLock,
    clock: Rc<dyn Clock>,
}

impl<C> TranscriptAdoptionService<C> {
    pub fn new(mut options: TranscriptAdoptionOptions<C>) -> Self {
        let clock = options.clock.take().unwrap_or_else(|| Rc::new(SystemClock));
        Self {
            options,
            locks: KeyedLock::default(),
            clock,
        }
    }

    pub async fn ensure(
        &self,
        chat_id: &str,
        signal: Option<TranscriptReadSignal<'_>>,
    ) -> LedgerResult<TranscriptView> {
        self.registered_chat(chat_id)?;
        if let Some(view) = self.options.store.current_view(chat_id)? {
            self.repair_session_cache(chat_id)?;
            return Ok(view);
        }

        self.locks
            .run_exclusive(chat_id, || self.ensure_locked(chat_id, signal), None)
            .await?
    }

    async fn ensure_locked(
        &self,
        chat_id: &str,
        signal: Option<TranscriptReadSignal<'_>>,
    ) -> LedgerResult<TranscriptView> {
        let entry = self.registered_chat(chat_id)?;
        if let Some(view) = self.options.store.current_view(chat_id)? {
            self.repair_session_cache(chat_id)?;
            return Ok(view);
        }
        check_signal(signal)?;
        let integration = self
            .options
            .integrations
            .require(&entry.agent_id, entry.executor_id.as_deref())?;
        let token = signal
            .map(|signal| signal.token().clone())
            .unwrap_or_default();
        let prefix = if entry.quarantine.is_some() {
            Vec::new()
        } else {
            self.options
                .frozen_history
                .load_all(&entry.carryover, token.clone())
                .await
                .map_err(|error| {
                    self.source_failure(chat_id, &entry.agent_id, "frozen-prefix", error, signal)
                })?
        };
        check_signal(signal)?;
        let mut steps = EventLoopSteps::new("transcript-import-conversion");
        let legacy = self
            .load_legacy(chat_id, &entry, integration, token, &mut steps, signal)
            .await
            .map_err(|error| {
                self.source_failure(
                    chat_id,
                    &entry.agent_id,
                    "legacy-history-import",
                    error,
                    signal,
                )
            })?;
        check_signal(signal)?;
        let now = || Ok(to_iso_string(self.clock.now_ms())?);
        let imported = imported_drafts(legacy, &now, &mut steps, signal).await?;
        check_signal(signal)?;
        let mut rows = match &entry.quarantine {
            Some(quarantine) => vec![quarantine_draft(quarantine, &now()?)],
            None => frozen_drafts(prefix, &now, &mut steps, signal).await?,
        };
        let content_start_ordinal = rows.len() as u64 + 1;
        let at = now()?;
        if let Some(agent_session_id) = entry.session.agent_session_id.filter(|id| !id.is_empty()) {
            rows.push(LedgerRowDraft {
                at,
                provider_meta: None,
                data: LedgerRowData::Session {
                    detail: AgentEstablishedSession {
                        agent_session_id,
                        native_session: entry.session.native_session,
                        native_seed_receipt: entry.session.native_seed_receipt,
                    },
                },
            });
        }
        steps
            .try_for_each(imported, |row| {
                check_signal(signal)?;
                rows.push(row);
                Ok::<_, Box<dyn Error>>(())
            })
            .await?;
        check_signal(signal)?;
        // Seeding captures the deletion generation on its first poll.
        let latest = self.options.registry.get_chat(chat_id);
        if !latest.is_some_and(|latest| latest.ownership_epoch == entry.ownership_epoch) {
            return Err(type_error(format!(
                "Chat ownership changed while adopting {chat_id}"
            )));
        }
        let view = self
            .options
            .store
            .seed_current_view(
                chat_id,
                InitializeViewInput {
                    view_id: None,
                    content_start_ordinal,
                    rows: &rows,
                },
            )
            .await?;
        self.notify_adopted(chat_id);
        self.repair_session_cache(chat_id)?;
        Ok(view)
    }

    fn registered_chat(&self, chat_id: &str) -> LedgerResult<RegisteredTranscriptChat<C>> {
        self.options.registry.get_chat(chat_id).ok_or_else(|| {
            type_error(format!(
                "Cannot adopt transcript for unknown chat {chat_id}"
            ))
        })
    }

    fn repair_session_cache(&self, chat_id: &str) -> LedgerResult<()> {
        let Some(entry) = self.options.registry.get_chat(chat_id) else {
            return Ok(());
        };
        let cache = match self
            .options
            .store
            .current_session(chat_id)?
            .map(|row| row.data)
        {
            Some(LedgerRowData::Session { detail }) => TranscriptSessionCache {
                agent_session_id: Some(detail.agent_session_id),
                native_session: detail.native_session,
                native_seed_receipt: detail.native_seed_receipt,
            },
            _ => TranscriptSessionCache::default(),
        };
        if entry.session != cache {
            self.options.registry.update_session_cache(chat_id, cache)?;
        }
        Ok(())
    }

    async fn load_legacy(
        &self,
        chat_id: &str,
        entry: &RegisteredTranscriptChat<C>,
        integration: LegacyHistoryIntegration,
        token: CancellationToken,
        steps: &mut EventLoopSteps,
        signal: Option<TranscriptReadSignal<'_>>,
    ) -> LedgerResult<Vec<ImportedRow>> {
        let session_id = entry.session.agent_session_id.as_deref();
        let native = &entry.session.native_session;
        let Some(importer) = integration.importer else {
            return Ok(Vec::new());
        };
        if session_id.is_none_or(str::is_empty) && native.is_none() {
            return Ok(Vec::new());
        }
        let carry_over_revision = self
            .options
            .frozen_history
            .revision(&entry.carryover, entry.quarantine.as_ref());
        let raw_settings = match entry.settings_by_agent.get(&integration.agent_id) {
            Some(saved) => saved.clone(),
            None => integration.settings.defaults()?,
        };
        let settings = integration.settings.parse(raw_settings)?;
        if native
            .as_ref()
            .is_some_and(|reference| reference.owner_id != integration.agent_id)
        {
            return Err(Box::<dyn Error>::from(format!(
                "Native session owner mismatch for {chat_id}"
            )));
        }
        let chat = AgentChatReference {
            chat_id: chat_id.into(),
            agent_id: integration.agent_id,
            agent_session_id: entry.session.agent_session_id.clone(),
            project_path: entry.project_path.clone(),
            model: entry.model.clone(),
            native_session: native.clone(),
            carry_over_revision,
            native_seed_receipt: entry.session.native_seed_receipt.clone(),
            settings,
        };
        let mut source = importer.load(
            AgentHistoryImportRequest {
                chat,
                signal: token,
            },
            None,
        );
        let mut rows = Vec::new();
        let mut first_user = None;
        while let Some(batch) = source.next().await {
            check_signal(signal)?;
            steps
                .try_for_each(batch?, |row| {
                    check_signal(signal)?;
                    if first_user.is_none() && matches!(row.message, ChatMessage::User(_)) {
                        first_user = Some(rows.len());
                    }
                    rows.push(ImportedRow {
                        message: row.message,
                        provider_meta: row.provider_meta,
                        preamble_application: None,
                    });
                    Ok::<_, Box<dyn Error>>(())
                })
                .await?;
        }
        check_signal(signal)?;
        if let Some(receipt) = entry.session.native_seed_receipt.as_ref() {
            // Receipt sanitation inspects only the first user message.
            let seed_candidate = first_user.map(|index| rows[index].message.clone());
            match sanitize_recorded_carried_context(
                seed_candidate.into_iter().collect(),
                Some(receipt),
                session_id,
            ) {
                SanitizeCarriedContextResult::Mismatch { .. } => {
                    return Err(type_error(
                        "Native transcript seed receipt does not match the current session",
                    ));
                }
                SanitizeCarriedContextResult::StrippedExact { mut messages } => {
                    if let (Some(index), Some(message)) = (first_user, messages.pop()) {
                        rows[index].message = message;
                    }
                }
                SanitizeCarriedContextResult::Absent { .. }
                | SanitizeCarriedContextResult::NotApplicable { .. } => {}
            }
        }
        Ok(rows)
    }

    fn source_failure(
        &self,
        chat_id: &str,
        provider: &str,
        phase: &'static str,
        error: Box<dyn Error>,
        signal: Option<TranscriptReadSignal<'_>>,
    ) -> Box<dyn Error> {
        if let Err(aborted) = check_signal(signal) {
            return aborted;
        }
        if error.is::<LockAborted>() {
            return error;
        }
        if let Some(logger) = &self.options.logger {
            let metadata = error_metadata(error.as_ref());
            let reason = metadata
                .code
                .filter(|code| !code.is_empty())
                .unwrap_or(metadata.name);
            logger.warn(
                "Transcript adoption source failed.",
                Some(&IndexMap::from([
                    ("chatId".into(), Opaque::from(json!(chat_id))),
                    ("provider".into(), Opaque::from(json!(provider))),
                    ("phase".into(), Opaque::from(json!(phase))),
                    ("reason".into(), Opaque::from(json!(reason))),
                ])),
            );
        }
        AgentIntegrationError::new(
            AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
            "Transcript adoption source failed",
            true,
            Some(serde_json::Map::from_iter([
                ("provider".into(), json!(provider)),
                ("phase".into(), json!(phase)),
            ])),
        )
        .into()
    }

    fn notify_adopted(&self, chat_id: &str) {
        if self
            .options
            .on_adopted
            .as_ref()
            .is_some_and(|listener| listener(chat_id).is_err())
            && let Some(logger) = &self.options.logger
        {
            logger.warn(
                "Transcript adoption notification failed.",
                Some(&IndexMap::from([(
                    "code".into(),
                    Opaque::from(json!("TRANSCRIPT_ADOPTION_NOTIFICATION_FAILED")),
                )])),
            );
        }
    }
}

impl<C> TranscriptViewAdoption for TranscriptAdoptionService<C> {
    fn ensure<'a>(
        &'a self,
        chat_id: &'a str,
        signal: Option<TranscriptReadSignal<'a>>,
    ) -> LocalBoxFuture<'a, LedgerResult<TranscriptView>> {
        Box::pin(TranscriptAdoptionService::ensure(self, chat_id, signal))
    }
}

fn check_signal(signal: Option<TranscriptReadSignal<'_>>) -> LedgerResult<()> {
    signal.map_or(Ok(()), TranscriptReadSignal::check)
}

fn type_error(message: impl Into<String>) -> Box<dyn Error> {
    NamedError {
        name: "TypeError".into(),
        message: message.into(),
        code: None,
    }
    .into()
}

fn quarantine_draft(quarantine: &CarryoverQuarantine, at: &str) -> LedgerRowDraft {
    notice(
        at,
        format!(
            "Some earlier chat history could not be migrated. Quarantine reference: {}.",
            quarantine.artifact_id
        ),
        json!({
            "type": "carryover-migration-quarantine",
            "artifactId": quarantine.artifact_id,
            "errorCode": quarantine.error_code,
        }),
    )
}
