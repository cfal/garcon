use std::{cell::OnceCell, path::Path, rc::Rc};

use async_trait::async_trait;
use futures::future::LocalBoxFuture;
use garcon_base::{
    keyed_lock::KeyedLock, log::create_logger,
    unhandled_rejection_policy::install_unhandled_rejection_policy,
};
use garcon_chats::agent_ownership_journal::{
    AgentOwnershipJournal, OwnershipAgent, OwnershipAgentDirectory, OwnershipJournalOptions,
    OwnershipLedger,
};
use garcon_chats::{
    registry_contracts::CarryOverSegmentRef,
    store::{ChatRegistry, ChatRegistryOptions},
};
use garcon_contract::{
    agents::AgentExecutionPolicy,
    chat_types::{ChatMessage, UserMessage},
    ws_requests::AgentCommandImage,
};
use garcon_controller::execution::{
    ExecutionAdoption, ExecutionBindings, ExecutionCommandBindings, ExecutionFoundation,
    ExecutionRuntimeBindings, ExecutionStartup, start_execution,
};
use garcon_execution::{
    accepted_input_transcript::{
        AcceptedInputTranscriptPort, AcceptedInputTranscriptResult, IdentifiedUserInput,
    },
    agent_registry::AdoptionChatRegistry,
    control_state::StoredControlInputEntry,
    queued_steer_delivery::QueuedSteerContent,
    session_types::{AgentSteerOptions, RunAgentTurnOptions},
    turn_terminal_settlement::{
        TurnEventMetadata, WorkingDirectorySettlement, WorkingDirectorySettlementPort,
    },
    types::{
        AgentTurnRunnerPort, ExecutionOperationResult, PrepareSteerDelivery, ProjectAdmissionPort,
        QueuedAttachmentAdmissionPort, UserInputAdmissionOptions,
    },
};
use garcon_executor::{Executor, ExecutorOptions};
use garcon_interface::{
    execution_runtime::{ExecutionRuntimeApi, ExecutorAvailability},
    services::{AgentSteerResult, AgentSteerTarget},
};
use garcon_ledger::{
    adoption::{CarryoverQuarantine, TranscriptAdoptionOptions, TranscriptFrozenHistory},
    service::TranscriptLedgerService,
    sqlite_operations::LedgerResult,
    store::TranscriptLedgerStore,
};
use serde_json::json;
use tokio::task::LocalSet;
use tokio_util::sync::CancellationToken;

fn unexpected<T>() -> ExecutionOperationResult<T> {
    Err("unexpected fixture operation".into())
}

fn local_executor(project: &str) -> Executor {
    Executor::start(ExecutorOptions {
        executor_id: "local".into(),
        project_base_path: project.into(),
        terminal_runtime_id: None,
        user_shell: None,
        child_environment: None,
        integrations: None,
    })
    .unwrap()
}

struct Idle;

impl TranscriptFrozenHistory<Vec<CarryOverSegmentRef>> for Idle {
    fn revision(&self, _: &Vec<CarryOverSegmentRef>, _: Option<&CarryoverQuarantine>) -> String {
        "synthetic".into()
    }
    fn load_all<'a>(
        &'a self,
        _: &'a Vec<CarryOverSegmentRef>,
        _: CancellationToken,
    ) -> LocalBoxFuture<'a, LedgerResult<Vec<ChatMessage>>> {
        Box::pin(async { unexpected() })
    }
}

impl OwnershipAgentDirectory for Idle {
    fn get(&self, _: &str, _: Option<&str>) -> Option<OwnershipAgent> {
        None
    }
}

#[async_trait(?Send)]
impl OwnershipLedger for Idle {
    async fn delete_chat(&self, _: &str) -> ExecutionOperationResult<()> {
        unexpected()
    }
}

