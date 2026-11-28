use std::ffi::OsStr;
use std::time::Duration;

use garcon_contract::chat_command_contracts::PermissionDecisionPayload;
use garcon_contract::chat_modes::ThinkingMode;
use garcon_contract::chat_types::{AssistantMessage, ChatMessage};
use garcon_interface::producer::{
    AgentFinalResponse, AgentProviderPermissionLifecycle, AgentRequestedPermission,
};
use garcon_js::ManualClock;
use serde_json::Map;
use tokio::process::Command;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::task::LocalSet;
use tokio::time::timeout;

use super::*;
use crate::acp::event_converter::AcpSessionUpdateContext;
use crate::execution::runtime_events::{AgentRuntimeEvent, ProviderRunOutcome, runtime_operation};
use crate::which::which;

#[derive(Default)]
struct Converter(RefCell<IndexMap<String, String>>);

impl AcpEventConverter for Converter {
    fn from_session_update(
        &self,
        notification: &Map<String, Value>,
        context: &AcpSessionUpdateContext,
    ) -> Vec<ChatMessage> {
        if let Some(text) = notification["update"]["content"].as_str() {
            self.0
                .borrow_mut()
                .entry(context.session_id.clone())
                .or_default()
                .push_str(text);
        }
        Vec::new()
    }

    fn end_turn(&self, id: &str, context: &AcpSessionUpdateContext) -> Vec<ChatMessage> {
        self.0
            .borrow_mut()
            .shift_remove(id)
            .map(|content| {
                ChatMessage::Assistant(AssistantMessage {
                    timestamp: context.timestamp.clone(),
                    content,
                    questions: None,
                })
            })
            .into_iter()
            .collect()
    }
}

fn setup(
    strategy: AcpAbortStrategy,
    session_reply: Option<&str>,
) -> (
    AcpAgentRuntime,
    UnboundedSender<AgentRuntimeEvent>,
    UnboundedReceiver<AgentRuntimeEvent>,
) {
    let command = which(OsStr::new("bun")).expect("the pinned Bun is available");
    let mut policy = AcpAgentPolicy::new("synthetic", command.to_str().unwrap());
    policy.args = Some(
        std::iter::once(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/acp-agent-runtime-peer.ts"
        ))
        .chain(session_reply)
        .map(str::to_owned)
        .collect(),
    );
    policy.abort_strategy = strategy;
    let runtime = AcpAgentRuntime::new(
        policy,
        AcpAgentRuntimeOptions {
            converter: Rc::new(Converter::default()),
            create_transport: Some(Rc::new(|| {
                AcpTransport::new(AcpTransportOptions {
                    request_timeout_ms: Some(2000.0),
                    ..Default::default()
                })
            })),
            logger: None,
            cancel_settle_timeout_ms: Some(400.0),
            steer_decision_timeout_ms: None,
            clock: Some(Rc::new(ManualClock::new(0))),
            new_permission_id: Some(Rc::new(|| "occurrence-1".to_owned())),
        },
    );
    let (send, events) = unbounded_channel();
    (runtime, send, events)
}

fn request(
    run_id: &str,
    command: &str,
    sender: &UnboundedSender<AgentRuntimeEvent>,
) -> AcpExecutionRequest {
    AcpExecutionRequest {
        chat_id: "chat-1".to_owned(),
        project_path: env!("CARGO_MANIFEST_DIR").to_owned(),
        model: "default".to_owned(),
        permission_mode: PermissionMode::Default,
        thinking_mode: ThinkingMode::None,
        operation: runtime_operation(
            run_id.to_owned(),
            Rc::new({
                let sender = sender.clone();
                move |event| {
                    let _ = sender.send(event);
                }
            }),
        ),
        execution_admission: None,
        command: command.to_owned(),
        images: None,
        env_overrides: Default::default(),
    }
}

async fn bounded(test: impl Future<Output = ()>) {
    LocalSet::new()
        .run_until(async {
            timeout(Duration::from_secs(10), test)
                .await
                .expect("the ACP peer must settle");
        })
        .await;
}

