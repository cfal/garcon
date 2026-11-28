use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use futures::poll;
use garcon_base::{executor_disconnect::as_agent_call_error, log::create_logger};
use garcon_interface::{
    errors::AgentDeliveryOutcome,
    execution_runtime::ExecutorAvailability,
    producer::{AgentProducerBindRequest, AgentProducers},
    resources::{AgentProducerBinding, AgentProducerBindingKind},
};
use garcon_js::json::{Opaque, parse};
use garcon_link::rpc_lane::RpcLane;
use serde_json::{Value, json};
use tokio::{sync::oneshot, task::LocalSet};

use super::{
    remote_client_wire_cases::{backing, pair},
    remote_producers::RemoteProducers,
    sessions::RemoteSessions,
};

fn scope(producers: &RemoteProducers, id: &str) -> AgentProducerBinding {
    AgentProducerBinding {
        scope: producers.scope().unwrap(),
        kind: AgentProducerBindingKind::Producer,
        id: id.into(),
    }
}

fn notification(binding: &AgentProducerBinding, event: Value) -> Opaque {
    Opaque::from_value(json!({"binding":binding,"event":event}))
}

#[tokio::test]
async fn the_same_producer_api_reads_the_new_instance_scope_and_fails_while_offline() {
    LocalSet::new()
        .run_until(async {
            let sessions = Rc::new(RemoteSessions::default());
            let producers = RemoteProducers::new(
                "fixture".into(),
                sessions.clone(),
                Rc::new(create_logger("fixture")),
            );
            assert_eq!(
                producers.scope().unwrap_err().to_string(),
                "Executor is offline"
            );
            let (old, _) = pair(RpcLane::Primary, "old");
            sessions.set_backing(RpcLane::Primary, Some(backing(old, "first-worker")));
            sessions.set_availability(ExecutorAvailability::Ready);
            assert_eq!(producers.scope().unwrap().instance_id, "first-worker");
            sessions.set_backing(RpcLane::Primary, None);
            sessions.set_availability(ExecutorAvailability::Reconnecting);
            assert_eq!(producers.scope().unwrap().instance_id, "first-worker");
            sessions.set_availability(ExecutorAvailability::Offline);
            assert_eq!(
                producers.scope().unwrap_err().to_string(),
                "Executor is offline"
            );
            let (new, _) = pair(RpcLane::Primary, "new");
            sessions.set_backing(RpcLane::Primary, Some(backing(new, "next-worker")));
            sessions.set_availability(ExecutorAvailability::Ready);
            assert_eq!(producers.scope().unwrap().instance_id, "next-worker");
        })
        .await;
}

#[tokio::test]
async fn unreadable_rows_report_one_gap_and_a_bad_control_event_fails_only_its_binding() {
    LocalSet::new().run_until(async {
        let sessions = Rc::new(RemoteSessions::default());
        let (rpc, worker) = pair(RpcLane::Primary, "primary");
        let active = backing(rpc.clone(), "worker");
        sessions.set_backing(RpcLane::Primary, Some(active.clone()));
        sessions.set_availability(ExecutorAvailability::Ready);
        worker.handle(Rc::new(|_, _, _, _| Box::pin(async { Ok(None) })));
        let producers = RemoteProducers::new("fixture".into(), sessions, Rc::new(create_logger("fixture")));
        let first = scope(&producers, "first");
        let other = scope(&producers, "other");
        for binding in [&first, &other] {
            producers.bind(AgentProducerBindRequest { binding: binding.clone(), chat_id: "synthetic".into() }, None).await.unwrap();
        }
        let off_throwing = producers.subscribe(Rc::new(|_| Err("synthetic listener failure".into())));
        let received = Rc::new(RefCell::new(Vec::new()));
        let off = producers.subscribe(Rc::new({
            let received = received.clone();
            move |notification| {
                received.borrow_mut().push((notification.binding.id, parse(&serde_json::to_string(&notification.event)?)?));
                Ok(())
            }
        }));
        for (seq, kind) in [(1, "unknown-message"), (2, "constructor")] {
            producers.receive(notification(&first, json!({"type":"rows","rows":[{"message":{"type":kind}}]})), seq, &active).unwrap();
        }
        assert_eq!(received.borrow().len(), 1);
        assert_eq!(received.borrow()[0].1["type"], "publication-gap");
        producers.receive(notification(&first, json!({"type":"publication-failed","error":{"code":"PROVIDER_FAILURE","message":null}})), 3, &active).unwrap();
        assert_eq!(received.borrow()[1].1["error"]["code"], "OUTCOME_UNKNOWN");
        let row = json!({"type":"rows","rows":[{"message":{"type":"assistant-message","content":"synthetic"}}]});
        producers.receive(notification(&first, row.clone()), 4, &active).unwrap();
        producers.receive(notification(&other, row), 1, &active).unwrap();
        assert_eq!(received.borrow().len(), 3);
        assert_eq!(received.borrow()[2].0, "other");
        assert_eq!(received.borrow()[2].1["type"], "rows");
        assert!(rpc.transport.connected());
        off_throwing();
        off();
        producers.retire();
        rpc.transport.close(None);
        worker.transport.close(None);
    }).await;
}

