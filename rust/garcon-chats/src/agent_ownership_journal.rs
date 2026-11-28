//! Durable cross-provider ownership and deletion decisions. The journal does
//! not persist execution or recover process-only input queues.

use std::{
    cell::RefCell,
    collections::HashSet,
    error::Error,
    future::Future,
    io,
    path::{Path, PathBuf},
    rc::Rc,
    time::Duration,
};

use async_trait::async_trait;
use futures::future::{FutureExt, LocalBoxFuture, Shared};
use garcon_base::{
    domain_error::DomainError,
    errors::{ErrorInput, NamedError, diagnostic_error_code},
    json_file_store::{JsonFileStore, JsonWriteOptions, WriteFileError},
    log::{Logger, create_logger},
    stored_json::parse_stored_json,
};
use garcon_contract::{
    error_codes::ErrorCode,
    executors::{ExecutorId, LOCAL_EXECUTOR_ID},
};
use garcon_interface::{
    native_history::{
        AgentHistoryImportRequest, AgentNativeSessionAccess, AgentNativeSessionReleaseReason,
        AgentNativeSessionReleaseRequest,
    },
    services::AgentSettings,
    transcript::AgentChatReference,
};
use garcon_js::{Clock, SystemClock, json::stringify, to_iso_string};
use tokio::{
    sync::{Mutex, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    agent_ownership_journal_format::{
        AgentHandoffIntent, AgentOwnershipJournalFileV5, DeleteIntent, DeletePhase, HandoffPhase,
        HandoffSource, HandoffTarget, OwnershipIntent, ReleaseReference,
        ResolvedAgentHandoffTarget, StoredIntent, TranscriptWatermark, empty_ownership_journal_v5,
        is_empty_earlier_journal, omit_empty_executor, parse_v5,
    },
    carryover::segments::carry_over_revision,
    preambles::boundary::{LifecyclePreambleBoundaryKind, create_preamble_boundary_binding},
    registry_contracts::ChatRegistryEntry,
    store::{
        ChatRegistry, ChatRegistryPatch, ChatRemovalReason, RegistryWriteFailure, ResolvedChat,
        RetainReferences,
    },
};

const FILE: &str = "agent-ownership-journal.json";
const MAX_SAFE_MILLIS: u64 = 9_007_199_254_740_991;
type BoxError = Box<dyn Error>;
type ExecutorConfigured = dyn Fn(&str) -> bool;

pub struct OwnershipAgent {
    pub agent_id: String,
    pub settings: Rc<dyn AgentSettings>,
    pub native_sessions: Option<Rc<dyn AgentNativeSessionAccess>>,
}

pub trait OwnershipAgentDirectory {
    fn get(&self, agent_id: &str, executor_id: Option<&str>) -> Option<OwnershipAgent>;
}

#[async_trait(?Send)]
pub trait OwnershipLedger {
    async fn delete_chat(&self, chat_id: &str) -> Result<(), BoxError>;
}

#[async_trait(?Send)]
pub trait OwnershipJournalWriter {
    async fn write(
        &self,
        path: &Path,
        journal: &AgentOwnershipJournalFileV5,
    ) -> Result<(), RegistryWriteFailure>;
}

#[async_trait(?Send)]
impl OwnershipJournalWriter for JsonFileStore {
    async fn write(
        &self,
        path: &Path,
        journal: &AgentOwnershipJournalFileV5,
    ) -> Result<(), RegistryWriteFailure> {
        self.write_json_file_atomic(
            &path.to_string_lossy(),
            journal,
            JsonWriteOptions {
                mode: Some(0o600),
                trailing_newline: None,
            },
        )
        .await
        .map_err(|error| RegistryWriteFailure {
            renamed: matches!(&error, WriteFileError::Atomic(atomic) if atomic.renamed),
            cause: Box::new(error),
        })
    }
}

pub struct OwnershipJournalOptions {
    pub release_timeout_ms: u64,
    pub retain_executor_references: Option<RetainReferences>,
    pub retain_provider_references: Option<RetainReferences>,
    pub writer: Rc<dyn OwnershipJournalWriter>,
    pub clock: Rc<dyn Clock>,
    pub operation_id: Rc<dyn Fn() -> String>,
}

impl Default for OwnershipJournalOptions {
    fn default() -> Self {
        Self {
            release_timeout_ms: 30_000,
            retain_executor_references: None,
            retain_provider_references: None,
            writer: Rc::new(JsonFileStore::default()),
            clock: Rc::new(SystemClock),
            operation_id: Rc::new(|| Uuid::new_v4().to_string()),
        }
    }
}

pub struct DecideHandoff {
    pub operation_id: String,
    pub client_request_id: String,
    pub submitted_target_hash: String,
    pub chat_id: String,
    pub source: HandoffSource,
    pub target: ResolvedAgentHandoffTarget,
    pub target_agent_ownership_epoch: String,
    pub watermark: TranscriptWatermark,
}

type QueueTail = Shared<LocalBoxFuture<'static, ()>>;

#[derive(Default)]
struct OperationQueue(RefCell<Option<QueueTail>>);

impl OperationQueue {
    fn push<T: 'static>(&self, work: impl Future<Output = T> + 'static) -> JoinHandle<T> {
        let (finished, receiver) = oneshot::channel::<()>();
        let tail = async move {
            let _ = receiver.await;
        }
        .boxed_local()
        .shared();
        let previous = self.0.replace(Some(tail));
        tokio::task::spawn_local(async move {
            if let Some(previous) = previous {
                previous.await;
            }
            let result = work.await;
            drop(finished);
            result
        })
    }

    async fn wait(&self) {
        let tail = self.0.borrow().clone();
        if let Some(tail) = tail {
            tail.await;
        }
    }
}

