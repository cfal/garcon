use std::{cell::Cell, path::Path, process::Command, time::Duration};

use async_trait::async_trait;
use garcon_base::{KeyedLock, unhandled_rejection_policy::install_unhandled_rejection_policy};
use garcon_chats::{
    chat_processing_activity::{ChatProcessingActivity, RunningChatSource, TurnReservationSource},
    chat_transient_feed::ChatTransientFeedStore,
    metadata_store::{ExistingTranscriptPreview, MetadataIndex, MetadataTranscriptSource},
    registry_contracts::ChatRegistryEntry,
    store::ChatRegistry,
};
use garcon_contract::{
    chat_types::UserMessage,
    cli_presentation::{CliBodyDisclosure, CliPresentation, CliRowFormat},
    executors::AgentExecutionTarget,
    ws_requests::AgentCommandImage,
};
use garcon_execution::{
    accepted_input_transcript::{
        AcceptedInputTranscriptPort, AcceptedInputTranscriptResult, IdentifiedUserInput,
    },
    agent_registry::AgentRegistryOptions,
    chat_execution_control_repository::InMemoryChatExecutionControlRepository,
    chat_execution_coordinator::{
        ChatExecutionCoordinatorDeps, ChatExecutionCoordinatorHost, ChatExecutionCoordinatorOptions,
    },
    command_ledger::{CommandLedger, CommandLedgerStatus, CommandTurnResult, LedgerAcceptInput},
    directory::{AgentDirectory, ExecutionIntegrationDirectory},
    runtime_router::{
        AgentRuntimeRouterOptions, RoutingChat, RuntimeRouterChats, RuntimeTranscriptLedger,
    },
    session_types::{AgentSteerOptions, RunAgentTurnOptions},
    types::{
        AgentTurnRunnerPort, PrepareSteerDelivery, ProjectAdmissionPort,
        QueuedAttachmentAdmissionPort, UserInputAdmissionOptions,
    },
};
use garcon_interface::{
    integration::AgentIntegration,
    producer::{AgentFinalResponse, AgentProducerEvent, AgentRunOutcome},
    services::{AgentSteerResult, AgentSteerTarget},
};
use garcon_js::clock::ManualClock;
use garcon_ledger::{
    service::{
        AppendChatRowInput, TranscriptCommitEvent, TranscriptCommitWork, TranscriptLedgerService,
        TranscriptLedgerServiceOptions,
    },
    store::{InitializeViewInput, TranscriptLedgerStore},
};
use serde_json::json;
use tokio::sync::{Notify, oneshot};

use super::{super::ServerEventWiringDeps, *};

const CHAT: &str = "1000000000000001";
const TURN: &str = "turn-1";
const REQUEST: &str = "request-1";

struct IdleExecution;

impl ExecutionIntegrationDirectory for IdleExecution {
    fn require_integration(
        &self,
        _: &AgentExecutionTarget,
    ) -> ExecutorResult<Rc<AgentIntegration>> {
        panic!("these lifecycle tests do not require integrations");
    }
    fn known_integration(&self, _: &AgentExecutionTarget) -> Option<Rc<AgentIntegration>> {
        None
    }
    fn integrations_for(&self, _: &str) -> ExecutorResult<Vec<Rc<AgentIntegration>>> {
        Ok(vec![])
    }
    fn is_ready(&self, _: &str) -> bool {
        true
    }
}

impl RuntimeRouterChats for IdleExecution {
    fn get_chat(&self, _: &str) -> Option<RoutingChat> {
        None
    }
}

