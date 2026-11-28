use std::{cell::Cell, rc::Rc, time::Duration};

use futures::poll;
use garcon_base::executor_disconnect::{ExecutorSessionLostError, as_agent_call_error};
use garcon_interface::{errors::AgentDeliveryOutcome, execution_runtime::ExecutorAvailability};
use garcon_js::{json::Opaque, performance_now_ms};
use garcon_link::{limits::BULK_RPC_CALL_LIMIT, rpc::RpcCallOptions, rpc_lane::RpcLane};
use serde_json::{Value, json};
use tokio::{sync::oneshot, task::LocalSet, time};

use super::{
    remote_client_wire_cases::{backing, pair},
    sessions::{HeldCallOptions, RemoteSessions},
    wire::own_rpc_error,
};

#[tokio::test(start_paused = true)]
async fn held_calls_use_a_separate_bulk_wait_and_keep_a_call_budget() {
    LocalSet::new()
        .run_until(async {
            let (primary, _) = pair(RpcLane::Primary, "primary");
            let (bulk, _) = pair(RpcLane::Bulk, "bulk");
            let sessions = RemoteSessions::default();
            sessions.set_backing(RpcLane::Primary, Some(backing(primary.clone(), "worker")));
            sessions.set_availability(ExecutorAvailability::Ready);
            let options = HeldCallOptions {
                timeout_ms: Some(1_000.0),
                ..Default::default()
            };
            let mut wait = Box::pin(sessions.acquire(RpcLane::Bulk, &options));
            assert!(poll!(&mut wait).is_pending());
            assert_eq!(sessions.admission.snapshot().outgoing.bulk, 1);
            let primary_call = sessions.acquire(RpcLane::Primary, &options).await.unwrap();
            assert!(Rc::ptr_eq(&primary_call.backing.rpc, &primary));
            time::advance(Duration::from_millis(200)).await;
            sessions.set_backing(RpcLane::Bulk, Some(backing(bulk.clone(), "worker")));
            let call = wait.await.unwrap();
            assert_eq!(call.timeout_ms, Some(800.0));
            assert!(Rc::ptr_eq(&call.backing.rpc, &bulk));
            assert_eq!(sessions.admission.snapshot().outgoing.bulk, 0);

            sessions.set_backing(RpcLane::Bulk, None);
            let bounded = HeldCallOptions {
                dispatch_deadline: Some(performance_now_ms() + 50.0),
                ..Default::default()
            };
            let mut wait = Box::pin(sessions.acquire(RpcLane::Bulk, &bounded));
            assert!(poll!(&mut wait).is_pending());
            time::advance(Duration::from_millis(51)).await;
            let error = wait.await.err().unwrap();
            assert_eq!(error.to_string(), "The executor did not reconnect in time.");
            assert_eq!(
                as_agent_call_error(error.as_ref()).unwrap().outcome,
                AgentDeliveryOutcome::NotDispatched
            );
            assert_eq!(sessions.admission.snapshot().outgoing.bulk, 0);
        })
        .await;
}

#[tokio::test]
async fn bulk_waiters_do_not_exhaust_primary_and_drops_return_admission() {
    LocalSet::new()
        .run_until(async {
            let (primary, _) = pair(RpcLane::Primary, "primary");
            let sessions = RemoteSessions::default();
            sessions.set_backing(RpcLane::Primary, Some(backing(primary, "worker")));
            sessions.set_availability(ExecutorAvailability::Ready);
            let options = HeldCallOptions::default();
            let mut waiting = Vec::new();
            for _ in 0..BULK_RPC_CALL_LIMIT {
                let mut waiter = Box::pin(sessions.acquire(RpcLane::Bulk, &options));
                assert!(poll!(&mut waiter).is_pending());
                waiting.push(waiter);
            }
            let busy = sessions
                .acquire(RpcLane::Bulk, &options)
                .await
                .err()
                .unwrap();
            assert_eq!(
                as_agent_call_error(busy.as_ref()).unwrap().code.as_str(),
                "EXECUTOR_BUSY"
            );
            assert!(
                sessions
                    .admission
                    .outgoing
                    .acquire(RpcLane::Primary)
                    .is_ok_and(|lease| {
                        lease.release();
                        true
                    })
            );
            drop(waiting);
            assert_eq!(sessions.admission.snapshot().outgoing.total, 0);
        })
        .await;
}

