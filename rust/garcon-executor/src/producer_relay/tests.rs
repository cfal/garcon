use std::pin::pin;

use async_trait::async_trait;
use garcon_contract::chat_types::parse_chat_message;
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::execution::AgentRunningSession;
use garcon_interface::execution_v5::{
    AgentExecutionKind, AgentResumeRequestV5, AgentStartRequestV5,
};
use garcon_interface::producer::{AgentProducedRow, AgentProducerBindRequest, AgentRunOutcome};
use garcon_interface::resources::{
    AgentProducerBindingKind, AgentResourceScope, ExecutorCallOptions, create_agent_resource_ref,
};
use garcon_js::json;
use serde_json::Value;
use tokio::sync::{Notify, oneshot};
use tokio::task::LocalSet;
use uuid::Uuid;

use super::*;

type Listener = Rc<dyn Fn(AgentProducerNotification) -> ExecutorResult<()>>;
type UndeliveredListeners = Rc<RefCell<Vec<Rc<dyn Fn()>>>>;

struct Producers {
    scope: AgentResourceScope,
    listeners: Rc<RefCell<Vec<Listener>>>,
    detached: RefCell<Vec<AgentProducerBinding>>,
}

#[async_trait(?Send)]
impl AgentProducers for Producers {
    fn scope(&self) -> ExecutorResult<AgentResourceScope> {
        Ok(self.scope.clone())
    }
    async fn bind(
        &self,
        _: AgentProducerBindRequest,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        panic!("the relay does not admit bindings itself");
    }
    async fn close(
        &self,
        _: AgentProducerBinding,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        panic!("the relay does not close native bindings itself");
    }
    fn detach(&self, binding: AgentProducerBinding) {
        self.detached.borrow_mut().push(binding);
    }
    fn subscribe(&self, listener: Listener) -> Box<dyn Fn()> {
        self.listeners.borrow_mut().push(listener.clone());
        let listeners = Rc::downgrade(&self.listeners);
        Box::new(move || {
            if let Some(listeners) = listeners.upgrade() {
                listeners
                    .borrow_mut()
                    .retain(|entry| !Rc::ptr_eq(&listener, entry));
            }
        })
    }
}

#[derive(Default)]
struct Execution {
    aborted: RefCell<Vec<AgentExecutionHandle>>,
    abort_called: Notify,
}