fn agents(ledger: Rc<TranscriptLedgerService>) -> Rc<AgentRegistry> {
    let logger = Rc::new(create_logger("test"));
    let idle = Rc::new(IdleExecution);
    let directory = Rc::new(AgentDirectory::new(idle.clone()));
    Rc::new(AgentRegistry::new(AgentRegistryOptions {
        runtime: AgentRuntimeRouterOptions {
            registry: idle,
            directory: directory.clone(),
            ledger: Rc::new(RuntimeTranscriptLedger(ledger)),
            unhandled_rejections: Rc::new(install_unhandled_rejection_policy(logger.clone())),
        },
        directory,
        get_carry_over_revision: Rc::new(|_| String::new()),
        ownership_transfer_pending: Rc::new(|_| false),
        logger,
    }))
}

#[async_trait(?Send)]
impl AgentTurnRunnerPort for IdleExecution {
    async fn run_agent_turn(&self, _: &str, _: &str, _: RunAgentTurnOptions) -> ExecutorResult<()> {
        panic!("an idle chat has no queued turn to run");
    }
    async fn capture_steer_target(
        &self,
        _: &str,
        _: Option<f64>,
    ) -> ExecutorResult<Option<AgentSteerTarget>> {
        Ok(None)
    }
    async fn steer_input(
        &self,
        _: &str,
        _: &str,
        _: &AgentSteerOptions,
        _: Option<&AgentSteerTarget>,
        _: PrepareSteerDelivery<'_>,
        _: Option<f64>,
    ) -> ExecutorResult<AgentSteerResult> {
        panic!("an idle chat has no steer target");
    }
    async fn abort_session(&self, _: &str) -> ExecutorResult<bool> {
        Ok(false)
    }
    fn is_chat_running(&self, _: &str) -> bool {
        false
    }
}

#[async_trait(?Send)]
impl ChatExecutionCoordinatorHost for IdleExecution {
    fn chat_exists(&self, chat: &str) -> bool {
        chat == CHAT
    }
    fn can_dispatch(&self, _: &str) -> bool {
        false
    }
    fn is_control_input_view_current(&self, _: &str, _: &str) -> ExecutorResult<bool> {
        Ok(true)
    }
}

#[async_trait(?Send)]
impl ProjectAdmissionPort for IdleExecution {
    async fn assert_available(&self, _: &str, _: Option<f64>) -> ExecutorResult<()> {
        Ok(())
    }
}

impl QueuedAttachmentAdmissionPort for IdleExecution {
    fn assert_supported(&self, _: &str, _: &[AgentCommandImage]) -> ExecutorResult<()> {
        Ok(())
    }
}

#[async_trait(?Send)]
impl AcceptedInputTranscriptPort for IdleExecution {
    fn has_matching_input(
        &self,
        _: &str,
        _: &UserMessage,
        _: &UserInputAdmissionOptions,
    ) -> ExecutorResult<bool> {
        Ok(false)
    }
    async fn admit_input(
        &self,
        _: &str,
        _: UserMessage,
        _: IdentifiedUserInput<'_>,
    ) -> ExecutorResult<AcceptedInputTranscriptResult> {
        panic!("terminal fanout does not admit input");
    }
    fn admit_queued_input(
        &self,
        _: &str,
        _: UserMessage,
        _: IdentifiedUserInput<'_>,
    ) -> ExecutorResult<AcceptedInputTranscriptResult> {
        panic!("terminal fanout does not admit queued input");
    }
    fn discard_prepared_input(&self, _: &str, _: Option<&str>) -> ExecutorResult<()> {
        Ok(())
    }
}

fn coordinator(clock: Rc<dyn Clock>) -> Rc<ChatExecutionCoordinator> {
    let idle = Rc::new(IdleExecution);
    ChatExecutionCoordinator::new(
        ChatExecutionCoordinatorDeps {
            turn_runner: idle.clone(),
            input_transcript: idle.clone(),
            get_drain_options: Rc::new(|_| Ok(RunAgentTurnOptions::default())),
            controls: Rc::new(InMemoryChatExecutionControlRepository::new(
                "fixture-instance".into(),
            )),
            options: ChatExecutionCoordinatorOptions {
                host: idle.clone(),
                working_directory_settlement: None,
                project_admission: idle.clone(),
                attachment_admission: idle,
                selection_admission_lock: Rc::new(KeyedLock::new()),
                unhandled_rejections: Rc::new(install_unhandled_rejection_policy(Rc::new(
                    create_logger("test"),
                ))),
            },
        },
        clock,
        || "fixture-id".into(),
        || 0.0,
    )
}

