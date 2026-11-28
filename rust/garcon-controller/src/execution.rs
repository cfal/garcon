//! Composes controller execution on the startup LocalSet. The binary supplies
//! the Local runtime; only the shell calls this module. Required runtime
//! bindings are not substituted by fallbacks while their owners are ported.

use std::{collections::HashSet, future::Future, rc::Rc};

use async_trait::async_trait;
use garcon_base::{
    keyed_lock::KeyedLock,
    log::{Logger, create_logger},
    unhandled_rejection_policy::UnhandledRejectionPolicy,
};
use garcon_chats::{
    agent_ownership_journal::AgentOwnershipJournal,
    registry_contracts::CarryOverSegmentRef,
    store::{ChatRegistry, ReferenceLease, RetainReferences},
};
use garcon_contract::{agents::AgentExecutionPolicy, executors::effective_executor_id};
use garcon_execution::{
    accepted_input_transcript::AcceptedInputTranscriptPort,
    agent_registry::{AgentRegistry, AgentRegistryOptions, RegistryCarryOverRevision},
    chat_execution_control_repository::InMemoryChatExecutionControlRepository,
    chat_execution_coordinator::{
        ChatExecutionCoordinator, ChatExecutionCoordinatorDeps, ChatExecutionCoordinatorHost,
        ChatExecutionCoordinatorOptions,
    },
    command_ledger::{CommandLedger, CommandLedgerOptions},
    control_state::StoredControlInputEntry,
    directory::AgentDirectory,
    executor_availability_wiring::{ExecutorAvailabilityWiring, wire_executor_availability},
    executor_config_guards::executor_config_guards,
    executor_manager::{ExecutorManager, ExecutorManagerOptions, ResolveExecutorCredential},
    queued_steer_delivery::QueuedSteerContent,
    reference_writes::RetainExecutorReferences,
    remote_client::RemoteExecutorClientFactory,
    runtime_router::{
        AgentRuntimeRouterOptions, RoutingChat, RuntimeRouterChats, RuntimeTranscriptLedger,
    },
    session_types::{
        PersistedChatExecutionConfig, RunAgentTurnOptions, require_chat_execution_config,
    },
    turn_terminal_settlement::WorkingDirectorySettlementPort,
    types::{
        AgentTurnRunnerPort, ExecutionOperationResult, ProjectAdmissionPort,
        QueuedAttachmentAdmissionPort,
    },
};
use garcon_interface::execution_runtime::ExecutionRuntimeApi;
use garcon_js::clock::{SystemClock, performance_now_ms};
use garcon_ledger::{
    adoption::TranscriptAdoptionService, service::TranscriptLedgerService,
    store::TranscriptLedgerStore,
};
use garcon_stores::executors::config_store::ExecutorConfigStore;

pub struct ExecutionStartup<'a> {
    pub workspace_dir: &'a str,
    pub server_instance_id: String,
    pub local: Rc<dyn ExecutionRuntimeApi>,
    pub resolve_credential: ResolveExecutorCredential,
    pub unhandled_rejections: Rc<UnhandledRejectionPolicy>,
}

/// Allows the other stores to open with the manager's real executor reference
/// guard, before constructing the registry and coordinator that need those stores.
pub struct ExecutionFoundation {
    pub manager: Rc<ExecutorManager>,
    pub directory: Rc<AgentDirectory>,
    pub retain_executor_references: RetainExecutorReferences,
}

impl ExecutionFoundation {
    pub fn retain_chat_executor_references(&self) -> RetainReferences {
        let retain = self.retain_executor_references.clone();
        Rc::new(move |next, current| {
            let next: Vec<_> = next.iter().map(|id| Some(id.as_str())).collect();
            let current: Vec<_> = current.iter().map(|id| Some(id.as_str())).collect();
            Ok(ReferenceLease::new(retain(&next, &current)?))
        })
    }
}