pub struct AgentOwnershipJournal {
    path: PathBuf,
    registry: Rc<ChatRegistry>,
    agents: Rc<dyn OwnershipAgentDirectory>,
    ledger: Rc<dyn OwnershipLedger>,
    configured: Rc<ExecutorConfigured>,
    options: OwnershipJournalOptions,
    current: RefCell<AgentOwnershipJournalFileV5>,
    unconfirmed_executors: RefCell<HashSet<String>>,
    completed_ledger_deletes: RefCell<HashSet<String>>,
    mutation_lock: Mutex<()>,
    deletes: OperationQueue,
    provider_cleanup: OperationQueue,
}

impl AgentOwnershipJournal {
    pub async fn open(
        workspace: &Path,
        registry: Rc<ChatRegistry>,
        agents: Rc<dyn OwnershipAgentDirectory>,
        ledger: Rc<dyn OwnershipLedger>,
        configured: Rc<ExecutorConfigured>,
        options: OwnershipJournalOptions,
    ) -> Result<Rc<Self>, BoxError> {
        if !(1..=MAX_SAFE_MILLIS).contains(&options.release_timeout_ms) {
            return Err("Ownership cleanup release timeout must be a positive integer".into());
        }
        let path = workspace.join(FILE);
        let current = load(&path).await?;
        let intents = current.intents.clone();
        let journal = Rc::new(Self {
            path,
            registry,
            agents,
            ledger,
            configured,
            options,
            current: RefCell::new(current),
            unconfirmed_executors: RefCell::new(HashSet::new()),
            completed_ledger_deletes: RefCell::new(HashSet::new()),
            mutation_lock: Mutex::new(()),
            deletes: OperationQueue::default(),
            provider_cleanup: OperationQueue::default(),
        });
        for stored in intents {
            if let OwnershipIntent::Delete(intent) = &stored.value
                && let Err(error) = journal.recover_delete(&stored, intent).await
            {
                warn(&format!(
                    "Ownership recovery retained an inconsistent delete intent: chatId={}, operationId={}, reason={error}",
                    intent.chat_id, intent.operation_id
                ));
            }
        }
        Ok(journal)
    }

    pub fn references_api_provider(&self, provider_id: &str) -> bool {
        provider_ids(&self.current.borrow())
            .iter()
            .any(|id| id == provider_id)
    }