#[async_trait(?Send)]
impl AgentTurnRunnerPort for Idle {
    async fn run_agent_turn(
        &self,
        _: &str,
        _: &str,
        _: RunAgentTurnOptions,
    ) -> ExecutionOperationResult<()> {
        unexpected()
    }
    async fn capture_steer_target(
        &self,
        _: &str,
        _: Option<f64>,
    ) -> ExecutionOperationResult<Option<AgentSteerTarget>> {
        unexpected()
    }
    async fn steer_input(
        &self,
        _: &str,
        _: &str,
        _: &AgentSteerOptions,
        _: Option<&AgentSteerTarget>,
        _: PrepareSteerDelivery<'_>,
        _: Option<f64>,
    ) -> ExecutionOperationResult<AgentSteerResult> {
        unexpected()
    }
    async fn abort_session(&self, _: &str) -> ExecutionOperationResult<bool> {
        unexpected()
    }
    fn is_chat_running(&self, _: &str) -> bool {
        false
    }
}

#[async_trait(?Send)]
impl AcceptedInputTranscriptPort for Idle {
    fn has_matching_input(
        &self,
        _: &str,
        _: &UserMessage,
        _: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool> {
        unexpected()
    }
    async fn admit_input(
        &self,
        _: &str,
        _: UserMessage,
        _: IdentifiedUserInput<'_>,
    ) -> ExecutionOperationResult<AcceptedInputTranscriptResult> {
        unexpected()
    }
    fn admit_queued_input(
        &self,
        _: &str,
        _: UserMessage,
        _: IdentifiedUserInput<'_>,
    ) -> ExecutionOperationResult<AcceptedInputTranscriptResult> {
        unexpected()
    }
    fn discard_prepared_input(&self, _: &str, _: Option<&str>) -> ExecutionOperationResult<()> {
        unexpected()
    }
}

#[async_trait(?Send)]
impl ExecutionCommandBindings for Idle {
    fn execution_policy(&self, _: &str) -> AgentExecutionPolicy {
        AgentExecutionPolicy::Conversation
    }
    fn append_control_receipt(
        &self,
        _: &str,
        _: &StoredControlInputEntry,
    ) -> ExecutionOperationResult<()> {
        unexpected()
    }
    async fn resolve_steer_content(
        &self,
        _: QueuedSteerContent<'_>,
    ) -> ExecutionOperationResult<String> {
        unexpected()
    }
}

#[async_trait(?Send)]
impl ProjectAdmissionPort for Idle {
    async fn assert_available(&self, _: &str, _: Option<f64>) -> ExecutionOperationResult<()> {
        unexpected()
    }
}

impl QueuedAttachmentAdmissionPort for Idle {
    fn assert_supported(&self, _: &str, _: &[AgentCommandImage]) -> ExecutionOperationResult<()> {
        unexpected()
    }
}

#[async_trait(?Send)]
impl WorkingDirectorySettlementPort for Idle {
    async fn settle(
        &self,
        _: &str,
        _: &TurnEventMetadata,
        _: &dyn Fn() -> bool,
    ) -> ExecutionOperationResult<WorkingDirectorySettlement> {
        unexpected()
    }
}

fn options(workspace_dir: &str, local: Rc<dyn ExecutionRuntimeApi>) -> ExecutionStartup<'_> {
    ExecutionStartup {
        workspace_dir,
        server_instance_id: "process-instance".into(),
        local,
        resolve_credential: Rc::new(|_, _, _| Box::pin(async { unexpected() })),
        unhandled_rejections: Rc::new(install_unhandled_rejection_policy(Rc::new(create_logger(
            "test",
        )))),
    }
}

