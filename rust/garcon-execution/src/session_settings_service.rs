//! Serializes provider settings confirmation with durable chat selection and queue admission.

use std::{
    error::Error,
    rc::Rc,
    task::{Context, Poll, Waker},
};

use async_trait::async_trait;
use garcon_base::{
    domain_error::DomainError,
    interactive_deadline::{interactive_deadline, read_before},
    keyed_lock::KeyedLock,
    unhandled_rejection_policy::UnhandledRejectionPolicy,
};
use garcon_chats::{
    registry_contracts::ChatRegistryEntry,
    store::{ChatRegistry, ChatRegistryPatch},
};
use garcon_contract::{
    agent_execution::AgentEndpointSelection,
    agent_integration::AgentSettingsEnvelope,
    chat_modes::{PermissionMode, ThinkingMode},
    error_codes::ErrorCode,
    execution_defaults::{is_thinking_mode_supported, normalize_supported_thinking_mode},
};
use garcon_interface::{
    execution::{
        AgentConfigurationValidation, AgentSessionConfiguration, AgentSessionConfigurationUpdate,
        AgentSessionConfigurationUpdates,
    },
    resources::ExecutorCallOptions,
    services::{AgentEndpoints, AgentSettings},
};
use garcon_stores::api_providers::endpoint_resolver::{
    ApiProviderEndpointResolver, ModelSelectionInput, PreviousModelSelectionInput,
    ResolvedModelSelection, assert_same_api_provider_boundary,
};
use serde_json::Value;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::{
    chat_execution_coordinator::ChatExecutionCoordinator,
    control_state::{StoredChatExecutionControlState, has_pending_turn_input},
    directory::AgentDirectory,
    execution_planning::to_agent_endpoint_selection,
    session_types::AgentSessionSettingsPatch,
    types::{
        ChatExecutionCommands, ExecutionOperationResult, LocalExecutionFuture,
        TranscriptSnapshotReservation, execution_error_input,
    },
};

#[derive(Debug, Clone)]
pub struct AgentConfigurationInput {
    pub executor_id: Option<String>,
    pub agent_id: String,
    pub model: String,
    pub api_provider_id: Option<String>,
    pub model_endpoint_id: Option<String>,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub agent_settings: AgentSettingsEnvelope,
}

pub trait SettingsEndpointResolver {
    fn resolve_selection(
        &self,
        input: ModelSelectionInput<'_>,
    ) -> ExecutionOperationResult<ResolvedModelSelection>;
    fn describe_previous(
        &self,
        input: PreviousModelSelectionInput<'_>,
    ) -> ExecutionOperationResult<ResolvedModelSelection>;
    fn to_agent_endpoint_selection(
        &self,
        selection: &ResolvedModelSelection,
    ) -> ExecutionOperationResult<Option<AgentEndpointSelection>>;
    fn assert_endpoint_reference(
        &self,
        selection: &ResolvedModelSelection,
    ) -> ExecutionOperationResult<()>;
}

impl SettingsEndpointResolver for ApiProviderEndpointResolver {
    fn resolve_selection(
        &self,
        input: ModelSelectionInput<'_>,
    ) -> ExecutionOperationResult<ResolvedModelSelection> {
        ApiProviderEndpointResolver::resolve_selection(self, input)
    }

    fn describe_previous(
        &self,
        input: PreviousModelSelectionInput<'_>,
    ) -> ExecutionOperationResult<ResolvedModelSelection> {
        ApiProviderEndpointResolver::describe_previous(self, input)
    }

    fn to_agent_endpoint_selection(
        &self,
        selection: &ResolvedModelSelection,
    ) -> ExecutionOperationResult<Option<AgentEndpointSelection>> {
        to_agent_endpoint_selection(self, selection)
    }

    fn assert_endpoint_reference(
        &self,
        selection: &ResolvedModelSelection,
    ) -> ExecutionOperationResult<()> {
        self.resolve_endpoint_reference(selection).map(drop)
    }
}

#[async_trait(?Send)]
pub trait SettingsChatRegistry {
    fn get_chat(&self, chat_id: &str) -> Option<ChatRegistryEntry>;
    async fn update_chat_flushed(
        self: Rc<Self>,
        chat_id: &str,
        patch: ChatRegistryPatch,
    ) -> ExecutionOperationResult<Option<ChatRegistryEntry>>;
}

