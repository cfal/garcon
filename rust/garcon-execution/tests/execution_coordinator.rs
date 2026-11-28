use std::{
    cell::{Cell, RefCell},
    error::Error,
    path::Path,
    rc::Rc,
    time::Duration,
};

use async_trait::async_trait;
use garcon_base::{
    domain_error::DomainError, errors::error_metadata, keyed_lock::KeyedLock, log::create_logger,
    unhandled_rejection_policy::install_unhandled_rejection_policy,
};
use garcon_cases::{CaseError, replay, text};
use garcon_contract::{
    chat_types::UserMessage,
    error_codes::ErrorCode,
    queue_state::{QueuePause, QueuePauseKind},
    transcript_notice_details::TranscriptNoticeDetail,
    ws_requests::AgentCommandImage,
};
use garcon_execution::{
    accepted_input_transcript::{
        AcceptedInputTranscriptPort, AcceptedInputTranscriptResult, IdentifiedUserInput,
    },
    chat_execution_control_repository::{
        ChatExecutionControlRepository, InMemoryChatExecutionControlRepository,
    },
    chat_execution_coordinator::{
        ChatExecutionCoordinator, ChatExecutionCoordinatorDeps, ChatExecutionCoordinatorHost,
        ChatExecutionCoordinatorOptions, RunEndedCommittedListener, RunEndedCommittedSource,
    },
    control_input_delivery::ControlInputSignal,
    control_state::{StoredControlInputEntry, StoredControlReceipt},
    session_types::{AgentSteerOptions, RunAgentTurnOptions},
    turn_identity::TurnIdentity,
    turn_terminal_settlement::{
        AgentTurnSettlementOutcome, TurnEventMetadata, WorkingDirectorySettlement,
        WorkingDirectorySettlementPort,
    },
    types::{
        AgentTurnRunnerPort, ChatExecutionCommands, ChatExecutionQueries, DirectTurnReservation,
        ExecutionOperationResult, PrepareSteerDelivery, ProjectAdmissionPort,
        QueuedAttachmentAdmissionPort, ServerControlInput, ServerControlOffer,
        UserInputAdmissionOptions, execution_error_input,
    },
};
use garcon_interface::{
    execution::AgentExecutionAdmission,
    resources::{AgentResourceRef, AgentResourceScope},
    services::{AgentSteerResult, AgentSteerTarget, AgentSteerTargetKind},
};
use garcon_js::clock::ManualClock;
use serde_json::{Value, json};
use tokio::{sync::Notify, task::LocalSet};
use tokio_util::sync::CancellationToken;

const CHAT: &str = "chat-1";
const VIEW: &str = "view-1";
const TIME: &str = "1970-01-01T00:01:00.123Z";

struct Ports {
    scenario: String,
    ready: Cell<bool>,
    running: Cell<bool>,
    effects: RefCell<Vec<Value>>,
    launched: Notify,
    last_turn: RefCell<Option<String>>,
    released: Notify,
    successor_released: Notify,
    aborting: Notify,
    abort: Notify,
    settling: Notify,
    settlement: Notify,
}

impl Ports {
    fn effect(&self, value: Value) {
        self.effects.borrow_mut().push(value);
    }
}

#[async_trait(?Send)]
impl AgentTurnRunnerPort for Ports {
    async fn run_agent_turn(
        &self,
        _: &str,
        content: &str,
        options: RunAgentTurnOptions,
    ) -> ExecutionOperationResult<()> {
        self.effect(json!([
            "run",
            content,
            options.turn_id,
            options.transcript_view_id
        ]));
        *self.last_turn.borrow_mut() = options.turn_id;
        self.launched.notify_one();
        if content == "queued while stopping" {
            self.successor_released.notified().await;
        } else if self.scenario != "terminal" {
            self.released.notified().await;
        }
        Ok(())
    }