/// Dispatch and command policy not owned by the coordinator or the stores.
#[async_trait(?Send)]
pub trait ExecutionCommandBindings {
    fn execution_policy(&self, chat_id: &str) -> AgentExecutionPolicy;
    fn append_control_receipt(
        &self,
        chat_id: &str,
        entry: &StoredControlInputEntry,
    ) -> ExecutionOperationResult<()>;
    async fn resolve_steer_content(
        &self,
        input: QueuedSteerContent<'_>,
    ) -> ExecutionOperationResult<String>;
}

pub type BindExecutionRuntime = dyn FnOnce(
    Rc<AgentRegistry>,
    Rc<CommandLedger>,
    Rc<ExecutionAdoption>,
) -> ExecutionOperationResult<ExecutionRuntimeBindings>;

pub type ExecutionAdoption = TranscriptAdoptionService<Vec<CarryOverSegmentRef>>;

pub struct ExecutionBindings {
    pub chats: Rc<ChatRegistry>,
    pub ownership: Rc<AgentOwnershipJournal>,
    pub ledger_store: Rc<TranscriptLedgerStore>,
    pub ledger: Rc<TranscriptLedgerService>,
    pub adoption: Rc<ExecutionAdoption>,
    pub get_carry_over_revision: Rc<RegistryCarryOverRevision>,
    pub bind_runtime: Box<BindExecutionRuntime>,
    pub selection_admission_lock: Rc<KeyedLock>,
    pub publish_executor_processing: Rc<dyn Fn(&str)>,
}

pub struct ExecutionRuntimeBindings {
    pub turn_runner: Rc<dyn AgentTurnRunnerPort>,
    pub input_transcript: Rc<dyn AcceptedInputTranscriptPort>,
    pub commands: Rc<dyn ExecutionCommandBindings>,
    pub project_admission: Rc<dyn ProjectAdmissionPort>,
    pub attachment_admission: Rc<dyn QueuedAttachmentAdmissionPort>,
    pub working_directory_settlement: Rc<dyn WorkingDirectorySettlementPort>,
}

pub struct ExecutionHandles {
    pub manager: Rc<ExecutorManager>,
    pub directory: Rc<AgentDirectory>,
    pub registry: Rc<AgentRegistry>,
    pub coordinator: Rc<ChatExecutionCoordinator>,
    pub command_ledger: Rc<CommandLedger>,
    pub adoption: Rc<ExecutionAdoption>,
    pub retain_executor_references: RetainExecutorReferences,
    subscriptions: Vec<Box<dyn Fn()>>,
}

impl ExecutionHandles {
    /// Stops event delivery before the caller tears down execution and stores.
    pub fn unsubscribe(&mut self) {
        for unsubscribe in self.subscriptions.drain(..).rev() {
            unsubscribe();
        }
    }
}

impl Drop for ExecutionHandles {
    fn drop(&mut self) {
        self.unsubscribe();
    }
}

pub async fn start_execution<Fut>(
    options: ExecutionStartup<'_>,
    bind: impl FnOnce(ExecutionFoundation) -> Fut,
) -> ExecutionOperationResult<ExecutionHandles>
where
    Fut: Future<Output = ExecutionOperationResult<ExecutionBindings>>,
{
    let config = match ExecutorConfigStore::open(options.workspace_dir).await {
        Ok(config) => config,
        Err(error) => {
            dispose_after_failed_start(options.local.as_ref()).await;
            return Err(error);
        }
    };
    let manager = ExecutorManager::start(ExecutorManagerOptions {
        local: options.local,
        config,
        remote_factory: Rc::new(RemoteExecutorClientFactory),
        resolve_credential: options.resolve_credential,
        logger: Rc::new(create_logger("executors")),
    })
    .await?;
    let directory = Rc::new(AgentDirectory::new(manager.clone()));
    let retain_executor_references = manager.retain_references();
    let bindings = bind(ExecutionFoundation {
        manager: manager.clone(),
        directory: directory.clone(),
        retain_executor_references: retain_executor_references.clone(),
    })
    .await;
    let result = bindings.and_then(|bindings| {
        finish_execution(
            options.server_instance_id,
            options.unhandled_rejections,
            manager.clone(),
            directory,
            retain_executor_references,
            bindings,
        )
    });
    if result.is_err()
        && let Err(error) = manager.dispose().await
    {
        create_logger("executors")
            .warn(&format!("Executor disposal after startup failed: {error}"));
    }
    result
}

