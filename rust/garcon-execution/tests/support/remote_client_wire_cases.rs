use std::{cell::RefCell, rc::Rc};

use futures::StreamExt;
use garcon_base::domain_error::as_domain_error;
use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::{
    agent_integration::AgentSettingsEnvelope,
    file_contracts::{FileSaveConflictResolution, SaveTextRequest},
};
use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome},
    execution_runtime::{ExecutorAvailability, ExecutorInfo, ExecutorServices},
    files::{
        ExecutionDirectoryCreation, ExecutionFileSave, ExecutionFileTarget, ExecutionFilesService,
    },
    native_history::{AgentHistoryImport, AgentHistoryImportRequest},
    resources::ExecutorResult,
    transcript::AgentChatReference,
};
use garcon_js::json::{Opaque, from_slice};
use garcon_link::{
    message_session::{MessageSessionAttachment, SessionError, SessionSocket},
    rpc::{ExecutorRpc, ExecutorRpcContinuity, RpcHandler},
    rpc_lane::RpcLane,
    session_transport::{SessionTransport, SessionTransportOptions},
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::task::LocalSet;
use tokio_util::sync::CancellationToken;

use super::{
    remote_files::RemoteFilesService,
    remote_history::{HistorySource, RemoteHistory},
    sessions::{RemoteSessionBacking, RemoteSessions},
};

const EXECUTOR_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

#[derive(Default)]
pub(super) struct Peer(RefCell<Option<Rc<MessageSessionAttachment>>>);

impl SessionSocket for Peer {
    fn send(&self, payload: String) -> Result<(), SessionError> {
        if let Some(peer) = self.0.borrow().clone() {
            tokio::task::spawn_local(async move {
                peer.receive(payload);
            });
        }
        Ok(())
    }

    fn close(&self) {
        self.0.take();
    }
}

pub(super) fn pair(lane: RpcLane, id: &str) -> (Rc<ExecutorRpc>, Rc<ExecutorRpc>) {
    let endpoint = |peer| {
        ExecutorRpc::new(
            SessionTransport::new(
                id.to_owned(),
                peer,
                Rc::new(|_| {}),
                SessionTransportOptions {
                    executor_id: EXECUTOR_ID.to_owned(),
                    lane,
                    primary_session_id: Some("parent".into()),
                    ..Default::default()
                },
            )
            .unwrap(),
            ExecutorRpcContinuity::default(),
        )
    };
    let controller = endpoint("worker".into());
    let worker = endpoint("controller".into());
    let to_controller = Rc::new(Peer::default());
    let to_worker = Rc::new(Peer::default());
    let controller_socket = controller.transport.attach(to_worker.clone()).unwrap();
    let worker_socket = worker.transport.attach(to_controller.clone()).unwrap();
    to_worker.0.replace(Some(Rc::new(worker_socket)));
    to_controller.0.replace(Some(Rc::new(controller_socket)));
    controller.activate();
    worker.activate();
    (controller, worker)
}

pub(super) fn backing(rpc: Rc<ExecutorRpc>, instance: &str) -> Rc<RemoteSessionBacking> {
    Rc::new(RemoteSessionBacking {
        rpc,
        info: Rc::new(ExecutorInfo {
            executor_id: EXECUTOR_ID.into(),
            instance_id: instance.to_owned(),
            project_base_path: "/fixture".into(),
            integration_ids: vec!["fixture".into()],
            services: ExecutorServices {
                files: true,
                git: true,
                gh: true,
                terminals: true,
                directory_creation: true,
            },
        }),
    })
}

async fn with_worker<T, F: Future<Output = ExecutorResult<T>>>(
    handler: RpcHandler,
    run: impl FnOnce(Rc<RemoteSessions>) -> F,
) -> ExecutorResult<T> {
    let sessions = Rc::new(RemoteSessions::default());
    let (primary, _primary_worker) = pair(RpcLane::Primary, "parent");
    let (bulk, worker) = pair(RpcLane::Bulk, "bulk");
    sessions.set_backing(RpcLane::Primary, Some(backing(primary.clone(), "worker")));
    sessions.set_backing(RpcLane::Bulk, Some(backing(bulk.clone(), "worker")));
    sessions.set_availability(ExecutorAvailability::Ready);
    worker.handle(handler);
    let result = run(sessions).await;
    bulk.transport.close(None);
    worker.transport.close(None);
    primary.transport.close(None);
    result
}

fn target() -> ExecutionFileTarget {
    ExecutionFileTarget {
        project_path: "/fixture".into(),
        file_path: "file.txt".into(),
    }
}

#[derive(Deserialize)]
struct SaveInput {
    #[serde(flatten)]
    target: ExecutionFileTarget,
    #[serde(rename = "expectedRevision")]
    expected_revision: String,
    #[serde(rename = "conflictResolution")]
    conflict_resolution: FileSaveConflictResolution,
    content: String,
}

fn case_error(error: Box<dyn std::error::Error>) -> CaseError {
    if let Some(error) = as_domain_error(error.as_ref()) {
        return CaseError::new(error.kind.name(), &error.message)
            .with_property("code", json!(error.code.as_str()))
            .with_property("status", json!(error.status))
            .with_property("retryable", json!(error.retryable));
    }
    CaseError::new("Error", error.to_string())
}

#[test]
fn wire_payloads_errors_and_history_messages_match_bun() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = LocalSet::new();
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/remote_client_wire"
        ),
        |function, args| {
            let input = unknown(function, args.first())?;
            let result = match function {
                "readReply" => {
                    let input = input.into_owned();
                    local.block_on(&runtime, with_worker(Rc::new(move |_, _, _, _| {
                    let input = input.clone();
                    Box::pin(async move { Ok(Some(Opaque::from_value(input))) })
                }), |sessions| async move {
                    let read = RemoteFilesService(sessions).read(target(), None).await?;
                    Ok(json!({"bytes": read.bytes, "path": read.path, "revision": read.revision}))
                }))
                }
                "saveWire" => {
                    let input: SaveInput = from_slice(&serde_json::to_vec(&input).unwrap())
                        .map_err(|error| CaseError::undeliverable(error.to_string()))?;
                    let captured = Rc::new(RefCell::new(None));
                    let capture = captured.clone();
                    local.block_on(&runtime, with_worker(Rc::new(move |call, _, _, _| {
                    capture.replace(Some(serde_json::to_string(&call.request).unwrap()));
                    Box::pin(async { Ok(Some(Opaque::from_value(json!({"success": true, "path":"/fixture/file.txt", "message":"Saved", "revision":"v1:new"})))) })
                }), |sessions| async move {
                    let request = SaveTextRequest { content: input.content, expected_revision: input.expected_revision, conflict_resolution: input.conflict_resolution };
                    RemoteFilesService(sessions).save(ExecutionFileSave { target: input.target, request }, None).await?;
                    Ok(json!(captured.take()))
                }))
                }
                "fileFailure" => {
                    let kind = input
                        .as_str()
                        .ok_or_else(|| CaseError::unhandled(function))?;
                    let outcome = match unknown(function, args.get(1))?.as_str() {
                        Some("unknown") => AgentDeliveryOutcome::Unknown,
                        Some("not-dispatched") => AgentDeliveryOutcome::NotDispatched,
                        Some("rejected") => AgentDeliveryOutcome::Rejected,
                        _ => return Err(CaseError::unhandled(function)),
                    };
                    local.block_on(&runtime, with_worker(Rc::new(move |_, _, _, _| {
                    Box::pin(async move { Err(Rc::new(AgentCallError::new(outcome, "synthetic file failure")) as SessionError) })
                }), |sessions| async move {
                    let service = RemoteFilesService(sessions);
                    let result = if kind == "save" {
                        service.save(ExecutionFileSave { target: target(), request: SaveTextRequest {
                            content: "sample".into(), expected_revision: "v1:old".into(), conflict_resolution: FileSaveConflictResolution::Reject,
                        } }, None).await.map(|_| ())
                    } else {
                        service.create_directory(ExecutionDirectoryCreation { parent_path: "/fixture".into(), name: "child".into() }, None).await.map(|_| ())
                    };
                    match result {
                        Err(error) => match error.downcast_ref::<AgentCallError>() {
                            Some(error) => Ok(json!({"outcome":error.outcome.as_str(),"code":error.code.as_str(),"message":error.message})),
                            None => Err(error),
                        },
                        Ok(()) => Ok(Value::Null),
                    }
                }))
                }
                "historyRows" => {
                    let input = input.into_owned();
                    local.block_on(&runtime, with_worker(Rc::new(move |call, _, _, _| {
                    let reply = match call.method.as_str() {
                        "history.open" => Some(json!({"executorId":EXECUTOR_ID,"instanceId":"worker","integrationId":"fixture","kind":"history-reader","id":"reader"})),
                        "history.next" => Some(json!({"done":false,"rows":input})),
                        "history.close" => None,
                        _ => panic!("unexpected oracle call: {}", call.method),
                    };
                    Box::pin(async move { Ok(reply.map(Opaque::from_value)) })
                }), |sessions| async move {
                    let history = RemoteHistory { sessions, integration_id: "fixture".into(), source: HistorySource::NativeHistoryImport };
                    let request = AgentHistoryImportRequest { chat: AgentChatReference {
                        chat_id: "1783725900000000".into(), project_path: "/fixture".into(), agent_session_id: Some("session".into()), native_session: None,
                        agent_id: "fixture".into(), model: "fixture".into(), carry_over_revision: "0".into(), native_seed_receipt: None,
                        settings: AgentSettingsEnvelope { owner_id: "fixture".into(), schema_version: 1, values: Opaque::from_value(json!({})) },
                    }, signal: CancellationToken::new() };
                    let rows = history.load(request, None).next().await.ok_or("Missing fixture history page")??;
                    Ok(json!(serde_json::to_string(&rows)?))
                }))
                }
                _ => return Err(CaseError::unhandled(function)),
            };
            result.map_err(case_error)
        },
    );
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}