    async fn capture_steer_target(
        &self,
        _: &str,
        _: Option<f64>,
    ) -> ExecutionOperationResult<Option<AgentSteerTarget>> {
        Ok(Some(AgentResourceRef {
            scope: AgentResourceScope {
                executor_id: "executor".into(),
                instance_id: "instance".into(),
                integration_id: "agent".into(),
            },
            kind: AgentSteerTargetKind::SteerTarget,
            id: "target".into(),
        }))
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
        self.effect(json!(["steer"]));
        if self.scenario == "fallback" {
            Err(Box::new(DomainError::new(
                ErrorCode::STEER_TURN_CHANGED,
                "The active turn changed before steering could be applied",
                409,
                false,
            )))
        } else {
            Ok(AgentSteerResult::Accepted)
        }
    }

    async fn abort_session(&self, _: &str) -> ExecutionOperationResult<bool> {
        self.effect(json!(["abort"]));
        self.aborting.notify_one();
        if matches!(self.scenario.as_str(), "coalesced" | "suppressed-drain") {
            self.abort.notified().await;
        }
        Ok(self.scenario == "suppressed-drain")
    }

    fn is_chat_running(&self, _: &str) -> bool {
        self.running.get()
    }
}

#[async_trait(?Send)]
impl ChatExecutionCoordinatorHost for Ports {
    fn chat_exists(&self, _: &str) -> bool {
        self.scenario != "hidden-missing"
    }
    fn can_dispatch(&self, _: &str) -> bool {
        self.ready.get()
    }
    fn is_control_input_view_current(&self, _: &str, _: &str) -> ExecutionOperationResult<bool> {
        Ok(self.scenario != "stale")
    }
    fn append_control_receipt(
        &self,
        _: &str,
        entry: &StoredControlInputEntry,
    ) -> ExecutionOperationResult<()> {
        self.effect(json!(["receipt", entry.input.content]));
        if self.scenario == "receipt-failure" {
            return Err(std::io::Error::other("receipt unavailable").into());
        }
        Ok(())
    }
}

#[async_trait(?Send)]
impl ProjectAdmissionPort for Ports {
    async fn assert_available(&self, _: &str, _: Option<f64>) -> ExecutionOperationResult<()> {
        Ok(())
    }
}

impl QueuedAttachmentAdmissionPort for Ports {
    fn assert_supported(&self, _: &str, _: &[AgentCommandImage]) -> ExecutionOperationResult<()> {
        Ok(())
    }
}

#[async_trait(?Send)]
impl WorkingDirectorySettlementPort for Ports {
    async fn settle(
        &self,
        _: &str,
        _: &TurnEventMetadata,
        _: &dyn Fn() -> bool,
    ) -> ExecutionOperationResult<WorkingDirectorySettlement> {
        self.settling.notify_one();
        if self.scenario == "terminal" {
            self.settlement.notified().await;
        }
        Ok(WorkingDirectorySettlement::Settled)
    }
}

