use std::{
    cell::{Cell, RefCell},
    error::Error,
    future::{Future, ready},
    path::Path,
    pin::pin,
    rc::Rc,
    task::{Context, Waker},
};

use garcon_base::{
    domain_error::as_domain_error, errors::error_metadata,
    executor_disconnect::ExecutorSessionLostError,
};
use garcon_cases::{CaseError, replay, text, unknown};
use garcon_contract::executors::AgentExecutionTarget;
use garcon_execution::{
    directory::{AgentDirectory, ExecutionIntegrationDirectory},
    event_bus::{AgentEventBus, AgentRunCompletionOutcome, CommittedRunOutcome, TurnEventMetadata},
    listener_dispatch::{ListenerWork, dispatch_listeners_sequentially},
    session_loss_retry::{SessionLossRetrySignal, retry_after_session_loss},
    turn_identity::TurnCommandType,
    turn_operation::{TurnOperationIds, operation_identity, operation_metadata},
    types::ExecutionOperationResult,
};
use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome},
    integration::AgentIntegration,
    producer::AgentRunFailureDetail,
};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

const CHAT: &str = "chat-1";

fn outcome<T>(result: Result<T, impl Error + 'static>, encode: impl FnOnce(T) -> Value) -> Value {
    match result {
        Ok(value) => encode(value),
        Err(error) => {
            json!({"error":error.to_string(),"code":as_domain_error(&error).map(|error| error.code.as_str())})
        }
    }
}

#[derive(Default)]
struct DirectoryPorts {
    ready: bool,
    calls: RefCell<Vec<Value>>,
}

impl ExecutionIntegrationDirectory for DirectoryPorts {
    fn require_integration(
        &self,
        target: &AgentExecutionTarget,
    ) -> ExecutionOperationResult<Rc<AgentIntegration>> {
        self.calls
            .borrow_mut()
            .push(json!(["require", target.executor_id, target.agent_id]));
        Err(std::io::Error::other("integration unavailable").into())
    }

    fn known_integration(&self, target: &AgentExecutionTarget) -> Option<Rc<AgentIntegration>> {
        self.calls
            .borrow_mut()
            .push(json!(["known", target.executor_id, target.agent_id]));
        None
    }

    fn integrations_for(
        &self,
        executor_id: &str,
    ) -> ExecutionOperationResult<Vec<Rc<AgentIntegration>>> {
        self.calls.borrow_mut().push(json!(["list", executor_id]));
        Ok(Vec::new())
    }

    fn is_ready(&self, executor_id: &str) -> bool {
        self.calls.borrow_mut().push(json!(["ready", executor_id]));
        self.ready
    }
}

fn directory_trace(spec: &Value) -> Value {
    let ports = Rc::new(DirectoryPorts {
        ready: spec["ready"].as_bool().unwrap(),
        ..DirectoryPorts::default()
    });
    let directory = AgentDirectory::new(ports.clone());
    let executor = spec["executorId"].as_str();
    let required = |result: ExecutionOperationResult<Rc<AgentIntegration>>| match result {
        Ok(integration) => json!(integration.descriptor.id),
        Err(error) => {
            json!({"error":error.to_string(),"code":as_domain_error(error.as_ref()).map(|error| error.code.as_str())})
        }
    };
    let values = [
        json!(directory.has("agent", executor)),
        json!(
            directory
                .get("agent", executor)
                .map(|integration| integration.descriptor.id.clone())
        ),
        required(directory.require("agent", executor)),
        json!(
            directory
                .list(executor)
                .unwrap()
                .iter()
                .map(|integration| &integration.descriptor.id)
                .collect::<Vec<_>>()
        ),
        json!(directory.is_ready(executor)),
        outcome(directory.require_ready(executor), |()| Value::Null),
    ];
    json!({"values":values,"calls":&*ports.calls.borrow()})
}