#[async_trait(?Send)]
impl SettingsChatRegistry for ChatRegistry {
    fn get_chat(&self, chat_id: &str) -> Option<ChatRegistryEntry> {
        ChatRegistry::get_chat(self, chat_id)
    }

    async fn update_chat_flushed(
        self: Rc<Self>,
        chat_id: &str,
        patch: ChatRegistryPatch,
    ) -> ExecutionOperationResult<Option<ChatRegistryEntry>> {
        Ok(ChatRegistry::update_chat_flushed(&self, chat_id, patch)
            .await?
            .map(|updated| updated.entry))
    }
}

pub struct SettingsIntegration {
    pub literal_execution: bool,
    pub supported_thinking_modes: Vec<ThinkingMode>,
    pub endpoints: Option<Rc<dyn AgentEndpoints>>,
    pub configuration_validation: Option<Rc<dyn AgentConfigurationValidation>>,
    pub session_configuration: Option<Rc<dyn AgentSessionConfigurationUpdates>>,
    pub settings: Rc<dyn AgentSettings>,
}

pub trait SettingsIntegrationDirectory {
    fn require_settings_integration(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<SettingsIntegration>;
}

impl SettingsIntegrationDirectory for AgentDirectory {
    fn require_settings_integration(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<SettingsIntegration> {
        let integration = self.require(agent_id, executor_id)?;
        Ok(SettingsIntegration {
            literal_execution: integration.literal_execution.is_some(),
            supported_thinking_modes: integration.descriptor.supported_thinking_modes.clone(),
            endpoints: integration.endpoints.clone(),
            configuration_validation: integration.configuration_validation.clone(),
            session_configuration: integration.session_configuration.clone(),
            settings: integration.settings.clone(),
        })
    }
}

pub type SettingsControlOperation<'a> = Box<
    dyn FnOnce(StoredChatExecutionControlState) -> LocalExecutionFuture<'a, ChatRegistryEntry> + 'a,
>;

#[async_trait(?Send)]
pub trait SettingsExecutionPort {
    fn owns_execution(&self, chat_id: &str) -> bool;
    fn reserve_transcript_snapshot(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<TranscriptSnapshotReservation>;
    async fn release_transcript_snapshot(
        &self,
        reservation: &TranscriptSnapshotReservation,
    ) -> ExecutionOperationResult<()>;
    async fn read_chat_execution_control(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState>;
    fn with_chat_execution_control<'a>(
        &'a self,
        chat_id: &'a str,
        operation: SettingsControlOperation<'a>,
    ) -> LocalExecutionFuture<'a, ChatRegistryEntry>;
}

#[async_trait(?Send)]
impl SettingsExecutionPort for ChatExecutionCoordinator {
    fn owns_execution(&self, chat_id: &str) -> bool {
        ChatExecutionCommands::owns_execution(self, chat_id)
    }