    pub fn has_pending(&self, chat_id: &str) -> bool {
        self.current
            .borrow()
            .intents
            .iter()
            .any(|intent| intent.value.chat_id() == chat_id)
    }

    pub fn references_executor(&self, executor_id: &str) -> bool {
        self.unconfirmed_executors.borrow().contains(executor_id)
            || self
                .current
                .borrow()
                .intents
                .iter()
                .any(|intent| intent_executors(&intent.value).contains(&executor_id))
    }

    pub fn blocks_executor_removal(&self, executor_id: &str) -> bool {
        self.unconfirmed_executors.borrow().contains(executor_id)
            || self.current.borrow().intents.iter().any(|intent| {
                let blocks = match &intent.value {
                    OwnershipIntent::Handoff(_) => true,
                    OwnershipIntent::Delete(intent) => {
                        intent.phase == DeletePhase::Prepared
                            || !self
                                .completed_ledger_deletes
                                .borrow()
                                .contains(&intent.operation_id)
                    }
                };
                blocks && intent_executors(&intent.value).contains(&executor_id)
            })
    }

    pub fn roots(&self) -> HashSet<String> {
        HashSet::new()
    }

    pub fn pending_handoffs(&self) -> Vec<AgentHandoffIntent> {
        self.current
            .borrow()
            .intents
            .iter()
            .filter_map(|stored| match &stored.value {
                OwnershipIntent::Handoff(intent) => Some(intent.as_ref().clone()),
                OwnershipIntent::Delete(_) => None,
            })
            .collect()
    }

    pub fn find_handoff(
        &self,
        chat_id: &str,
        client_request_id: &str,
    ) -> Option<AgentHandoffIntent> {
        self.current
            .borrow()
            .intents
            .iter()
            .find_map(|stored| match &stored.value {
                OwnershipIntent::Handoff(intent)
                    if intent.chat_id == chat_id
                        && intent.client_request_id == client_request_id =>
                {
                    Some(intent.as_ref().clone())
                }
                _ => None,
            })
    }

    pub async fn decide_handoff(
        self: &Rc<Self>,
        options: DecideHandoff,
    ) -> Result<AgentHandoffIntent, BoxError> {
        let inherited = options.source.executor_id.as_deref().map(str::to_owned);
        let stored = Rc::new(StoredIntent::handoff(AgentHandoffIntent {
            version: 5,
            operation_id: options.operation_id,
            client_request_id: options.client_request_id,
            submitted_target_hash: options.submitted_target_hash,
            kind: "handoff",
            chat_id: options.chat_id,
            phase: HandoffPhase::CommitDecided,
            source: HandoffSource {
                executor_id: omit_empty_executor(options.source.executor_id),
                ..options.source
            },
            target: HandoffTarget {
                execution: options.target,
                agent_ownership_epoch: options.target_agent_ownership_epoch,
            },
            watermark: options.watermark,
            created_at: self.now()?,
        })?);
        let journal = self.clone();
        tokio::task::spawn_local(async move {
            let id = stored.value.operation_id();
            journal
                .mutate(inherited.as_deref(), |current| {
                    if let Some(existing) = current
                        .intents
                        .iter()
                        .find(|intent| intent.value.operation_id() == id)
                    {
                        if same_handoff_decision(existing, &stored) {
                            return Ok((None, ()));
                        }
                        return Err(DomainError::new(
                            ErrorCode::IDEMPOTENCY_CONFLICT,
                            "The handoff operation was decided with different inputs.",
                            409,
                            false,
                        )
                        .into());
                    }
                    assert_available(
                        current,
                        stored.value.chat_id(),
                        ErrorCode::AGENT_HANDOFF_REQUIRES_IDLE,
                    )?;
                    let mut candidate = current.clone();
                    candidate.intents.push(stored.clone());
                    Ok((Some(candidate), ()))
                })
                .await?;
            let (_, intent) = journal.require_handoff(id)?;
            Ok(intent)
        })
        .await?
    }