#[async_trait(?Send)]
impl AgentExecutionV5 for Execution {
    async fn start(
        &self,
        _: AgentStartRequestV5,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        panic!("the relay takes a captured native launch");
    }
    async fn resume(
        &self,
        _: AgentResumeRequestV5,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        panic!("the relay takes a captured native launch");
    }
    async fn abort(
        &self,
        handle: AgentExecutionHandle,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<bool> {
        self.aborted.borrow_mut().push(handle);
        self.abort_called.notify_one();
        Ok(true)
    }
    async fn running_sessions(
        &self,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Vec<AgentRunningSession>> {
        panic!("the relay does not inspect native sessions");
    }
}

struct Owner {
    integration: RelayIntegration,
    producers: Rc<Producers>,
    execution: Rc<Execution>,
}

impl Owner {
    fn new(relay: &Rc<ProducerRelay>) -> Self {
        let producers = Rc::new(Producers {
            scope: AgentResourceScope {
                executor_id: "executor-1".into(),
                instance_id: "instance-1".into(),
                integration_id: "test".into(),
            },
            listeners: Rc::default(),
            detached: RefCell::default(),
        });
        let execution = Rc::new(Execution::default());
        let integration = RelayIntegration {
            producers: producers.clone(),
            execution: execution.clone(),
        };
        relay.track(&integration);
        Self {
            integration,
            producers,
            execution,
        }
    }

    fn bind(&self, relay: &ProducerRelay, session: &Session) -> AgentProducerBinding {
        let reference = create_agent_resource_ref(
            self.producers.scope.clone(),
            AgentProducerBindingKind::Producer,
            || Uuid::new_v4().to_string(),
        );
        relay.bind(&session.offer, &self.integration, reference.clone());
        reference
    }

    fn handle(&self) -> AgentExecutionHandle {
        create_agent_resource_ref(
            self.producers.scope.clone(),
            AgentExecutionKind::Execution,
            || Uuid::new_v4().to_string(),
        )
    }

    fn publish(&self, reference: &AgentProducerBinding, event: AgentProducerNotificationEvent) {
        for listener in self.producers.listeners.borrow().iter() {
            listener(AgentProducerNotification {
                binding: reference.clone(),
                event: event.clone(),
            })
            .unwrap();
        }
    }

    fn resume(
        &self,
        relay: &Rc<ProducerRelay>,
        session: &Session,
        bindings: &[(&AgentProducerBinding, u64)],
    ) -> Vec<ProducerResumeState<AgentExecutionHandle>> {
        relay.resume(
            &session.offer,
            &self.integration,
            bindings
                .iter()
                .map(|(binding, seq)| (binding.id.clone(), *seq)),
        )
    }

    async fn launch<Fut: Future<Output = ExecutorResult<AgentExecutionHandle>>>(
        &self,
        relay: &Rc<ProducerRelay>,
        session: &Session,
        reference: &AgentProducerBinding,
        run_id: &str,
        control: &LaunchControl,
        run: impl FnOnce(CancellationToken) -> Fut,
    ) -> ExecutorResult<AgentExecutionHandle> {
        relay
            .launch(
                &session.offer,
                &self.integration,
                LaunchRequest {
                    producer_binding: reference,
                    run_id,
                },
                control.signal.clone(),
                control.observer(),
                run,
            )
            .await
    }
}

#[derive(Default)]
struct LaunchControl {
    signal: CancellationToken,
    undelivered: UndeliveredListeners,
}

impl LaunchControl {
    fn observer(&self) -> ObserveUndeliveredReply {
        let undelivered = self.undelivered.clone();
        Rc::new(move |listener| undelivered.borrow_mut().push(listener))
    }
    fn miss_reply(&self) {
        for callback in self.undelivered.take() {
            callback();
        }
    }
}

struct Session {
    offer: ProducerRelaySession,
    sent: Rc<RefCell<Vec<String>>>,
    capacity: Rc<Cell<usize>>,
}

impl Session {
    fn new(capacity: usize) -> Self {
        let sent: Rc<RefCell<Vec<String>>> = Rc::default();
        let capacity = Rc::new(Cell::new(capacity));
        let offer: ProducerRelaySession = Rc::new({
            let sent = sent.clone();
            let capacity = capacity.clone();
            move |frame| {
                if sent.borrow().len() >= capacity.get() {
                    return false;
                }
                sent.borrow_mut().push(frame);
                true
            }
        });
        Self {
            offer,
            sent,
            capacity,
        }
    }

    fn unlimited() -> Self {
        Self::new(usize::MAX)
    }

    fn frames(&self) -> Vec<Value> {
        self.sent
            .borrow()
            .iter()
            .map(|text| json::parse(text).unwrap())
            .collect()
    }

    fn seqs(&self) -> Vec<u64> {
        self.frames()
            .iter()
            .map(|frame| json::as_number(&frame["seq"]).unwrap() as u64)
            .collect()
    }

    fn texts(&self) -> Vec<String> {
        self.frames()
            .iter()
            .map(|frame| {
                let event = &frame["notification"]["event"];
                event["rows"][0]["message"]["content"]
                    .as_str()
                    .or_else(|| event["type"].as_str())
                    .unwrap()
                    .to_owned()
            })
            .collect()
    }
}

fn rows(content: &str) -> AgentProducerNotificationEvent {
    let message = parse_chat_message(&serde_json::json!({
        "type":"assistant-message","timestamp":"now","content":content,
    }))
    .unwrap()
    .unwrap();
    AgentProducerNotificationEvent::Provider(AgentProducerEvent::Rows {
        rows: vec![AgentProducedRow {
            message,
            provider_meta: None,
        }],
    })
}

fn started(run_id: &str) -> AgentProducerNotificationEvent {
    AgentProducerNotificationEvent::Control(AgentProducerControlEvent::Started {
        run_id: run_id.into(),
    })
}

fn ended(run_id: &str) -> AgentProducerNotificationEvent {
    AgentProducerNotificationEvent::Provider(AgentProducerEvent::RunEnded {
        run_id: run_id.into(),
        outcome: AgentRunOutcome::Finished {
            final_response: None,
        },
        working_directory: None,
    })
}

fn ack(relay: &ProducerRelay, session: &Session, reference: &AgentProducerBinding, seq: u64) {
    relay.acknowledge(
        &session.offer,
        vec![ProducerAcknowledgement {
            binding_id: reference.id.clone(),
            seq,
        }],
    );
}

#[tokio::test(start_paused = true)]
async fn replays_only_unacknowledged_frames_before_new_output() {
    LocalSet::new()
        .run_until(async {
            let relay = ProducerRelay::new(Default::default());
            let owner = Owner::new(&relay);
            let first = Session::unlimited();
            let reference = owner.bind(&relay, &first);
            for text in ["one", "two", "three"] {
                owner.publish(&reference, rows(text));
            }
            ack(&relay, &first, &reference, 2);
            relay.suspend(&first.offer);
            owner.publish(&reference, rows("during gap"));
            owner.publish(&reference, ended("run-1"));
            let second = Session::new(2);
            let resumed = owner.resume(&relay, &second, &[(&reference, 1)]);
            assert_eq!(resumed[0].binding_id, reference.id);
            assert_eq!(resumed[0].replay_through_seq, 5);
            assert!(resumed[0].launch.is_none());
            assert!(resumed[0].received_run_ids.is_empty());
            owner.publish(&reference, rows("newer"));
            assert_eq!(first.seqs(), [1, 2, 3]);
            assert_eq!(second.texts(), ["three", "during gap"]);
            second.capacity.set(10);
            sleep(Duration::from_millis(30)).await;
            assert_eq!(second.seqs(), [3, 4, 5, 6]);
            assert_eq!(
                second.texts(),
                ["three", "during gap", "run-ended", "newer"]
            );
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn resumes_several_bindings_in_publication_order() {
    LocalSet::new()
        .run_until(async {
            let relay = ProducerRelay::new(Default::default());
            let owner = Owner::new(&relay);
            let first = Session::unlimited();
            let left = owner.bind(&relay, &first);
            let right = owner.bind(&relay, &first);
            relay.suspend(&first.offer);
            owner.publish(&left, rows("left first"));
            owner.publish(&right, rows("right"));
            owner.publish(&left, rows("left second"));
            let second = Session::unlimited();
            owner.resume(&relay, &second, &[(&right, 0), (&left, 0)]);
            assert_eq!(second.texts(), ["left first", "right", "left second"]);
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn drops_oldest_rows_without_losing_facts_or_skipping_queued_rows() {
    LocalSet::new()
        .run_until(async {
            let relay = ProducerRelay::new(ProducerRelayOptions {
                retained_bytes: 2048,
                ..Default::default()
            });
            let owner = Owner::new(&relay);
            let first = Session::new(2);
            let reference = owner.bind(&relay, &first);
            for label in ["one", "two", "three"] {
                owner.publish(&reference, rows(&format!("{label}:{}", "x".repeat(600))));
            }
            first.capacity.set(9);
            sleep(Duration::from_millis(30)).await;
            assert_eq!(first.seqs(), [1, 2, 3]);
            ack(&relay, &first, &reference, 3);
            relay.suspend(&first.offer);
            owner.publish(&reference, started("run"));
            for _ in 0..6 {
                owner.publish(&reference, rows(&"x".repeat(600)));
            }
            owner.publish(&reference, ended("run"));
            let second = Session::unlimited();
            owner.resume(&relay, &second, &[(&reference, 3)]);
            let seqs = second.seqs();
            assert_eq!((seqs.first(), seqs.last()), (Some(&4), Some(&11)));
            assert_eq!(second.texts().first().unwrap(), "started");
            assert_eq!(second.texts().last().unwrap(), "run-ended");
            assert!(seqs.len() < 8 && seqs[1] > 5);
            assert!(second.sent.borrow().iter().map(String::len).sum::<usize>() < 3_000);
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn replay_ends_at_the_last_retained_frame_and_pins_a_reported_tail() {
    LocalSet::new()
        .run_until(async {
            for pin_tail in [false, true] {
                let relay = ProducerRelay::new(ProducerRelayOptions {
                    retained_bytes: 2048,
                    ..Default::default()
                });
                let owner = Owner::new(&relay);
                let first = Session::unlimited();
                let reference = owner.bind(&relay, &first);
                let other = owner.bind(&relay, &first);
                relay.suspend(&first.offer);
                let second = Session::new(if pin_tail { 0 } else { usize::MAX });
                if pin_tail {
                    owner.publish(&reference, rows(&format!("old:{}", "x".repeat(600))));
                    owner.publish(&reference, rows(&format!("tail:{}", "x".repeat(600))));
                    assert_eq!(
                        owner.resume(&relay, &second, &[(&reference, 0)])[0].replay_through_seq,
                        2
                    );
                    owner.publish(&other, rows(&"x".repeat(1400)));
                    second.capacity.set(8);
                    sleep(Duration::from_millis(30)).await;
                    assert_eq!(second.seqs(), [2]);
                    assert!(second.texts()[0].starts_with("tail:"));
                } else {
                    owner.publish(&reference, started("run"));
                    owner.publish(&reference, rows(&"x".repeat(1200)));
                    owner.publish(&other, rows(&"x".repeat(500)));
                    assert_eq!(
                        owner.resume(&relay, &second, &[(&reference, 0)])[0].replay_through_seq,
                        1
                    );
                    assert_eq!(second.seqs(), [1]);
                }
            }
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn expires_only_suspended_bindings_and_never_extends_their_grace() {
    LocalSet::new()
        .run_until(async {
            for (grace, superseded_grace, replace) in
                [(10, 10, false), (10, 60_000, true), (60_000, 10, true)]
            {
                let relay = ProducerRelay::new(ProducerRelayOptions {
                    grace: Duration::from_millis(grace),
                    superseded_grace: Duration::from_millis(superseded_grace),
                    ..Default::default()
                });
                let owner = Owner::new(&relay);
                let stranger = Owner::new(&relay);
                let first = Session::unlimited();
                let second = Session::unlimited();
                let orphan = owner.bind(&relay, &first);
                let kept = owner.bind(&relay, &first);
                assert!(relay.owns(&first.offer, &owner.integration, &orphan));
                relay.suspend(&first.offer);
                assert!(relay.suspended(&owner.integration, &orphan));
                owner.publish(&orphan, rows("orphaned"));
                if replace {
                    relay.shorten_suspended_grace();
                }
                assert!(stranger.resume(&relay, &second, &[(&kept, 0)]).is_empty());
                assert_eq!(owner.resume(&relay, &second, &[(&kept, 0)]).len(), 1);
                sleep(Duration::from_millis(30)).await;
                assert_eq!(
                    &*owner.producers.detached.borrow(),
                    std::slice::from_ref(&orphan)
                );
                assert!(owner.resume(&relay, &second, &[(&orphan, 0)]).is_empty());
                owner.publish(&kept, rows("first"));
                ack(&relay, &first, &kept, 1);
                stranger.publish(&kept, rows("wrong integration"));
                relay.suspend(&second.offer);
                let third = Session::unlimited();
                owner.resume(&relay, &third, &[(&kept, 0)]);
                assert_eq!(third.texts(), ["first"]);
                relay.close(&kept);
                assert!(owner.resume(&relay, &third, &[(&kept, 0)]).is_empty());
                relay.dispose();
                assert!(owner.producers.listeners.borrow().is_empty());
            }
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn reports_pending_and_completed_launches_and_the_last_eight_receipts() {
    LocalSet::new()
        .run_until(async {
            let relay = ProducerRelay::new(Default::default());
            let owner = Owner::new(&relay);
            let first = Session::unlimited();
            let reference = owner.bind(&relay, &first);
            let control = LaunchControl::default();
            let (release, gate) = oneshot::channel();
            let mut launch =
                pin!(
                    owner.launch(&relay, &first, &reference, "run-1", &control, |_| async {
                        Ok(gate.await.unwrap())
                    })
                );
            assert!(futures::poll!(&mut launch).is_pending());
            relay.suspend(&first.offer);
            let second = Session::unlimited();
            let resumed = owner.resume(&relay, &second, &[(&reference, 0)]);
            assert_eq!(resumed[0].received_run_ids, ["run-1"]);
            assert_eq!(resumed[0].replay_through_seq, 0);
            assert!(resumed[0].launch.as_ref().unwrap().handle.is_none());
            let handle = owner.handle();
            release.send(handle.clone()).unwrap();
            assert_eq!(launch.await.unwrap(), handle);
            assert_eq!(second.texts(), ["launch-settled"]);
            relay.suspend(&second.offer);
            let third = Session::unlimited();
            let resumed = owner.resume(&relay, &third, &[(&reference, 1)]);
            assert_eq!(
                resumed[0].launch.as_ref().unwrap().handle.as_ref(),
                Some(&handle)
            );
            owner.publish(&reference, ended("run-1"));
            assert!(
                owner.resume(&relay, &third, &[(&reference, 2)])[0]
                    .launch
                    .is_none()
            );
            for i in 2..=10 {
                owner
                    .launch(
                        &relay,
                        &third,
                        &reference,
                        &format!("run-{i}"),
                        &control,
                        |_| async { Ok(handle.clone()) },
                    )
                    .await
                    .unwrap();
            }
            owner
                .launch(
                    &relay,
                    &third,
                    &reference,
                    "run-failed",
                    &control,
                    |_| async { Err(std::io::Error::other("Synthetic rejection").into()) },
                )
                .await
                .unwrap_err();
            let resumed = owner.resume(&relay, &third, &[(&reference, 2)]);
            assert_eq!(
                resumed[0].received_run_ids,
                [
                    "run-4",
                    "run-5",
                    "run-6",
                    "run-7",
                    "run-8",
                    "run-9",
                    "run-10",
                    "run-failed"
                ]
            );
            assert!(resumed[0].launch.is_none());
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn lost_launch_replies_preserve_failure_and_pre_start_cancellation() {
    LocalSet::new()
        .run_until(async {
            let relay = ProducerRelay::new(Default::default());
            let owner = Owner::new(&relay);
            let first = Session::unlimited();
            let cancelled = owner.bind(&relay, &first);
            let failed = owner.bind(&relay, &first);
            let control = LaunchControl::default();
            let (fail, gate) = oneshot::channel();
            let mut cancellation = pin!(owner.launch(
                &relay,
                &first,
                &cancelled,
                "cancelled",
                &control,
                |signal| async move {
                    signal.cancelled().await;
                    Err(std::io::Error::other("Synthetic cancelled admission").into())
                }
            ));
            let mut rejection =
                pin!(
                    owner.launch(&relay, &first, &failed, "failure", &control, |_| async {
                        gate.await.unwrap();
                        Err(AgentIntegrationError::new(
                            AgentIntegrationErrorCode::AUTH_REQUIRED,
                            "Synthetic sign-in required",
                            false,
                            None,
                        )
                        .into())
                    })
                );
            assert!(futures::poll!(&mut cancellation).is_pending());
            assert!(futures::poll!(&mut rejection).is_pending());
            relay.suspend(&first.offer);
            relay.cancel_launch(&owner.integration, &cancelled.id, "wrong-run");
            assert!(futures::poll!(&mut cancellation).is_pending());
            relay.cancel_launch(&owner.integration, &cancelled.id, "cancelled");
            cancellation.await.unwrap_err();
            fail.send(()).unwrap();
            rejection.await.unwrap_err();
            let second = Session::unlimited();
            owner.resume(&relay, &second, &[(&cancelled, 0), (&failed, 0)]);
            let frames = second.frames();
            assert_eq!(
                frames[0]["notification"]["event"]["error"]["code"],
                EXECUTOR_DISCONNECTED_BEFORE_START.code
            );
            assert_eq!(
                frames[0]["notification"]["event"]["error"]["message"],
                EXECUTOR_DISCONNECTED_BEFORE_START.message
            );
            assert_eq!(
                frames[1]["notification"]["event"]["error"],
                serde_json::json!({
                    "code":"AUTH_REQUIRED","message":"Synthetic sign-in required",
                })
            );
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn caller_cancellation_survives_a_lost_session() {
    LocalSet::new()
        .run_until(async {
            let relay = ProducerRelay::new(Default::default());
            let owner = Owner::new(&relay);
            let first = Session::unlimited();
            let reference = owner.bind(&relay, &first);
            let control = LaunchControl::default();
            let mut pending = pin!(owner.launch(
                &relay,
                &first,
                &reference,
                "run",
                &control,
                |signal| async move {
                    signal.cancelled().await;
                    Err(std::io::Error::other("Synthetic cancelled admission").into())
                }
            ));
            assert!(futures::poll!(&mut pending).is_pending());
            relay.suspend(&first.offer);
            control.signal.cancel();
            tokio::time::timeout(Duration::from_secs(1), pending)
                .await
                .unwrap()
                .unwrap_err();
            let second = Session::unlimited();
            owner.resume(&relay, &second, &[(&reference, 0)]);
            assert_eq!(
                second.frames()[0]["notification"]["event"]["error"]["code"],
                EXECUTOR_DISCONNECTED_BEFORE_START.code
            );
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn a_newer_launch_aborts_the_late_handle_of_abandoned_admission() {
    LocalSet::new()
        .run_until(async {
            let relay = ProducerRelay::new(Default::default());
            let owner = Owner::new(&relay);
            let live = Session::unlimited();
            let reference = owner.bind(&relay, &live);
            let control = LaunchControl::default();
            let late = owner.handle();
            let newest = owner.handle();
            let (release, gate) = oneshot::channel();
            let mut old =
                pin!(
                    owner.launch(&relay, &live, &reference, "old", &control, |signal| {
                        let late = late.clone();
                        async move {
                            gate.await.unwrap();
                            assert!(signal.is_cancelled());
                            Ok(late)
                        }
                    })
                );
            assert!(futures::poll!(&mut old).is_pending());
            owner
                .launch(&relay, &live, &reference, "new", &control, |_| async {
                    Ok(newest.clone())
                })
                .await
                .unwrap();
            release.send(()).unwrap();
            let error = old.await.unwrap_err();
            assert_eq!(
                error.to_string(),
                "The launch was cancelled before it started."
            );
            tokio::time::timeout(
                Duration::from_secs(1),
                owner.execution.abort_called.notified(),
            )
            .await
            .unwrap();
            assert_eq!(
                &*owner.execution.aborted.borrow(),
                std::slice::from_ref(&late)
            );
            assert_eq!(
                owner.resume(&relay, &live, &[(&reference, 0)])[0]
                    .launch
                    .as_ref()
                    .unwrap()
                    .handle
                    .as_ref(),
                Some(&newest)
            );
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn live_launches_use_their_replies_unless_the_session_cannot_take_them() {
    LocalSet::new()
        .run_until(async {
            let relay = ProducerRelay::new(Default::default());
            let owner = Owner::new(&relay);
            let live = Session::unlimited();
            let reference = owner.bind(&relay, &live);
            let failed = owner.bind(&relay, &live);
            let success = LaunchControl::default();
            let failure = LaunchControl::default();
            let handle = owner.handle();
            owner
                .launch(&relay, &live, &reference, "run-1", &success, |_| async {
                    Ok(handle.clone())
                })
                .await
                .unwrap();
            let nested = AgentCallError::new(
                AgentDeliveryOutcome::Unknown,
                "Synthetic credential read outcome is unknown",
            );
            let error = owner
                .launch(&relay, &live, &failed, "run-2", &failure, |_| async {
                    Err(nested.clone().into())
                })
                .await
                .unwrap_err();
            let call = error.downcast_ref::<AgentCallError>().unwrap();
            assert_eq!(call.outcome, AgentDeliveryOutcome::Rejected);
            assert_eq!(call.code, nested.code);
            assert_eq!(call.message, nested.message);
            assert!(live.frames().is_empty());
            success.miss_reply();
            failure.miss_reply();
            let frames = live.frames();
            let handle = json::parse(&serde_json::to_string(&handle).unwrap()).unwrap();
            assert_eq!(frames[0]["notification"]["event"]["handle"], handle);
            assert_eq!(
                frames[1]["notification"]["event"]["error"]["message"],
                nested.message
            );
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn oversized_publication_is_replaced_by_an_explicit_failure() {
    LocalSet::new()
        .run_until(async {
            let relay = ProducerRelay::new(Default::default());
            let owner = Owner::new(&relay);
            let live = Session::unlimited();
            let reference = owner.bind(&relay, &live);
            owner.publish(&reference, rows(&"x".repeat(SESSION_MESSAGE_BYTES)));
            assert_eq!(live.seqs(), [1]);
            assert_eq!(live.texts(), ["publication-failed"]);
            assert_eq!(
                live.frames()[0]["notification"]["event"]["error"]["code"],
                "OUTCOME_UNKNOWN"
            );
        })
        .await;
}