#[tokio::test]
async fn rejects_non_string_session_ids_before_registration_or_publication() {
    bounded(async {
        for reply in [
            r#"{}"#,
            r#"{"sessionId":17}"#,
            r#"{"sessionId":{"id":"native-1"}}"#,
        ] {
            let (runtime, sender, mut events) = setup(AcpAbortStrategy::Cancel, Some(reply));
            let error = runtime
                .start_session(AcpStartRequest {
                    execution: request("bad", "must not be sent", &sender),
                    on_session_activated: Some(Rc::new(|_| {
                        panic!("malformed session must not be activated")
                    })),
                })
                .await
                .err()
                .expect("malformed session must fail");
            let provider = error
                .downcast_ref::<AgentIntegrationError>()
                .expect("expected a provider failure");
            assert_eq!(provider.code, AgentIntegrationErrorCode::PROVIDER_FAILURE);
            assert_eq!(
                provider.message,
                "ACP session response did not include a string sessionId"
            );
            assert!(!provider.retryable);
            assert!(runtime.sessions().is_empty());
            assert!(events.try_recv().is_err());
        }
    })
    .await;
}

#[tokio::test]
async fn accepts_an_empty_string_id_but_preserves_the_null_reply_type_error() {
    bounded(async {
        let (runtime, sender, _) = setup(AcpAbortStrategy::Cancel, Some(r#"{"sessionId":""}"#));
        let session = runtime
            .start_session(AcpStartRequest {
                execution: request("empty", "empty ID", &sender),
                on_session_activated: None,
            })
            .await
            .unwrap();
        assert_eq!(session.agent_session_id, "");
        assert!(session.native_path.is_none());
        runtime.shutdown();

        let (runtime, sender, mut events) = setup(AcpAbortStrategy::Cancel, Some("null"));
        let error = runtime
            .start_session(AcpStartRequest {
                execution: request("null", "must not be sent", &sender),
                on_session_activated: None,
            })
            .await
            .err()
            .expect("null has no sessionId property");
        assert_eq!(
            garcon_base::errors::error_metadata(error.as_ref()).name,
            "TypeError"
        );
        assert_eq!(
            error.to_string(),
            "null is not an object (evaluating 'opened.sessionId')"
        );
        assert!(runtime.sessions().is_empty());
        assert!(events.try_recv().is_err());
    })
    .await;
}

#[tokio::test]
async fn the_running_runtime_emits_the_same_rows_and_terminal_outcomes_as_bun() {
    bounded(async {
        let mut oracle = Command::new("bun");
        oracle.arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/acp-agent-runtime-wire.ts"
        )).kill_on_drop(true);
        let oracle = oracle.output().await.unwrap();
        assert!(oracle.status.success(), "{}", String::from_utf8_lossy(&oracle.stderr));
        let (runtime, sender, mut events) = setup(AcpAbortStrategy::Cancel, None);
        let session = runtime.start_session(AcpStartRequest {
            execution: request("first", "first", &sender), on_session_activated: None,
        }).await.unwrap();
        let mut replies = Vec::new();
        for (run_id, text) in [("first", "first:1"), ("second", "second:2")] {
            if run_id == "second" {
                runtime.run_turn(AcpResumeRequest {
                    execution: request(run_id, "second", &sender),
                    agent_session_id: session.agent_session_id.clone(),
                    native_path: session.native_path.clone(),
                }).await.unwrap();
            }
            let Some(AgentRuntimeEvent::Rows { rows }) = events.recv().await else { panic!("expected a row") };
            let rows: Vec<_> = rows.into_iter().map(|row| row.message).collect();
            replies.push(json!({"event": "rows", "rows": rows}));
            let Some(AgentRuntimeEvent::RunEnded {
                run_id: id,
                outcome: ProviderRunOutcome::Finished { final_response: Some(final_response) },
                ..
            }) = events.recv().await else { panic!("expected a finished turn") };
            assert_eq!(id, run_id);
            assert_eq!(final_response, AgentFinalResponse::Text { text: text.to_owned() });
            replies.push(json!({"event": "run-ended", "runId": id, "outcome": "finished", "finalResponse": final_response}));
        }
        let actual = json!({
            "session": {"agentSessionId": session.agent_session_id, "nativePath": session.native_path},
            "replies": replies,
        });
        assert_eq!(format!("{}\n", garcon_js::json::stringify(&actual)), String::from_utf8(oracle.stdout).unwrap());
        runtime.shutdown();
    }).await;
}