#[async_trait(?Send)]
impl AcceptedInputTranscriptPort for Ports {
    fn has_matching_input(
        &self,
        _: &str,
        _: &UserMessage,
        _: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool> {
        Ok(false)
    }
    async fn admit_input(
        &self,
        _: &str,
        _: UserMessage,
        _: IdentifiedUserInput<'_>,
    ) -> ExecutionOperationResult<AcceptedInputTranscriptResult> {
        self.effect(json!(["direct-admission"]));
        Ok(AcceptedInputTranscriptResult { inserted: true })
    }
    fn admit_queued_input(
        &self,
        _: &str,
        _: UserMessage,
        _: IdentifiedUserInput<'_>,
    ) -> ExecutionOperationResult<AcceptedInputTranscriptResult> {
        self.effect(json!(["queued-admission"]));
        Ok(AcceptedInputTranscriptResult { inserted: true })
    }
    fn discard_prepared_input(&self, _: &str, _: Option<&str>) -> ExecutionOperationResult<()> {
        Ok(())
    }
}

type ListenerSlot = Rc<RefCell<Option<RunEndedCommittedListener>>>;

#[derive(Default)]
struct CommittedTerminals(ListenerSlot);

impl RunEndedCommittedSource for CommittedTerminals {
    fn subscribe_run_ended_committed(
        &self,
        listener: RunEndedCommittedListener,
    ) -> Box<dyn FnOnce()> {
        *self.0.borrow_mut() = Some(listener);
        let slot = self.0.clone();
        Box::new(move || {
            slot.borrow_mut().take();
        })
    }
}

fn fixture(scenario: &str) -> (Rc<ChatExecutionCoordinator>, Rc<Ports>) {
    let ports = Rc::new(Ports {
        scenario: scenario.into(),
        ready: Cell::new(!matches!(scenario, "receipt" | "receipt-failure" | "stale")),
        running: Cell::new(scenario == "provider"),
        effects: RefCell::default(),
        launched: Notify::new(),
        last_turn: RefCell::default(),
        released: Notify::new(),
        successor_released: Notify::new(),
        aborting: Notify::new(),
        abort: Notify::new(),
        settling: Notify::new(),
        settlement: Notify::new(),
    });
    let sequence = Cell::new(0);
    let repository = Rc::new(InMemoryChatExecutionControlRepository::new("server".into()));
    if scenario == "hidden-paused" {
        let mut control = repository.load(CHAT);
        control.pause = Some(QueuePause {
            id: "pause".into(),
            kind: QueuePauseKind::Manual {
                paused_at: TIME.into(),
            },
        });
        repository.save(CHAT, &control).unwrap();
    }
    let coordinator = ChatExecutionCoordinator::new(
        ChatExecutionCoordinatorDeps {
            turn_runner: ports.clone(),
            input_transcript: ports.clone(),
            get_drain_options: Rc::new(|_| Ok(RunAgentTurnOptions::default())),
            controls: repository,
            options: ChatExecutionCoordinatorOptions {
                host: ports.clone(),
                working_directory_settlement: Some(ports.clone()),
                project_admission: ports.clone(),
                attachment_admission: ports.clone(),
                selection_admission_lock: Rc::new(KeyedLock::new()),
                unhandled_rejections: Rc::new(install_unhandled_rejection_policy(Rc::new(
                    create_logger("test"),
                ))),
            },
        },
        Rc::new(ManualClock::new(60_123)),
        move || {
            let id = sequence.get() + 1;
            sequence.set(id);
            format!("id-{id}")
        },
        || 0.0,
    );
    let log = ports.clone();
    coordinator.on_session_stopped(move |_, outcome, intent, turn| {
        log.effect(json!([
            "stopped",
            outcome,
            intent,
            turn.and_then(|turn| turn.turn_id.as_deref())
        ]));
        Ok(())
    });
    (coordinator, ports)
}

fn turn(id: &str) -> TurnEventMetadata {
    TurnEventMetadata {
        turn_id: Some(id.into()),
        ..Default::default()
    }
}

fn identity(id: &str) -> TurnIdentity {
    TurnIdentity {
        turn_id: Some(id.into()),
        client_request_id: None,
    }
}

fn result<T: serde::Serialize>(result: ExecutionOperationResult<T>) -> Value {
    match result {
        Ok(value) => json!(value),
        Err(error) => {
            let metadata = match execution_error_input(error.as_ref()) {
                garcon_base::errors::ErrorInput::Diagnostic(error) => error.diagnostic_metadata(),
                _ => error_metadata(error.as_ref()),
            };
            json!({"code": metadata.code, "message": error.to_string()})
        }
    }
}

async fn run(
    coordinator: &ChatExecutionCoordinator,
    reservation: DirectTurnReservation,
) -> ExecutionOperationResult<()> {
    coordinator
        .run_reserved_turn(
            reservation,
            "initial".into(),
            RunAgentTurnOptions {
                turn_id: Some("first".into()),
                ..RunAgentTurnOptions::default()
            },
        )
        .await
}

async fn settle_launched(
    coordinator: &ChatExecutionCoordinator,
    ports: &Ports,
) -> ExecutionOperationResult<()> {
    ports.launched.notified().await;
    let id = ports.last_turn.borrow().clone().expect("provider turn");
    coordinator
        .on_agent_turn_terminal(CHAT, Some(&turn(&id)), AgentTurnSettlementOutcome::Finished)
        .await?;
    ports.released.notify_one();
    Ok(())
}

async fn trace(scenario: &str) -> ExecutionOperationResult<Value> {
    let (execution, ports) = fixture(scenario);
    let mut values = Vec::new();
    let token = CancellationToken::new();
    let signal = ControlInputSignal {
        token: &token,
        reason: &|| std::io::Error::other("cancelled").into(),
    };
    let input = ServerControlInput {
        content: "control".into(),
        transcript_view_id: VIEW.into(),
        created_at: TIME.into(),
        receipt: Some(StoredControlReceipt {
            title: "Inter-agent message".into(),
            content: "control".into(),
            detail: Box::new(TranscriptNoticeDetail::InterAgentMessageReceived {
                from_chat_id: None,
            }),
        }),
    };
    let first = identity("first");
    match scenario {
        "provider" => {
            // Exercise both trait facets with provider-only ownership.
            values.push(json!(ChatExecutionCommands::owns_execution(
                execution.as_ref(),
                CHAT
            )));
            let snapshot = execution.reserve_transcript_snapshot(CHAT);
            if let Ok(snapshot) = &snapshot {
                execution.release_transcript_snapshot(snapshot).await?;
            }
            values.push(result(snapshot.map(|_| ())));
            ports.running.set(false);
            values.push(json!(ChatExecutionQueries::owns_execution(
                execution.as_ref(),
                CHAT
            )));
        }
        "startup" => {
            let reservation = execution.reserve_direct_turn(CHAT, &first)?;
            let signal = reservation.execution_admission.clone();
            let stop = async {
                ports.launched.notified().await;
                values.push(json!(execution.stop_active_turn(CHAT).await?.outcome));
                values.push(json!(signal.signal().is_cancelled()));
                let successor = execution.reserve_direct_turn(CHAT, &identity("successor"))?;
                ports.released.notify_one();
                Ok::<_, Box<dyn Error>>(successor)
            };
            let (_, successor) = tokio::try_join!(run(&execution, reservation), stop)?;
            values.push(json!(execution.owns_execution(CHAT)));
            execution.release_direct_turn(&successor).await?;
        }
        "coalesced" => {
            let unblock = async {
                ports.aborting.notified().await;
                values.push(json!(execution.is_chat_stop_in_flight(CHAT)));
                ports.abort.notify_one();
                Ok::<_, Box<dyn Error>>(())
            };
            let (a, b, ()) = tokio::try_join!(
                execution.interrupt_active_turn(CHAT),
                execution.interrupt_active_turn(CHAT),
                unblock
            )?;
            values.extend([json!(a), json!(b)]);
        }
        "terminal" => {
            run(&execution, execution.reserve_direct_turn(CHAT, &first)?).await?;
            let terminals = CommittedTerminals::default();
            let unsubscribe = execution.subscribe_run_ended_committed(&terminals);
            terminals.0.borrow().as_ref().expect("subscription")(CHAT, "first");
            let metadata = turn("first");
            let ended = execution.on_agent_turn_terminal(
                CHAT,
                Some(&metadata),
                AgentTurnSettlementOutcome::Finished,
            );
            let stop = async {
                ports.settling.notified().await;
                execution
                    .create_chat_queue_entry(CHAT, "queued".into(), None)
                    .await?;
                values.push(json!(execution.interrupt_active_turn(CHAT).await?));
                values.push(json!(execution.stop_active_turn(CHAT).await?.outcome));
                values.push(json!(execution.owns_execution(CHAT)));
                ports.settlement.notify_one();
                Ok::<_, Box<dyn Error>>(())
            };
            tokio::try_join!(ended, stop)?;
            unsubscribe();
            assert!(terminals.0.borrow().is_none());
        }
        "snapshot" => {
            let snapshot = execution.reserve_transcript_snapshot(CHAT)?;
            values.push(result(
                execution.reserve_direct_turn(CHAT, &first).map(|_| ()),
            ));
            execution
                .create_chat_queue_entry(CHAT, "queued".into(), None)
                .await?;
            execution.trigger_drain(CHAT).await?;
            values.push(json!(ports.effects.borrow().len()));
            execution.release_transcript_snapshot(&snapshot).await?;
            settle_launched(&execution, &ports).await?;
        }
        "hidden" | "hidden-paused" | "hidden-missing" => {
            values.push(result(
                execution
                    .deliver_control_input(
                        CHAT,
                        "hidden",
                        VIEW,
                        None,
                        signal,
                        Box::new(|turn| {
                            ports.effect(json!(["reserved", turn]));
                            Ok(())
                        }),
                    )
                    .await,
            ));
            if scenario == "hidden" {
                values.extend([
                    json!(execution.owns_execution(CHAT)),
                    json!(ports.effects.borrow().len()),
                ]);
                settle_launched(&execution, &ports).await?;
            }
        }
        "receipt" | "receipt-failure" | "stale" => {
            values.push(json!(
                execution
                    .deliver_server_control_input(CHAT, input, signal)
                    .await?
            ));
            execution.wait_for_execution_owners().await;
            ports.ready.set(true);
            if scenario == "receipt" {
                tokio::try_join!(
                    execution.trigger_drain(CHAT),
                    settle_launched(&execution, &ports)
                )?;
            } else {
                values.push(result(execution.trigger_drain(CHAT).await));
            }
        }
        "fallback" | "ambiguous" => {
            let reservation = execution.reserve_direct_turn(CHAT, &first)?;
            if scenario == "fallback" {
                let offer = execution
                    .offer_server_control_input(CHAT, &input, signal, Some(123.0))
                    .await?;
                let ServerControlOffer::AfterTurn { attempt } = offer else {
                    return Err(std::io::Error::other("expected captured attempt").into());
                };
                values.push(json!("after-turn"));
                execution.release_direct_turn(&reservation).await?;
                attempt.wait_until_settled().await;
                ports.ready.set(false);
                values.push(json!(
                    execution
                        .queue_server_control_input(CHAT, &input, signal)
                        .await?
                ));
            } else {
                values.push(result(
                    execution
                        .deliver_server_control_input(CHAT, input, signal)
                        .await,
                ));
                execution.release_direct_turn(&reservation).await?;
            }
        }
        "plain-stop" => {
            execution.reserve_direct_turn(CHAT, &first)?;
            execution
                .create_chat_queue_entry(CHAT, "queued".into(), None)
                .await?;
            values.push(json!(execution.stop_active_turn(CHAT).await?.outcome));
        }
        "suppressed-drain" => {
            let reservation = execution.reserve_direct_turn(CHAT, &first)?;
            let orchestrate = async {
                ports.launched.notified().await;
                let enqueue_while_aborting = async {
                    ports.aborting.notified().await;
                    execution
                        .create_chat_queue_entry(CHAT, "queued while stopping".into(), None)
                        .await?;
                    execution.trigger_drain(CHAT).await?;
                    ports.abort.notify_one();
                    Ok::<_, Box<dyn Error>>(())
                };
                let (stopped, ()) =
                    tokio::try_join!(execution.stop_active_turn(CHAT), enqueue_while_aborting)?;
                values.extend([json!(stopped.outcome), pause_kind(stopped.control.pause)]);
                ports.launched.notified().await;
                let id = ports.last_turn.borrow().clone().expect("successor turn");
                execution
                    .on_agent_turn_terminal(
                        CHAT,
                        Some(&turn(&id)),
                        AgentTurnSettlementOutcome::Finished,
                    )
                    .await?;
                ports.successor_released.notify_one();
                ports.released.notify_one();
                Ok::<_, Box<dyn Error>>(())
            };
            tokio::try_join!(run(&execution, reservation), orchestrate)?;
        }
        "shutdown" => {
            execution.reserve_direct_turn(CHAT, &first)?;
            values.push(json!(execution.begin_shutdown()));
            values.push(result(
                execution.reserve_direct_turn("other", &first).map(|_| ()),
            ));
            values.push(json!(execution.abort_for_shutdown(CHAT).await?));
        }
        "deletion" => {
            execution.reserve_transcript_snapshot(CHAT)?;
            execution
                .create_chat_queue_entry(CHAT, "queued".into(), None)
                .await?;
            execution.delete_chat_queue_file(CHAT).await?;
        }
        _ => {
            return Err(
                std::io::Error::other(format!("unknown coordinator scenario: {scenario}")).into(),
            );
        }
    }
    execution.wait_for_dispatches().await?;
    execution.wait_for_execution_owners().await;
    let state = execution.read_chat_execution_control(CHAT).await?;
    Ok(json!({
        "values": values,
        "effects": &*ports.effects.borrow(),
        "owned": execution.owns_execution(CHAT),
        "entries": state.entries.iter().map(|entry| &entry.content).collect::<Vec<_>>(),
        "control": state.control_entries.iter().map(|entry| &entry.input.content).collect::<Vec<_>>(),
        "pause": pause_kind(state.pause),
    }))
}

fn pause_kind(pause: Option<QueuePause>) -> Value {
    pause.map_or(Value::Null, |pause| {
        serde_json::to_value(pause).unwrap()["kind"].clone()
    })
}

#[test]
fn replays_coordinator_traces() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = LocalSet::new();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/cases/execution-coordinator");
    replay(dir, |name, args| {
        if name != "coordinatorTrace" {
            return Err(CaseError::unhandled(name));
        }
        let scenario = text(name, args.first())?
            .ok_or_else(|| CaseError::undeliverable("expected a coordinator scenario"))?;
        local.block_on(&runtime, async {
            tokio::time::timeout(Duration::from_secs(2), trace(scenario))
                .await
                .map_err(|_| CaseError::undeliverable(format!("{scenario} deadlocked")))?
                .map_err(|error| CaseError::new("Error", error.to_string()))
        })
    });
}

#[tokio::test]
async fn dropping_stop_waiter_does_not_cancel_provider_interrupt_or_state_cleanup() {
    LocalSet::new()
        .run_until(async {
            let (execution, ports) = fixture("coalesced");
            let reservation = execution
                .reserve_direct_turn(CHAT, &identity("first"))
                .unwrap();
            {
                let stopping = execution.stop_active_turn(CHAT);
                tokio::pin!(stopping);
                tokio::select! {
                    biased;
                    _ = &mut stopping => panic!("stop must await the provider"),
                    () = ports.aborting.notified() => {}
                }
            }
            assert!(reservation.execution_admission.signal().is_cancelled());
            assert!(execution.is_chat_stop_in_flight(CHAT));
            ports.abort.notify_one();
            tokio::time::timeout(
                Duration::from_secs(2),
                execution.wait_for_execution_owners(),
            )
            .await
            .unwrap();
            assert!(!execution.is_chat_stop_in_flight(CHAT));
            assert!(
                execution
                    .reserve_direct_turn(CHAT, &identity("successor"))
                    .is_ok()
            );
        })
        .await;
}