fn turn_operation_trace(spec: &Value) -> Value {
    let command_type = match spec["commandType"].as_str().unwrap() {
        "chat-start" => TurnCommandType::ChatStart,
        "agent-run" => TurnCommandType::AgentRun,
        "fork-run" => TurnCommandType::ForkRun,
        "agent-compact" => TurnCommandType::AgentCompact,
        supplied => panic!("undeliverable turn command {supplied}"),
    };
    let ids = &spec["ids"];
    let mut generated = 0;
    let operation = operation_identity(
        spec["epoch"].as_str(),
        TurnOperationIds {
            client_request_id: ids["clientRequestId"].as_str(),
            client_message_id: ids["clientMessageId"].as_str(),
            turn_id: ids["turnId"].as_str(),
        },
        command_type,
        || {
            generated += 1;
            format!("id-{generated}")
        },
    );
    let value = outcome(operation, |operation| {
        let metadata = operation_metadata(&operation);
        let mut result = serde_json::Map::new();
        result.insert("commandType".into(), json!(metadata.command_type));
        if let Some(id) = metadata.client_request_id {
            result.insert("clientRequestId".into(), json!(id));
        }
        result.insert("turnId".into(), json!(metadata.turn_id));
        result.insert(
            "agentOwnershipEpoch".into(),
            json!(metadata.agent_ownership_epoch),
        );
        result.insert("turnOwner".into(), json!(metadata.turn_owner));
        json!({"operation":operation,"metadata":result})
    });
    json!({"value":value,"generated":generated})
}

async fn retry_trace(spec: &Value) -> Value {
    let signal = CancellationToken::new();
    let calls = Cell::new(0usize);
    let steps = spec["steps"].as_array().unwrap();
    let abort = spec["abortOn"].as_u64();
    let result = retry_after_session_loss(
        || {
            let value = steps[calls.get().min(steps.len() - 1)].as_str().unwrap();
            calls.set(calls.get() + 1);
            if Some(calls.get() as u64) == abort {
                signal.cancel();
            }
            let result: ExecutionOperationResult<_> = match value {
                "ok" => Ok("resolved"),
                "plain" => Err(AgentCallError::new(
                    AgentDeliveryOutcome::Unknown,
                    "Live-session failure",
                )
                .into()),
                "other" => Err(std::io::Error::other("Other failure").into()),
                value => {
                    let delivery = match value {
                        "unknown" => AgentDeliveryOutcome::Unknown,
                        "not-dispatched" => AgentDeliveryOutcome::NotDispatched,
                        "rejected" => AgentDeliveryOutcome::Rejected,
                        unknown => panic!("undeliverable delivery outcome {unknown}"),
                    };
                    Err(ExecutorSessionLostError::new(delivery, "Lost session").into())
                }
            };
            ready(result)
        },
        Some(SessionLossRetrySignal {
            token: &signal,
            reason: &|| std::io::Error::other("Stopped").into(),
        }),
    )
    .await;
    match result {
        Ok(value) => json!({"value":value,"calls":calls.get()}),
        Err(error) => {
            let name = if error.is::<ExecutorSessionLostError>() {
                "ExecutorSessionLostError"
            } else {
                error_metadata(error.as_ref()).name
            };
            json!({"error":error.to_string(),"name":name,"calls":calls.get()})
        }
    }
}