    pub async fn apply_handoff_decision(
        self: &Rc<Self>,
        operation_id: &str,
    ) -> Result<ResolvedChat, BoxError> {
        let journal = self.clone();
        let operation_id = operation_id.to_owned();
        tokio::task::spawn_local(async move { journal.apply_handoff(&operation_id).await }).await?
    }

    async fn apply_handoff(&self, operation_id: &str) -> Result<ResolvedChat, BoxError> {
        let (stored, intent) = self.require_handoff(operation_id)?;
        let current = self.registry.get_chat(&intent.chat_id);
        if let Some(current) = current
            .as_ref()
            .filter(|current| matches_handoff_target(Some(current), &intent))
        {
            return Ok(ResolvedChat {
                id: garcon_contract::chat_id::parse_chat_id(&serde_json::Value::String(
                    intent.chat_id,
                ))?,
                entry: current.clone(),
            });
        }
        let Some(current) = current.filter(|current| matches_handoff_source(current, &intent))
        else {
            return Err(DomainError::new(
                ErrorCode::STALE_CHAT_OWNERSHIP,
                format!("Agent handoff ownership changed for {}.", intent.chat_id),
                409,
                false,
            )
            .into());
        };
        let execution = &intent.target.execution;
        let mut settings = current.agent_settings_by_id;
        settings.insert(execution.agent_id.clone(), execution.agent_settings.clone());
        let binding = create_preamble_boundary_binding(
            LifecyclePreambleBoundaryKind::AgentSwitch,
            intent.target.agent_ownership_epoch.clone(),
        );
        let patch = ChatRegistryPatch {
            agent_id: Some(execution.agent_id.clone()),
            model: Some(execution.model.clone()),
            api_provider_id: Some(execution.api_provider_id.clone()),
            model_endpoint_id: Some(execution.model_endpoint_id.clone()),
            model_protocol: Some(execution.model_protocol),
            permission_mode: Some(execution.permission_mode),
            thinking_mode: Some(execution.thinking_mode),
            agent_settings_by_id: Some(settings),
            agent_session_id: Some(None),
            native_session: Some(None),
            native_seed_receipt: Some(None),
            carry_over_segments: Some(Vec::new()),
            carry_over_migration_quarantine: Some(None),
            agent_ownership_epoch: Some(binding.agent_ownership_epoch),
            pending_preamble_boundary: Some(Some(binding.pending_preamble_boundary)),
            ..Default::default()
        };
        let updated = self
            .registry
            .install_agent_ownership(
                &intent.chat_id,
                execution.executor_id.as_option().cloned(),
                execution
                    .project_path
                    .clone()
                    .unwrap_or(current.project_path),
                patch,
            )
            .await?
            .ok_or_else(|| format!("Session not found: {}", intent.chat_id))?;
        if intent.phase != HandoffPhase::RegistryCommitted {
            self.replace_intent(stored.commit_handoff(intent)).await?;
        }
        Ok(updated)
    }

    pub async fn complete_handoff(self: &Rc<Self>, operation_id: &str) -> Result<(), BoxError> {
        let journal = self.clone();
        let operation_id = operation_id.to_owned();
        tokio::task::spawn_local(async move {
            let (_, intent) = journal.require_handoff(&operation_id)?;
            if !matches_handoff_target(journal.registry.get_chat(&intent.chat_id).as_ref(), &intent)
            {
                return Err(format!(
                    "Cannot complete handoff before target ownership is installed: {operation_id}"
                )
                .into());
            }
            journal.remove_intent(&operation_id).await
        })
        .await?
    }

    pub async fn delete(self: &Rc<Self>, chat_id: &str) -> Result<(), BoxError> {
        let journal = self.clone();
        let chat_id = chat_id.to_owned();
        self.deletes
            .push(async move { journal.delete_now(&chat_id).await })
            .await?
    }

