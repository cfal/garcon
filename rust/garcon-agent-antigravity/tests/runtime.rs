#![cfg(unix)]

mod support;

use std::{collections::BTreeMap, path::PathBuf, rc::Rc, time::Duration};

use garcon_agent_antigravity::{
    AntigravityAgentIntegration,
    antigravity_acp_event_converter::AntigravityAcpEventConverter,
    antigravity_acp_policy::create_antigravity_acp_policy,
    config::AntigravityConfig,
    run_single_query::{AntigravitySingleQueryOptions, run_antigravity_single_query},
};
use garcon_agents_common::{
    acp::{
        agent_runtime::{AcpAgentRuntime, AcpAgentRuntimeOptions},
        runtime_types::{AcpExecutionRequest, AcpResumeRequest, AcpStartRequest},
        transport::{AcpTransport, AcpTransportOptions},
    },
    direct::conformance_host::conformance_host,
    execution::runtime_events::{
        AgentRuntimeEvent, ProviderRunOutcome, RuntimeSteerRequest, runtime_operation,
    },
};
use garcon_contract::{
    agent_execution::{AgentAttachment, AgentAttachmentKind},
    chat_modes::{PermissionMode, ThinkingMode},
};
use garcon_interface::{
    integration::AgentIntegrationClass,
    testing::{AgentIntegrationConformanceOptions, run_agent_integration_conformance},
};
use serde_json::{Value, json};
use support::{bounded, environment, executable};
use tokio::{
    sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel},
    time::sleep,
};
use tokio_util::sync::CancellationToken;

struct Peer {
    config: AntigravityConfig,
    root: tempfile::TempDir,
    binary: PathBuf,
}

impl Peer {
    fn new(key: Option<&str>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("agy.ts");
        executable(&binary, include_str!("fixtures/agy-peer.ts"));
        let config = AntigravityConfig::new(environment(&binary, None, key));
        Self {
            config,
            root,
            binary,
        }
    }

    fn work(&self) -> String {
        self.root.path().to_string_lossy().into_owned()
    }

    fn frames(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.path().join("received.jsonl"))
            .map(|lines| {
                lines
                    .lines()
                    .filter(|line| !line.is_empty())
                    .map(|line| garcon_js::json::from_str(line).unwrap())
                    .collect()
            })
            .unwrap_or_default()
    }

    async fn wait_for_method(&self, method: &str) {
        while !self.frames().iter().any(|frame| frame["method"] == method) {
            sleep(Duration::from_millis(5)).await;
        }
    }

    fn method_params(&self, method: &str) -> Vec<Value> {
        self.frames()
            .into_iter()
            .filter(|frame| frame["method"] == method)
            .map(|frame| frame["params"].clone())
            .collect()
    }

    fn runtime(
        &self,
    ) -> (
        AcpAgentRuntime,
        UnboundedSender<AgentRuntimeEvent>,
        UnboundedReceiver<AgentRuntimeEvent>,
    ) {
        let runtime = AcpAgentRuntime::new(
            create_antigravity_acp_policy(self.config.clone()),
            AcpAgentRuntimeOptions {
                converter: Rc::new(AntigravityAcpEventConverter::default()),
                create_transport: Some(Rc::new(|| {
                    AcpTransport::new(AcpTransportOptions {
                        request_timeout_ms: Some(2500.0),
                        ..Default::default()
                    })
                })),
                logger: None,
                clock: Some(Rc::new(garcon_js::ManualClock::new(0))),
                new_permission_id: None,
                cancel_settle_timeout_ms: Some(100.0),
                steer_decision_timeout_ms: Some(1000.0),
            },
        );
        let (sender, receiver) = unbounded_channel();
        (runtime, sender, receiver)
    }

    fn request(
        &self,
        sender: &UnboundedSender<AgentRuntimeEvent>,
        command: &str,
        run: &str,
    ) -> AcpExecutionRequest {
        let sender = sender.clone();
        AcpExecutionRequest {
            chat_id: "chat-1".into(),
            project_path: self.work(),
            model: "default".into(),
            permission_mode: PermissionMode::Default,
            thinking_mode: ThinkingMode::None,
            execution_admission: None,
            command: command.into(),
            images: None,
            operation: runtime_operation(
                run.into(),
                Rc::new(move |event| {
                    let _ = sender.send(event);
                }),
            ),
            env_overrides: BTreeMap::new(),
        }
    }

    fn query(&self, timeout_ms: Option<f64>) -> AntigravitySingleQueryOptions {
        AntigravitySingleQueryOptions {
            project_path: self.work(),
            model: None,
            thinking_mode: ThinkingMode::None,
            timeout_ms,
            signal: CancellationToken::new(),
            create_transport: None,
        }
    }
}