async fn listener_trace() -> Value {
    let events = RefCell::new(Vec::new());
    let (release, pending) = oneshot::channel();
    let mut pending = Some(pending);
    let mut dispatched = pin!(dispatch_listeners_sequentially(
        0..4,
        |listener| match listener {
            0 => {
                events.borrow_mut().push("sync".to_string());
                ListenerWork::Synchronous(Ok(()))
            }
            1 => ListenerWork::Synchronous(Err(std::io::Error::other("sync failure").into())),
            2 => {
                events.borrow_mut().push("await".to_string());
                let pending = pending.take().unwrap();
                ListenerWork::Pending(Box::pin(async {
                    pending.await?;
                    Err(std::io::Error::other("async failure").into())
                }))
            }
            3 => {
                events.borrow_mut().push("last".to_string());
                ListenerWork::Synchronous(Ok(()))
            }
            _ => unreachable!(),
        },
        |error| events.borrow_mut().push(error.to_string()),
    ));
    assert!(
        dispatched
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let inline = events.borrow().clone();
    release.send(()).unwrap();
    dispatched.await;
    json!({"inline":inline,"events":&*events.borrow()})
}

fn turn(id: &str) -> TurnEventMetadata {
    TurnEventMetadata {
        command_type: Some(TurnCommandType::AgentRun),
        client_request_id: Some(format!("request-{id}")),
        turn_id: Some(id.into()),
        ..TurnEventMetadata::default()
    }
}

async fn event_trace(spec: &str) -> Value {
    let bus = Rc::new(AgentEventBus::new());
    let effects = Rc::new(RefCell::new(Vec::new()));
    let log = effects.clone();
    bus.on_finished(Rc::new(move |chat, exit, metadata, outcome| {
        log.borrow_mut().push(json!([
            "finished",
            chat,
            exit,
            metadata.and_then(|metadata| metadata.turn_id.as_deref()),
            outcome
        ]));
        ListenerWork::Synchronous(Ok(()))
    }));
    let log = effects.clone();
    bus.on_failed(Rc::new(move |chat, message, code, metadata| {
        log.borrow_mut().push(json!([
            "failed",
            chat,
            message,
            code,
            metadata.and_then(|metadata| metadata.turn_id.as_deref())
        ]));
        ListenerWork::Synchronous(Ok(()))
    }));
    bus.on_session_created(Rc::new(|_| {
        ListenerWork::Synchronous(Err(
            std::io::Error::other("synthetic listener failure").into()
        ))
    }));
    let log = effects.clone();
    let listener: Rc<dyn for<'a> Fn(&'a str) -> ListenerWork<'a>> = Rc::new(move |chat| {
        log.borrow_mut().push(json!(["session", chat]));
        ListenerWork::Synchronous(Ok(()))
    });
    bus.on_session_created(listener.clone());
    bus.on_session_created(listener);
    let log = effects.clone();
    bus.on_run_steerable(Rc::new(move |chat| {
        log.borrow_mut().push(json!(["steerable", chat]));
        ListenerWork::Synchronous(Ok(()))
    }));
    let first = turn("first");
    let finished = || CommittedRunOutcome::Completed(AgentRunCompletionOutcome::Finished);
    let active = || {
        bus.get_active_turn(CHAT)
            .and_then(|metadata| metadata.turn_id)
    };
    let mut values = Vec::new();
    if spec == "listeners" {
        let weak = Rc::downgrade(&bus);
        let log = effects.clone();
        bus.on_session_created(Rc::new(move |_| {
            let log = log.clone();
            weak.upgrade()
                .unwrap()
                .on_session_created(Rc::new(move |chat| {
                    log.borrow_mut().push(json!(["added", chat]));
                    ListenerWork::Synchronous(Ok(()))
                }));
            ListenerWork::Synchronous(Ok(()))
        }));
        bus.publish_session(CHAT).await;
        bus.publish_run_steerable(CHAT).await;
    } else {
        bus.track_turn(CHAT, &first).unwrap();
        match spec {
            "conflict" => {
                let mut copy = bus.get_active_turn(CHAT).unwrap();
                copy.turn_id = Some("mutated".into());
                assert_eq!(copy.turn_id.as_deref(), Some("mutated"));
                values.push(outcome(bus.track_turn(CHAT, &turn("successor")), |()| {
                    Value::Null
                }));
                values.push(json!(active()));
            }
            "settled" => {
                bus.settle_turn(CHAT, &turn("other"));
                values.push(json!(active()));
                bus.settle_turn(CHAT, &first);
                values.push(json!(active()));
                bus.publish_run_ended(
                    CHAT,
                    "first",
                    CommittedRunOutcome::Failed(Some(AgentRunFailureDetail {
                        code: "START_FAILED".into(),
                        message: None,
                    })),
                    None,
                )
                .await;
            }
            "default-failure" => {
                bus.publish_run_ended(CHAT, "first", CommittedRunOutcome::Failed(None), None)
                    .await
            }
            "completed" => {
                bus.publish_run_ended(
                    CHAT,
                    "first",
                    CommittedRunOutcome::Completed(AgentRunCompletionOutcome::Interrupted),
                    None,
                )
                .await;
                bus.publish_run_ended(CHAT, "first", finished(), None).await;
                bus.track_turn(CHAT, &turn("successor")).unwrap();
                bus.publish_run_failed(
                    CHAT,
                    "first",
                    &AgentRunFailureDetail {
                        code: "FAILED".into(),
                        message: None,
                    },
                    None,
                )
                .await;
            }
            "stale" => bus.publish_run_ended(CHAT, "other", finished(), None).await,
            "cleared" => {
                bus.track_turn(
                    CHAT,
                    &TurnEventMetadata {
                        turn_id: Some(String::new()),
                        client_request_id: Some(String::new()),
                        client_message_id: Some("message".into()),
                        ..TurnEventMetadata::default()
                    },
                )
                .unwrap();
                bus.publish_run_ended(CHAT, "first", finished(), None).await;
            }
            _ => panic!("undeliverable event bus scenario {spec}"),
        }
    }
    json!({"values":values,"effects":&*effects.borrow(),"active":active()})
}

