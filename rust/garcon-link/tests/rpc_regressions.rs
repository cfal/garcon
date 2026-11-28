use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome};
use garcon_js::json::{Opaque, parse};
use garcon_link::limits::RPC_CALL_LIMIT;
use garcon_link::message_session::{MessageSessionAttachment, SessionError, SessionSocket};
use garcon_link::rpc::{
    ExecutorRpc, ExecutorRpcContinuity, ParkedRpcCalls, RpcCallOptions, RpcResult, RpcTimeout,
};
use garcon_link::rpc_admission::RpcAdmissionBudgets;
use garcon_link::session_transport::{SessionTransport, SessionTransportOptions};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio::task::{LocalSet, yield_now};
use tokio::time::{Instant, sleep_until, timeout};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Wire {
    blocked: Cell<bool>,
    sent: RefCell<Vec<Value>>,
    peer: RefCell<Option<MessageSessionAttachment>>,
}

impl SessionSocket for Wire {
    fn send(&self, body: String) -> Result<(), SessionError> {
        self.sent.borrow_mut().push(parse(&body).unwrap());
        if let Some(peer) = self.peer.borrow().as_ref() {
            peer.receive(body);
        }
        Ok(())
    }

    fn can_send(&self, _: usize) -> bool {
        !self.blocked.get()
    }

    fn close(&self) {
        self.peer.borrow_mut().take();
    }
}