fn start(execution: AcpExecutionRequest) -> AcpStartRequest {
    AcpStartRequest {
        execution,
        on_session_activated: None,
    }
}

fn resume(execution: AcpExecutionRequest) -> AcpResumeRequest {
    AcpResumeRequest {
        execution,
        agent_session_id: "session-1".into(),
        native_path: None,
    }
}

async fn ended(
    receiver: &mut UnboundedReceiver<AgentRuntimeEvent>,
) -> (ProviderRunOutcome, Vec<Value>) {
    let mut messages = Vec::new();
    loop {
        match receiver.recv().await.unwrap() {
            AgentRuntimeEvent::Rows { rows } => messages.extend(
                rows.into_iter()
                    .map(|row| serde_json::to_value(row.message).unwrap()),
            ),
            AgentRuntimeEvent::RunEnded { outcome, .. } => return (outcome, messages),
            _ => (),
        }
    }
}

#[tokio::test]
async fn satisfies_conformance_and_declares_provider_facets() {
    bounded(async {
        let peer = Peer::new(None);
        let class = AntigravityAgentIntegration;
        let mut host = conformance_host(class.integration_id(), peer.root.path()).unwrap();
        host.environment = environment(&peer.binary, None, None);
        let integration = class.create(host);
        run_agent_integration_conformance(AgentIntegrationConformanceOptions {
            integration_id: class.integration_id(),
            api_version: class.api_version(),
            integration: &integration,
        })
        .await
        .unwrap();
        assert!(integration.descriptor.supports_images);
        assert!(!integration.descriptor.supports_project_path_update);
        assert!(integration.project_path_updates.is_none() && integration.forking.is_none());
        assert!(integration.native_history_import.is_none());
        assert!(integration.steering.is_some());
    })
    .await;
}

#[tokio::test]
async fn authenticates_sets_model_and_mode_and_sends_only_the_image_when_text_is_blank() {
    bounded(async {
        let peer = Peer::new(Some("synthetic"));
        let (runtime, send, mut events) = peer.runtime();
        let mut request = peer.request(&send, " \u{a0} ", "first");
        request.model = "gemini-test-high".into();
        request.permission_mode = PermissionMode::AcceptEdits;
        request.images = Some(vec![AgentAttachment {
            kind: AgentAttachmentKind::Image,
            name: Some("image.png".into()),
            mime_type: "image/png".into(),
            data: "data:image/png;base64,YQ==".into(),
        }]);
        let session = runtime.start_session(start(request)).await.unwrap();
        assert_eq!(
            session.native_path.as_deref(),
            Some("!antigravity:session-1")
        );
        assert!(matches!(
            ended(&mut events).await.0,
            ProviderRunOutcome::Finished { .. }
        ));
        assert_eq!(
            peer.method_params("authenticate"),
            [json!({"methodId":"gemini-api-key"})]
        );
        assert_eq!(
            peer.method_params("session/set_model"),
            [json!({"sessionId":"session-1","modelId":"gemini-test-high"})]
        );
        assert_eq!(
            peer.method_params("session/set_config_option"),
            [json!({"sessionId":"session-1","configId":"mode","value":"accept-edits"})]
        );
        assert_eq!(
            peer.method_params("session/prompt")[0]["prompt"],
            json!([{"type":"image","mimeType":"image/png","data":"YQ=="}])
        );

        runtime
            .run_turn(resume(peer.request(&send, "Default again.", "second")))
            .await
            .unwrap();
        assert_eq!(
            peer.method_params("session/set_model")[1]["modelId"],
            "gemini-test-low"
        );
        assert_eq!(
            peer.method_params("session/set_config_option")[1]["value"],
            "default"
        );
        runtime.shutdown();
    })
    .await;
}

