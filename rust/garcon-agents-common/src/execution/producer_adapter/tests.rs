use std::{io, pin::pin, time::Duration};

use futures::future::LocalBoxFuture;
use garcon_contract::chat_types::{AssistantMessage, ChatMessage, parse_tool_use_message};
use garcon_interface::{
    native_message_source::NativeSourced,
    services::{AgentSteerRequest, AgentSteerResult, AgentSteerTargetRequest},
};
use serde_json::json;
use tokio::{sync::oneshot, task::LocalSet, time::timeout};

use super::*;
use crate::execution::{
    admission::{assert_execution_open, mark_execution_started},
    control_adapters::{RuntimeSteering, create_agent_steering},
    runtime_events::{RuntimeSteerRequest, RuntimeSteerTarget, runtime_rows},
};

type Start = dyn Fn(
    AgentRuntimeStartRequest,
    AgentRuntimePublisher,
) -> LocalBoxFuture<'static, ExecutorResult<AgentEstablishedSession>>;
type Resume = dyn Fn(
    AgentRuntimeResumeRequest,
    AgentRuntimePublisher,
) -> LocalBoxFuture<'static, ExecutorResult<()>>;
type Abort = dyn Fn(String) -> LocalBoxFuture<'static, ExecutorResult<bool>>;
type Fields = IndexMap<String, Opaque>;

struct Runtime {
    start: RefCell<Rc<Start>>,
    resume: RefCell<Rc<Resume>>,
    abort: RefCell<Rc<Abort>>,
}