struct PreviewSource(Rc<TranscriptLedgerStore>);

impl MetadataTranscriptSource for PreviewSource {
    fn existing_view_id(&self, chat: &ChatId) -> ExecutorResult<Option<String>> {
        Ok(self
            .0
            .existing_current_view(chat)?
            .map(|view| view.view_id.to_string()))
    }

    fn existing_preview(
        &self,
        _: &ChatRegistryEntry,
        chat: &ChatId,
    ) -> ExecutorResult<Option<ExistingTranscriptPreview>> {
        Ok(self
            .existing_view_id(chat)?
            .map(|_| ExistingTranscriptPreview { preview: None }))
    }
}

#[derive(Default)]
struct Processing(Cell<bool>);

impl RunningChatSource for Processing {
    fn is_chat_running(&self, _: &str) -> bool {
        false
    }

    fn get_running_chat_ids_snapshot(&self) -> Vec<String> {
        vec![]
    }
}

impl TurnReservationSource for Processing {
    fn is_chat_turn_reserved(&self, chat: &str) -> bool {
        chat == CHAT && self.0.get()
    }

    fn get_turn_reserved_chat_ids(&self) -> Vec<String> {
        if self.0.get() {
            vec![CHAT.into()]
        } else {
            vec![]
        }
    }

    fn is_chat_stop_in_flight(&self, chat: &str) -> bool {
        self.is_chat_turn_reserved(chat)
    }
}

struct Fixture {
    events: Rc<RefCell<Vec<ServerWsMessage>>>,
    control_events: Rc<RefCell<Vec<String>>>,
    ledger: Rc<TranscriptLedgerService>,
    store: Rc<TranscriptLedgerStore>,
    wiring: Rc<ServerEventWiring>,
    agents: Rc<AgentRegistry>,
    coordinator: Rc<ChatExecutionCoordinator>,
    commands: Rc<CommandLedger>,
    processing: Rc<Processing>,
    clock: Rc<ManualClock>,
    unsubscribe: [Box<dyn Fn()>; 2],
}

impl Fixture {
    async fn open(workspace: &Path) -> Self {
        std::fs::write(workspace.join("chats.json"), json!({
            "version":6,"sessions":{CHAT:{
                "agentId":"shell","agentOwnershipEpoch":"fixture-epoch","agentSettingsById":{},
                "projectPath":"/srv/seeded-project","carryOverSegments":[],"nativeSeedReceipt":null,
                "carryOverMigrationQuarantine":null,"parentChatId":null,"lineage":null
            }}
        }).to_string()).unwrap();
        let registry = ChatRegistry::open(workspace).await.unwrap();
        let store = Rc::new(
            TranscriptLedgerStore::new(
                &workspace.join("ledgers").to_string_lossy(),
                Default::default(),
            )
            .unwrap(),
        );
        let clock = Rc::new(ManualClock::new(1_000_000_000_000));
        let ledger = Rc::new(TranscriptLedgerService::new(
            store.clone(),
            TranscriptLedgerServiceOptions {
                clock: Some(clock.clone()),
                ..Default::default()
            },
        ));
        let processing = Rc::new(Processing::default());
        let events = Rc::new(RefCell::new(Vec::new()));
        let control_events = Rc::new(RefCell::new(Vec::new()));
        let metadata = MetadataIndex::open(
            registry.clone(),
            Rc::new(PreviewSource(store.clone())),
            Default::default(),
        )
        .await;
        let wiring = ServerEventWiring::new(ServerEventWiringDeps {
            registry,
            metadata,
            processing: Rc::new(ChatProcessingActivity {
                running: processing.clone(),
                reservations: processing.clone(),
                is_chat_executor_reconnecting: Rc::new(|_| false),
            }),
            feeds: Rc::new(ChatTransientFeedStore::new("fixture-instance".into()).unwrap()),
            activities: Rc::default(),
            replace_metadata: Rc::new(|_, _| async { Ok(()) }.boxed_local()),
            resend_candidates: Rc::new(|_| Ok(vec![])),
            publish: {
                let events = events.clone();
                Rc::new(move |event| {
                    events.borrow_mut().push(event);
                    Ok(())
                })
            },
            publish_execution_control: {
                let control_events = control_events.clone();
                Rc::new(move |event| {
                    control_events
                        .borrow_mut()
                        .push(serde_json::to_string(&event)?);
                    Ok(())
                })
            },
        });
        let agents = agents(ledger.clone());
        let coordinator = coordinator(clock.clone());
        let commands = Rc::new(CommandLedger::new(Default::default(), clock.clone()).unwrap());
        wiring
            .wire_execution(
                &coordinator,
                &agents,
                commands.clone(),
                clock.clone(),
                Rc::new(|_| {}),
            )
            .unwrap();
        let unsubscribe = [
            wiring.wire_transcript(&agents, &ledger),
            agents.bind_transcript_commits(&ledger, commands.clone()),
        ];
        Self {
            events,
            control_events,
            ledger,
            store,
            wiring,
            agents,
            coordinator,
            commands,
            processing,
            clock,
            unsubscribe,
        }
    }