    pub async fn retire_removed_executor(
        self: &Rc<Self>,
        executor_id: &str,
    ) -> Result<(), BoxError> {
        let journal = self.clone();
        let executor_id = executor_id.to_owned();
        self.provider_cleanup
            .push(async move {
                if (journal.configured)(&executor_id) {
                    return Ok(());
                }
                journal.finish_executor_deletes(&executor_id).await
            })
            .await?
    }

    pub async fn retry_provider_cleanup(
        self: &Rc<Self>,
        executor_id: &str,
    ) -> Result<(), BoxError> {
        let journal = self.clone();
        let executor_id = executor_id.to_owned();
        self.provider_cleanup
            .push(async move { journal.finish_executor_deletes(&executor_id).await })
            .await?
    }

    pub async fn wait_for_provider_cleanup(&self) {
        self.provider_cleanup.wait().await;
    }

    async fn delete_now(self: &Rc<Self>, chat_id: &str) -> Result<(), BoxError> {
        let current = self.registry.get_chat(chat_id);
        let executor_id = current
            .as_ref()
            .and_then(|entry| entry.executor_id.as_deref());
        let Some((stored, intent)) = self
            .mutate(executor_id, |journal| {
                assert_available(journal, chat_id, ErrorCode::SESSION_BUSY)?;
                let Some(current) = &current else {
                    return Ok((None, None));
                };
                let intent = DeleteIntent {
                    version: 2,
                    operation_id: (self.options.operation_id)(),
                    kind: "delete",
                    chat_id: chat_id.into(),
                    phase: DeletePhase::Prepared,
                    source_epoch: Some(current.agent_ownership_epoch.clone()),
                    release_references: self
                        .release_reference(chat_id, current)?
                        .into_iter()
                        .map(Rc::new)
                        .collect(),
                    created_at: self.now()?,
                };
                let prepared = Rc::new(StoredIntent::delete(intent.clone())?);
                let mut candidate = journal.clone();
                candidate.intents.push(prepared.clone());
                Ok((Some(candidate), Some((prepared, intent))))
            })
            .await?
        else {
            return Ok(());
        };
        self.registry
            .remove_chat(chat_id, ChatRemovalReason::UserDeletion)?;
        self.registry.flush().await?;
        self.finish_controller_delete(&stored, &intent, "Delete cleanup scheduling failed")
            .await
    }

    async fn recover_delete(
        self: &Rc<Self>,
        stored: &StoredIntent,
        intent: &DeleteIntent,
    ) -> Result<(), BoxError> {
        if let Some(current) = self.registry.get_chat(&intent.chat_id) {
            if intent.source_epoch.as_deref() != Some(&current.agent_ownership_epoch) {
                return Err(format!(
                    "Agent delete journal integrity failure for chat {}",
                    intent.chat_id
                )
                .into());
            }
            self.registry
                .remove_chat(&intent.chat_id, ChatRemovalReason::UserDeletion)?;
            self.registry.flush().await?;
        }
        self.finish_controller_delete(stored, intent, "Recovered delete cleanup failed")
            .await
    }

    async fn finish_controller_delete(
        self: &Rc<Self>,
        stored: &StoredIntent,
        intent: &DeleteIntent,
        cleanup_failure: &'static str,
    ) -> Result<(), BoxError> {
        // The controller ledger is retired before delete settles; only provider release is detached.
        self.ledger.delete_chat(&intent.chat_id).await?;
        self.completed_ledger_deletes
            .borrow_mut()
            .insert(intent.operation_id.clone());
        self.replace_intent(stored.mark_registry_removed(intent.clone()))
            .await?;
        let operation_id = intent.operation_id.clone();
        let chat_id = intent.chat_id.clone();
        let journal = self.clone();
        drop(self.provider_cleanup.push(async move {
            if let Err(error) = journal.finish_delete(&operation_id).await {
                warn(&format!(
                    "{cleanup_failure}: chatId={chat_id}, reason={error}"
                ));
            }
        }));
        Ok(())
    }