#[async_trait(?Send)]
impl AgentRuntimeExecution for Runtime {
    async fn start(
        &self,
        request: AgentRuntimeStartRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<AgentEstablishedSession> {
        let action = self.start.borrow().clone();
        action(request, publish).await
    }
    async fn resume(
        &self,
        request: AgentRuntimeResumeRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<()> {
        let action = self.resume.borrow().clone();
        action(request, publish).await
    }
    async fn abort(&self, agent_session_id: &str) -> ExecutorResult<bool> {
        let action = self.abort.borrow().clone();
        action(agent_session_id.to_owned()).await
    }
    fn running_sessions(&self) -> Vec<AgentRunningSession> {
        Vec::new()
    }
}

#[derive(Default)]
struct Logger(RefCell<Vec<(String, Fields)>>);

impl AgentLogger for Logger {
    fn debug(&self, _: &str, _: Option<&Fields>) {}
    fn info(&self, _: &str, _: Option<&Fields>) {}
    fn error(&self, _: &str, _: Option<&Fields>) {}
    fn warn(&self, message: &str, fields: Option<&Fields>) {
        self.0
            .borrow_mut()
            .push((message.into(), fields.cloned().unwrap_or_default()));
    }
}

struct Fixture {
    adapter: Rc<AgentProducerAdapter>,
    runtime: Rc<Runtime>,
    logger: Rc<Logger>,
    source: AgentStartRequestV5,
    events: Rc<RefCell<Vec<AgentProducerNotification>>>,
    abortions: Rc<RefCell<Vec<String>>>,
    closed_sink: Rc<Cell<bool>>,
}

impl Fixture {
    async fn new() -> Self {
        let source: AgentStartRequestV5 = garcon_js::json::from_str(r#"{
          "chatId":"chat-1","projectPath":"/project","model":"model","permissionMode":"default",
          "thinkingMode":"medium","settings":{"ownerId":"test","schemaVersion":1,"values":{}},
          "endpoint":null,"runId":"run-1",
          "producerBinding":{"executorId":"test-node","instanceId":"test-runtime","integrationId":"test","kind":"producer","id":"first"},
          "prompt":"hello","attachments":[],"carriedContext":null
        }"#).unwrap();
        let abortions = Rc::new(RefCell::new(Vec::new()));
        let runtime = Rc::new(Runtime {
            start: RefCell::new(Rc::new(|_, _| Box::pin(async { Ok(session("session-1")) }))),
            resume: RefCell::new(Rc::new(|_, _| Box::pin(async { Ok(()) }))),
            abort: RefCell::new(Rc::new({
                let abortions = abortions.clone();
                move |session| {
                    abortions.borrow_mut().push(session);
                    Box::pin(async { Ok(true) })
                }
            })),
        });
        let logger = Rc::new(Logger::default());
        let adapter = create_agent_producer_adapter(
            runtime.clone(),
            logger.clone(),
            source.context.producer_binding.scope.clone(),
            new_ids(),
        );
        let closed_sink = Rc::new(Cell::new(false));
        let events = Rc::new(RefCell::new(Vec::new()));
        let _off = adapter.subscribe(Rc::new({
            let (events, closed_sink) = (events.clone(), closed_sink.clone());
            move |notification| {
                if closed_sink.get() {
                    return Err(io::Error::other("Transcript producer sink is closed").into());
                }
                events.borrow_mut().push(notification);
                Ok(())
            }
        }));
        adapter
            .bind(
                AgentProducerBindRequest {
                    chat_id: source.context.chat_id.clone(),
                    binding: source.context.producer_binding.clone(),
                },
                None,
            )
            .await
            .unwrap();
        Self {
            adapter,
            runtime,
            logger,
            source,
            events,
            abortions,
            closed_sink,
        }
    }

    async fn start(&self) -> ExecutorResult<AgentExecutionHandle> {
        self.adapter.start(self.source.clone(), None).await
    }

    async fn replacement(&self) -> AgentStartRequestV5 {
        let mut next = self.source.clone();
        next.context.run_id = "replacement".into();
        next.context.producer_binding.id = "replacement-binding".into();
        self.adapter
            .bind(
                AgentProducerBindRequest {
                    binding: next.context.producer_binding.clone(),
                    chat_id: next.context.chat_id.clone(),
                },
                None,
            )
            .await
            .unwrap();
        next
    }

    async fn close(&self) {
        self.adapter
            .close(self.source.context.producer_binding.clone(), None)
            .await
            .unwrap();
    }

    fn detach(&self) {
        self.adapter
            .detach(self.source.context.producer_binding.clone());
    }

    fn wire_events(&self) -> Vec<Value> {
        self.events
            .borrow()
            .iter()
            .map(|notification| wire(&notification.event))
            .collect()
    }
}

fn new_ids() -> Rc<dyn Fn() -> String> {
    let count = Cell::new(0);
    Rc::new(move || {
        count.update(|count| count + 1);
        format!("resource-{}", count.get())
    })
}

fn wire(value: &impl serde::Serialize) -> Value {
    garcon_js::json::from_slice(&serde_json::to_vec(value).unwrap()).unwrap()
}

fn session(id: &str) -> AgentEstablishedSession {
    AgentEstablishedSession {
        agent_session_id: id.into(),
        native_session: None,
        native_seed_receipt: None,
    }
}

fn resume(request: &AgentStartRequestV5) -> AgentResumeRequestV5 {
    AgentResumeRequestV5 {
        context: request.context.clone(),
        agent_session_id: "session-1".into(),
        native_session: None,
        prompt: request.prompt.clone(),
        attachments: request.attachments.clone(),
    }
}

fn row(content: &str) -> AgentRuntimeEvent {
    AgentRuntimeEvent::Rows {
        rows: runtime_rows([NativeSourced::new(ChatMessage::Assistant(
            AssistantMessage {
                timestamp: "2026-01-01T00:00:00Z".into(),
                content: content.into(),
                questions: None,
            },
        ))]),
    }
}

fn ended(run_id: &str) -> AgentRuntimeEvent {
    AgentRuntimeEvent::RunEnded {
        run_id: run_id.into(),
        outcome: ProviderRunOutcome::Finished {
            final_response: None,
        },
        working_directory: None,
    }
}

fn assert_code<T>(result: ExecutorResult<T>, expected: AgentIntegrationErrorCode) {
    let error = result.err().expect("expected a call error");
    assert_eq!(
        error.downcast_ref::<AgentCallError>().unwrap().code,
        expected
    );
}

struct Decision {
    id: String,
    calls: RefCell<Vec<PermissionDecisionPayload>>,
}

#[async_trait(?Send)]
impl RuntimePermissionResponse for Decision {
    fn permission_occurrence_id(&self) -> &str {
        &self.id
    }
    async fn respond(&self, request: PermissionDecisionPayload) -> ExecutorResult<()> {
        self.calls.borrow_mut().push(request);
        Ok(())
    }
}

fn permission(run_id: &str, occurrence: &str, command: &str) -> (AgentRuntimeEvent, Rc<Decision>) {
    let decision = Rc::new(Decision {
        id: occurrence.into(),
        calls: RefCell::default(),
    });
    let requested_tool = Box::new(parse_tool_use_message(&json!({
        "type":"bash-tool-use","timestamp":"2026-01-01T00:00:00Z","toolUseId":"tool-1","command":command,
    })).unwrap());
    (
        AgentRuntimeEvent::Permission {
            run_id: run_id.into(),
            lifecycle: AgentProviderPermissionLifecycle::Requested(
                AgentRequestedPermission::Requested {
                    permission_occurrence_id: occurrence.into(),
                    requested_tool,
                    options: Vec::new(),
                    reason: None,
                },
            ),
            decision: Some(decision.clone()),
        },
        decision,
    )
}

fn permission_cancel(run_id: &str, occurrence: &str) -> AgentRuntimeEvent {
    AgentRuntimeEvent::Permission {
        run_id: run_id.into(),
        lifecycle: AgentProviderPermissionLifecycle::Terminal(AgentTerminalPermission::Cancelled {
            permission_occurrence_id: occurrence.into(),
            reason: Some("aborted".into()),
        }),
        decision: None,
    }
}

fn response(notification: &AgentProducerNotification) -> AgentPermissionRespondRequest {
    let AgentProducerNotificationEvent::Provider(AgentProducerEvent::Permission {
        permission: AgentProducerPermission::Requested { decision, .. },
        ..
    }) = &notification.event
    else {
        panic!("expected a permission request")
    };
    AgentPermissionRespondRequest {
        response: decision.response.clone(),
        decision: PermissionDecisionPayload {
            allow: true,
            always_allow: None,
            response: None,
        },
    }
}

#[tokio::test]
async fn publishes_sessions_rows_and_terminal_events_without_spending_completed_execution_slots() {
    let fixture = Fixture::new().await;
    let late: Rc<RefCell<Option<AgentRuntimePublisher>>> = Rc::default();
    fixture.runtime.start.replace(Rc::new({
        let late = late.clone();
        move |request, publish| {
            let late = late.clone();
            Box::pin(async move {
                let current = session("session-1");
                publish(AgentRuntimeEvent::Session {
                    session: current.clone(),
                });
                if request.context.run_id == "run-1" {
                    late.replace(Some(publish.clone()));
                    publish(row("answer"));
                }
                publish(ended(&request.context.run_id));
                Ok(current)
            })
        }
    }));
    let handle = fixture.start().await.unwrap();
    let events = fixture.wire_events();
    assert_eq!(
        events
            .iter()
            .map(|event| event["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["session", "rows", "run-ended"]
    );
    assert_eq!(events[1]["rows"][0]["message"]["content"], "answer");
    assert_eq!(
        events[2],
        json!({"type":"run-ended","runId":"run-1","outcome":"finished"})
    );
    assert_code(
        fixture.adapter.abort(handle, None).await,
        AgentIntegrationErrorCode::STALE_RESOURCE,
    );

    for index in 2..=4097 {
        let mut request = fixture.source.clone();
        request.context.chat_id = format!("chat-{index}");
        request.context.run_id = format!("run-{index}");
        request.context.producer_binding.id = format!("binding-{index}");
        fixture
            .adapter
            .bind(
                AgentProducerBindRequest {
                    chat_id: request.context.chat_id.clone(),
                    binding: request.context.producer_binding.clone(),
                },
                None,
            )
            .await
            .unwrap();
        let handle = fixture.adapter.start(request, None).await.unwrap();
        assert_code(
            fixture.adapter.abort(handle, None).await,
            AgentIntegrationErrorCode::STALE_RESOURCE,
        );
    }
    assert_eq!(fixture.events.borrow().len(), 4097 * 2 + 1);
    late.borrow().as_ref().unwrap()(row("late first-chat output"));
    assert_eq!(
        fixture.wire_events().last().unwrap()["rows"][0]["message"]["content"],
        "late first-chat output"
    );
    assert!(fixture.logger.0.borrow().is_empty());
    fixture.close().await;
    assert!(fixture.abortions.borrow().is_empty());
    late.borrow().as_ref().unwrap()(row("retired first binding"));
    assert_eq!(fixture.events.borrow().len(), 4097 * 2 + 2);
}

#[tokio::test]
async fn preserves_each_permission_occurrence_and_drops_unnamed_events_without_content() {
    let fixture = Fixture::new().await;
    let (tx_events, permissions) = {
        let (first, first_decision) = permission("run-1", "first-occurrence", "first");
        let (second, second_decision) = permission("run-1", "second-occurrence", "second");
        let (missing, _) = permission("", "private-occurrence", "private-command");
        (
            vec![
                row("before"),
                first,
                second,
                permission_cancel("run-1", "first-occurrence"),
                missing,
                row("after"),
            ],
            [first_decision, second_decision],
        )
    };
    fixture.runtime.start.replace(Rc::new({
        let events = RefCell::new(tx_events);
        move |_, publish| {
            let events = events.take();
            Box::pin(async move {
                let native = session("session-1");
                publish(AgentRuntimeEvent::Session {
                    session: native.clone(),
                });
                for event in events {
                    publish(event);
                }
                Ok(native)
            })
        }
    }));
    fixture.start().await.unwrap();
    let events = fixture.wire_events();
    assert_eq!(
        events
            .iter()
            .map(|event| event["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "session",
            "rows",
            "permission",
            "permission",
            "permission",
            "rows"
        ]
    );
    assert_eq!(
        events[2]["decision"]["permissionOccurrenceId"],
        "first-occurrence"
    );
    assert_eq!(
        events[3]["decision"]["permissionOccurrenceId"],
        "second-occurrence"
    );
    assert_ne!(
        events[2]["decision"]["response"],
        events[3]["decision"]["response"]
    );
    assert_eq!(events[4]["lifecycle"]["kind"], "cancelled");
    let first = response(&fixture.events.borrow()[2]);
    let second = response(&fixture.events.borrow()[3]);
    assert_code(
        fixture.adapter.respond(first, None).await,
        AgentIntegrationErrorCode::STALE_RESOURCE,
    );
    fixture.adapter.respond(second.clone(), None).await.unwrap();
    assert_code(
        fixture.adapter.respond(second, None).await,
        AgentIntegrationErrorCode::STALE_RESOURCE,
    );
    assert!(permissions[0].calls.borrow().is_empty());
    assert_eq!(permissions[1].calls.borrow().len(), 1);
    let warning = fixture.logger.0.borrow();
    assert_eq!(warning.len(), 1);
    assert_eq!(warning[0].0, "Dropped an unnamed provider permission event");
    assert_eq!(warning[0].1["eventType"].as_str(), Some("permission"));
    let encoded = serde_json::to_string(&*warning).unwrap();
    assert!(!encoded.contains("private-occurrence") && !encoded.contains("private-command"));
}

#[tokio::test]
async fn unavailable_sink_drops_events_but_still_retires_run_ended() {
    let fixture = Fixture::new().await;
    fixture.runtime.start.replace(Rc::new({
        let closed = fixture.closed_sink.clone();
        move |request, publish| {
            let closed = closed.clone();
            Box::pin(async move {
                let native = session("session-1");
                publish(AgentRuntimeEvent::Session {
                    session: native.clone(),
                });
                closed.set(true);
                publish(row("after close"));
                publish(ended(&request.context.run_id));
                Ok(native)
            })
        }
    }));
    let handle = fixture.start().await.unwrap();
    assert_eq!(fixture.events.borrow().len(), 1);
    {
        let warnings = fixture.logger.0.borrow();
        assert_eq!(warnings.len(), 2);
        assert_eq!(
            warnings[0].0,
            "Dropped a provider event for an unavailable transcript sink"
        );
        assert_eq!(warnings[0].1["eventType"].as_str(), Some("rows"));
        assert_eq!(warnings[1].1["eventType"].as_str(), Some("run-ended"));
    }
    assert_code(
        fixture.adapter.abort(handle, None).await,
        AgentIntegrationErrorCode::STALE_RESOURCE,
    );
}

#[tokio::test]
async fn synchronous_delivery_observes_added_and_removed_subscriptions() {
    let fixture = Fixture::new().await;
    let calls = Rc::new(RefCell::new(Vec::new()));
    let second_off = Rc::new(RefCell::new(None::<Box<dyn Fn()>>));
    let new: Listener = Rc::new({
        let calls = calls.clone();
        move |_| {
            calls.borrow_mut().push("added");
            Ok(())
        }
    });
    let _first = fixture.adapter.subscribe(Rc::new({
        let adapter = Rc::downgrade(&fixture.adapter);
        let calls = calls.clone();
        let second_off = second_off.clone();
        move |_| {
            calls.borrow_mut().push("first");
            if let Some(remove) = second_off.take() {
                remove();
            }
            let _added = adapter.upgrade().unwrap().subscribe(new.clone());
            Ok(())
        }
    }));
    second_off.replace(Some(fixture.adapter.subscribe(Rc::new({
        let calls = calls.clone();
        move |_| {
            calls.borrow_mut().push("removed");
            Ok(())
        }
    }))));
    fixture.start().await.unwrap();
    assert_eq!(*calls.borrow(), ["first", "added"]);
}

#[tokio::test]
async fn aborts_only_the_closed_startup_and_normalizes_its_error() {
    LocalSet::new()
        .run_until(async {
            for published in [false, true] {
                for cooperative in [false, true] {
                    let fixture = Fixture::new().await;
                    let (release, gate) = oneshot::channel();
                    let admission: Rc<RefCell<Option<CancellationToken>>> = Rc::default();
                    fixture.runtime.start.replace(Rc::new({
                        let admission = admission.clone();
                        let gate = RefCell::new(Some(gate));
                        move |request, publish| {
                            let gate = gate.take().unwrap();
                            let admission = admission.clone();
                            Box::pin(async move {
                                admission.replace(Some(request.context.admission.signal().clone()));
                                let native = session("closed-session");
                                if published {
                                    publish(AgentRuntimeEvent::Session {
                                        session: native.clone(),
                                    });
                                }
                                gate.await.unwrap();
                                if cooperative {
                                    assert_execution_open(request.context.admission.as_ref())?;
                                }
                                Ok(native)
                            })
                        }
                    }));
                    let mut start = pin!(fixture.start());
                    assert!(futures::poll!(&mut start).is_pending());
                    fixture.close().await;
                    assert!(admission.borrow().as_ref().unwrap().is_cancelled());
                    assert_eq!(fixture.abortions.borrow().len(), usize::from(published));
                    release.send(()).unwrap();
                    assert_code(start.await, AgentIntegrationErrorCode::STALE_RESOURCE);
                    assert_eq!(
                        fixture.abortions.borrow().len(),
                        usize::from(published || !cooperative)
                    );
                    assert_eq!(fixture.events.borrow().len(), usize::from(published));
                }
            }
        })
        .await;
}

#[tokio::test]
async fn caller_cancellation_keeps_its_abort_error_while_the_binding_remains_open() {
    let fixture = Fixture::new().await;
    let (release, gate) = oneshot::channel();
    fixture.runtime.start.replace(Rc::new({
        let gate = RefCell::new(Some(gate));
        move |request, _| {
            let gate = gate.take().unwrap();
            Box::pin(async move {
                gate.await.unwrap();
                assert_execution_open(request.context.admission.as_ref())?;
                Ok(session("session-1"))
            })
        }
    }));
    let signal = CancellationToken::new();
    let mut pending = pin!(fixture.adapter.start(
        fixture.source.clone(),
        Some(ExecutorCallOptions {
            signal: Some(signal.clone()),
            ..Default::default()
        })
    ));
    assert!(futures::poll!(&mut pending).is_pending());
    signal.cancel();
    release.send(()).unwrap();
    let error = pending.await.unwrap_err();
    assert_eq!(
        error.downcast_ref::<NamedError>().unwrap().name,
        "AbortError"
    );
    assert_eq!(error.to_string(), "The operation was aborted.");
    fixture.close().await;
}

#[tokio::test]
async fn detach_denies_pending_and_future_permissions_but_keeps_admission_busy_until_completion() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            let publisher: Rc<RefCell<Option<AgentRuntimePublisher>>> = Rc::default();
            fixture.runtime.start.replace(Rc::new({
                let publisher = publisher.clone();
                move |_, publish| {
                    publisher.replace(Some(publish));
                    Box::pin(async { Ok(session("session-1")) })
                }
            }));
            fixture.start().await.unwrap();
            let publish = publisher.borrow().as_ref().unwrap().clone();
            let (event, first) = permission("run-1", "first", "pwd");
            publish(event);
            fixture.detach();
            let (event, second) = permission("run-1", "second", "ls");
            publish(event);
            publish(row("detached output"));
            let next = fixture.replacement().await;
            assert_code(
                fixture.adapter.start(next.clone(), None).await,
                AgentIntegrationErrorCode::SESSION_BUSY,
            );
            assert_code(
                fixture.adapter.resume(resume(&next), None).await,
                AgentIntegrationErrorCode::SESSION_BUSY,
            );
            assert_code(
                fixture
                    .adapter
                    .run_existing(resume(&next), |_, _| async { Ok(()) }, None)
                    .await,
                AgentIntegrationErrorCode::SESSION_BUSY,
            );
            tokio::task::yield_now().await;
            assert_eq!(fixture.events.borrow().len(), 2);
            let reply = response(&fixture.events.borrow()[1]);
            assert_code(
                fixture.adapter.respond(reply, None).await,
                AgentIntegrationErrorCode::STALE_RESOURCE,
            );
            for capability in [first, second] {
                let decisions = capability.calls.borrow();
                assert_eq!(
                    &*decisions,
                    &[PermissionDecisionPayload {
                        allow: false,
                        always_allow: None,
                        response: None
                    }]
                );
            }
            assert!(fixture.abortions.borrow().is_empty());
            publish(ended("run-1"));
            assert_code(
                fixture.start().await,
                AgentIntegrationErrorCode::STALE_RESOURCE,
            );
            fixture.detach();
            fixture.adapter.start(next, None).await.unwrap();
        })
        .await;
}

#[tokio::test]
async fn an_idle_detachment_removes_the_binding_immediately() {
    let fixture = Fixture::new().await;
    fixture.detach();
    assert_code(
        fixture.start().await,
        AgentIntegrationErrorCode::STALE_RESOURCE,
    );
}

#[tokio::test]
async fn a_late_native_session_is_aborted_before_startup_returns_unless_the_replacement_owns_it() {
    LocalSet::new()
        .run_until(async {
            for replacement_owns in [false, true] {
                let fixture = Fixture::new().await;
                let (release, gate) = oneshot::channel();
                let publisher: Rc<RefCell<Option<AgentRuntimePublisher>>> = Rc::default();
                fixture.runtime.start.replace(Rc::new({
                    let publisher = publisher.clone();
                    let gate = RefCell::new(Some(gate));
                    move |_, publish| {
                        let gate = gate.take().unwrap();
                        publisher.replace(Some(publish));
                        Box::pin(async move {
                            gate.await.unwrap();
                            Ok(session("session-1"))
                        })
                    }
                }));
                let mut start = pin!(fixture.start());
                assert!(futures::poll!(&mut start).is_pending());
                fixture.close().await;
                let next = fixture.replacement().await;
                let replacement = if replacement_owns {
                    Some(fixture.adapter.resume(resume(&next), None).await.unwrap())
                } else {
                    None
                };
                publisher.borrow().as_ref().unwrap()(AgentRuntimeEvent::Session {
                    session: session("session-1"),
                });
                assert_eq!(
                    fixture.abortions.borrow().len(),
                    usize::from(!replacement_owns)
                );
                assert!(fixture.events.borrow().is_empty());
                release.send(()).unwrap();
                assert_code(start.await, AgentIntegrationErrorCode::STALE_RESOURCE);
                if let Some(handle) = replacement {
                    assert!(fixture.adapter.abort(handle, None).await.unwrap());
                }
                assert_eq!(&*fixture.abortions.borrow(), &["session-1"]);
            }
        })
        .await;
}

#[tokio::test]
async fn failed_abort_keeps_the_binding_closed() {
    let fixture = Fixture::new().await;
    fixture.runtime.abort.replace(Rc::new(|_| {
        Box::pin(async { Err(io::Error::other("Synthetic native abort failure").into()) })
    }));
    let handle = fixture.start().await.unwrap();
    fixture.close().await;
    assert_code(
        fixture.adapter.abort(handle, None).await,
        AgentIntegrationErrorCode::STALE_RESOURCE,
    );
    let warnings = fixture.logger.0.borrow();
    assert_eq!(
        warnings[0].0,
        "Failed to abort execution for a closed producer binding"
    );
    assert_eq!(
        warnings[0].1["reason"].as_str(),
        Some("Synthetic native abort failure")
    );
}

#[tokio::test]
async fn releases_execution_slots_when_native_dispatch_fails() {
    let fixture = Fixture::new().await;
    fixture.runtime.start.replace(Rc::new(|_, _| {
        Box::pin(async { Err(io::Error::other("synthetic launch failure").into()) })
    }));
    for index in 1..=4097 {
        let mut request = fixture.source.clone();
        if index > 1 {
            request.context.chat_id = format!("chat-{index}");
            request.context.producer_binding.id = format!("binding-{index}");
            fixture
                .adapter
                .bind(
                    AgentProducerBindRequest {
                        binding: request.context.producer_binding.clone(),
                        chat_id: request.context.chat_id.clone(),
                    },
                    None,
                )
                .await
                .unwrap();
        }
        assert_eq!(
            fixture
                .adapter
                .start(request, None)
                .await
                .unwrap_err()
                .to_string(),
            "synthetic launch failure"
        );
    }
    assert!(fixture.events.borrow().is_empty());
    assert!(fixture.logger.0.borrow().is_empty());
}

#[tokio::test]
async fn a_late_permission_fact_cannot_restore_authority_or_steering() {
    let fixture = Fixture::new().await;
    fixture.runtime.start.replace(Rc::new(|request, publish| {
        Box::pin(async move {
            let native = session("session-1");
            publish(AgentRuntimeEvent::Session {
                session: native.clone(),
            });
            publish(AgentRuntimeEvent::Steerable);
            publish(ended(&request.context.run_id));
            publish(AgentRuntimeEvent::Steerable);
            publish(permission(&request.context.run_id, "late", "pwd").0);
            Ok(native)
        })
    }));
    fixture.start().await.unwrap();
    let wire = fixture.wire_events();
    assert_eq!(
        wire.iter()
            .map(|event| event["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["session", "steerable", "run-ended", "permission"]
    );
    let request = response(&fixture.events.borrow()[3]);
    assert_code(
        fixture.adapter.respond(request, None).await,
        AgentIntegrationErrorCode::STALE_RESOURCE,
    );
    assert!(fixture.logger.0.borrow().is_empty());
}

#[tokio::test]
async fn resume_returns_a_handle_before_native_settlement_and_cancels_before_abort() {
    LocalSet::new()
        .run_until(timeout(Duration::from_secs(5), async {
            let fixture = Fixture::new().await;
            let admission: Rc<RefCell<Option<CancellationToken>>> = Rc::default();
            let (release, gate) = oneshot::channel();
            fixture.runtime.resume.replace(Rc::new({
                let admission = admission.clone();
                let gate = RefCell::new(Some(gate));
                move |request, _| {
                    let gate = gate.take().unwrap();
                    let admission = admission.clone();
                    Box::pin(async move {
                        admission.replace(Some(request.context.admission.signal().clone()));
                        gate.await.unwrap();
                        mark_execution_started(request.context.admission.as_ref()).await
                    })
                }
            }));
            fixture.runtime.abort.replace(Rc::new({
                let admission = admission.clone();
                move |_| {
                    assert!(admission.borrow().as_ref().unwrap().is_cancelled());
                    Box::pin(async { Ok(false) })
                }
            }));
            let handle = fixture
                .adapter
                .resume(resume(&fixture.source), None)
                .await
                .unwrap();
            assert!(!admission.borrow().as_ref().unwrap().is_cancelled());
            assert!(!fixture.adapter.abort(handle, None).await.unwrap());
            release.send(()).unwrap();
            tokio::task::yield_now().await;
            let events = fixture.wire_events();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0]["type"], "run-ended");
            assert_eq!(events[0]["outcome"], "failed");
            assert_eq!(events[0]["error"]["message"], "The operation was aborted.");
        }))
        .await
        .unwrap();
}

#[tokio::test]
async fn publishes_one_terminal_when_resume_reports_failure_and_then_rejects() {
    LocalSet::new()
        .run_until(async {
            for reports in [false, true] {
                let fixture = Fixture::new().await;
                fixture
                    .runtime
                    .resume
                    .replace(Rc::new(move |request, publish| {
                        Box::pin(async move {
                            if reports {
                                publish(AgentRuntimeEvent::RunEnded {
                                    run_id: request.context.run_id,
                                    outcome: ProviderRunOutcome::Failed {
                                        error: Some(AgentRunFailureDetail {
                                            code: "UNAVAILABLE".into(),
                                            message: Some("quota".into()),
                                        }),
                                    },
                                    working_directory: None,
                                });
                            }
                            Err(io::Error::other("resume failed").into())
                        })
                    }));
                fixture
                    .adapter
                    .resume(resume(&fixture.source), None)
                    .await
                    .unwrap();
                let events = fixture.wire_events();
                assert_eq!(events.len(), 1);
                assert_eq!(events[0]["type"], "run-ended");
                assert_eq!(
                    events[0]["error"]["message"],
                    if reports { "quota" } else { "resume failed" }
                );
            }
        })
        .await;
}

#[tokio::test]
async fn run_existing_and_a_replacement_keep_their_exact_publishers() {
    let fixture = Fixture::new().await;
    let publisher: Rc<RefCell<Option<AgentRuntimePublisher>>> = Rc::default();
    let result = fixture
        .adapter
        .run_existing(
            resume(&fixture.source),
            {
                let publisher = publisher.clone();
                move |_, publish| async move {
                    publisher.replace(Some(publish.clone()));
                    publish(row("compacted"));
                    Ok("done")
                }
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(result.1, "done");
    assert_eq!(
        fixture.wire_events()[0]["rows"][0]["message"]["content"],
        "compacted"
    );
    fixture.close().await;
    fixture
        .adapter
        .start(fixture.replacement().await, None)
        .await
        .unwrap();
    let count = fixture.events.borrow().len();
    publisher.borrow().as_ref().unwrap()(row("from the replaced generation"));
    assert_eq!(fixture.events.borrow().len(), count);
    assert_eq!(
        fixture.logger.0.borrow()[0].0,
        "Dropped a provider event for an unavailable transcript sink"
    );
}

struct SteeringRuntime {
    admitted: Rc<Cell<usize>>,
    fence: RefCell<Option<Box<dyn FnOnce()>>>,
}

#[async_trait(?Send)]
impl RuntimeSteering for SteeringRuntime {
    fn capture_target(&self, agent_session_id: &str) -> Option<RuntimeSteerTarget> {
        (agent_session_id == "session-1")
            .then(|| Rc::new(agent_session_id.to_owned()) as RuntimeSteerTarget)
    }

    async fn steer(&self, request: RuntimeSteerRequest) -> ExecutorResult<AgentSteerResult> {
        if let Some(fence) = self.fence.take() {
            fence();
        }
        (request.prepare_delivery)().await?;
        assert_eq!(
            request.target.unwrap().downcast_ref::<String>().unwrap(),
            "session-1"
        );
        self.admitted.update(|n| n + 1);
        Ok(AgentSteerResult::Accepted)
    }
}

#[tokio::test(start_paused = true)]
async fn steering_consumes_a_target_and_fences_delivery_and_expiry() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            let publisher: Rc<RefCell<Option<AgentRuntimePublisher>>> = Rc::default();
            fixture.runtime.start.replace(Rc::new({
                let publisher = publisher.clone();
                move |_, publish| {
                    publisher.replace(Some(publish));
                    Box::pin(async { Ok(session("session-1")) })
                }
            }));
            fixture.start().await.unwrap();
            let runtime = Rc::new(SteeringRuntime {
                admitted: Rc::new(Cell::new(0)),
                fence: RefCell::default(),
            });
            let steering =
                create_agent_steering(fixture.adapter.clone(), runtime.clone(), new_ids());
            let capture = AgentSteerTargetRequest {
                chat_id: "chat-1".into(),
                agent_session_id: "session-1".into(),
                native_session: None,
                producer_binding: fixture.source.context.producer_binding.clone(),
                expected_run_id: "run-1".into(),
            };
            let mut request = AgentSteerRequest {
                question_reply: None,
                chat_id: "chat-1".into(),
                project_path: "/project".into(),
                agent_session_id: "session-1".into(),
                native_session: None,
                target: None,
                input: "input".into(),
                client_message_id: "message".into(),
            };
            assert!(matches!(
                steering.steer(request.clone(), None).await.unwrap(),
                AgentSteerResult::Rejected { .. }
            ));
            request.target = steering
                .capture_target(capture.clone(), None)
                .await
                .unwrap();
            assert_eq!(
                steering.steer(request.clone(), None).await.unwrap(),
                AgentSteerResult::Accepted
            );
            assert_code(
                steering.steer(request.clone(), None).await,
                AgentIntegrationErrorCode::STALE_RESOURCE,
            );

            request.target = steering
                .capture_target(capture.clone(), None)
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_secs(31)).await;
            assert_code(
                steering.steer(request.clone(), None).await,
                AgentIntegrationErrorCode::STALE_RESOURCE,
            );
            request.target = steering
                .capture_target(capture.clone(), None)
                .await
                .unwrap();
            runtime.fence.replace(Some(Box::new(move || {
                publisher.borrow().as_ref().unwrap()(ended("run-1"))
            })));
            assert_code(
                steering.steer(request, None).await,
                AgentIntegrationErrorCode::STALE_RESOURCE,
            );
            assert_eq!(runtime.admitted.get(), 1);
            assert!(
                steering
                    .capture_target(capture, None)
                    .await
                    .unwrap()
                    .is_none()
            );
        })
        .await;
}