    async fn commit_row(&self) -> oneshot::Sender<()> {
        let (release, hold) = oneshot::channel();
        drop(
            self.wiring
                .queue
                .schedule(CHAT, "test barrier", async move {
                    hold.await?;
                    Ok(())
                }),
        );
        // The original dispatches commit listeners in a microtask. Wait for
        // their synchronous prefix but keep the enqueued fanout blocked.
        let (delivery, delivered) = oneshot::channel();
        let delivery = RefCell::new(Some(delivery));
        let unsubscribe = self.ledger.subscribe(Rc::new(move |_| {
            if let Some(delivery) = delivery.borrow_mut().take() {
                delivery.send(()).unwrap();
            }
            TranscriptCommitWork::Complete(Ok(()))
        }));
        let view = self
            .store
            .initialize_current_view(
                CHAT,
                InitializeViewInput {
                    view_id: None,
                    content_start_ordinal: 1,
                    rows: &[],
                },
            )
            .unwrap();
        self.ledger
            .append_chat_row(
                CHAT,
                AppendChatRowInput {
                    view_id: &view.view_id,
                    client_message_id: "row-1",
                    presentation: &CliPresentation::Info,
                    format: CliRowFormat::Plain,
                    disclosure: CliBodyDisclosure::Expanded,
                    title: None,
                    content: "Synthetic transcript row",
                },
            )
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), delivered)
            .await
            .unwrap()
            .unwrap();
        unsubscribe();
        release
    }

    async fn accept_run(&self) {
        self.commands
            .accept(&LedgerAcceptInput {
                command_type: "agent-run".into(),
                chat_id: CHAT.into(),
                client_request_id: REQUEST.into(),
                payload: json!({}).into(),
                turn_id: Some(TURN.into()),
                entry_id: None,
            })
            .await
            .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for unsubscribe in &self.unsubscribe {
            unsubscribe();
        }
    }
}

