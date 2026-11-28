use std::{
    cell::{Cell, RefCell},
    error::Error,
    io,
    path::Path,
    rc::Rc,
    time::Duration,
};

use async_trait::async_trait;
use garcon_base::executor_disconnect::{ExecutorSessionLostError, as_agent_call_error};
use garcon_cases::{CaseError, replay, text};
use garcon_execution::{
    producer_bindings::{
        LaunchSettledEvent, ProducerBindingEvents, ProducerBindingOptions, ProducerBindingTarget,
        ProducerBindings, TranscriptProducerLease,
    },
    turn_terminal_settlement::ProducerLeaseState,
};
use garcon_interface::{
    errors::AgentDeliveryOutcome,
    producer::{
        AgentLaunchOutcome, AgentProducerBindRequest, AgentProducerControlEvent,
        AgentProducerEvent, AgentProducerNotification, AgentProducerNotificationEvent,
        AgentProducerSink, AgentProducers, AgentRunFailureDetail, AgentRunOutcome,
    },
    resources::{AgentProducerBinding, AgentResourceScope, ExecutorCallOptions, ExecutorResult},
};
use garcon_js::performance_now_ms;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{sync::Notify, task::LocalSet};
use tokio_util::sync::CancellationToken;

type Listener = Rc<dyn Fn(AgentProducerNotification) -> ExecutorResult<()>>;

#[derive(Default)]
struct Log {
    calls: RefCell<Vec<Value>>,
    errors: RefCell<Vec<Value>>,
    scopes: Cell<usize>,
    subscriptions: Cell<usize>,
}

impl Log {
    fn push(&self, call: Value) {
        self.calls.borrow_mut().push(call);
    }
}

fn record(value: &impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(value).unwrap()).unwrap()
}