#[tokio::test]
async fn a_request_proven_unsent_retries_only_on_the_same_worker_instance() {
    LocalSet::new()
        .run_until(async {
            for same_instance in [true, false] {
                let (old, _old_worker) = pair(RpcLane::Primary, "old");
                let (replacement, replacement_worker) = pair(RpcLane::Primary, "replacement");
                let sessions = RemoteSessions::default();
                sessions.set_backing(RpcLane::Primary, Some(backing(old.clone(), "worker")));
                sessions.set_availability(ExecutorAvailability::Ready);
                let received = Rc::new(Cell::new(0));
                replacement_worker.handle(Rc::new({
                    let received = received.clone();
                    move |_, _, _, _| {
                        received.set(received.get() + 1);
                        Box::pin(async { Ok(Some(Opaque::from_value(json!("received")))) })
                    }
                }));
                let mut request =
                    Box::pin(
                        sessions.send(RpcLane::Primary, HeldCallOptions::default(), |held| {
                            if Rc::ptr_eq(&old, &held.backing.rpc) {
                                // Acquisition completed but the socket retired before dispatch.
                                old.transport.close(None);
                                sessions.set_backing(RpcLane::Primary, None);
                                sessions.set_availability(ExecutorAvailability::Reconnecting);
                            }
                            let reply = held.backing.rpc.call(
                                "",
                                "projects.inspect",
                                Opaque::from_value(Value::Null),
                                RpcCallOptions::default(),
                            );
                            async { reply.await.map_err(own_rpc_error) }
                        }),
                    );
                assert!(poll!(&mut request).is_pending());
                let instance = if same_instance { "worker" } else { "restarted" };
                sessions.set_backing(RpcLane::Primary, Some(backing(replacement, instance)));
                sessions.set_availability(ExecutorAvailability::Ready);
                let result = request.await;
                if same_instance {
                    assert_eq!(result.unwrap().unwrap().as_str(), Some("received"));
                    assert_eq!(received.get(), 1);
                } else {
                    assert_eq!(
                        result.unwrap_err().to_string(),
                        "The executor restarted before the request was sent."
                    );
                    assert_eq!(received.get(), 0);
                }
            }
        })
        .await;
}

#[tokio::test]
async fn a_session_mutation_that_reached_the_worker_is_never_repeated() {
    LocalSet::new()
        .run_until(async {
            let sessions = RemoteSessions::default();
            let (original, origin_worker) = pair(RpcLane::Primary, "primary-old");
            let (replacement, replacement_worker) = pair(RpcLane::Primary, "primary-new");
            sessions.set_backing(RpcLane::Primary, Some(backing(original.clone(), "worker")));
            sessions.set_availability(ExecutorAvailability::Ready);
            let (applied, effect) = oneshot::channel();
            let (release, continue_reply) = oneshot::channel();
            let handler = std::cell::RefCell::new(Some((applied, continue_reply)));
            origin_worker.handle(Rc::new(move |_, _, _, _| {
                let (applied, continue_reply) = handler.take().expect("one side effect");
                Box::pin(async move {
                    applied.send(()).unwrap();
                    let _ = continue_reply.await;
                    Ok(Some(Opaque::from_value(json!("created"))))
                })
            }));
            let unexpected = Rc::new(Cell::new(false));
            replacement_worker.handle(Rc::new({
                let unexpected = unexpected.clone();
                move |_, _, _, _| {
                    unexpected.set(true);
                    Box::pin(async { Ok(None) })
                }
            }));
            let mut call = Box::pin(sessions.call(
                "",
                "terminals.create",
                Opaque::from_value(Value::Null),
                HeldCallOptions::default(),
            ));
            assert!(poll!(&mut call).is_pending());
            effect.await.unwrap();
            original.transport.close(None);
            sessions.set_backing(RpcLane::Primary, Some(backing(replacement, "worker")));
            let error = call.await.unwrap_err();
            assert_eq!(
                error
                    .downcast_ref::<ExecutorSessionLostError>()
                    .unwrap()
                    .outcome,
                AgentDeliveryOutcome::Unknown
            );
            assert_eq!(sessions.availability(), ExecutorAvailability::Ready);
            release.send(()).unwrap();
            origin_worker.transport.close(None);
            tokio::task::yield_now().await;
            assert!(!unexpected.get());
        })
        .await;
}