#[tokio::test]
async fn a_resumed_launch_is_resent_once_only_after_the_reported_replay_position() {
    LocalSet::new().run_until(async {
        for worker_received in [false, true] {
            let sessions = Rc::new(RemoteSessions::default());
            let (old, old_worker) = pair(RpcLane::Primary, "old");
            let first = backing(old.clone(), "worker");
            sessions.set_backing(RpcLane::Primary, Some(first.clone()));
            sessions.set_availability(ExecutorAvailability::Ready);
            let producers = RemoteProducers::new("fixture".into(), sessions.clone(), Rc::new(create_logger("fixture")));
            let events = Rc::new(RefCell::new(Vec::new()));
            let off = producers.subscribe(Rc::new({
                let events = events.clone();
                move |notification| {
                    let event = parse(&serde_json::to_string(&notification.event)?).unwrap();
                    events.borrow_mut().push(event);
                    Ok(())
                }
            }));
            let binding = scope(&producers, "binding");
            let (saw_launch, launched) = oneshot::channel();
            let launch_admitted = RefCell::new(Some(saw_launch));
            old_worker.handle(Rc::new(move |call, signal, _, _| {
                let launch = (call.method == "execution.start").then(|| launch_admitted.take().unwrap());
                Box::pin(async move {
                    if let Some(launch) = launch {
                        launch.send(()).unwrap();
                        signal.cancelled().await;
                    }
                    Ok(None)
                })
            }));
            producers.bind(AgentProducerBindRequest { binding: binding.clone(), chat_id: "1783725900000000".into() }, None).await.unwrap();
            let input = Opaque::from_value(json!({"runId":"run","producerBinding": binding}));
            let mut launch = Box::pin(producers.launch("execution.start", &binding, "run", input, None));
            assert!(poll!(&mut launch).is_pending());
            tokio::time::timeout(Duration::from_secs(2), launched).await.unwrap().unwrap();
            old.transport.close(None);
            old_worker.transport.close(None);
            sessions.set_backing(RpcLane::Primary, None);
            sessions.set_availability(ExecutorAvailability::Reconnecting);
            let error = launch.await.unwrap_err();
            assert_eq!(as_agent_call_error(error.as_ref()).unwrap().outcome, AgentDeliveryOutcome::Unknown);

            let (new, new_worker) = pair(RpcLane::Primary, "new");
            let replacement = backing(new.clone(), "worker");
            let dispatches = Rc::new(Cell::new(0));
            let (settle, settled) = oneshot::channel();
            let settle = RefCell::new(Some(settle));
            new_worker.handle(Rc::new({
                let binding = binding.clone();
                let dispatches = dispatches.clone();
                move |call, _, _, _| {
                    let result = match call.method.as_str() {
                        "producers.resume" => {
                            assert_eq!(call.request["bindings"][0]["acknowledgedSeq"].as_f64(), Some(0.0));
                            let seen = if worker_received { vec!["run"] } else { vec![] };
                            json!({"resumed":[{"bindingId":binding.id,"replayThroughSeq":2,"launch":null,"receivedRunIds":seen}]})
                        }
                        "execution.start" => {
                            dispatches.set(dispatches.get() + 1);
                            settle.take().unwrap().send(()).unwrap();
                            let mut handle = serde_json::to_value(&binding.scope).unwrap();
                            handle["kind"] = json!("execution");
                            handle["id"] = json!("execution");
                            handle
                        }
                        method => panic!("unexpected producer request: {method}"),
                    };
                    Box::pin(async move { Ok(Some(Opaque::from_value(result))) })
                }
            }));
            producers.resume(&replacement).await.unwrap();
            assert_eq!(dispatches.get(), 0);
            let first_row = notification(&binding, json!({"type":"rows","rows":[{"message":{"type":"assistant-message","content":"first"}}]}));
            producers.receive(first_row.clone(), 1, &replacement).unwrap();
            producers.receive(first_row, 1, &replacement).unwrap();
            assert_eq!(dispatches.get(), 0);
            let second_row = notification(&binding, json!({"type":"rows","rows":[{"message":{"type":"assistant-message","content":"second"}}]}));
            producers.receive(second_row.clone(), 2, &first).unwrap();
            assert_eq!(events.borrow().len(), 1);
            producers.receive(second_row, 2, &replacement).unwrap();
            if !worker_received {
                tokio::time::timeout(Duration::from_secs(2), async {
                    settled.await.unwrap();
                    while events.borrow().len() < 3 { tokio::task::yield_now().await; }
                }).await.unwrap();
            }
            assert_eq!(events.borrow().len(), 3);
            assert_eq!(events.borrow()[2]["type"], "launch-settled");
            assert_eq!(dispatches.get(), usize::from(!worker_received));
            if worker_received {
                assert_eq!(events.borrow()[2]["error"]["code"], "EXECUTOR_UNAVAILABLE");
            } else {
                assert_eq!(events.borrow()[2]["handle"]["id"], "execution");
            }
            off();
            producers.retire();
            new.transport.close(None);
            new_worker.transport.close(None);
        }
    }).await;
}