fn error_result(error: &(dyn Error + 'static)) -> Value {
    json!({
        "error": error.to_string(),
        "outcome": as_agent_call_error(error).map(|error| error.outcome.as_str()),
    })
}

fn binding_result(result: ExecutorResult<AgentProducerBinding>) -> Value {
    match result {
        Ok(binding) => json!({"kind": binding.kind}),
        Err(error) => error_result(error.as_ref()),
    }
}

impl ProducerBindingEvents for Log {
    fn on_error(&self, error: &(dyn Error + 'static)) {
        self.errors.borrow_mut().push(error_result(error));
    }

    fn on_publication_failed(
        &self,
        chat: &str,
        lease: &Rc<dyn TranscriptProducerLease>,
        error: &AgentRunFailureDetail,
    ) -> ExecutorResult<()> {
        self.push(json!(["failure", chat, lease.closed(), error]));
        Err(io::Error::other("Synthetic terminal failure").into())
    }

    fn on_publication_gap(
        &self,
        chat: &str,
        lease: &Rc<dyn TranscriptProducerLease>,
    ) -> ExecutorResult<()> {
        self.push(json!(["gap", chat, lease.closed()]));
        Ok(())
    }

    fn on_launch_settled(
        &self,
        chat: &str,
        lease: &Rc<dyn TranscriptProducerLease>,
        agent: &str,
        event: LaunchSettledEvent,
    ) -> ExecutorResult<()> {
        self.push(json!([
            "launch",
            chat,
            lease.closed(),
            agent,
            record(&AgentProducerControlEvent::LaunchSettled {
                run_id: event.run_id,
                outcome: event.outcome
            })
        ]));
        Ok(())
    }

    fn on_steerable(
        &self,
        chat: &str,
        lease: &Rc<dyn TranscriptProducerLease>,
        run: &str,
    ) -> ExecutorResult<()> {
        self.push(json!(["steerable", chat, lease.closed(), run]));
        Ok(())
    }
}

struct Lease {
    log: Rc<Log>,
    label: String,
    closed: Cell<bool>,
    on_closed: RefCell<Vec<Box<dyn FnOnce()>>>,
}

impl AgentProducerSink for Lease {
    fn publish(&self, event: AgentProducerEvent) -> ExecutorResult<()> {
        if self.closed() {
            return Err(io::Error::other("Closed route received an event").into());
        }
        if self.label == "fenced" {
            return Err(
                io::Error::other("Transcript ledger is fenced for chat fenced-chat").into(),
            );
        }
        self.log
            .push(json!(["publish", self.label, record(&event)]));
        Ok(())
    }
}

impl ProducerLeaseState for Lease {
    fn closed(&self) -> bool {
        self.closed.get()
    }
}

impl TranscriptProducerLease for Lease {
    fn on_closed(&self, listener: Box<dyn FnOnce()>) {
        if self.closed() {
            listener();
        } else {
            self.on_closed.borrow_mut().push(listener);
        }
    }

    fn close(&self) {
        if !self.closed.replace(true) {
            self.log.push(json!(["lease-closed", self.label]));
            for listener in self.on_closed.take() {
                listener();
            }
        }
    }
}

struct Producers {
    log: Rc<Log>,
    scenario: String,
    scope: AgentResourceScope,
    reconnecting: Cell<bool>,
    registering: Notify,
    worker_close: CancellationToken,
    closed: Notify,
    requests: RefCell<Vec<AgentProducerBinding>>,
    listeners: RefCell<Vec<Listener>>,
}

#[async_trait(?Send)]
impl AgentProducers for Producers {
    fn scope(&self) -> &AgentResourceScope {
        &self.scope
    }

    async fn bind(
        &self,
        request: AgentProducerBindRequest,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        self.log.push(json!(["bind", request.chat_id]));
        self.requests.borrow_mut().push(request.binding);
        if self.scenario == "exhausted"
            || (self.scenario == "retry" && self.requests.borrow().len() < 3)
        {
            return Err(ExecutorSessionLostError::new(
                AgentDeliveryOutcome::NotDispatched,
                "session lost",
            )
            .into());
        }
        if matches!(self.scenario.as_str(), "close-during-bind" | "join-cancel") {
            self.registering.notified().await;
        }
        Ok(())
    }

    async fn close(
        &self,
        _: AgentProducerBinding,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        self.log.push(json!(["close"]));
        if matches!(
            self.scenario.as_str(),
            "close-during-bind" | "replace-while-closing"
        ) {
            self.worker_close.cancelled().await;
        }
        self.closed.notify_one();
        Ok(())
    }

    fn detach(&self, _: AgentProducerBinding) {}

    fn subscribe(&self, listener: Listener) -> Box<dyn Fn()> {
        self.log.subscriptions.set(self.log.subscriptions.get() + 1);
        self.listeners.borrow_mut().push(listener);
        Box::new(|| {})
    }
}

impl Producers {
    fn new(scenario: &str, log: Rc<Log>) -> Self {
        Self {
            log,
            scenario: scenario.into(),
            scope: AgentResourceScope {
                executor_id: "local".into(),
                instance_id: "worker".into(),
                integration_id: "test".into(),
            },
            reconnecting: Cell::default(),
            registering: Notify::new(),
            worker_close: CancellationToken::new(),
            closed: Notify::new(),
            requests: RefCell::default(),
            listeners: RefCell::default(),
        }
    }

    fn target(self: &Rc<Self>) -> ProducerBindingTarget {
        let producer = self.clone();
        ProducerBindingTarget {
            agent_id: "test".into(),
            producers: self.clone(),
            read_scope: Rc::new(move || {
                producer.log.scopes.set(producer.log.scopes.get() + 1);
                if producer.reconnecting.get() {
                    return Err(io::Error::other("Executor is reconnecting").into());
                }
                Ok(producer.scope().clone())
            }),
        }
    }

    fn emit(&self, binding: &AgentProducerBinding, event: AgentProducerNotificationEvent) {
        for listener in self.listeners.borrow().iter() {
            listener(AgentProducerNotification {
                binding: binding.clone(),
                event: event.clone(),
            })
            .unwrap();
        }
    }

    fn rows(&self, binding: &AgentProducerBinding) {
        self.emit(
            binding,
            AgentProducerNotificationEvent::Provider(AgentProducerEvent::Rows { rows: vec![] }),
        );
    }

    fn control(&self, binding: &AgentProducerBinding, event: AgentProducerControlEvent) {
        self.emit(binding, AgentProducerNotificationEvent::Control(event));
    }
}

struct Fixture {
    log: Rc<Log>,
    bindings: Rc<ProducerBindings>,
    producers: Rc<Producers>,
}

impl Fixture {
    fn new(scenario: &str) -> Self {
        let log = Rc::new(Log::default());
        let ids = Cell::new(0);
        let bindings = Rc::new(ProducerBindings::new(log.clone(), move || {
            ids.set(ids.get() + 1);
            format!("binding-{}", ids.get())
        }));
        let producers = Rc::new(Producers::new(scenario, log.clone()));
        Self {
            log,
            bindings,
            producers,
        }
    }

    fn lease(&self, label: &str) -> Rc<dyn TranscriptProducerLease> {
        Rc::new(Lease {
            log: self.log.clone(),
            label: label.into(),
            closed: Cell::default(),
            on_closed: RefCell::default(),
        })
    }

    async fn bind(
        &self,
        chat: &str,
        lease: &Rc<dyn TranscriptProducerLease>,
    ) -> ExecutorResult<AgentProducerBinding> {
        self.bindings
            .bind(
                self.producers.target(),
                chat,
                lease.clone(),
                ProducerBindingOptions::default(),
            )
            .await
    }
}

async fn trace(scenario: &str) -> Value {
    let fixture = Fixture::new(scenario);
    let Fixture {
        log,
        bindings,
        producers,
    } = &fixture;
    let mut result = Vec::new();
    match scenario {
        "dedup" => {
            for _ in 0..3 {
                let lease = fixture.lease("chat");
                let binding = fixture.bind("chat", &lease).await.unwrap();
                result.push(json!(
                    binding == fixture.bind("chat", &lease).await.unwrap()
                ));
                lease.close();
            }
        }
        "publication-failed" | "sink-error" => {
            let bad = fixture.lease(if scenario == "sink-error" {
                "fenced"
            } else {
                "failed"
            });
            let good = fixture.lease("healthy");
            let binding = fixture.bind("bad", &bad).await.unwrap();
            let other = fixture.bind("healthy", &good).await.unwrap();
            if scenario == "publication-failed" {
                producers.control(
                    &binding,
                    AgentProducerControlEvent::PublicationFailed {
                        error: AgentRunFailureDetail {
                            code: "OUTCOME_UNKNOWN".into(),
                            message: Some("Synthetic publication failure".into()),
                        },
                    },
                );
            }
            producers.rows(&binding);
            producers.rows(&other);
            result.extend([json!(bad.closed()), json!(good.closed())]);
            bad.close();
            good.close();
        }
        "scope-unavailable" => {
            let lease = fixture.lease("chat");
            let binding = fixture.bind("chat", &lease).await.unwrap();
            producers.reconnecting.set(true);
            producers.rows(&binding);
            for slot in 0..4 {
                let mut other = binding.clone();
                *match slot {
                    0 => &mut other.scope.instance_id,
                    1 => &mut other.scope.executor_id,
                    2 => &mut other.scope.integration_id,
                    _ => &mut other.id,
                } = "another".into();
                producers.rows(&other);
            }
            result.push(binding_result(
                fixture.bind("offline", &fixture.lease("offline")).await,
            ));
            lease.close();
        }
        "close-during-bind" => {
            let lease = fixture.lease("chat");
            let (first, second, ()) = tokio::join!(biased;
            fixture.bind("chat", &lease), fixture.bind("chat", &lease), async {
                lease.close();
                producers.registering.notify_one();
            });
            result.extend([
                binding_result(first),
                binding_result(second),
                binding_result(fixture.bind("chat", &lease).await),
            ]);
            producers.worker_close.cancel();
        }
        "replace-while-closing" => {
            let old = fixture.lease("old");
            let previous = fixture.bind("chat", &old).await.unwrap();
            old.close();
            let lease = fixture.lease("new");
            let next = fixture.bind("chat", &lease).await.unwrap();
            producers.rows(&previous);
            producers.rows(&next);
            result.push(binding_result(fixture.bind("chat", &old).await));
            lease.close();
            producers.worker_close.cancel();
        }
        "control-events" => {
            let lease = fixture.lease("chat");
            let binding = fixture.bind("chat", &lease).await.unwrap();
            let effects = log.clone();
            bindings.on_started("run".into(), move || {
                effects.push(json!(["started"]));
                Some(Box::pin(async {
                    Err(io::Error::other("Synthetic start failure").into())
                }))
            });
            result.push(json!(bindings.has_started("run")));
            for _ in 0..2 {
                producers.control(
                    &binding,
                    AgentProducerControlEvent::Started {
                        run_id: "run".into(),
                    },
                );
            }
            result.push(json!(bindings.has_started("run")));
            producers.control(
                &binding,
                AgentProducerControlEvent::Steerable {
                    run_id: "run".into(),
                },
            );
            producers.control(&binding, AgentProducerControlEvent::PublicationGap);
            producers.control(
                &binding,
                AgentProducerControlEvent::LaunchSettled {
                    run_id: "run".into(),
                    outcome: AgentLaunchOutcome::Failed {
                        error: AgentRunFailureDetail {
                            code: "OUTCOME_UNKNOWN".into(),
                            message: None,
                        },
                    },
                },
            );
            producers.emit(
                &binding,
                AgentProducerNotificationEvent::Provider(AgentProducerEvent::RunEnded {
                    run_id: "run".into(),
                    outcome: AgentRunOutcome::Interrupted,
                    working_directory: None,
                }),
            );
            result.push(json!(bindings.has_started("run")));
            lease.close();
        }
        "join-cancel" => {
            let lease = fixture.lease("chat");
            let (first, ()) = tokio::join!(biased; fixture.bind("chat", &lease), async {
                let expired = bindings.bind(producers.target(), "chat", lease.clone(), ProducerBindingOptions {
                    call: ExecutorCallOptions { dispatch_deadline: Some(performance_now_ms() + 10.0), ..Default::default() },
                    ..Default::default()
                }).await;
                result.push(binding_result(expired));
                let signal = CancellationToken::new();
                let stopped = bindings.bind(producers.target(), "chat", lease.clone(), ProducerBindingOptions {
                    call: ExecutorCallOptions { signal: Some(signal.clone()), ..Default::default() },
                    abort_reason: Some(Rc::new(|| io::Error::other("Synthetic stop").into())),
                });
                let (stopped, ()) = tokio::join!(biased; stopped, async { signal.cancel() });
                result.push(binding_result(stopped));
                producers.registering.notify_one();
            });
            result.push(binding_result(first));
            lease.close();
        }
        "retry" => {
            let lease = fixture.lease("chat");
            result.push(binding_result(fixture.bind("chat", &lease).await));
            let requests = producers.requests.borrow();
            assert_eq!(requests.len(), 3);
            assert_ne!(requests[0].id, requests[1].id);
            assert_ne!(requests[1].id, requests[2].id);
            lease.close();
        }
        _ => panic!("unknown scenario {scenario}"),
    }
    tokio::task::yield_now().await;
    json!({ "result": result, "calls": *log.calls.borrow(), "errors": *log.errors.borrow(),
        "scopes": log.scopes.get(), "subscriptions": log.subscriptions.get() })
}

#[test]
fn producer_binding_recordings() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = LocalSet::new();
    replay(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/cases/producer-bindings"),
        |function, args| {
            if function != "producerBindingsTrace" {
                return Err(CaseError::unhandled(function));
            }
            let scenario = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("missing bindings scenario"))?;
            local
                .block_on(&runtime, async {
                    tokio::time::timeout(Duration::from_secs(2), trace(scenario)).await
                })
                .map_err(|error| CaseError::undeliverable(error.to_string()))
        },
    );
}