    fn reserve_transcript_snapshot(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<TranscriptSnapshotReservation> {
        ChatExecutionCommands::reserve_transcript_snapshot(self, chat_id)
    }

    async fn release_transcript_snapshot(
        &self,
        reservation: &TranscriptSnapshotReservation,
    ) -> ExecutionOperationResult<()> {
        ChatExecutionCommands::release_transcript_snapshot(self, reservation).await
    }

    async fn read_chat_execution_control(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        ChatExecutionCommands::read_chat_execution_control(self, chat_id).await
    }

    fn with_chat_execution_control<'a>(
        &'a self,
        chat_id: &'a str,
        operation: SettingsControlOperation<'a>,
    ) -> LocalExecutionFuture<'a, ChatRegistryEntry> {
        ChatExecutionCommands::with_chat_execution_control(self, chat_id, operation)
    }
}

pub type SettingsCommitCallback = dyn Fn(&str) -> ExecutionOperationResult<()>;

pub struct AgentSessionSettingsServiceOptions {
    pub registry: Rc<dyn SettingsChatRegistry>,
    pub directory: Rc<dyn SettingsIntegrationDirectory>,
    pub endpoint_resolver: Rc<dyn SettingsEndpointResolver>,
    pub get_execution: Rc<dyn Fn() -> Rc<dyn SettingsExecutionPort>>,
    pub has_admitted_provider_turn: Rc<dyn Fn(&str) -> bool>,
    pub chat_mutation_lock: Rc<KeyedLock>,
    pub selection_admission_lock: Rc<KeyedLock>,
    pub on_committed: Option<Rc<SettingsCommitCallback>>,
    pub unhandled_rejections: Rc<UnhandledRejectionPolicy>,
}

pub struct AgentSessionSettingsService {
    options: AgentSessionSettingsServiceOptions,
    deadline: Box<dyn Fn() -> f64>,
}

struct PreparedUpdate<'a> {
    chat_id: &'a str,
    entry: ChatRegistryEntry,
    integration: SettingsIntegration,
    previous: ResolvedModelSelection,
    next: ResolvedModelSelection,
    patch: AgentSessionSettingsPatch,
    deadline: f64,
    signal: Option<CancellationToken>,
}

impl AgentSessionSettingsService {
    pub fn new(options: AgentSessionSettingsServiceOptions) -> Self {
        Self::with_deadline(options, interactive_deadline)
    }

    pub fn with_deadline(
        options: AgentSessionSettingsServiceOptions,
        deadline: impl Fn() -> f64 + 'static,
    ) -> Self {
        Self {
            options,
            deadline: Box::new(deadline),
        }
    }

    pub async fn validate_configuration(
        &self,
        input: AgentConfigurationInput,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutionOperationResult<()> {
        let integration = self
            .options
            .directory
            .require_settings_integration(&input.agent_id, input.executor_id.as_deref())?;
        let resolved = self
            .options
            .endpoint_resolver
            .resolve_selection(ModelSelectionInput {
                executor_id: input.executor_id.as_deref(),
                agent_id: Some(&input.agent_id),
                model: &input.model,
                api_provider_id: input.api_provider_id.as_deref(),
                model_endpoint_id: input.model_endpoint_id.as_deref(),
            })?;
        if let Some(validation) = integration.configuration_validation.as_ref() {
            let configuration = AgentSessionConfiguration {
                model: resolved.model.clone(),
                permission_mode: input.permission_mode,
                thinking_mode: supported_thinking(input.thinking_mode, &integration),
                settings: integration.settings.parse(input.agent_settings)?,
                endpoint: self
                    .options
                    .endpoint_resolver
                    .to_agent_endpoint_selection(&resolved)?,
            };
            validation.validate(configuration, options).await?;
        }
        Ok(())
    }

    pub async fn update_session_settings(
        self: &Rc<Self>,
        chat_id: &str,
        patch: AgentSessionSettingsPatch,
        expected_agent_ownership_epoch: Option<&str>,
        signal: Option<CancellationToken>,
    ) -> ExecutionOperationResult<ChatRegistryEntry> {
        // The reconnect budget begins before the request queues for the mutation lock.
        let deadline = (self.deadline)();
        let service = self.clone();
        let chat_id = chat_id.to_owned();
        let epoch = expected_agent_ownership_epoch.map(str::to_owned);
        let mut operation = Box::pin(async move {
            service
                .options
                .chat_mutation_lock
                .run_exclusive(
                    &format!("chat:{chat_id}"),
                    || service.update_locked(&chat_id, patch, epoch.as_deref(), signal, deadline),
                    None,
                )
                .await?
        });
        if let Poll::Ready(result) = operation
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            return result;
        }
        // An abandoned waiter cannot release either lock before persistence and cleanup settle.
        let policy = self.options.unhandled_rejections.clone();
        let (done, wait) = oneshot::channel();
        tokio::task::spawn_local(async move {
            if let Err(Err(error)) = done.send(operation.await) {
                policy.report(execution_error_input(error.as_ref()));
            }
        });
        wait.await?
    }