#[tokio::test]
async fn rejects_unavailable_models_unconfirmed_modes_and_unsupported_input_before_prompt() {
    bounded(async {
        for (model, mode, command, setting, detail) in [
            (
                "unavailable",
                PermissionMode::Default,
                "send",
                "",
                "Antigravity model unavailable is not available for this account.",
            ),
            (
                "default",
                PermissionMode::Plan,
                "send",
                "wrong-mode",
                "Antigravity did not apply the requested mode: expected plan, got default.",
            ),
            (
                "default",
                PermissionMode::Default,
                "send",
                "unconfirmed",
                "Antigravity did not confirm the requested default mode.",
            ),
            (
                "default",
                PermissionMode::Default,
                "   ",
                "",
                "Antigravity needs a message or an image to send.",
            ),
        ] {
            let peer = Peer::new(None);
            let (runtime, send, _) = peer.runtime();
            let mut request = peer.request(&send, command, "first");
            request.model = model.into();
            request.permission_mode = mode;
            request
                .env_overrides
                .insert("GARCON_TEST_AGY_SETTING".into(), setting.into());
            let error = runtime.start_session(start(request)).await.err().unwrap();
            assert_eq!(error.to_string(), detail);
            assert!(peer.method_params("session/prompt").is_empty());
            if command.trim().is_empty() {
                assert!(peer.frames().is_empty());
            }
            runtime.shutdown();
        }
    })
    .await;
}

#[tokio::test]
async fn reapplies_mode_after_resume_and_cancels_without_killing_a_live_process() {
    bounded(async {
        let peer = Peer::new(None);
        let (runtime, send, mut events) = peer.runtime();
        runtime
            .start_session(start(peer.request(&send, "hold", "first")))
            .await
            .unwrap();
        peer.wait_for_method("session/prompt").await;
        assert!(runtime.abort("session-1"));
        while runtime.is_running("session-1") {
            sleep(Duration::from_millis(5)).await;
        }
        let mut rows = Vec::new();
        while let Ok(event) = events.try_recv() {
            match event {
                AgentRuntimeEvent::Rows { rows: next } => rows.extend(
                    next.into_iter()
                        .map(|row| serde_json::to_value(row.message).unwrap()),
                ),
                AgentRuntimeEvent::RunEnded { .. } => panic!("Stop does not publish a run outcome"),
                _ => (),
            }
        }
        assert!(rows.iter().any(|row| {
            row["content"]
                .as_str()
                .is_some_and(|text| text.contains("Stopped."))
        }));
        runtime
            .run_turn(resume(peer.request(&send, "Next.", "second")))
            .await
            .unwrap();
        assert_eq!(peer.method_params("initialize").len(), 1);
        assert!(peer.method_params("session/resume").is_empty());
        runtime.release_session("chat-1", Some("session-1"));

        let mut request = peer.request(&send, "Resume.", "third");
        request.permission_mode = PermissionMode::Plan;
        runtime.run_turn(resume(request)).await.unwrap();
        assert_eq!(peer.method_params("session/resume").len(), 1);
        assert_eq!(
            peer.method_params("session/set_config_option")[2]["value"],
            "plan"
        );
        runtime.shutdown();
    })
    .await;
}