#[tokio::test]
async fn publishes_a_committed_row_before_stop_and_keeps_the_captured_phase() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let workspace = tempfile::tempdir().unwrap();
            let fixture = Fixture::open(workspace.path()).await;
            fixture.accept_run().await;
            let release = fixture.commit_row().await;
            fixture.processing.0.set(true);
            fixture.wiring.session_stopped(
                chat_id(CHAT).unwrap(),
                ChatStopOutcome::InterruptRequested,
                ChatStopIntent::Stop,
                Some(&TurnIdentity {
                    turn_id: Some(TURN.into()),
                    client_request_id: Some(REQUEST.into()),
                }),
            );
            fixture.processing.0.set(false);
            assert!(fixture.events.borrow().is_empty());
            release.send(()).unwrap();
            fixture.wiring.wait_for_idle().await.unwrap();
            let command = fixture
                .commands
                .get_record(&command_ledger_key("agent-run", CHAT, REQUEST))
                .await
                .unwrap();
            assert_eq!(command.status, CommandLedgerStatus::Finished);
            assert_eq!(
                command.interruption_reason(),
                Some(&InterruptionReason::UserStop)
            );
            fixture.wiring.session_stopped(
                chat_id(CHAT).unwrap(),
                ChatStopOutcome::AlreadyIdle,
                ChatStopIntent::Stop,
                None,
            );
            fixture.wiring.wait_for_idle().await.unwrap();
            let events = fixture.events.borrow();
            assert!(matches!(
                events.first(),
                Some(ServerWsMessage::ChatMessages(_))
            ));
            let bun = Command::new("bun")
                .arg(
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("tests/oracles/chat-lifecycle-events.ts"),
                )
                .output()
                .unwrap();
            assert!(
                bun.status.success(),
                "{}",
                String::from_utf8_lossy(&bun.stderr)
            );
            assert_eq!(
                serde_json::to_string(&events[1..]).unwrap(),
                String::from_utf8(bun.stdout).unwrap().trim_end()
            );
        })
        .await;
}

#[tokio::test]
async fn deduplicates_agent_and_queue_failure_by_turn_and_settles_the_command() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let workspace = tempfile::tempdir().unwrap();
            let fixture = Fixture::open(workspace.path()).await;
            let release = fixture.commit_row().await;
            fixture.accept_run().await;
            let chat_id = chat_id(CHAT).unwrap();
            let turn = TurnEventMetadata {
                turn_id: Some(TURN.into()),
                client_request_id: Some(REQUEST.into()),
                command_type: Some(TurnCommandType::AgentRun),
                ..Default::default()
            };
            fixture.wiring.queue_failure(
                chat_id.clone(),
                "Synthetic queue failure".into(),
                turn.clone(),
                fixture.clock.clone(),
            );
            release.send(()).unwrap();
            fixture.wiring.wait_for_idle().await.unwrap();
            fixture
                .wiring
                .handle_failure(
                    &chat_id,
                    "Synthetic duplicate failure",
                    Some("INVALID_INPUT"),
                    Some(&turn),
                    None,
                    fixture.clock.as_ref(),
                    false,
                )
                .await
                .unwrap();
            let command = fixture
                .commands
                .get_record(&command_ledger_key("agent-run", CHAT, REQUEST))
                .await
                .unwrap();
            assert_eq!(command.status, CommandLedgerStatus::Failed);
            assert_eq!(
                command.error().map(String::as_str),
                Some("Synthetic queue failure")
            );
            assert_eq!(
                command.error_code().map(String::as_str),
                Some("INTERNAL_ERROR")
            );
            assert!(command.public_terminal_at().is_some());
            let events = fixture.events.borrow();
            let failures = events
                .iter()
                .filter_map(|event| match event {
                    ServerWsMessage::AgentRunFailed(event) => Some(event),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(failures.len(), 1);
            assert_eq!(failures[0].turn_id.as_deref(), Some(TURN));
            assert_eq!(failures[0].error, "Synthetic queue failure");
        })
        .await;
}