async fn bind_stores(
    workspace: &Path,
    foundation: ExecutionFoundation,
    observed_adoption: Rc<OnceCell<Rc<ExecutionAdoption>>>,
) -> ExecutionOperationResult<ExecutionBindings> {
    let fixture = Rc::new(Idle);
    let id = foundation
        .manager
        .create(
            json!({"label":"Offline", "direction":"executor-connects"}),
            None,
            None,
        )
        .await?
        .id;
    assert!(!foundation.directory.is_ready(Some(&id)));
    let retain_chat = foundation.retain_chat_executor_references();
    let release = retain_chat(std::slice::from_ref(&id), &[])?;
    let error = foundation
        .manager
        .remove(id.clone(), None)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("A reference to this executor is being saved")
    );
    drop(release);
    foundation.manager.remove(id, None).await?;
    let chats = ChatRegistry::open_with_options(
        workspace,
        ChatRegistryOptions {
            retain_executor_references: Some(retain_chat.clone()),
            ..Default::default()
        },
    )
    .await?;
    let ownership = AgentOwnershipJournal::open(
        workspace,
        chats.clone(),
        fixture.clone(),
        fixture.clone(),
        Rc::new(|_| false),
        OwnershipJournalOptions {
            retain_executor_references: Some(retain_chat),
            ..Default::default()
        },
    )
    .await?;
    let ledger_dir = workspace.join("ledger");
    let ledger_store = Rc::new(TranscriptLedgerStore::new(
        ledger_dir.to_str().unwrap(),
        Default::default(),
    )?);
    let ledger = Rc::new(TranscriptLedgerService::new(
        ledger_store.clone(),
        Default::default(),
    ));
    let adoption = Rc::new(ExecutionAdoption::new(TranscriptAdoptionOptions {
        store: ledger_store.clone(),
        registry: Rc::new(AdoptionChatRegistry::new(chats.clone())),
        integrations: foundation.directory,
        frozen_history: fixture.clone(),
        on_adopted: None,
        logger: None,
        clock: None,
    }));
    Ok(ExecutionBindings {
        chats,
        ownership,
        ledger,
        ledger_store,
        adoption: adoption.clone(),
        get_carry_over_revision: Rc::new(|_| "synthetic".into()),
        bind_runtime: Box::new(move |registry, _command_ledger, runtime_adoption| {
            assert!(Rc::ptr_eq(&runtime_adoption, &adoption));
            assert!(observed_adoption.set(runtime_adoption).is_ok());
            assert!(registry.get_running_chat_ids_snapshot().is_empty());
            Ok(ExecutionRuntimeBindings {
                turn_runner: fixture.clone(),
                input_transcript: fixture.clone(),
                commands: fixture.clone(),
                project_admission: fixture.clone(),
                attachment_admission: fixture.clone(),
                working_directory_settlement: fixture,
            })
        }),
        selection_admission_lock: Rc::new(KeyedLock::new()),
        publish_executor_processing: Rc::new(|_| {}),
    })
}

#[tokio::test]
async fn startup_brings_up_the_manager_before_the_stores_and_uses_process_local_controls() {
    LocalSet::new()
        .run_until(async {
            let workspace = tempfile::tempdir().unwrap();
            let root = workspace.path();
            let executor = local_executor(root.to_str().unwrap());
            let local = executor.api();
            let adoption = Rc::new(OnceCell::new());
            let instance = local.get_info(None).await.unwrap().instance_id;
            let mut handles = start_execution(
                options(root.to_str().unwrap(), local.clone()),
                |foundation| bind_stores(root, foundation, adoption.clone()),
            )
            .await
            .unwrap();
            assert!(handles.manager.is_ready("local"));
            assert_eq!(
                handles.manager.ready_instance_id("local").unwrap(),
                instance
            );
            assert!(Rc::ptr_eq(&handles.adoption, adoption.get().unwrap()));
            let controls = handles
                .coordinator
                .read_chat_execution_control("1767225600000000")
                .await
                .unwrap();
            assert_eq!(controls.server_instance_id, "process-instance");
            assert!(controls.entries.is_empty());
            handles.unsubscribe();
            handles.manager.dispose().await.unwrap();
            assert_eq!(local.availability(), ExecutorAvailability::Disposed);
        })
        .await;
}

#[tokio::test]
async fn a_store_binding_failure_disposes_the_started_local_runtime() {
    LocalSet::new()
        .run_until(async {
            let workspace = tempfile::tempdir().unwrap();
            let executor = local_executor(workspace.path().to_str().unwrap());
            let local = executor.api();
            let result = start_execution(
                options(workspace.path().to_str().unwrap(), local.clone()),
                |_| async { Err("synthetic store failure".into()) },
            )
            .await;
            assert_eq!(result.err().unwrap().to_string(), "synthetic store failure");
            assert_eq!(local.availability(), ExecutorAvailability::Disposed);
        })
        .await;
}