impl Wire {
    fn latest_id(&self) -> String {
        self.sent.borrow().last().unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
}

fn rpc() -> Rc<ExecutorRpc> {
    rpc_with_parked("session", None)
}

fn rpc_with_parked(id: &str, parked: Option<Rc<ParkedRpcCalls>>) -> Rc<ExecutorRpc> {
    ExecutorRpc::new(
        SessionTransport::new(
            id.to_owned(),
            "peer".to_owned(),
            Rc::new(|_| {}),
            SessionTransportOptions {
                max_queued_bytes: Some(8192),
                ..SessionTransportOptions::default()
            },
        )
        .unwrap(),
        ExecutorRpcContinuity {
            admission: Some(Rc::new(RpcAdmissionBudgets::default())),
            parked,
            ..ExecutorRpcContinuity::default()
        },
    )
}

#[derive(Clone, Copy, Debug)]
enum Replacement {
    PendingAfterDeadline,
    NotReceivedAfterDeadline,
    PendingBeforeDeadline,
    LostDuringReconciliation,
}

#[tokio::test]
async fn parked_call_dispatch_deadlines_follow_reconciliation_outcomes() {
    LocalSet::new()
        .run_until(async {
            for scenario in [
                Replacement::PendingAfterDeadline,
                Replacement::NotReceivedAfterDeadline,
                Replacement::PendingBeforeDeadline,
                Replacement::LostDuringReconciliation,
            ] {
                let parked = Rc::new(ParkedRpcCalls::default());
                let original = rpc_with_parked("lost", Some(parked.clone()));
                let previous_wire = Rc::new(Wire::default());
                let _previous = original.transport.attach(previous_wire.clone()).unwrap();
                let deadline = Instant::now() + Duration::from_millis(75);
                let reply = original.call(
                    "",
                    "projects.inspect",
                    Opaque::from_value(json!({"projectPath": "/test-project"})),
                    RpcCallOptions {
                        timeout: RpcTimeout::Milliseconds(2000),
                        dispatch_deadline: Some(deadline),
                        ..RpcCallOptions::default()
                    },
                );
                let id = previous_wire.latest_id();
                original.transport.close(None);
                assert_eq!(parked.size(), 1);
                let replacement = rpc_with_parked("replacement", Some(parked.clone()));
                let wire = Rc::new(Wire::default());
                let connection = replacement.transport.attach(wire.clone()).unwrap();
                let reconciling = replacement.reconcile_parked();
                tokio::pin!(reconciling);
                assert!(futures::poll!(&mut reconciling).is_pending());
                let reconcile_id = wire.latest_id();
                let reconciled = |state| {
                    connection.receive(json!({
                "type":"result","id":reconcile_id,"value":{"states":[{"id":id,"state":state}]},
            }).to_string())
                };
                match scenario {
                    Replacement::PendingAfterDeadline | Replacement::NotReceivedAfterDeadline => {
                        // The reply is processed after the deadline but before its timer runs.
                        std::thread::sleep(
                            deadline.saturating_duration_since(Instant::now())
                                + Duration::from_millis(5),
                        );
                        let pending = matches!(scenario, Replacement::PendingAfterDeadline);
                        reconciled(if pending { "pending" } else { "not-received" });
                        assert!(matches!(
                            futures::poll!(&mut reconciling),
                            std::task::Poll::Ready(Ok(()))
                        ));
                        let error = within(reply).await.unwrap_err();
                        if pending {
                            assert_eq!(
                                error.downcast_ref::<AgentCallError>().unwrap().outcome,
                                AgentDeliveryOutcome::Unknown
                            );
                            assert_eq!(
                                error.to_string(),
                                "The executor did not reconnect in time, so the outcome is unknown."
                            );
                            assert_eq!(
                                wire.sent.borrow().last().unwrap(),
                                &json!({"type":"cancel","id":id})
                            );
                        } else {
                            let error = error.downcast_ref::<AgentCallError>().unwrap();
                            assert_eq!(error.outcome, AgentDeliveryOutcome::NotDispatched);
                            assert_eq!(
                                error.to_string(),
                                "The executor did not reconnect in time."
                            );
                            assert!(
                                !wire
                                    .sent
                                    .borrow()
                                    .iter()
                                    .any(|frame| frame["method"] == "projects.inspect")
                            );
                        }
                    }
                    Replacement::PendingBeforeDeadline => {
                        reconciled("pending");
                        within(reconciling).await.unwrap();
                        sleep_until(deadline + Duration::from_millis(5)).await;
                        result(&connection, &id);
                        assert_eq!(within(reply).await.unwrap().unwrap().as_value(), &json!([]));
                    }
                    Replacement::LostDuringReconciliation => {
                        replacement.transport.close(None);
                        assert_eq!(parked.size(), 1);
                        assert!(within(reconciling).await.is_err());
                        assert_outcome(
                            within(reply).await,
                            AgentDeliveryOutcome::Unknown,
                            "The executor did not reconnect in time, so the outcome is unknown.",
                        );
                    }
                }
                assert_eq!(parked.size(), 0, "{scenario:?}");
                replacement.transport.close(None);
                parked.close();
            }
        })
        .await;
}

fn pair() -> (Rc<ExecutorRpc>, Rc<ExecutorRpc>, Rc<Wire>) {
    let client = rpc();
    let server = rpc();
    let client_wire = Rc::new(Wire::default());
    let server_wire = Rc::new(Wire::default());
    let client_end = client.transport.attach(client_wire.clone()).unwrap();
    let server_end = server.transport.attach(server_wire.clone()).unwrap();
    *client_wire.peer.borrow_mut() = Some(server_end);
    *server_wire.peer.borrow_mut() = Some(client_end);
    (client, server, server_wire)
}

fn call(rpc: &Rc<ExecutorRpc>, options: RpcCallOptions) -> impl Future<Output = RpcResult> + use<> {
    rpc.call(
        "",
        "execution.runningSessions",
        Opaque::from_value(Value::Null),
        options,
    )
}

fn assert_outcome(result: RpcResult, outcome: AgentDeliveryOutcome, message: &str) {
    let error = result.unwrap_err();
    assert_eq!(
        error.downcast_ref::<AgentCallError>().unwrap().outcome,
        outcome
    );
    assert_eq!(error.to_string(), message);
}

async fn within<T>(future: impl Future<Output = T>) -> T {
    timeout(Duration::from_secs(2), future).await.unwrap()
}

#[tokio::test(start_paused = true)]
async fn invalid_rpc_deadline_rejects_before_dispatch() {
    LocalSet::new()
        .run_until(async {
            let client = rpc();
            let wire = Rc::new(Wire::default());
            let _connection = client.transport.attach(wire.clone()).unwrap();
            for millis in [0, i32::MAX as u64 + 1, u64::MAX] {
                assert_outcome(
                    call(
                        &client,
                        RpcCallOptions {
                            timeout: RpcTimeout::Milliseconds(millis),
                            ..RpcCallOptions::default()
                        },
                    )
                    .await,
                    AgentDeliveryOutcome::NotDispatched,
                    "Invalid executor deadline",
                );
            }
            assert!(wire.sent.borrow().is_empty());
            assert!(client.transport.connected());
            client.transport.close(None);
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn queue_saturation_rejects_a_new_call_before_dispatch_without_retiring_the_session() {
    LocalSet::new()
        .run_until(async {
            let rpc = rpc();
            let wire = Rc::new(Wire::default());
            let _connection = rpc.transport.attach(wire.clone()).unwrap();
            wire.blocked.set(true);
            let start = || {
                rpc.call(
                    "",
                    "execution.start",
                    Opaque::from_value(json!({"prompt":"p".repeat(850)})),
                    RpcCallOptions {
                        timeout: RpcTimeout::None,
                        ..RpcCallOptions::default()
                    },
                )
            };
            let pending: Vec<_> = (0..8).map(|_| start()).collect();
            let queued = rpc.transport.channel.queued_frames();
            assert_eq!(queued, pending.len());
            assert_outcome(
                within(start()).await,
                AgentDeliveryOutcome::NotDispatched,
                "The connection to the executor is backed up. Try again shortly.",
            );
            assert!(wire.sent.borrow().is_empty());
            assert!(rpc.transport.connected());
            assert_eq!(rpc.transport.channel.queued_frames(), queued);
            rpc.transport.close(None);
            for call in pending {
                assert!(within(call).await.is_err());
            }
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn reply_guards_retain_their_call_context_across_handler_replacement_and_run_before_enqueue()
{
    LocalSet::new()
        .run_until(async {
            let (client, server, _) = pair();
            let (entered, running) = oneshot::channel();
            let (release, held) = oneshot::channel();
            let pending = RefCell::new(Some((entered, held)));
            let guarded = Rc::new(Cell::new(0));
            let transport = Rc::downgrade(&server.transport);
            server.handle(Rc::new({
                let guarded = guarded.clone();
                move |request, _, guard, _| {
                    let (entered, held) = pending.borrow_mut().take().unwrap();
                    let guarded = guarded.clone();
                    let value = json!(["synthetic command"]);
                    let bytes = json!({"type":"result","id":request.id,"value":value})
                        .to_string()
                        .len();
                    let transport = transport.clone();
                    guard(Rc::new(move |encoded| {
                        guarded.set(guarded.get() + 1);
                        assert_eq!(encoded, bytes);
                        assert_eq!(transport.upgrade().unwrap().channel.queued_bytes(), 0);
                        Err(Rc::new(AgentCallError::new(
                            AgentDeliveryOutcome::Rejected,
                            "Original authorization expired",
                        )))
                    }));
                    Box::pin(async move {
                        entered.send(()).unwrap();
                        held.await.unwrap();
                        Ok(Some(Opaque::from_value(value)))
                    })
                }
            }));
            let reply = call(&client, RpcCallOptions::default());
            within(running).await.unwrap();
            server.handle(Rc::new(|_, _, _, _| {
                Box::pin(async { Ok(Some(Opaque::from_value(json!([])))) })
            }));
            release.send(()).unwrap();
            assert_outcome(
                within(reply).await,
                AgentDeliveryOutcome::Rejected,
                "Original authorization expired",
            );
            assert_eq!(guarded.get(), 1);
            assert_eq!(
                within(call(&client, RpcCallOptions::default()))
                    .await
                    .unwrap()
                    .unwrap()
                    .as_value(),
                &json!([])
            );
            client.transport.close(None);
            server.transport.close(None);
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn reply_queue_refusal_reports_uncertainty_and_notifies_only_the_affected_handler() {
    LocalSet::new()
        .run_until(async {
            let (client, server, wire) = pair();
            let (entered, running) = oneshot::channel();
            let (release, held) = oneshot::channel();
            let (refused, refusal) = oneshot::channel();
            let pending = RefCell::new(Some((entered, held, refused)));
            server.handle(Rc::new(move |_, _, _, observe| {
                let (entered, held, refused) = pending.borrow_mut().take().unwrap();
                let refused = RefCell::new(Some(refused));
                observe(Rc::new(move || {
                    refused.borrow_mut().take().unwrap().send(()).unwrap()
                }));
                Box::pin(async move {
                    entered.send(()).unwrap();
                    held.await.unwrap();
                    Ok(Some(Opaque::from_value(json!("x".repeat(2000)))))
                })
            }));
            let reply = call(&client, RpcCallOptions::default());
            within(running).await.unwrap();
            wire.blocked.set(true);
            server
                .transport
                .send(
                    json!({"type":"result","id":"unrelated","value":"q".repeat(7450)}).to_string(),
                )
                .unwrap();
            release.send(()).unwrap();
            within(refusal).await.unwrap();
            assert!(server.transport.connected());
            wire.blocked.set(false);
            assert_outcome(
                within(reply).await,
                AgentDeliveryOutcome::Unknown,
                "The executor's reply could not be delivered, so the outcome is unknown.",
            );
            server.handle(Rc::new(|_, _, _, observe| {
                observe(Rc::new(|| {
                    panic!("a delivered reply must not notify its observer")
                }));
                Box::pin(async { Ok(Some(Opaque::from_value(json!([])))) })
            }));
            assert_eq!(
                within(call(&client, RpcCallOptions::default()))
                    .await
                    .unwrap()
                    .unwrap()
                    .as_value(),
                &json!([])
            );
            assert!(server.transport.connected());
            client.transport.close(None);
            server.transport.close(None);
        })
        .await;
}

fn result(connection: &MessageSessionAttachment, id: &str) {
    connection.receive(json!({"type":"result","id":id,"value":[]}).to_string());
}

fn failed(connection: &MessageSessionAttachment, id: &str) {
    connection.receive(
        json!({"type":"error","id":id,"error":{
            "code":"PROVIDER_FAILURE","message":"Synthetic failure","retryable":false
        }})
        .to_string(),
    );
}

#[tokio::test(start_paused = true)]
async fn normal_results_and_cancellation_before_dispatch_never_invoke_late_cleanup() {
    LocalSet::new()
        .run_until(async {
            let rpc = rpc();
            let wire = Rc::new(Wire::default());
            let connection = rpc.transport.attach(wire.clone()).unwrap();
            let options = |signal| RpcCallOptions {
                signal,
                on_late_result: Some(Rc::new(|_| panic!("no cleanup for this call"))),
                on_late_result_lost: Some(Rc::new(|| panic!("no lost cleanup for this call"))),
                ..RpcCallOptions::default()
            };
            let cancelled = CancellationToken::new();
            cancelled.cancel();
            assert_outcome(
                call(&rpc, options(Some(cancelled))).await,
                AgentDeliveryOutcome::NotDispatched,
                "Executor is unavailable",
            );
            assert!(wire.sent.borrow().is_empty());
            let reply = call(&rpc, options(None));
            result(&connection, &wire.latest_id());
            assert_eq!(within(reply).await.unwrap().unwrap().as_value(), &json!([]));
            rpc.transport.close(None);
            yield_now().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn deadline_cancellation_cleans_up_a_late_result() {
    LocalSet::new()
        .run_until(async {
            let rpc = rpc();
            let wire = Rc::new(Wire::default());
            let connection = rpc.transport.attach(wire.clone()).unwrap();
            let (clean, cleaned) = oneshot::channel();
            let clean = RefCell::new(Some(clean));
            let reply = call(
                &rpc,
                RpcCallOptions {
                    timeout: RpcTimeout::Milliseconds(1),
                    on_late_result: Some(Rc::new(move |value| {
                        clean.borrow_mut().take().unwrap().send(value).unwrap();
                        Box::pin(async { Ok(()) })
                    })),
                    ..RpcCallOptions::default()
                },
            );
            let id = wire.latest_id();
            assert_outcome(
                within(reply).await,
                AgentDeliveryOutcome::Unknown,
                "The executor did not reply in time.",
            );
            result(&connection, &id);
            assert_eq!(
                within(cleaned).await.unwrap().unwrap().as_value(),
                &json!([])
            );
            rpc.transport.close(None);
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn retirement_reports_lost_cleanup_including_a_result_queued_immediately_before_retirement() {
    LocalSet::new()
        .run_until(async {
            let rpc = rpc();
            let wire = Rc::new(Wire::default());
            let connection = rpc.transport.attach(wire.clone()).unwrap();
            let cancelled = CancellationToken::new();
            let lost = Rc::new(Cell::new(0));
            let pending: Vec<_> = (0..2)
                .map(|_| {
                    let lost = lost.clone();
                    let reply = call(
                        &rpc,
                        RpcCallOptions {
                            signal: Some(cancelled.clone()),
                            on_late_result: Some(Rc::new(|_| {
                                panic!("cleanup must not run on a retired session")
                            })),
                            on_late_result_lost: Some(Rc::new(move || lost.set(lost.get() + 1))),
                            ..RpcCallOptions::default()
                        },
                    );
                    (wire.latest_id(), reply)
                })
                .collect();
            cancelled.cancel();
            let mut ids = Vec::new();
            for (id, reply) in pending {
                assert_outcome(
                    within(reply).await,
                    AgentDeliveryOutcome::Unknown,
                    "The request was cancelled after it was sent to the executor.",
                );
                ids.push(id);
            }
            result(&connection, &ids[0]);
            result(&connection, &ids[0]);
            rpc.transport.close(None);
            result(&connection, &ids[1]);
            yield_now().await;
            assert_eq!(lost.get(), 2);
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn late_results_and_errors_settled_before_retirement_do_not_report_lost_cleanup() {
    LocalSet::new()
        .run_until(async {
            for (settle, expected) in [
                (result as fn(&MessageSessionAttachment, &str), 1),
                (failed, 0),
            ] {
                let rpc = rpc();
                let wire = Rc::new(Wire::default());
                let connection = rpc.transport.attach(wire.clone()).unwrap();
                let cancelled = CancellationToken::new();
                let cleaned = Rc::new(Cell::new(0));
                let reply = call(
                    &rpc,
                    RpcCallOptions {
                        signal: Some(cancelled.clone()),
                        on_late_result: Some(Rc::new({
                            let cleaned = cleaned.clone();
                            move |_| {
                                cleaned.set(cleaned.get() + 1);
                                Box::pin(async { Ok(()) })
                            }
                        })),
                        on_late_result_lost: Some(Rc::new(|| panic!("settled call is not lost"))),
                        ..RpcCallOptions::default()
                    },
                );
                let id = wire.latest_id();
                cancelled.cancel();
                assert!(within(reply).await.is_err());
                settle(&connection, &id);
                yield_now().await;
                rpc.transport.close(None);
                assert_eq!(cleaned.get(), expected);
            }
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn cancelled_calls_hold_bounded_cleanup_until_a_result_or_error_settles_them() {
    LocalSet::new()
        .run_until(async {
            let rpc = rpc();
            let wire = Rc::new(Wire::default());
            let connection = Rc::new(rpc.transport.attach(wire.clone()).unwrap());
            let cancelled = CancellationToken::new();
            let (clean, cleaned) = oneshot::channel();
            let clean = RefCell::new(Some(clean));
            let on_late_result = Rc::new({
                let rpc = Rc::downgrade(&rpc);
                let connection = connection.clone();
                let wire = wire.clone();
                move |_| {
                    let clean = clean.borrow_mut().take().expect("cleanup is called once");
                    let reply = call(&rpc.upgrade().unwrap(), RpcCallOptions::default());
                    result(&connection, &wire.latest_id());
                    Box::pin(async move {
                        let reply = reply.await?;
                        clean.send(reply).unwrap();
                        Ok(())
                    })
                        as futures::future::LocalBoxFuture<'static, Result<(), SessionError>>
                }
            });
            let pending: Vec<_> = (0..RPC_CALL_LIMIT)
                .map(|_| {
                    let reply = call(
                        &rpc,
                        RpcCallOptions {
                            signal: Some(cancelled.clone()),
                            on_late_result: Some(on_late_result.clone()),
                            ..RpcCallOptions::default()
                        },
                    );
                    (wire.latest_id(), reply)
                })
                .collect();
            cancelled.cancel();
            let mut ids = Vec::new();
            for (id, reply) in pending {
                assert_outcome(
                    within(reply).await,
                    AgentDeliveryOutcome::Unknown,
                    "The request was cancelled after it was sent to the executor.",
                );
                ids.push(id);
            }
            assert_outcome(
                within(call(&rpc, RpcCallOptions::default())).await,
                AgentDeliveryOutcome::NotDispatched,
                "The executor is handling too many requests. Try again shortly.",
            );
            result(&connection, &ids[0]);
            assert_eq!(
                within(cleaned).await.unwrap().unwrap().as_value(),
                &json!([])
            );
            result(&connection, &ids[0]);
            failed(&connection, &ids[1]);
            let admitted = call(&rpc, RpcCallOptions::default());
            result(&connection, &wire.latest_id());
            assert_eq!(
                within(admitted).await.unwrap().unwrap().as_value(),
                &json!([])
            );
            rpc.transport.close(None);
        })
        .await;
}