async fn dispose_after_failed_start(local: &dyn ExecutionRuntimeApi) {
    if let Err(error) = local.dispose().await {
        create_logger("executors").warn(&format!(
            "Local executor disposal after startup failed: {error}"
        ));
    }
}

fn finish_execution(
    server_instance_id: String,
    unhandled_rejections: Rc<UnhandledRejectionPolicy>,
    manager: Rc<ExecutorManager>,
    directory: Rc<AgentDirectory>,
    retain_executor_references: RetainExecutorReferences,
    bindings: ExecutionBindings,
) -> ExecutionOperationResult<ExecutionHandles> {
    let registry = Rc::new(AgentRegistry::new(AgentRegistryOptions {
        runtime: AgentRuntimeRouterOptions {
            registry: Rc::new(RouterChats(bindings.chats.clone())),
            directory: directory.clone(),
            ledger: Rc::new(RuntimeTranscriptLedger(bindings.ledger.clone())),
            unhandled_rejections: unhandled_rejections.clone(),
        },
        directory: directory.clone(),
        get_carry_over_revision: bindings.get_carry_over_revision,
        ownership_transfer_pending: Rc::new({
            let ownership = bindings.ownership.clone();
            move |chat_id| ownership.has_pending(chat_id)
        }),
        logger: Rc::new(create_logger("agents")),
    }));
    let clock = Rc::new(SystemClock);
    let command_ledger = Rc::new(CommandLedger::new(
        CommandLedgerOptions::default(),
        clock.clone(),
    )?);
    let runtime = (bindings.bind_runtime)(
        registry.clone(),
        command_ledger.clone(),
        bindings.adoption.clone(),
    )?;
    let unsubscribe_transcript =
        registry.bind_transcript_commits(&bindings.ledger, command_ledger.clone());
    let coordinator = ChatExecutionCoordinator::new(
        ChatExecutionCoordinatorDeps {
            turn_runner: runtime.turn_runner,
            input_transcript: runtime.input_transcript,
            controls: Rc::new(InMemoryChatExecutionControlRepository::new(
                server_instance_id,
            )),
            get_drain_options: Rc::new({
                let chats = bindings.chats.clone();
                move |chat_id| queue_drain_options(&chats, chat_id)
            }),
            options: ChatExecutionCoordinatorOptions {
                host: Rc::new(CoordinatorHost {
                    chats: bindings.chats.clone(),
                    manager: manager.clone(),
                    ledger: bindings.ledger_store,
                    command_ledger: command_ledger.clone(),
                    commands: runtime.commands,
                }),
                project_admission: runtime.project_admission,
                attachment_admission: runtime.attachment_admission,
                working_directory_settlement: Some(runtime.working_directory_settlement),
                selection_admission_lock: bindings.selection_admission_lock,
                unhandled_rejections,
            },
        },
        clock,
        || uuid::Uuid::new_v4().to_string(),
        performance_now_ms,
    );
    let unsubscribe_terminal = bindings.ledger.subscribe_run_ended_committed(Rc::new({
        let coordinator = Rc::downgrade(&coordinator);
        move |run| {
            if let Some(coordinator) = coordinator.upgrade() {
                coordinator.mark_run_terminal_committed(&run.chat_id, &run.run_id);
            }
            Ok(())
        }
    }));
    manager.set_guards(executor_config_guards(
        bindings.chats.clone(),
        coordinator.clone(),
        bindings.ownership.clone(),
    ));
    let unsubscribe_availability = wire_executor_availability(ExecutorAvailabilityWiring {
        executors: manager.clone(),
        sessions: registry.clone(),
        chats: bindings.chats,
        ownership: bindings.ownership,
        queue: coordinator.clone(),
        publish_processing: bindings.publish_executor_processing,
        logger: Rc::new(create_logger("server-events")),
    });
    Ok(ExecutionHandles {
        manager,
        directory,
        registry,
        coordinator,
        command_ledger,
        adoption: bindings.adoption,
        retain_executor_references,
        subscriptions: vec![
            unsubscribe_transcript,
            unsubscribe_terminal,
            unsubscribe_availability,
        ],
    })
}