#[tokio::test]
async fn does_not_retain_replaced_integrations_after_their_final_binding_closes() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new("live");
            for _ in 0..10 {
                let producer = Rc::new(Producers::new("retiring", fixture.log.clone()));
                let weak = Rc::downgrade(&producer);
                let lease = fixture.lease("chat");
                fixture
                    .bindings
                    .bind(
                        producer.target(),
                        "chat",
                        lease.clone(),
                        ProducerBindingOptions::default(),
                    )
                    .await
                    .unwrap();
                lease.close();
                producer.closed.notified().await;
                drop(producer);
                assert!(weak.upgrade().is_none());
            }
            let lease = fixture.lease("replacement");
            fixture.bind("chat", &lease).await.unwrap();
            lease.close();
            fixture.producers.closed.notified().await;
        })
        .await;
}

#[tokio::test]
async fn dropping_the_first_waiter_does_not_drop_worker_registration() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new("join-cancel");
            let lease = fixture.lease("chat");
            {
                let first = fixture.bind("chat", &lease);
                tokio::pin!(first);
                tokio::select! {
                    biased;
                    _ = &mut first => panic!("registration settled early"),
                    () = std::future::ready(()) => {},
                }
            }
            assert_eq!(fixture.producers.requests.borrow().len(), 1);
            fixture.producers.registering.notify_one();
            let binding = fixture.bind("chat", &lease).await.unwrap();
            assert_eq!(fixture.producers.requests.borrow().as_slice(), [binding]);
            lease.close();
            fixture.producers.closed.notified().await;
        })
        .await;
}

#[tokio::test]
async fn concurrent_waiters_keep_the_concrete_session_loss_after_exhausted_retries() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new("exhausted");
            let lease = fixture.lease("chat");
            let (first, second) =
                tokio::join!(fixture.bind("chat", &lease), fixture.bind("chat", &lease),);
            for result in [first, second] {
                let error = result.unwrap_err();
                assert!(error.is::<ExecutorSessionLostError>());
                assert_eq!(
                    as_agent_call_error(error.as_ref()).unwrap().outcome,
                    AgentDeliveryOutcome::NotDispatched,
                );
            }
            assert_eq!(fixture.producers.requests.borrow().len(), 3);
            lease.close();
        })
        .await;
}