    async fn update_locked(
        &self,
        chat_id: &str,
        patch: AgentSessionSettingsPatch,
        epoch: Option<&str>,
        signal: Option<CancellationToken>,
        deadline: f64,
    ) -> ExecutionOperationResult<ChatRegistryEntry> {
        let entry = self
            .options
            .registry
            .get_chat(chat_id)
            .ok_or_else(|| missing_chat(chat_id))?;
        if epoch.is_some_and(|expected| expected != entry.agent_ownership_epoch) {
            return Err(DomainError::new(
                ErrorCode::STALE_CHAT_OWNERSHIP,
                "Chat ownership changed before settings were updated.",
                409,
                false,
            )
            .into());
        }
        let integration = self
            .options
            .directory
            .require_settings_integration(&entry.agent_id, entry.executor_id.as_deref())?;
        let resolver = &self.options.endpoint_resolver;
        let previous = resolver.describe_previous(PreviousModelSelectionInput {
            model: &entry.model,
            api_provider_id: entry.api_provider_id.as_deref(),
            model_endpoint_id: entry.model_endpoint_id.as_deref(),
        })?;
        let next = resolver.resolve_selection(ModelSelectionInput {
            executor_id: entry.executor_id.as_deref(),
            agent_id: Some(&entry.agent_id),
            model: patch.model.as_deref().unwrap_or(&entry.model),
            api_provider_id: if patch.api_provider_id.is_absent() {
                entry.api_provider_id.as_deref()
            } else {
                patch.api_provider_id.as_deref()
            },
            model_endpoint_id: if patch.model_endpoint_id.is_absent() {
                entry.model_endpoint_id.as_deref()
            } else {
                patch.model_endpoint_id.as_deref()
            },
        })?;
        let reservation = if integration.literal_execution && previous.model != next.model {
            Some((self.options.get_execution)().reserve_transcript_snapshot(chat_id)?)
        } else {
            None
        };
        let update = PreparedUpdate {
            chat_id,
            entry,
            integration,
            previous,
            next,
            patch,
            deadline,
            signal,
        };
        let result = self.apply_update(reservation.as_ref(), update).await;
        if let Some(reservation) = reservation {
            (self.options.get_execution)()
                .release_transcript_snapshot(&reservation)
                .await?;
        }
        result
    }