#[tokio::test]
async fn steer_reuses_the_turn_and_the_terminal_answer_excludes_post_reply_text() {
    bounded(async {
        let peer = Peer::new(None);
        let (runtime, send, mut events) = peer.runtime();
        runtime
            .start_session(start(peer.request(&send, "hold", "first")))
            .await
            .unwrap();
        peer.wait_for_method("session/prompt").await;
        let result = runtime
            .steer(RuntimeSteerRequest {
                question_reply: None,
                chat_id: "chat-1".into(),
                project_path: peer.work(),
                agent_session_id: "session-1".into(),
                native_session: None,
                target: runtime.capture_steer_target("session-1"),
                input: "Next.".into(),
                client_message_id: "steer-1".into(),
                prepare_delivery: Rc::new(|| Box::pin(async { Ok(()) })),
            })
            .await
            .unwrap();
        assert!(matches!(
            result,
            garcon_interface::services::AgentSteerResult::Accepted
        ));
        let (_, rows) = ended(&mut events).await;
        assert!(rows.iter().any(|row| row["content"] == "First. Next."));

        assert_eq!(
            runtime
                .run_turn(resume(peer.request(&send, "upstream-error", "second")))
                .await
                .unwrap_err()
                .to_string(),
            "Antigravity agent executor error: Error 429"
        );
        let (outcome, rows) = ended(&mut events).await;
        assert!(matches!(outcome, ProviderRunOutcome::Failed { .. }));
        assert!(rows.iter().any(|row| {
            row.to_string()
                .contains("Antigravity agent executor error: Error 429")
        }));
        assert!(rows.iter().any(|row| row["content"] == "After the reply."));
        runtime.shutdown();
    })
    .await;
}

#[tokio::test]
async fn disposable_queries_use_plan_reject_permissions_and_only_fail_on_final_markers() {
    bounded(async {
        let peer = Peer::new(None);
        let run = |prompt: &str| {
            run_antigravity_single_query(prompt.into(), peer.query(None), &peer.config)
        };
        assert_eq!(run("permission").await.unwrap(), "Denied.");
        assert_eq!(
            peer.method_params("session/set_config_option")[0]["value"],
            "plan"
        );
        assert!(
            peer.frames()
                .iter()
                .any(|frame| frame["id"] == "permission-1"
                    && frame["result"]["outcome"]["optionId"] == "deny")
        );
        assert_eq!(
            run("upstream-error").await.unwrap_err().to_string(),
            "Antigravity agent executor error: Error 429"
        );
        assert_eq!(
            run("quoted-error").await.unwrap(),
            "Quote:\n\u{26a0} agent executor error: quoted"
        );

        let mut options = peer.query(Some(400.0));
        options.create_transport = Some(Rc::new(|| {
            AcpTransport::new(AcpTransportOptions {
                request_timeout_ms: Some(2000.0),
                ..Default::default()
            })
        }));
        let error = run_antigravity_single_query("hold".into(), options, &peer.config)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Single query timed out after 400ms.");
    })
    .await;
}

#[tokio::test]
async fn matches_bun_runtime_output_after_resume_and_native_failure() {
    bounded(async {
        let peer = Peer::new(None);
        let oracle = tokio::process::Command::new("bun")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/oracles/runtime-wire.ts"))
            .arg(&peer.binary).arg(peer.root.path()).kill_on_drop(true).output().await.unwrap();
        assert!(oracle.status.success(), "{}", String::from_utf8_lossy(&oracle.stderr));

        let (runtime, send, mut events) = peer.runtime();
        let session = runtime.start_session(start(peer.request(&send, "First.", "first"))).await.unwrap();
        let first = ended(&mut events).await;
        runtime.release_session("chat-1", Some("session-1"));
        assert!(runtime.run_turn(resume(peer.request(&send, "upstream-error", "second"))).await.is_err());
        let second = ended(&mut events).await;

        let mut output = vec![];
        for (run_id, (outcome, rows)) in [("first", first), ("second", second)] {
            output.extend(rows.into_iter().map(|mut row| {
                row.as_object_mut().unwrap().shift_remove("timestamp");
                row
            }));
            output.push(match outcome {
                ProviderRunOutcome::Finished { final_response } => json!({"runId":run_id,"outcome":"finished","finalResponse":final_response}),
                ProviderRunOutcome::Failed { error } => json!({"runId":run_id,"outcome":"failed","error":error}),
            });
        }
        let actual = json!({"session":{"agentSessionId":session.agent_session_id,"nativePath":session.native_path},"output":output});
        assert_eq!(serde_json::to_string(&actual).unwrap(), String::from_utf8(oracle.stdout).unwrap().trim_end());
        runtime.shutdown();
    }).await;
}