#[tokio::test]
async fn publishes_permission_and_terminal_output_only_for_the_owning_session() {
    bounded(async {
        let (runtime, sender, mut events) = setup(AcpAbortStrategy::Cancel, None);
        let session = runtime
            .start_session(AcpStartRequest {
                execution: request("first", "permission", &sender),
                on_session_activated: None,
            })
            .await
            .unwrap();
        assert_eq!(session.agent_session_id, "native-1");
        assert_eq!(session.native_path.as_deref(), Some("!synthetic:native-1"));
        let Some(AgentRuntimeEvent::Permission {
            run_id,
            lifecycle:
                AgentProviderPermissionLifecycle::Requested(AgentRequestedPermission::Requested {
                    permission_occurrence_id,
                    requested_tool,
                    ..
                }),
            decision: Some(decision),
        }) = events.recv().await
        else {
            panic!("expected the permission event")
        };
        assert_eq!(run_id, "first");
        assert_eq!(permission_occurrence_id, "occurrence-1");
        assert_eq!(requested_tool.tool_id(), "tool-1");
        assert!(runtime.is_running("native-1"));
        decision
            .respond(PermissionDecisionPayload {
                allow: false,
                always_allow: None,
                response: None,
            })
            .await
            .unwrap();
        let Some(AgentRuntimeEvent::Rows { rows }) = events.recv().await else {
            panic!("expected the assistant row")
        };
        assert_eq!(rows.len(), 1);
        let ChatMessage::Assistant(answer) = &rows[0].message else {
            panic!("expected assistant text")
        };
        assert_eq!(answer.content, "before permission no");
        let Some(AgentRuntimeEvent::RunEnded {
            run_id,
            outcome:
                ProviderRunOutcome::Finished {
                    final_response: Some(AgentFinalResponse::Text { text }),
                },
            ..
        }) = events.recv().await
        else {
            panic!("expected the terminal event")
        };
        assert_eq!(run_id, "first");
        assert_eq!(text, "before permission no");
        assert!(!runtime.is_running("native-1"));
        let late = decision
            .respond(PermissionDecisionPayload {
                allow: true,
                always_allow: None,
                response: None,
            })
            .await
            .unwrap_err();
        assert_eq!(
            late.to_string(),
            "ACP permission occurrence is no longer pending"
        );
        runtime.shutdown();
    })
    .await;
}

#[tokio::test]
async fn resumes_the_exact_session_and_replaces_only_the_restart_policy_process() {
    bounded(async {
        for (strategy, prompts) in [
            (AcpAbortStrategy::Cancel, 2),
            (AcpAbortStrategy::ProcessRestart, 1),
        ] {
            let (runtime, sender, mut events) = setup(strategy, None);
            let session = runtime
                .start_session(AcpStartRequest {
                    execution: request("first", "hold", &sender),
                    on_session_activated: None,
                })
                .await
                .unwrap();
            let id = session.agent_session_id;
            assert!(runtime.is_running(&id));
            assert!(runtime.abort(&id));
            runtime
                .run_turn(AcpResumeRequest {
                    execution: request("second", "answer", &sender),
                    agent_session_id: id.clone(),
                    native_path: session.native_path,
                })
                .await
                .unwrap();
            let mut terminal = None;
            while let Ok(event) = events.try_recv() {
                if let AgentRuntimeEvent::RunEnded {
                    run_id, outcome, ..
                } = event
                {
                    assert_eq!(run_id, "second");
                    assert!(terminal.replace(outcome).is_none());
                }
            }
            let Some(ProviderRunOutcome::Finished {
                final_response: Some(AgentFinalResponse::Text { text }),
            }) = terminal
            else {
                panic!("expected the resumed turn to finish");
            };
            assert_eq!(text, format!("answer:{prompts}"));
            assert!(!runtime.is_running(&id));
            runtime.shutdown();
        }
    })
    .await;
}