    async fn finish_executor_deletes(&self, executor_id: &str) -> Result<(), BoxError> {
        let intents = self.current.borrow().intents.clone();
        for stored in intents {
            if let OwnershipIntent::Delete(intent) = &stored.value
                && intent.phase == DeletePhase::RegistryRemoved
                && intent_executors(&stored.value).contains(&executor_id)
            {
                self.finish_delete(&intent.operation_id).await?;
            }
        }
        Ok(())
    }

    async fn finish_delete(&self, operation_id: &str) -> Result<(), BoxError> {
        let stored = self
            .current
            .borrow()
            .intents
            .iter()
            .find(|intent| intent.value.operation_id() == operation_id)
            .cloned();
        let Some(stored) = stored else {
            return Ok(());
        };
        let OwnershipIntent::Delete(intent) = &stored.value else {
            return Ok(());
        };
        if intent.phase != DeletePhase::RegistryRemoved
            || !self
                .completed_ledger_deletes
                .borrow()
                .contains(operation_id)
        {
            return Ok(());
        }
        let mut remaining = intent.release_references.clone();
        for reference in &intent.release_references {
            let executor_id = reference.executor_id.as_deref();
            if (self.configured)(effective_executor(executor_id)) {
                let Some(agent) = self.agents.get(&reference.chat.agent_id, executor_id) else {
                    continue;
                };
                if let Some(native) = agent.native_sessions
                    && let Err(error) = self
                        .release_transcript(native, reference.chat.clone())
                        .await
                {
                    warn(&format!(
                        "Delete cleanup release failed: chatId={}, agentId={}, errorCode={}",
                        intent.chat_id,
                        reference.chat.agent_id,
                        diagnostic_error_code(ErrorInput::Error(error.as_ref()))
                    ));
                    continue;
                }
            }
            remaining.retain(|candidate| !Rc::ptr_eq(candidate, reference));
            if !remaining.is_empty() {
                self.replace_intent(stored.with_remaining(intent.clone(), remaining.clone()))
                    .await?;
            }
        }
        if remaining.is_empty() {
            self.remove_intent(operation_id).await?;
        }
        Ok(())
    }

    async fn release_transcript(
        &self,
        native: Rc<dyn AgentNativeSessionAccess>,
        chat: AgentChatReference,
    ) -> Result<(), BoxError> {
        let signal = CancellationToken::new();
        let request = AgentNativeSessionReleaseRequest {
            request: AgentHistoryImportRequest {
                chat,
                signal: signal.clone(),
            },
            reason: AgentNativeSessionReleaseReason::Deleted,
        };
        let mut release = tokio::task::spawn_local(async move { native.release(request).await });
        tokio::select! {
            biased;
            result = &mut release => result?,
            () = tokio::time::sleep(Duration::from_millis(self.options.release_timeout_ms)) => {
                signal.cancel();
                Err(Box::new(NamedError { name: "AbortError".into(), message: "Provider transcript release timed out".into(), code: None }))
            }
        }
    }

    fn release_reference(
        &self,
        chat_id: &str,
        current: &ChatRegistryEntry,
    ) -> Result<Option<ReleaseReference>, BoxError> {
        let agent = self
            .agents
            .get(&current.agent_id, current.executor_id.as_deref());
        let connected = agent.is_some();
        let (agent_id, settings) = match agent {
            Some(agent) => {
                let input = match current.agent_settings_by_id.get(&agent.agent_id) {
                    Some(settings) => settings.clone(),
                    None => agent.settings.defaults()?,
                };
                let settings = agent.settings.parse(input)?;
                if current
                    .native_session
                    .as_ref()
                    .is_some_and(|native| native.owner_id != agent.agent_id)
                {
                    return Err(format!("Native session owner mismatch for {chat_id}").into());
                }
                (agent.agent_id, settings)
            }
            None => {
                let Some(settings) = current.agent_settings_by_id.get(&current.agent_id) else {
                    return Ok(None);
                };
                (current.agent_id.clone(), settings.clone())
            }
        };
        let reference = AgentChatReference {
            chat_id: chat_id.into(),
            agent_id,
            agent_session_id: current.agent_session_id.clone(),
            project_path: current.project_path.clone(),
            model: current.model.clone(),
            native_session: current.native_session.clone(),
            carry_over_revision: carry_over_revision(
                &current.carry_over_segments,
                current.carry_over_migration_quarantine.as_ref(),
            ),
            native_seed_receipt: current.native_seed_receipt.clone(),
            settings,
        };
        Ok(Some(ReleaseReference::from_chat(
            reference,
            current.executor_id.clone(),
            connected,
        )?))
    }