#[tokio::test]
async fn committed_message_fanout_precedes_terminal_processing_and_finished_event() {
    tokio::task::LocalSet::new().run_until(async {
        let workspace = tempfile::tempdir().unwrap();
        let fixture = Fixture::open(workspace.path()).await;
        let agents = &fixture.agents;
        fixture.accept_run().await;
        agents.events().track_turn(CHAT, &TurnEventMetadata {
            turn_id: Some(TURN.into()),
            client_request_id: Some(REQUEST.into()),
            command_type: Some(TurnCommandType::AgentRun),
            ..Default::default()
        }).unwrap();
        let release = fixture.commit_row().await;
        let dispatch = Rc::new(Notify::new());
        agents.on_transcript_committed(Rc::new({
            let dispatch = dispatch.clone();
            move |event| {
                if matches!(event.as_ref(), TranscriptCommitEvent::RunEnded { .. }) {
                    dispatch.notify_one();
                }
                ListenerWork::Synchronous(Ok(()))
            }
        }));
        let terminal = Rc::new(Notify::new());
        agents.events().on_finished(Rc::new({
            let terminal = terminal.clone();
            move |_, _, _, _| {
                terminal.notify_one();
                ListenerWork::Synchronous(Ok(()))
            }
        }));
        let producer = fixture.ledger.open_producer(CHAT, "shell").unwrap();
        fixture.ledger.begin_run(CHAT, Some(TURN)).unwrap();
        producer.sink().publish(AgentProducerEvent::RunEnded {
            run_id: TURN.into(),
            outcome: AgentRunOutcome::Finished {
                final_response: Some(AgentFinalResponse::Text { text: "Synthetic answer".into() }),
            },
            working_directory: None,
        }).unwrap();
        tokio::time::timeout(Duration::from_secs(5), dispatch.notified()).await.unwrap();
        assert!(fixture.events.borrow().is_empty());
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), terminal.notified()).await.unwrap();
        fixture.wiring.wait_for_idle().await.unwrap();
        let command = fixture.commands.get_record(&command_ledger_key("agent-run", CHAT, REQUEST)).await.unwrap();
        assert_eq!(command.status, CommandLedgerStatus::Finished);
        assert!(command.public_terminal_at().is_some());
        assert!(matches!(command.turn_result(),
            Some(CommandTurnResult::Available { text, .. }) if text == "Synthetic answer"));
        assert!(matches!(fixture.events.borrow().as_slice(), [
            ServerWsMessage::ChatMessages(_),
            ServerWsMessage::ChatMessages(run_ended),
            ServerWsMessage::ChatActivityUpdated(_),
            ServerWsMessage::ChatProcessingUpdated(phase),
            ServerWsMessage::ChatActivityUpdated(_),
            ServerWsMessage::AgentRunFinished(finished),
        ] if run_ended.turn_id.as_deref() == Some(TURN) && phase.phase.is_none()
            && finished.turn_id.as_deref() == Some(TURN) && finished.client_request_id.as_deref() == Some(REQUEST)));
    }).await;
}

#[tokio::test]
async fn control_update_with_a_queued_entry_matches_bun_bytes_and_the_shared_parser() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let workspace = tempfile::tempdir().unwrap();
            let fixture = Fixture::open(workspace.path()).await;
            fixture
                .coordinator
                .create_chat_queue_entry(CHAT, "Synthetic queued input".into(), None)
                .await
                .unwrap();
            fixture.wiring.wait_for_idle().await.unwrap();
            let wire = fixture.control_events.take();
            assert_eq!(wire.len(), 1);
            let bun = Command::new("bun")
                .arg(
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("tests/oracles/chat-execution-control-event.ts"),
                )
                .output()
                .unwrap();
            assert!(
                bun.status.success(),
                "{}",
                String::from_utf8_lossy(&bun.stderr)
            );
            assert_eq!(wire[0], String::from_utf8(bun.stdout).unwrap().trim_end());
            let parsed = garcon_contract::ws_events::parse_server_ws_message(
                &garcon_js::json::parse(&wire[0]).unwrap(),
            )
            .unwrap();
            assert!(
                matches!(parsed, Some(ServerWsMessage::ChatExecutionControlUpdated(message))
            if message.control.queue.entries.len() == 1)
            );
        })
        .await;
}
