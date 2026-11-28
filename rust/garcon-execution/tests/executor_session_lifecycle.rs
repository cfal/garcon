use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use garcon_base::{
    log::create_logger, unhandled_rejection_policy::install_unhandled_rejection_policy,
};
use garcon_cases::{CaseError, replay, text};
use garcon_contract::executors::AgentExecutionTarget;
use garcon_execution::{
    agent_registry::{AgentRegistry, AgentRegistryOptions},
    directory::{AgentDirectory, ExecutionIntegrationDirectory},
    execution_aborts::{ExecutionAbortDirectory, ExecutionAborts},
    producer_bindings::{
        LaunchSettledEvent, ProducerBindingEvents, ProducerBindings, TranscriptProducerLease,
    },
    runtime_router::{
        AgentRuntimeRouterOptions, RoutingChat, RuntimeRouterChats, RuntimeTranscriptLedger,
        session_lifecycle::RuntimeSessions,
    },
    session_types::PersistedChatExecutionConfig,
    types::{ExecutionOperationResult, LocalExecutionFuture},
};
use garcon_interface::{
    execution_v5::{AgentExecutionHandle, AgentExecutionKind},
    integration::AgentIntegration,
    producer::AgentRunFailureDetail,
    resources::{AgentResourceRef, AgentResourceScope},
};
use garcon_js::OptionalNullable;
use garcon_ledger::{
    contracts::{LedgerRowData, transcript_view_id},
    service::TranscriptLedgerService,
    store::{InitializeViewInput, TranscriptLedgerStore},
};
use serde_json::{Value, json};
use tokio::task::LocalSet;

const REMOTE: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const TARGET: &str = "1767225600000000";
const SAFE: &str = "1767225600000001";

struct Fixture;

impl RuntimeRouterChats for Fixture {
    fn get_chat(&self, id: &str) -> Option<RoutingChat> {
        let executor = match id {
            TARGET => REMOTE,
            SAFE => OTHER,
            _ => return None,
        };
        Some(RoutingChat {
            agent_id: "test".into(),
            agent_session_id: None,
            native_session: None,
            execution: PersistedChatExecutionConfig {
                executor_id: OptionalNullable::some(executor.into()),
                project_path: Some("/synthetic".into()),
                model: Some("synthetic".into()),
                ..Default::default()
            },
        })
    }
}

impl ExecutionIntegrationDirectory for Fixture {
    fn require_integration(
        &self,
        _: &AgentExecutionTarget,
    ) -> ExecutionOperationResult<Rc<AgentIntegration>> {
        Err("unexpected fixture integration".into())
    }
    fn known_integration(&self, _: &AgentExecutionTarget) -> Option<Rc<AgentIntegration>> {
        None
    }
    fn integrations_for(&self, _: &str) -> ExecutionOperationResult<Vec<Rc<AgentIntegration>>> {
        Err("unexpected fixture integrations".into())
    }
    fn is_ready(&self, _: &str) -> bool {
        false
    }
}

impl ProducerBindingEvents for Fixture {
    fn on_error(&self, error: &(dyn std::error::Error + 'static)) {
        panic!("unexpected fixture error: {error}");
    }
    fn on_publication_failed(
        &self,
        _: &str,
        _: &Rc<dyn TranscriptProducerLease>,
        _: &AgentRunFailureDetail,
    ) -> ExecutionOperationResult<()> {
        Err("unexpected producer failure".into())
    }
    fn on_publication_gap(
        &self,
        _: &str,
        _: &Rc<dyn TranscriptProducerLease>,
    ) -> ExecutionOperationResult<()> {
        Err("unexpected producer gap".into())
    }
    fn on_launch_settled(
        &self,
        _: &str,
        _: &Rc<dyn TranscriptProducerLease>,
        _: &str,
        _: LaunchSettledEvent,
    ) -> ExecutionOperationResult<()> {
        Err("unexpected launch settlement".into())
    }
    fn on_steerable(
        &self,
        _: &str,
        _: &Rc<dyn TranscriptProducerLease>,
        _: &str,
    ) -> ExecutionOperationResult<()> {
        Err("unexpected producer steerable".into())
    }
}

async fn trace(scenario: &str) -> Value {
    let root = tempfile::tempdir().unwrap();
    let store = Rc::new(
        TranscriptLedgerStore::new(root.path().to_str().unwrap(), Default::default()).unwrap(),
    );
    for chat in [TARGET, SAFE] {
        store
            .initialize_current_view(
                chat,
                InitializeViewInput {
                    view_id: Some(transcript_view_id(chat).unwrap()),
                    content_start_ordinal: 1,
                    rows: &[],
                },
            )
            .unwrap();
    }
    let ledger = Rc::new(TranscriptLedgerService::new(
        store.clone(),
        Default::default(),
    ));
    let directory = Rc::new(AgentDirectory::new(Rc::new(Fixture)));
    let logger = Rc::new(create_logger("test"));
    let registry = AgentRegistry::new(AgentRegistryOptions {
        runtime: AgentRuntimeRouterOptions {
            registry: Rc::new(Fixture),
            directory: directory.clone(),
            ledger: Rc::new(RuntimeTranscriptLedger(ledger.clone())),
            unhandled_rejections: Rc::new(install_unhandled_rejection_policy(logger.clone())),
        },
        directory,
        get_carry_over_revision: Rc::new(|_| String::new()),
        ownership_transfer_pending: Rc::new(|_| false),
        logger,
    });
    let sessions = registry.runtime_sessions();
    let target = sessions.producer(TARGET).unwrap();
    let safe = sessions.producer(SAFE).unwrap();
    ledger.begin_run(SAFE, Some("safe-run")).unwrap();
    let bindings = Rc::new(ProducerBindings::new(Rc::new(Fixture), || "binding".into()));
    let run = sessions
        .begin_run(TARGET, "lost-run", bindings, || None)
        .unwrap();
    if scenario != "setup" {
        sessions.mark_launch_dispatched(TARGET, &run);
    }
    let executor = if scenario == "unrelated" {
        "unrelated"
    } else {
        REMOTE
    };
    registry.execution_session_lost(executor);
    registry.execution_session_lost(executor);
    let watermark = store.high_watermark(TARGET).unwrap();
    let terminals: Vec<_> = store
        .rows_through(TARGET, &watermark)
        .await
        .unwrap()
        .into_iter()
        .filter_map(|row| match row.data {
            LedgerRowData::RunEnded {
                outcome,
                origin,
                error,
            } => Some(json!({"outcome":outcome,"origin":origin,"error":error})),
            _ => None,
        })
        .collect();
    let mut result = json!({"terminal":terminals,"targetClosed":target.closed(),"safeClosed":safe.closed(),
        "targetActive":registry.is_chat_running(TARGET),"safeActive":registry.is_chat_running(SAFE)});
    if scenario == "reopened" {
        registry.reopen_transcript_producer(TARGET).unwrap();
        let reopened = sessions.producer(TARGET).unwrap();
        result["reopened"] = Value::Bool(!Rc::ptr_eq(&target, &reopened) && !reopened.closed());
    }
    ledger.close().unwrap();
    result
}

#[test]
fn executor_session_loss_matches_bun() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = LocalSet::new();
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/executor-session-lifecycle"
        ),
        |function, args| {
            if function != "executorSessionTrace" {
                return Err(CaseError::unhandled(function));
            }
            let scenario = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("missing scenario"))?;
            Ok(local.block_on(&runtime, async {
                tokio::time::timeout(Duration::from_secs(5), trace(scenario))
                    .await
                    .unwrap()
            }))
        },
    );
}