    fn require_handoff(
        &self,
        id: &str,
    ) -> Result<(Rc<StoredIntent>, AgentHandoffIntent), BoxError> {
        self.current
            .borrow()
            .intents
            .iter()
            .find_map(|stored| match &stored.value {
                OwnershipIntent::Handoff(intent) if intent.operation_id == id => {
                    Some((stored.clone(), intent.as_ref().clone()))
                }
                _ => None,
            })
            .ok_or_else(|| format!("Agent handoff intent not found: {id}").into())
    }

    async fn replace_intent(&self, intent: StoredIntent) -> Result<(), BoxError> {
        let intent = Rc::new(intent);
        self.mutate(None, |current| {
            let mut candidate = current.clone();
            for stored in &mut candidate.intents {
                if stored.value.operation_id() == intent.value.operation_id() {
                    *stored = intent.clone();
                }
            }
            Ok((Some(candidate), ()))
        })
        .await
    }

    async fn remove_intent(&self, id: &str) -> Result<(), BoxError> {
        self.mutate(None, |current| {
            let mut candidate = current.clone();
            candidate
                .intents
                .retain(|intent| intent.value.operation_id() != id);
            Ok((Some(candidate), ()))
        })
        .await?;
        self.completed_ledger_deletes.borrow_mut().remove(id);
        Ok(())
    }

    async fn mutate<T>(
        &self,
        inherited_executor: Option<&str>,
        edit: impl FnOnce(
            &AgentOwnershipJournalFileV5,
        ) -> Result<(Option<AgentOwnershipJournalFileV5>, T), BoxError>,
    ) -> Result<T, BoxError> {
        let _lock = self.mutation_lock.lock().await;
        let current = self.current.borrow().clone();
        let (candidate, result) = edit(&current)?;
        let Some(candidate) = candidate else {
            return Ok(result);
        };
        let executors = executor_ids(&candidate);
        let _executors = if let Some(retain) = &self.options.retain_executor_references {
            let mut inherited = executor_ids(&current);
            inherited.extend(inherited_executor.map(str::to_owned));
            Some(retain(&executors, &inherited)?)
        } else {
            None
        };
        let _providers = self
            .options
            .retain_provider_references
            .as_ref()
            .map(|retain| retain(&provider_ids(&candidate), &provider_ids(&current)))
            .transpose()?;
        let mut delay = 25;
        let mut attempt = 0_u64;
        let mut ambiguous = false;
        loop {
            match self.options.writer.write(&self.path, &candidate).await {
                Ok(()) => break,
                Err(error) => {
                    ambiguous |= error.renamed;
                    if !ambiguous {
                        return Err(Box::new(error));
                    }
                    // Neither rollback nor ownership publication is safe until this exact candidate is durable.
                    self.unconfirmed_executors
                        .borrow_mut()
                        .extend(executors.iter().cloned());
                    attempt = attempt.saturating_add(1);
                    warn(&format!(
                        "Retrying an unconfirmed ownership decision: attempt={attempt}"
                    ));
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    delay = (delay * 2).min(1000);
                }
            }
        }
        self.current.replace(candidate);
        self.unconfirmed_executors.borrow_mut().clear();
        Ok(result)
    }

    fn now(&self) -> Result<String, garcon_js::InvalidTimeValue> {
        to_iso_string(self.options.clock.now_ms())
    }
}

