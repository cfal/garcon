use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use futures::poll;
use garcon_base::{executor_disconnect::as_agent_call_error, log::create_logger};
use garcon_contract::agent_integration::AgentSettingsEnvelope;
use garcon_interface::{
    errors::AgentDeliveryOutcome, execution::AgentPrepareProjectPathUpdateRequest,
    execution_runtime::ExecutorAvailability, resources::ExecutorCallOptions,
    transcript::AgentChatReference,
};
use garcon_js::json::{Opaque, from_str};
use garcon_link::{rpc_lane::RpcLane, rpc_protocol::IntegrationManifest};
use serde_json::json;
use tokio::{sync::oneshot, task::LocalSet, time::timeout};
use tokio_util::sync::CancellationToken;

use super::{
    remote_agent_integration::RemoteAgentIntegration,
    remote_client_wire_cases::{backing, pair},
    sessions::RemoteSessions,
};

fn manifest() -> IntegrationManifest {
    from_str(r#"{
        "descriptor": {"id":"fixture","label":"Fixture","icon":null,"supportedPermissionModes":[],"supportedThinkingModes":[],"supportsImages":false,"supportsProjectPathUpdate":true,"requiresNativePathForProjectPathUpdate":false,"supportedEndpointProtocols":[],"configuration":[]},
        "scope": {"executorId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","instanceId":"worker","integrationId":"fixture"},
        "settings": {"descriptors":[],"defaults":{"ownerId":"fixture","schemaVersion":1,"values":{}}},
        "attachments": null, "capabilities": {"projectPathUpdates":true}, "literalExecution": null,
        "authMethods": {"launchLogin":false,"completeLogin":false,"loginStatus":false}, "singleQueryRunsToolsWithoutPermission": false
    }"#).unwrap()
}

#[tokio::test]
async fn late_path_preparation_cleanup_uses_only_the_session_that_published_the_result() {
    LocalSet::new().run_until(async {
        for retired in [false, true] {
            let sessions = Rc::new(RemoteSessions::default());
            let (old, old_worker) = pair(RpcLane::Primary, "old");
            let (new, new_worker) = pair(RpcLane::Primary, "new");
            sessions.set_backing(RpcLane::Primary, Some(backing(old.clone(), "worker")));
            sessions.set_availability(ExecutorAvailability::Ready);
            let new_calls = Rc::new(Cell::new(0));
            new_worker.handle(Rc::new({
                let new_calls = new_calls.clone();
                move |_, _, _, _| {
                    new_calls.set(new_calls.get() + 1);
                    Box::pin(async { Ok(None) })
                }
            }));
            let (entered, preparing) = oneshot::channel();
            let (release, ready) = oneshot::channel();
            let (settled, finished) = oneshot::channel();
            let (cleaned, rollback) = oneshot::channel();
            let pending = RefCell::new(Some((entered, ready, settled)));
            let cleaned = RefCell::new(Some(cleaned));
            old_worker.handle(Rc::new(move |call, _, _, _| {
                match call.method.as_str() {
                    "projectPathUpdates.prepare" => {
                        let (entered, ready, settled) = pending.take().unwrap();
                        Box::pin(async move {
                            entered.send(()).unwrap();
                            ready.await.unwrap();
                            settled.send(()).unwrap();
                            Ok(Some(Opaque::from_value(json!({"preparation":{
                                "executorId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","instanceId":"worker","integrationId":"fixture",
                                "kind":"project-path-preparation","id":"late",
                            }}))))
                        })
                    }
                    "projectPathUpdates.rollback" => {
                        assert_eq!(call.request["id"], "late");
                        cleaned.take().unwrap().send(()).unwrap();
                        Box::pin(async { Ok(None) })
                    }
                    method => panic!("unexpected cleanup request: {method}"),
                }
            }));
            let api = RemoteAgentIntegration::new(manifest(), sessions.clone(), Rc::new(create_logger("fixture"))).unwrap().api();
            let updates = api.project_path_updates.as_ref().unwrap();
            let signal = CancellationToken::new();
            let mut call = Box::pin(updates.prepare(AgentPrepareProjectPathUpdateRequest {
                chat: AgentChatReference {
                    chat_id: "1783725900000000".into(), agent_id: "fixture".into(), agent_session_id: None,
                    project_path: "/fixture".into(), model: "fixture".into(), native_session: None,
                    carry_over_revision: "0".into(), native_seed_receipt: None,
                    settings: AgentSettingsEnvelope { owner_id:"fixture".into(), schema_version:1, values:Opaque::from_value(json!({})) },
                },
                next_project_path: "/next-fixture".into(),
            }, Some(ExecutorCallOptions { signal: Some(signal.clone()), ..Default::default() })));
            assert!(poll!(&mut call).is_pending());
            timeout(Duration::from_secs(2), preparing).await.unwrap().unwrap();
            signal.cancel();
            let error = call.await.unwrap_err();
            assert_eq!(as_agent_call_error(error.as_ref()).unwrap().outcome, AgentDeliveryOutcome::Unknown);
            sessions.set_backing(RpcLane::Primary, Some(backing(new.clone(), "restarted")));
            if retired {
                old.transport.close(None);
                old_worker.transport.close(None);
            }
            release.send(()).unwrap();
            timeout(Duration::from_secs(2), finished).await.unwrap().unwrap();
            if !retired { timeout(Duration::from_secs(2), rollback).await.unwrap().unwrap(); }
            assert_eq!(new_calls.get(), 0);
            old.transport.close(None);
            old_worker.transport.close(None);
            new.transport.close(None);
            new_worker.transport.close(None);
        }
    }).await;
}