#[derive(Default)]
struct CapturedAborts {
    available: Cell<bool>,
    attempts: RefCell<Vec<(String, AgentExecutionHandle)>>,
}

impl ExecutionAbortDirectory for CapturedAborts {
    fn is_ready(&self, executor_id: &str) -> bool {
        executor_id == REMOTE && self.available.get()
    }

    fn abort(
        &self,
        agent_id: &str,
        handle: &AgentExecutionHandle,
    ) -> ExecutionOperationResult<LocalExecutionFuture<'static, bool>> {
        self.attempts
            .borrow_mut()
            .push((agent_id.into(), handle.clone()));
        if !self.is_ready(&handle.scope.executor_id) {
            return Err("synthetic executor offline".into());
        }
        Ok(Box::pin(async { Ok(true) }))
    }
}

#[tokio::test]
async fn resumption_retries_an_interrupted_runs_captured_executor_and_handle() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let store = Rc::new(
                TranscriptLedgerStore::new(root.path().to_str().unwrap(), Default::default())
                    .unwrap(),
            );
            store
                .initialize_current_view(
                    TARGET,
                    InitializeViewInput {
                        view_id: Some(transcript_view_id("view").unwrap()),
                        content_start_ordinal: 1,
                        rows: &[],
                    },
                )
                .unwrap();
            let ledger = Rc::new(TranscriptLedgerService::new(store, Default::default()));
            let port = Rc::new(CapturedAborts::default());
            let sessions = RuntimeSessions::new(
                Rc::new(Fixture),
                Rc::new(RuntimeTranscriptLedger(ledger.clone())),
                Rc::new(ExecutionAborts::new(port.clone())),
                Rc::new(|_| false),
                Rc::new(create_logger("test")),
            );
            sessions.producer(TARGET).unwrap();
            let bindings = Rc::new(ProducerBindings::new(Rc::new(Fixture), || "binding".into()));
            let run = sessions
                .begin_run(TARGET, "run", bindings, || None)
                .unwrap();
            sessions.mark_launch_dispatched(TARGET, &run);
            let handle = AgentResourceRef {
                id: "captured-handle".into(),
                kind: AgentExecutionKind::Execution,
                scope: AgentResourceScope {
                    executor_id: REMOTE.into(),
                    instance_id: "captured-instance".into(),
                    integration_id: "test".into(),
                },
            };
            sessions.retain_or_abort_handle(TARGET, "test", &run, handle.clone());
            assert!(sessions.abort_session(TARGET).unwrap());
            assert!(!ledger.is_run_active(TARGET, None));
            assert_eq!(port.attempts.borrow().len(), 1);
            port.available.set(true);
            sessions.execution_session_resumed(OTHER);
            assert_eq!(port.attempts.borrow().len(), 1);
            sessions.execution_session_resumed(REMOTE);
            sessions.execution_session_resumed(REMOTE);
            assert_eq!(
                *port.attempts.borrow(),
                [("test".into(), handle.clone()), ("test".into(), handle)]
            );
            ledger.close().unwrap();
        })
        .await;
}