async fn load(path: &Path) -> Result<AgentOwnershipJournalFileV5, BoxError> {
    let raw = match tokio::fs::read(path).await {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(empty_ownership_journal_v5());
        }
        Err(error) => return Err(error.into()),
    };
    let parsed = parse_stored_json(&String::from_utf8_lossy(&raw), FILE)?;
    if let Some(journal) = parse_v5(&parsed) {
        return Ok(journal);
    }
    if is_empty_earlier_journal(&parsed) {
        return Ok(empty_ownership_journal_v5());
    }
    Err("Invalid agent ownership journal".into())
}

fn intent_executors(intent: &OwnershipIntent) -> Vec<&str> {
    match intent {
        OwnershipIntent::Handoff(intent) => vec![
            effective_executor(intent.source.executor_id.as_deref()),
            effective_executor(intent.target.execution.executor_id.as_deref()),
        ],
        OwnershipIntent::Delete(intent) => intent
            .release_references
            .iter()
            .map(|reference| effective_executor(reference.executor_id.as_deref()))
            .collect(),
    }
}

fn executor_ids(journal: &AgentOwnershipJournalFileV5) -> Vec<ExecutorId> {
    journal
        .intents
        .iter()
        .flat_map(|intent| intent_executors(&intent.value))
        .map(str::to_owned)
        .collect()
}

fn provider_ids(journal: &AgentOwnershipJournalFileV5) -> Vec<String> {
    journal
        .intents
        .iter()
        .filter_map(|stored| match &stored.value {
            OwnershipIntent::Handoff(intent) => intent
                .target
                .execution
                .api_provider_id
                .as_ref()
                .filter(|id| !id.is_empty())
                .cloned(),
            OwnershipIntent::Delete(_) => None,
        })
        .collect()
}

fn effective_executor(executor_id: Option<&str>) -> &str {
    executor_id.unwrap_or(LOCAL_EXECUTOR_ID)
}

fn same_handoff_decision(left: &StoredIntent, right: &StoredIntent) -> bool {
    let (OwnershipIntent::Handoff(a), OwnershipIntent::Handoff(b)) = (&left.value, &right.value)
    else {
        return false;
    };
    a.client_request_id == b.client_request_id
        && a.submitted_target_hash == b.submitted_target_hash
        && a.chat_id == b.chat_id
        && a.source.agent_id == b.source.agent_id
        && effective_executor(a.source.executor_id.as_deref())
            == effective_executor(b.source.executor_id.as_deref())
        && a.source.agent_ownership_epoch == b.source.agent_ownership_epoch
        && a.target.agent_ownership_epoch == b.target.agent_ownership_epoch
        && stringify(left.target_execution_wire()) == stringify(right.target_execution_wire())
        && a.watermark == b.watermark
}

fn matches_handoff_source(current: &ChatRegistryEntry, intent: &AgentHandoffIntent) -> bool {
    current.agent_id == intent.source.agent_id
        && effective_executor(current.executor_id.as_deref())
            == effective_executor(intent.source.executor_id.as_deref())
        && current.agent_ownership_epoch == intent.source.agent_ownership_epoch
}

pub fn matches_handoff_target(
    current: Option<&ChatRegistryEntry>,
    intent: &AgentHandoffIntent,
) -> bool {
    let execution = &intent.target.execution;
    current.is_some_and(|current| {
        current.agent_id == execution.agent_id
            && effective_executor(current.executor_id.as_deref())
                == effective_executor(execution.executor_id.as_deref())
            && execution
                .project_path
                .as_ref()
                .is_none_or(|path| current.project_path == *path)
            && current.agent_ownership_epoch == intent.target.agent_ownership_epoch
    })
}

fn assert_available(
    journal: &AgentOwnershipJournalFileV5,
    chat_id: &str,
    code: ErrorCode,
) -> Result<(), DomainError> {
    if journal
        .intents
        .iter()
        .any(|intent| intent.value.chat_id() == chat_id)
    {
        return Err(DomainError::new(
            code,
            format!("Agent ownership change is pending for {chat_id}."),
            409,
            true,
        ));
    }
    Ok(())
}

fn warn(message: &str) {
    create_logger("chats:ownership-journal").warn(message);
}