struct RouterChats(Rc<ChatRegistry>);

impl RuntimeRouterChats for RouterChats {
    fn get_chat(&self, chat_id: &str) -> Option<RoutingChat> {
        let chat = self.0.get_chat(chat_id)?;
        Some(RoutingChat {
            agent_id: chat.agent_id,
            agent_session_id: chat.agent_session_id,
            native_session: chat.native_session,
            execution: PersistedChatExecutionConfig {
                executor_id: chat.executor_id,
                project_path: Some(chat.project_path),
                model: Some(chat.model),
                permission_mode: Some(chat.permission_mode.as_str().into()),
                thinking_mode: Some(chat.thinking_mode.as_str().into()),
                agent_settings_by_id: Some(chat.agent_settings_by_id),
            },
        })
    }
}

struct CoordinatorHost {
    chats: Rc<ChatRegistry>,
    manager: Rc<ExecutorManager>,
    ledger: Rc<TranscriptLedgerStore>,
    command_ledger: Rc<CommandLedger>,
    commands: Rc<dyn ExecutionCommandBindings>,
}

#[async_trait(?Send)]
impl ChatExecutionCoordinatorHost for CoordinatorHost {
    fn chat_exists(&self, chat_id: &str) -> bool {
        self.chats.has_chat(chat_id)
    }

    fn can_dispatch(&self, chat_id: &str) -> bool {
        let chat = self.chats.get_chat(chat_id);
        self.manager.is_ready(&effective_executor_id(
            chat.as_ref().and_then(|chat| chat.executor_id.as_deref()),
        ))
    }

    fn is_control_input_view_current(
        &self,
        chat_id: &str,
        view_id: &str,
    ) -> ExecutionOperationResult<bool> {
        Ok(self.chats.has_chat(chat_id)
            && self
                .ledger
                .existing_current_view(chat_id)?
                .is_some_and(|view| view.view_id.as_str() == view_id))
    }

    fn execution_policy(&self, chat_id: &str) -> AgentExecutionPolicy {
        self.commands.execution_policy(chat_id)
    }

    fn unsettled_queue_receipt_keys(&self, chat_id: &str) -> HashSet<String> {
        self.command_ledger
            .unsettled_queue_receipt_keys(chat_id)
            .into_iter()
            .collect()
    }

    fn append_control_receipt(
        &self,
        chat_id: &str,
        entry: &StoredControlInputEntry,
    ) -> ExecutionOperationResult<()> {
        self.commands.append_control_receipt(chat_id, entry)
    }

    async fn resolve_steer_content(
        &self,
        input: QueuedSteerContent<'_>,
    ) -> ExecutionOperationResult<String> {
        self.commands.resolve_steer_content(input).await
    }
}

fn queue_drain_options(
    chats: &ChatRegistry,
    chat_id: &str,
) -> ExecutionOperationResult<RunAgentTurnOptions> {
    let chat = chats.get_chat(chat_id);
    let config = chat.as_ref().map(|chat| PersistedChatExecutionConfig {
        executor_id: chat.executor_id.clone(),
        project_path: Some(chat.project_path.clone()),
        model: Some(chat.model.clone()),
        permission_mode: Some(chat.permission_mode.as_str().into()),
        thinking_mode: Some(chat.thinking_mode.as_str().into()),
        agent_settings_by_id: Some(chat.agent_settings_by_id.clone()),
    });
    let entry = require_chat_execution_config(chat_id, config.as_ref())?;
    // INFALLIBLE: requiring the projected config succeeded only for an existing chat.
    let chat = chat.expect("required config belongs to a chat");
    Ok(RunAgentTurnOptions {
        permission_mode: Some(entry.permission_mode),
        thinking_mode: Some(entry.thinking_mode),
        agent_settings: entry.agent_settings_by_id.get(&chat.agent_id).cloned(),
        model: Some(entry.model),
        api_provider_id: chat.api_provider_id.into(),
        model_endpoint_id: chat.model_endpoint_id.into(),
        model_protocol: chat.model_protocol.into(),
        ..Default::default()
    })
}
