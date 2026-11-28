#![cfg(unix)]

use std::cell::{Cell, RefCell};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

use garcon_agent_pi::{
    config::create_pi_config,
    lazy_runtime::PiRuntime,
    pi_models::PiModelCatalogService,
    pi_rpc_runtime::PiRpcRuntime,
    runtime_types::{PiExecutionRequest, PiResumeRequest, PiStartRequest},
};
use garcon_agents_common::{
    direct::conformance_host::conformance_host,
    execution::runtime_events::{
        AgentRuntimeEvent, AgentRuntimeOperation, ProviderRunOutcome, RuntimeSteerRequest,
    },
};
use garcon_contract::chat_modes::{PermissionMode, ThinkingMode};
use garcon_interface::{
    host::AgentEnvironmentReader, producer::AgentFinalResponse, resources::ExecutorResult,
    services::AgentSteerResult,
};
use tokio::{fs, sync::oneshot, task::LocalSet, time::timeout};

struct Environment(String);

impl AgentEnvironmentReader for Environment {
    fn get(&self, name: &str) -> ExecutorResult<Option<String>> {
        Ok((name == "GARCON_PI_BINARY").then(|| self.0.clone()))
    }
}

fn execution(
    dir: &Path,
    run_id: &str,
    prompt: &str,
) -> (PiExecutionRequest, oneshot::Receiver<ProviderRunOutcome>) {
    let (complete, finished) = oneshot::channel();
    let complete = RefCell::new(Some(complete));
    let operation = AgentRuntimeOperation {
        run_id: run_id.to_owned(),
        publish: Rc::new(move |event| {
            if let AgentRuntimeEvent::RunEnded { outcome, .. } = event {
                assert!(complete.borrow_mut().take().unwrap().send(outcome).is_ok());
            }
        }),
    };
    (
        PiExecutionRequest {
            chat_id: "synthetic-chat".to_owned(),
            project_path: dir.to_str().unwrap().to_owned(),
            model: "synthetic/model".to_owned(),
            permission_mode: PermissionMode::Default,
            thinking_mode: ThinkingMode::None,
            operation,
            execution_admission: None,
            command: prompt.to_owned(),
            images: Vec::new(),
            env_overrides: None,
        },
        finished,
    )
}

async fn assert_reply(finished: oneshot::Receiver<ProviderRunOutcome>, expected: &str) {
    let result = timeout(Duration::from_secs(5), finished)
        .await
        .unwrap()
        .unwrap();
    let ProviderRunOutcome::Finished {
        final_response: Some(AgentFinalResponse::Text { text }),
    } = result
    else {
        panic!("Pi did not publish the expected final reply");
    };
    assert_eq!(text, expected);
}

#[tokio::test]
async fn handshakes_reuses_steers_and_retires_the_direct_child() {
    LocalSet::new()
        .run_until(async {
            let dir = tempfile::tempdir().unwrap();
            let executable = dir.path().join("fake-pi.ts");
            fs::write(&executable, include_str!("fixtures/rpc-pi.ts"))
                .await
                .unwrap();
            fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))
                .await
                .unwrap();
            let session_path = dir.path().join("synthetic-session.jsonl");
            fs::write(
                &session_path,
                r#"{"type":"session","id":"synthetic-session"}"#,
            )
            .await
            .unwrap();
            let host = conformance_host("pi", dir.path()).unwrap();
            let config = Rc::new(create_pi_config(Rc::new(Environment(
                executable.to_str().unwrap().to_owned(),
            ))));
            let models = Rc::new(PiModelCatalogService::new(config.clone()));
            let runtime = PiRpcRuntime::new(config, host.logger, models);

            let activated = Rc::new(Cell::new(false));
            let callback_activation = Rc::clone(&activated);
            let (start, first_end) = execution(dir.path(), "run-one", "first");
            let session = runtime
                .start_session(PiStartRequest {
                    execution: start,
                    on_session_activated: Some(Rc::new(move |_| {
                        callback_activation.set(true);
                        Ok(())
                    })),
                })
                .await
                .unwrap();
            assert!(activated.get());
            assert_eq!(session.agent_session_id, "synthetic-session");
            assert_reply(first_end, "Reply: first").await;

            let (resume, second_end) = execution(dir.path(), "run-two", "second");
            runtime
                .run_turn(PiResumeRequest {
                    execution: resume,
                    agent_session_id: session.agent_session_id.clone(),
                    native_path: session.native_path.clone(),
                })
                .await
                .unwrap();
            assert_reply(second_end, "Reply: second").await;
            assert_eq!(
                fs::read_to_string(dir.path().join("fake-pi-starts"))
                    .await
                    .unwrap(),
                "spawn\n"
            );

            let (mut held, held_end) = execution(dir.path(), "run-three", "held");
            let (mark_steerable, steerable) = oneshot::channel();
            let mark_steerable = RefCell::new(Some(mark_steerable));
            let publish = held.operation.publish.clone();
            held.operation.publish = Rc::new(move |event| {
                if matches!(event, AgentRuntimeEvent::Steerable) {
                    mark_steerable
                        .borrow_mut()
                        .take()
                        .unwrap()
                        .send(())
                        .unwrap();
                }
                publish(event);
            });
            let waiting = tokio::task::spawn_local({
                let runtime = runtime.clone();
                let id = session.agent_session_id.clone();
                let path = session.native_path.clone();
                async move {
                    runtime
                        .run_turn(PiResumeRequest {
                            execution: held,
                            agent_session_id: id,
                            native_path: path,
                        })
                        .await
                }
            });
            timeout(Duration::from_secs(5), steerable)
                .await
                .unwrap()
                .unwrap();
            let target = runtime.capture_steer_target(&session.agent_session_id);
            assert!(target.is_some());
            let steer = runtime
                .steer(RuntimeSteerRequest {
                    question_reply: None,
                    chat_id: "synthetic-chat".to_owned(),
                    project_path: dir.path().to_str().unwrap().to_owned(),
                    agent_session_id: session.agent_session_id.clone(),
                    native_session: None,
                    target,
                    input: "course correction".to_owned(),
                    client_message_id: "client-steer".to_owned(),
                    prepare_delivery: Rc::new(|| Box::pin(async { Ok(()) })),
                })
                .await
                .unwrap();
            assert!(matches!(steer, AgentSteerResult::Accepted));
            assert!(runtime.abort(&session.agent_session_id).await.unwrap());
            assert!(matches!(
                timeout(Duration::from_secs(5), held_end)
                    .await
                    .unwrap()
                    .unwrap(),
                ProviderRunOutcome::Finished {
                    final_response: None
                }
            ));
            waiting.await.unwrap().unwrap();
            assert!(
                runtime
                    .capture_steer_target(&session.agent_session_id)
                    .is_none()
            );

            let (resume, restarted_end) = execution(dir.path(), "run-four", "restarted");
            runtime
                .run_turn(PiResumeRequest {
                    execution: resume,
                    agent_session_id: session.agent_session_id,
                    native_path: session.native_path,
                })
                .await
                .unwrap();
            assert_reply(restarted_end, "Reply: restarted").await;
            assert_eq!(
                fs::read_to_string(dir.path().join("fake-pi-starts"))
                    .await
                    .unwrap(),
                "spawn\nspawn\n"
            );
            runtime.shutdown().await.unwrap();
        })
        .await;
}
