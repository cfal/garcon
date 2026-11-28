use std::{fs, os::unix::fs::PermissionsExt, path::Path, time::Duration};

use garcon_agents_common::execution::runtime_events::{
    PrepareDelivery, ProviderRunOutcome, RuntimeSteerRequest, runtime_operation,
};
use garcon_contract::chat_modes::{PermissionMode, ThinkingMode};
use garcon_interface::services::{AgentSteerRejectionReason, AgentSteerResult};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::{mpsc, oneshot},
    task::LocalSet,
};

use super::*;
use crate::cli_process_transport::ClaudeSubprocess;

struct Logger;
impl AgentLogger for Logger {
    fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn warn(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
}

#[tokio::test(start_paused = true)]
async fn an_interrupt_receipt_replaces_the_receipt_deadline_with_a_completion_deadline() {
    LocalSet::new()
        .run_until(async {
            let runtime = ClaudeCli::new(Rc::new(|| "not-spawned".into()), Rc::new(Logger));
            let session = Rc::new(ClaudeRunningSession::new(options(Path::new("."))));
            runtime.register_session(session.clone());
            let (publish, mut events) = mpsc::unbounded_channel();
            let turn = runtime
                .begin_turn(
                    &session,
                    runtime_operation(
                        "run-1".into(),
                        Rc::new(move |event| publish.send(event).unwrap()),
                    ),
                )
                .unwrap();
            let input = turn.protocol.borrow().input_uuid.clone();
            turn.protocol.borrow_mut().observe_input(
                &json!({"type":"command_lifecycle","state":"started","command_uuid":input}),
            );
            let (stdin, peer) = tokio::io::duplex(4096);
            let mut peer = BufReader::new(peer).lines();
            let (exit, exited) = oneshot::channel();
            let exit = RefCell::new(Some(exit));
            let (signal, mut signals) = mpsc::unbounded_channel();
            let transport = ClaudeProcessTransport::new(ClaudeProcessTransportOptions {
                process: ClaudeSubprocess {
                    stdin: Some(Box::pin(stdin)),
                    stdout: None,
                    stderr: None,
                    pid: None,
                    exited: Box::pin(async move { Ok(exited.await.unwrap()) }),
                    kill: Rc::new(move |kind| {
                    signal.send((kind, Instant::now())).unwrap();
                        if let Some(exit) = exit.take() {
                            exit.send(143).unwrap();
                        }
                        Ok(())
                    }),
                },
                logger: Rc::new(Logger),
                session_id: session.id.clone(),
                on_message: Rc::new(|_| {}),
                on_failure: Rc::new(|error| panic!("{error:?}")),
                on_eof: Rc::new(|| {}),
                on_exit: Rc::new(|_| {}),
                max_stdout_frame_bytes: None,
            });
            session.process.replace(Some(ClaudeSessionProcess {
                identity: Rc::new(()),
                transport,
            }));
        let steer_request = |prepare_delivery: PrepareDelivery| RuntimeSteerRequest {
            question_reply: None, chat_id: session.chat_id.clone(), project_path: ".".into(),
            agent_session_id: session.id.clone(), native_session: None, input: "synthetic steer".into(),
            target: runtime.steering.capture_target(&session.id), client_message_id: "steer-1".into(),
            prepare_delivery,
        };
        let process = session.process.borrow().clone().unwrap();
        let request = steer_request(Rc::new({
            let session = session.clone();
            let process = process.clone();
            move || Box::pin({
                let session = session.clone();
                let process = process.clone();
                async move {
                    session.process.replace(Some(ClaudeSessionProcess {
                        identity: Rc::new(()), transport: process.transport,
                    }));
                    Ok(())
                }
            })
        }));
        assert!(matches!(
            runtime.steering.steer(request).await.unwrap(),
            AgentSteerResult::Rejected { reason: AgentSteerRejectionReason::TurnChanged, .. }
        ));
        assert!(!turn.steering.blocks_idle_settlement());
        session.process.replace(Some(process));
        assert_eq!(
            runtime.steering.steer(steer_request(Rc::new(|| Box::pin(async { Ok(()) })))).await.unwrap(),
            AgentSteerResult::Accepted,
        );
        let steer = garcon_js::json::parse(&peer.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(steer["priority"], "next");
        assert_eq!(steer["session_id"], session.id);
        assert_eq!(steer["message"]["content"][0]["text"],
            "The user sent steering guidance for the active task:\n\nsynthetic steer");
        let steering_uuid = steer["uuid"].as_str().unwrap();
        assert_eq!(turn.steering.submitted_count(), 1);
        runtime.on_control_or_lifecycle(&session, &json!({"type":"command_lifecycle","state":"started","command_uuid":steering_uuid}));
        runtime.on_control_or_lifecycle(&session, &json!({"type":"command_lifecycle","state":"completed","command_uuid":steering_uuid}));
        assert!(!turn.steering.blocks_idle_settlement());
        let abort = tokio::task::spawn_local({
                let runtime = runtime.clone();
                let id = session.id.clone();
                async move { runtime.abort_session(&id).await }
            });
            let request = peer.next_line().await.unwrap().unwrap();
            let request = garcon_js::json::parse(&request).unwrap();
            assert_eq!(request["request"]["subtype"], "interrupt");
            assert_eq!(request["request"]["cancel_queued"], true);
        let receipt_at = Instant::now();
        assert!(runtime.control.handle_response(&session.id, &json!({
            "type":"control_response",
            "response":{"subtype":"success", "request_id":request["request_id"], "response":{}}
        })));
            assert!(abort.await.unwrap().unwrap());
            assert!(session.is_current_turn(&turn));
        let (signal, signalled_at) = signals.recv().await.unwrap();
        assert_eq!(signal, ClaudeProcessSignal::Term);
        assert!(signalled_at.duration_since(receipt_at) >= INTERRUPT_COMPLETION_TIMEOUT);
            turn.completion().await;
            let AgentRuntimeEvent::RunEnded {
                outcome: ProviderRunOutcome::Failed { error: Some(error) },
                ..
            } = events.try_recv().unwrap()
            else {
                panic!("expected failed interrupt");
            };
            assert_eq!(
                error.message.as_deref(),
                Some("Claude CLI did not confirm the interrupt.")
            );
            assert!(events.try_recv().is_err());
        })
        .await;
}

fn options(cwd: &Path) -> ClaudeSessionOptions {
    ClaudeSessionOptions {
        agent_session_id: "synthetic-session".into(),
        session_id: "synthetic-session".into(),
        chat_id: "synthetic-chat".into(),
        project_path: cwd.to_str().unwrap().into(),
        model: "synthetic-model".into(),
        permission_mode: PermissionMode::Default,
        thinking_mode: ThinkingMode::None,
        claude_thinking_mode: None,
        env_overrides: None,
    }
}

#[tokio::test]
async fn a_real_cli_gets_matching_permitted_answers_and_cannot_reuse_a_cancelled_decision() {
    use garcon_contract::chat_command_contracts::{
        PermissionDecisionPayload, PermissionDecisionResponse,
    };
    use garcon_interface::producer::AgentRequestedPermission;

    async fn receive<T>(events: &mut mpsc::UnboundedReceiver<T>) -> T {
        tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap()
    }

    LocalSet::new().run_until(async {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("fake-claude-permissions");
        fs::write(&script, r#"#!/bin/sh
printf '%s\n' '{"type":"control_request","request_id":"bash","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}'
read -r answer || exit 1
printf '{"type":"permission-observed","frame":%s}\n' "$answer"
printf '%s\n' '{"type":"control_request","request_id":"question","request":{"subtype":"can_use_tool","tool_name":"Ask_User-Question","tool_use_id":"tool-question","input":{"questions":[{"question":"Which?","options":[{"id":"a","label":"First","preview":"Synthetic preview"}]}]}}}'
read -r answer || exit 1
printf '{"type":"permission-observed","frame":%s}\n' "$answer"
printf '%s\n' '{"type":"control_request","request_id":"cancel","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion"}}'
printf '%s\n' '{"type":"control_cancel_request","request_id":"cancel"}'
read -r close || exit 1
"#).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = ClaudeCli::new(Rc::new(move || script.as_os_str().to_owned()), Rc::new(Logger));
        let mut options = options(directory.path());
        options.permission_mode = PermissionMode::ManualBypass;
        let session = Rc::new(ClaudeRunningSession::new(options.clone()));
        runtime.register_session(session.clone());
        let (publish, mut events) = mpsc::unbounded_channel();
        let turn = runtime.begin_turn(&session, runtime_operation("run-1".into(), Rc::new(move |event| publish.send(event).unwrap()))).unwrap();
        let input = turn.protocol.borrow().input_uuid.clone();
        turn.protocol.borrow_mut().observe_input(&json!({"type":"command_lifecycle","state":"started","command_uuid":input}));
        let (echo, mut echoed) = mpsc::unbounded_channel();
        runtime.spawn_cli(&session, options, false, Rc::new(move |_, frame| echo.send(frame).unwrap())).await.unwrap();

        let bypassed = receive(&mut echoed).await;
        assert_eq!(bypassed["frame"], json!({
            "type":"control_response",
            "response":{"request_id":"bash","subtype":"success","response":{"behavior":"allow","updatedInput":{"command":"ls"}}},
        }));
        let AgentRuntimeEvent::Permission {
            lifecycle: AgentProviderPermissionLifecycle::Requested(AgentRequestedPermission::Requested {
                permission_occurrence_id, requested_tool, ..
            }), decision: Some(decide), ..
        } = receive(&mut events).await else { panic!("expected structured question"); };
        assert_eq!(decide.permission_occurrence_id(), permission_occurrence_id);
        assert_eq!(serde_json::to_value(requested_tool).unwrap()["type"], "ask-user-question-tool-use");
        let answer = PermissionDecisionPayload {
            allow: true, always_allow: Some(false),
            response: Some(PermissionDecisionResponse::Provider(json!({
                "type":"ask-user-question-response","outcome":"answered",
                "answers":[{"questionId":"Which?","selectedOptionIds":["a"]}]
            }).into())),
        };
        decide.respond(answer.clone()).await.unwrap();
        let answered = receive(&mut echoed).await;
        assert_eq!(answered["frame"]["response"]["request_id"], "question");
        let response = &answered["frame"]["response"]["response"];
        assert_eq!(response["toolUseID"], "tool-question");
        assert_eq!(response["updatedInput"]["answers"]["Which?"], "First");
        assert_eq!(response["updatedInput"]["annotations"]["Which?"]["preview"], "Synthetic preview");

        let AgentRuntimeEvent::Permission { decision: Some(cancelled), .. } =
            receive(&mut events).await else { panic!("expected another structured question"); };
        assert!(matches!(receive(&mut events).await, AgentRuntimeEvent::Permission {
            lifecycle: AgentProviderPermissionLifecycle::Terminal(AgentTerminalPermission::Cancelled {
                permission_occurrence_id, ..
            }), ..
        } if permission_occurrence_id == cancelled.permission_occurrence_id()));
        assert_eq!(cancelled.respond(answer).await.unwrap_err().to_string(), "Claude permission occurrence is no longer pending");
        runtime.finish_turn(&session);
        let process = session.process.borrow().clone().unwrap();
        process.transport.write_line("{}".into(), Default::default()).await.unwrap();
        assert_eq!(process.transport.exited().await.unwrap(), 0);
    }).await;
}

#[tokio::test]
async fn a_real_cli_exit_settles_the_active_turn_once_and_cancels_its_pending_permission() {
    LocalSet::new().run_until(async {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("fake-claude");
        fs::write(&script, concat!(
            "#!/bin/sh\n",
            "read -r first || exit 1\n",
            "printf '%s\\n' '{\"type\":\"fake-barrier\"}'\n",
            "printf '%s\\n' '{\"type\":\"stale-frame\"}'\n",
            "read -r second || exit 1\n",
            "exit 7\n",
        )).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = ClaudeCli::new(Rc::new(move || script.as_os_str().to_owned()), Rc::new(Logger));
        let options = options(directory.path());
        let session = Rc::new(ClaudeRunningSession::new(options.clone()));
        runtime.register_session(session.clone());
        let (publish, mut events) = mpsc::unbounded_channel();
        let turn = runtime.begin_turn(&session, runtime_operation("run-1".into(), Rc::new(move |event| publish.send(event).unwrap()))).unwrap();
        let input = turn.protocol.borrow().input_uuid.clone();
        turn.protocol.borrow_mut().observe_input(&json!({"type":"command_lifecycle","state":"started","command_uuid":input}));
        turn.protocol.borrow_mut().mark_abort_requested();
        runtime.pending_permissions.borrow_mut().push(PendingPermission {
            permission_occurrence_id: "synthetic-permission".into(),
            cli_request_id: Some("synthetic-control".into()),
            agent_session_id: session.id.clone(),
            tool_name: "Read".into(),
            tool_input: json!({}).into(),
            tool_use_id: None,
            turn: turn.clone(),
        });
        let (reached, mut barrier) = mpsc::unbounded_channel();
        let replacement = Rc::new(ClaudeRunningSession::new(options.clone()));
        runtime.spawn_cli(&session, options, false, Rc::new({
            let runtime = Rc::downgrade(&runtime);
            move |_, frame| {
                if frame["type"] == "fake-barrier" {
                    runtime.upgrade().unwrap().register_session(replacement.clone());
                }
                reached.send(frame).unwrap();
            }
        })).await.unwrap();
        let process = session.process.borrow().clone().unwrap();
        process.transport.write_line("{}".into(), Default::default()).await.unwrap();
        let ready = tokio::time::timeout(Duration::from_secs(5), barrier.recv()).await.unwrap().unwrap();
        assert_eq!(ready["type"], "fake-barrier");
        assert!(session.is_current_turn(&turn));
        process.transport.write_line("{}".into(), Default::default()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), turn.completion()).await.unwrap();
        assert!(turn.interrupt_request_failed());
        assert!(session.active_turn.borrow().is_none());
        assert!(session.process.borrow().is_none());
        assert!(runtime.pending_permissions.borrow().is_empty());
        assert!(matches!(events.try_recv().unwrap(), AgentRuntimeEvent::Permission {
            lifecycle: AgentProviderPermissionLifecycle::Terminal(AgentTerminalPermission::Cancelled {
                permission_occurrence_id, ..
            }), ..
        } if permission_occurrence_id == "synthetic-permission"));
        let AgentRuntimeEvent::RunEnded {
            run_id, outcome: ProviderRunOutcome::Failed { error: Some(error) }, ..
        } = events.try_recv().unwrap() else { panic!("expected one failed run"); };
        assert_eq!(run_id, "run-1");
        assert_eq!(error.code, "PROVIDER_FAILURE");
        assert!(matches!(error.message.as_deref(),
            Some("Claude CLI stdout ended before the submitted message produced a terminal result."
                | "Claude CLI process exited with code 7")
        ));
        assert_eq!(process.transport.exited().await.unwrap(), 7);
        if let Some(retirement) = runtime.retire_session_process(&session).unwrap() {
            retirement.as_ref().clone().await.unwrap();
        }
        assert!(events.try_recv().is_err());
        assert!(barrier.try_recv().is_err());
    }).await;
}