#[test]
fn agent_registry_leaves_recordings() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/cases/agent-registry-leaves");
    replay(dir, |name, args| {
        Ok(match name {
            "directoryTrace" => directory_trace(unknown(name, args.first())?.as_ref()),
            "turnOperationTrace" => turn_operation_trace(unknown(name, args.first())?.as_ref()),
            "sessionLossRetryTrace" => {
                runtime.block_on(retry_trace(unknown(name, args.first())?.as_ref()))
            }
            "listenerDispatchTrace" => runtime.block_on(listener_trace()),
            "eventBusTrace" => runtime
                .block_on(event_trace(text(name, args.first())?.ok_or_else(|| {
                    CaseError::undeliverable("expected an event bus scenario")
                })?)),
            _ => return Err(CaseError::unhandled(name)),
        })
    });
}

#[test]
fn directory_does_not_fall_back_from_an_explicit_offline_executor() {
    let trace = directory_trace(&json!({"executorId":"remote","ready":false}));
    assert_eq!(
        trace["values"][5],
        json!({"error":"Executor is unavailable","code":"EXECUTOR_UNAVAILABLE"})
    );
    assert!(
        trace["calls"]
            .as_array()
            .unwrap()
            .iter()
            .all(|call| call[1] == "remote")
    );
}

#[test]
fn operation_ids_keep_empty_values_but_metadata_drops_the_empty_request_id() {
    let operation = operation_identity(
        Some("epoch"),
        TurnOperationIds {
            client_request_id: Some(""),
            client_message_id: None,
            turn_id: Some(""),
        },
        TurnCommandType::AgentRun,
        || panic!("explicit identifiers must not consume a UUID"),
    )
    .unwrap();
    assert_eq!(operation.turn_owner.client_request_id, "");
    let metadata = operation_metadata(&operation);
    assert_eq!(metadata.client_request_id, None);
    assert_eq!(metadata.turn_id.as_deref(), Some(""));
}

#[tokio::test]
async fn retry_checks_abort_only_before_repeating_a_lost_session_step() {
    let cancelled = retry_trace(&json!({"steps":["unknown","ok"],"abortOn":1})).await;
    assert_eq!(
        cancelled,
        json!({"error":"Stopped","name":"Error","calls":1})
    );
    let exhausted = retry_trace(&json!({"steps":["unknown"],"abortOn":3})).await;
    assert_eq!(
        exhausted,
        json!({"error":"Lost session","name":"ExecutorSessionLostError","calls":3})
    );
}

#[tokio::test]
async fn listener_errors_do_not_reorder_synchronous_or_pending_observers() {
    let trace = listener_trace().await;
    assert_eq!(trace["inline"], json!(["sync", "sync failure", "await"]));
    assert_eq!(
        trace["events"],
        json!(["sync", "sync failure", "await", "async failure", "last"])
    );
}

#[tokio::test]
async fn delayed_terminal_cannot_clear_a_successor() {
    let trace = event_trace("completed").await;
    assert_eq!(
        trace["effects"],
        json!([["finished", CHAT, 0, "first", "interrupted"]])
    );
    assert_eq!(trace["active"], "successor");
}