    async fn apply_update(
        &self,
        reservation: Option<&TranscriptSnapshotReservation>,
        update: PreparedUpdate<'_>,
    ) -> ExecutionOperationResult<ChatRegistryEntry> {
        let PreparedUpdate {
            chat_id,
            entry,
            integration,
            previous,
            next,
            patch,
            deadline,
            signal,
        } = update;
        if reservation.is_some() {
            let control = (self.options.get_execution)()
                .read_chat_execution_control(chat_id)
                .await?;
            assert_empty_queue(&control)?;
        }
        let resolver = &self.options.endpoint_resolver;
        let endpoint = resolver.to_agent_endpoint_selection(&next)?;
        if let Some(endpoint) = endpoint.as_ref() {
            let endpoints = integration.endpoints.as_ref().ok_or_else(|| {
                std::io::Error::other(format!(
                    "Agent integration {} does not accept API provider endpoints",
                    entry.agent_id
                ))
            })?;
            endpoints
                .validate(
                    endpoint.clone(),
                    Some(read_before(Some(deadline), signal.clone())),
                )
                .await?;
        }
        assert_same_api_provider_boundary(&previous, &next)?;
        let permission_mode = patch.permission_mode.unwrap_or(entry.permission_mode);
        if let Some(mode) = patch.thinking_mode
            && !is_thinking_mode_supported(mode, &integration.supported_thinking_modes)
        {
            return Err(DomainError::new(
                ErrorCode::VALIDATION_FAILED,
                format!(
                    "Thinking mode {} is not supported by {}",
                    mode.as_str(),
                    entry.agent_id
                ),
                422,
                false,
            )
            .into());
        }
        let thinking_mode = supported_thinking(
            patch.thinking_mode.unwrap_or(entry.thinking_mode),
            &integration,
        );
        let current_settings = match entry.agent_settings_by_id.get(&entry.agent_id) {
            Some(settings) => settings.clone(),
            None => integration.settings.defaults()?,
        };
        let current_settings = integration.settings.parse(current_settings)?;
        let settings = match patch.agent_settings_patch {
            Some(patch) => integration
                .settings
                .apply_patch(current_settings.clone(), patch)?,
            None => current_settings.clone(),
        };
        let configuration = AgentSessionConfiguration {
            model: next.model.clone(),
            permission_mode,
            thinking_mode,
            settings,
            endpoint,
        };
        if let Some(validation) = integration.configuration_validation.as_ref() {
            validation
                .validate(
                    configuration.clone(),
                    Some(read_before(Some(deadline), signal)),
                )
                .await?;
        }
        resolver.assert_endpoint_reference(&next)?;

        let apply_and_persist = || async move {
            let session_id = self
                .options
                .registry
                .get_chat(chat_id)
                .and_then(|entry| entry.agent_session_id)
                .filter(|session| !session.is_empty());
            let permission_mode_explicit = patch.permission_mode.is_some();
            if let Some(session_configuration) = integration.session_configuration.as_ref() {
                if permission_mode_explicit
                    && (self.options.get_execution)().owns_execution(chat_id)
                    && (session_id.is_none() || !(self.options.has_admitted_provider_turn)(chat_id))
                {
                    return Err(DomainError::new(
                        ErrorCode::SESSION_BUSY,
                        "The provider has not admitted this turn. Retry the permission change after it starts.",
                        409, true,
                    ).into());
                }
                if let Some(session_id) = session_id.as_deref() {
                    let previous = AgentSessionConfiguration {
                        model: previous.model,
                        permission_mode: entry.permission_mode,
                        thinking_mode: supported_thinking(entry.thinking_mode, &integration),
                        settings: current_settings,
                        endpoint: previous.endpoint,
                    };
                    session_configuration
                        .apply(
                            session_id,
                            AgentSessionConfigurationUpdate {
                                configuration: configuration.clone(),
                                permission_mode_explicit,
                            },
                            previous,
                            Some(ExecutorCallOptions {
                                dispatch_deadline: Some(deadline),
                                ..Default::default()
                            }),
                        )
                        .await?;
                }
            }
            let mut settings_by_id = entry.agent_settings_by_id;
            settings_by_id.insert(entry.agent_id, configuration.settings);
            let updated = self
                .options
                .registry
                .clone()
                .update_chat_flushed(
                    chat_id,
                    ChatRegistryPatch {
                        model: Some(configuration.model),
                        api_provider_id: Some(next.api_provider_id),
                        model_endpoint_id: Some(next.endpoint_id),
                        model_protocol: Some(next.protocol),
                        permission_mode: Some(configuration.permission_mode),
                        thinking_mode: Some(configuration.thinking_mode),
                        agent_settings_by_id: Some(settings_by_id),
                        ..Default::default()
                    },
                )
                .await?
                .ok_or_else(|| missing_chat(chat_id))?;
            if let Some(committed) = &self.options.on_committed {
                committed(chat_id)?;
            }
            Ok(updated)
        };
        // Dequeue must not observe a changed native setting before its durable selection.
        self.options
            .selection_admission_lock
            .run_exclusive(
                &format!("chat:{chat_id}"),
                || async {
                    if reservation.is_none() {
                        return apply_and_persist().await;
                    }
                    let execution = (self.options.get_execution)();
                    execution
                        .with_chat_execution_control(
                            chat_id,
                            Box::new(|control| {
                                Box::pin(async move {
                                    assert_empty_queue(&control)?;
                                    apply_and_persist().await
                                })
                            }),
                        )
                        .await
                },
                None,
            )
            .await?
    }
}

fn missing_chat(chat_id: &str) -> Box<dyn Error> {
    std::io::Error::other(format!("Session not found: {chat_id}")).into()
}

fn supported_thinking(mode: ThinkingMode, integration: &SettingsIntegration) -> ThinkingMode {
    normalize_supported_thinking_mode(
        &Value::String(mode.as_str().into()),
        &integration.supported_thinking_modes,
    )
}

fn assert_empty_queue(control: &StoredChatExecutionControlState) -> ExecutionOperationResult<()> {
    if has_pending_turn_input(control) {
        return Err(DomainError::new(
            ErrorCode::SESSION_BUSY,
            "Cannot change execution mode with queued input.",
            409,
            false,
        )
        .into());
    }
    Ok(())
}
