use std::{fs, os::unix::fs::PermissionsExt, path::Path, time::Duration};

use garcon_agents_common::execution::runtime_events::{
    PrepareDelivery, ProviderRunOutcome, RuntimeSteerRequest, runtime_operation,
};
use garcon_contract::chat_modes::{PermissionMode, ThinkingMode};
use garcon_interface::services::{AgentSteerRejectionReason, AgentSteerResult};
use garcon_js::ManualClock;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader, DuplexStream},
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

#[test]
fn api_retry_logs_javascript_numbers_and_keeps_signed_zero_until_serialization() {
    #[derive(Default)]
    struct RetryLogger(RefCell<Vec<IndexMap<String, Opaque>>>);
    impl AgentLogger for RetryLogger {
        fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn warn(&self, message: &str, fields: Option<&IndexMap<String, Opaque>>) {
            assert_eq!(message, "Claude API request is retrying");
            self.0.borrow_mut().push(fields.unwrap().clone());
        }
        fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    }

    let logger = Rc::new(RetryLogger::default());
    let runtime = ClaudeCli::new(Rc::new(|| "not-spawned".into()), logger.clone());
    let session = Rc::new(ClaudeRunningSession::new(options(Path::new("."))));
    runtime
        .begin_turn(&session, runtime_operation("run-1".into(), Rc::new(|_| {})))
        .unwrap();
    let retry = garcon_js::json::parse(
        r#"{"type":"system","subtype":"api_retry","attempt":-0.0,"retry_delay_ms":0.000001,"error_status":1e21,"error":"synthetic retry"}"#,
    )
    .unwrap();
    assert!(runtime.on_control_or_lifecycle(&session, &retry));

    let warnings = logger.0.borrow();
    let [details] = warnings.as_slice() else {
        panic!("expected one retry warning");
    };
    assert_eq!(
        serde_json::to_string(details).unwrap(),
        concat!(
            r#"{"chatId":"synthetic-chat","runId":"run-1","sessionId":"syntheti","processId":null,"matchedUserInput":false,"#,
            r#""attempt":0,"maxRetries":null,"delayMs":0.000001,"errorStatus":1e+21,"error":"synthetic retry"}"#,
        ),
    );
    let attempt = garcon_js::json::as_number(details["attempt"].as_value()).unwrap();
    assert!(attempt.is_sign_negative());
    drop(warnings);

    let retry = garcon_js::json::parse(
        r#"{"type":"system","subtype":"api_retry","retry_delay_ms":1.25,"error_status":529.0}"#,
    )
    .unwrap();
    assert!(runtime.on_control_or_lifecycle(&session, &retry));
    let warnings = logger.0.borrow();
    let status = &warnings[1]["errorStatus"];
    assert_eq!(serde_json::to_string(status).unwrap(), "529");
    assert_eq!(serde_json::to_string(status.as_value()).unwrap(), "529.0");
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

#[test]
fn terminal_before_start_is_not_routed_as_steering_work() {
    let runtime = ClaudeCli::new(Rc::new(|| "not-spawned".into()), Rc::new(Logger));
    let session = Rc::new(ClaudeRunningSession::new(options(Path::new("."))));
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
    turn.steering.mark_submitted(input.clone());
    let handled = runtime.on_control_or_lifecycle(
        &session,
        &json!({
            "type":"command_lifecycle","state":"discarded","command_uuid":input
        }),
    );
    assert_eq!(turn.steering.settlement_failure_message(), None);
    assert!(handled);
    let AgentRuntimeEvent::RunEnded {
        outcome: ProviderRunOutcome::Failed { error: Some(error) },
        ..
    } = events.try_recv().unwrap()
    else {
        panic!("expected failed submitted input");
    };
    assert_eq!(
        error.message.as_deref(),
        Some("Claude CLI discarded the submitted message before it started.")
    );
}

#[tokio::test(start_paused = true)]
async fn a_second_retirement_does_not_close_its_writer_until_the_first_exits() {
    fn process() -> (ClaudeSessionProcess, DuplexStream, oneshot::Sender<i32>) {
        let (stdin, peer) = tokio::io::duplex(64);
        let (exit, exited) = oneshot::channel();
        let transport = ClaudeProcessTransport::new(ClaudeProcessTransportOptions {
            process: ClaudeSubprocess {
                stdin: Some(Box::pin(stdin)),
                stdout: None,
                stderr: None,
                pid: None,
                exited: Box::pin(async move { exited.await.map_err(|error| error.to_string()) }),
                kill: Rc::new(|_| panic!("no signal expected before the test reports exit")),
            },
            logger: Rc::new(Logger),
            session_id: "synthetic-session".into(),
            on_message: Rc::new(|_| {}),
            on_failure: Rc::new(|_| {}),
            on_eof: Rc::new(|| {}),
            on_exit: Rc::new(|_| {}),
            max_stdout_frame_bytes: None,
        });
        (
            ClaudeSessionProcess {
                identity: Rc::new(()),
                transport,
            },
            peer,
            exit,
        )
    }
    LocalSet::new()
        .run_until(async {
            let runtime = ClaudeCli::new(Rc::new(|| "not-spawned".into()), Rc::new(Logger));
            let session = Rc::new(ClaudeRunningSession::new(options(Path::new("."))));
            let (first, mut first_peer, first_exit) = process();
            session.process.replace(Some(first));
            let first_retirement = runtime.retire_session_process(&session).unwrap().unwrap();
            let mut byte = [0];
            assert_eq!(first_peer.read(&mut byte).await.unwrap(), 0);

            let (second, mut second_peer, second_exit) = process();
            session.process.replace(Some(second));
            let second_retirement = runtime.retire_session_process(&session).unwrap().unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(10), second_peer.read(&mut byte))
                    .await
                    .is_err()
            );
            first_exit.send(0).unwrap();
            assert_eq!(second_peer.read(&mut byte).await.unwrap(), 0);
            second_exit.send(0).unwrap();
            first_retirement.as_ref().clone().await.unwrap();
            second_retirement.as_ref().clone().await.unwrap();
        })
        .await;
}

const READ_INITIALIZE: &str = r#"
read -r initialize || exit 1
case "$initialize" in *'"subtype":"initialize"'*) ;; *) exit 2 ;; esac
request_id=${initialize#*\"request_id\":\"}
request_id=${request_id%%\"*}
"#;

const ACK_INITIALIZE: &str = r#"
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"commands":[]}}}\n' "$request_id"
"#;

fn write_fake_cli(script: &Path, body: &str) {
    fs::write(
        script,
        format!("#!/bin/sh\n{READ_INITIALIZE}\n{ACK_INITIALIZE}\n{body}"),
    )
    .unwrap();
    fs::set_permissions(script, fs::Permissions::from_mode(0o700)).unwrap();
}

fn write_fake_session_cli(script: &Path) {
    fs::write(
        script,
        format!(
            r#"#!/bin/sh
if [ "$1" = --version ]; then
  printf '%s\n' '2.1.238 (Claude Code)'
  exit 0
fi
printf 'spawn\n' >> process-starts
{READ_INITIALIZE}
{ACK_INITIALIZE}
while IFS= read -r frame; do
  case "$frame" in *'"type":"user"'*) ;; *) exit 3 ;; esac
  printf '%s\n' "$frame" >> prompt-frames
  input_id=${{frame#*\"uuid\":\"}}
  input_id=${{input_id%%\"*}}
  printf '{{"type":"command_lifecycle","state":"started","command_uuid":"%s"}}\n' "$input_id"
  printf '{{"type":"result","user_message_uuid":"%s","result":"synthetic answer"}}\n' "$input_id"
  printf '%s\n' '{{"type":"system","subtype":"session_state_changed","state":"idle"}}'
done
"#
        ),
    )
    .unwrap();
    fs::set_permissions(script, fs::Permissions::from_mode(0o700)).unwrap();
}

fn execution_request(
    directory: &Path,
    run: &str,
    prompt: &str,
    publish: Rc<dyn Fn(AgentRuntimeEvent)>,
) -> crate::runtime_types::ClaudeExecutionRequest {
    let session = options(directory);
    crate::runtime_types::ClaudeExecutionRequest {
        chat_id: session.chat_id,
        project_path: session.project_path,
        model: session.model,
        permission_mode: session.permission_mode,
        thinking_mode: session.thinking_mode,
        claude_thinking_mode: session.claude_thinking_mode,
        execution_admission: None,
        command: prompt.into(),
        images: Vec::new(),
        env_overrides: None,
        operation: runtime_operation(run.into(), publish),
    }
}

#[tokio::test]
async fn starts_and_resumes_one_native_process_only_after_execution_admission() {
    use garcon_interface::execution::AgentExecutionAdmission;

    struct Admission {
        signal: CancellationToken,
        entered: Cell<Option<oneshot::Sender<()>>>,
        release: Cell<Option<oneshot::Receiver<()>>>,
    }

    #[async_trait::async_trait(?Send)]
    impl AgentExecutionAdmission for Admission {
        fn signal(&self) -> &CancellationToken {
            &self.signal
        }

        async fn mark_started(&self) -> ExecutorResult<()> {
            self.entered.take().unwrap().send(()).unwrap();
            self.release.take().unwrap().await?;
            Ok(())
        }
    }

    LocalSet::new()
        .run_until(async {
            let directory = tempfile::tempdir().unwrap();
            let script = directory.path().join("fake-claude-runtime");
            write_fake_session_cli(&script);
            let runtime = ClaudeCli::new(
                Rc::new({
                    let script = script.clone();
                    move || script.as_os_str().to_owned()
                }),
                Rc::new(Logger),
            );
            let (entered, pending_admission) = oneshot::channel();
            let (release, allowed) = oneshot::channel();
            let (publish, mut events) = mpsc::unbounded_channel();
            let mut first = execution_request(
                directory.path(),
                "first-run",
                "synthetic first prompt",
                Rc::new({
                    let publish = publish.clone();
                    move |event| publish.send(event).unwrap()
                }),
            );
            first.execution_admission = Some(Rc::new(Admission {
                signal: CancellationToken::new(),
                entered: Cell::new(Some(entered)),
                release: Cell::new(Some(allowed)),
            }));
            let activated = Rc::new(Cell::new(false));
            let id = "synthetic-session";
            let start = tokio::task::spawn_local({
                let runtime = runtime.clone();
                let activated = activated.clone();
                async move {
                    runtime
                        .start_claude_cli_session(ClaudeStartRequest {
                            execution: first,
                            agent_session_id: id.into(),
                            on_session_activated: Some(Rc::new(move || activated.set(true))),
                        })
                        .await
                }
            });
            tokio::time::timeout(Duration::from_secs(5), pending_admission)
                .await
                .unwrap()
                .unwrap();
            assert!(activated.get());
            assert_eq!(runtime.running_sessions()[0].agent_session_id, id);
            assert!(!directory.path().join("prompt-frames").exists());
            assert_eq!(
                fs::read_to_string(directory.path().join("process-starts")).unwrap(),
                "spawn\n"
            );
            let error = runtime.prepare_claude_project_path_update(ClaudeProjectPathUpdate {
                chat_id: "synthetic-chat".into(),
                agent_session_id: Some(id.into()),
                previous_project_path: directory.path().to_string_lossy().into_owned(),
                next_project_path: "synthetic-destination".into(),
                native_path: None,
            }).await.unwrap_err();
            let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
            assert_eq!(error.code, AgentIntegrationErrorCode::SESSION_BUSY);
            assert_eq!(error.message, "Cannot update project path while Claude is running");
            release.send(()).unwrap();
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(5), start)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap(),
                id
            );
            assert!(runtime.running_sessions().is_empty());

            let session = runtime.session(id).unwrap();
            let pid = session.process_id().unwrap();
            runtime
                .run_claude_turn(ClaudeResumeRequest {
                    execution: execution_request(
                        directory.path(),
                        "second-run",
                        "synthetic second prompt",
                        Rc::new(move |event| publish.send(event).unwrap()),
                    ),
                    agent_session_id: id.into(),
                    native_path: None,
                })
                .await
                .unwrap();
            assert_eq!(session.process_id(), Some(pid));
            assert!(runtime.running_sessions().is_empty());
            let mut frames: Vec<Value> = fs::read_to_string(directory.path().join("prompt-frames"))
                .unwrap()
                .lines()
                .map(|line| garcon_js::json::parse(line).unwrap())
                .collect();
            assert_eq!(frames.len(), 2);
            assert_eq!(frames[0]["message"]["content"], "synthetic first prompt");
            assert_eq!(frames[1]["message"]["content"], "synthetic second prompt");
            assert_ne!(frames[0]["uuid"], frames[1]["uuid"]);
            let mut completed = Vec::new();
            while let Ok(event) = events.try_recv() {
                if let AgentRuntimeEvent::RunEnded {
                    run_id,
                    outcome: ProviderRunOutcome::Finished { final_response },
                    ..
                } = event
                {
                    completed.push(json!({"runId":run_id, "outcome":"finished", "finalResponse":final_response}));
                }
            }
            assert_eq!(completed.len(), 2);
            assert_eq!(completed[0]["runId"], "first-run");
            assert_eq!(completed[1]["runId"], "second-run");
            runtime
                .release_session("different-chat", Some(id))
                .await
                .unwrap();
            assert_eq!(session.process_id(), Some(pid));
            runtime
                .release_session(&session.chat_id, Some(id))
                .await
                .unwrap();
            assert!(runtime.session(id).is_none());
            assert!(session.process_id().is_none());

            for frame in &mut frames {
                frame.as_object_mut().unwrap().shift_remove("uuid");
            }
            let starts = fs::read_to_string(directory.path().join("process-starts")).unwrap();
            let original_directory = tempfile::tempdir().unwrap();
            let original = tokio::process::Command::new("bun")
                .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/oracles/cli-runtime.ts"))
                .arg(script)
                .arg(original_directory.path())
                .output().await.unwrap();
            assert!(original.status.success(), "{}", String::from_utf8_lossy(&original.stderr));
            assert_eq!(
                serde_json::to_string(&json!({"frames":frames,"completed":completed,"starts":starts})).unwrap(),
                String::from_utf8(original.stdout).unwrap(),
            );
        })
        .await;
}

#[tokio::test]
async fn a_refused_mark_started_sends_no_prompt_and_retires_the_initialized_cli() {
    use garcon_interface::execution::AgentExecutionAdmission;

    struct Refusal(CancellationToken);

    #[async_trait::async_trait(?Send)]
    impl AgentExecutionAdmission for Refusal {
        fn signal(&self) -> &CancellationToken {
            &self.0
        }

        async fn mark_started(&self) -> ExecutorResult<()> {
            Err("synthetic admission refusal".into())
        }
    }

    LocalSet::new()
        .run_until(async {
            let directory = tempfile::tempdir().unwrap();
            let script = directory.path().join("fake-claude-refusal");
            write_fake_session_cli(&script);
            let runtime = ClaudeCli::new(
                Rc::new(move || script.as_os_str().to_owned()),
                Rc::new(Logger),
            );
            let mut execution = execution_request(
                directory.path(),
                "refused-run",
                "not submitted",
                Rc::new(|_| {}),
            );
            execution.execution_admission = Some(Rc::new(Refusal(CancellationToken::new())));
            let id = "synthetic-session";
            let error = runtime
                .start_claude_cli_session(ClaudeStartRequest {
                    execution,
                    agent_session_id: id.into(),
                    on_session_activated: None,
                })
                .await
                .unwrap_err();
            assert_eq!(error.to_string(), "synthetic admission refusal");
            assert_eq!(
                fs::read_to_string(directory.path().join("process-starts")).unwrap(),
                "spawn\n"
            );
            assert!(!directory.path().join("prompt-frames").exists());
            assert!(runtime.session(id).is_none());
            assert!(runtime.running_sessions().is_empty());
        })
        .await;
}

#[tokio::test]
async fn live_content_and_compaction_rows_keep_their_native_source() {
    use garcon_contract::chat_types::{CompactionTrigger, ToolUseChatMessage};

    async fn receive(events: &mut mpsc::UnboundedReceiver<AgentRuntimeEvent>) -> AgentRuntimeEvent {
        tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap()
    }

    LocalSet::new().run_until(async {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("fake-claude-stream");
        write_fake_cli(&script, r#"
read -r prompt || exit 1
printf '%s\n' '{"type":"assistant","uuid":"internal","content":[{"type":"text","text":"internal output"}]}'
printf '%s\n' '{"type":"command_lifecycle","state":"started","command_uuid":"stream-input"}'
printf '%s\n' '{"type":"assistant","uuid":"assistant-1","content":[{"type":"text","text":" "},{"type":"text","text":"visible"},{"type":"tool_use","id":"read-1","name":"Read","input":{"file_path":"synthetic.txt"}}]}'
printf '%s\n' '{"type":"user","uuid":"user-1","isReplay":true,"message":{"content":[{"type":"text","text":"copied prompt"},{"type":"tool_result","tool_use_id":"read-1","content":"synthetic output"}]},"tool_use_result":{"exitCode":0}}'
printf '%s\n' '{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":1000,"post_tokens":250}}'
printf '%s\n' '{"type":"user","uuid":"summary-1","message":{"content":"This session is being continued from a previous conversation. Summary: synthetic summary"}}'
printf '%s\n' '{"type":"result","user_message_uuid":"stream-input","result":"visible"}'
printf '%s\n' '{"type":"system","subtype":"session_state_changed","state":"idle"}'
read -r close || exit 2
"#);
        let runtime = ClaudeCli::new(Rc::new(move || script.as_os_str().to_owned()), Rc::new(Logger));
        let options = options(directory.path());
        let session = Rc::new(ClaudeRunningSession::with_clock(options.clone(), Rc::new(ManualClock::new(1234))));
        runtime.register_session(session.clone());
        let (publish, mut events) = mpsc::unbounded_channel();
        let turn = runtime.begin_turn(&session, runtime_operation("run-1".into(),
            Rc::new(move |event| publish.send(event).unwrap()))).unwrap();
        turn.protocol.borrow_mut().input_uuid = "stream-input".into();
        runtime.spawn_cli(&session, options, false, Rc::new(|_, frame| panic!("unexpected frame {frame:?}"))).await.unwrap();
        let process = session.process.borrow().clone().unwrap();
        process.transport.write_line("{}".into(), Default::default()).await.unwrap();
        assert!(matches!(receive(&mut events).await, AgentRuntimeEvent::Steerable));
        let AgentRuntimeEvent::Rows { rows } = receive(&mut events).await else { panic!("expected content rows"); };
        assert_eq!(rows.len(), 2);
        assert!(matches!(&rows[0].message, ChatMessage::Assistant(message) if message.content == "visible"));
        assert!(matches!(&rows[1].message, ChatMessage::ToolUse(ToolUseChatMessage::Read { .. })));
        let source = rows[1].provider_meta.as_ref().unwrap();
        assert_eq!(source["entryId"], "assistant-1");
        assert_eq!(garcon_js::json::as_number(&source["withinSourceOrdinal"]), Some(1.0));

        let AgentRuntimeEvent::Rows { rows } = receive(&mut events).await else { panic!("expected tool result"); };
        assert_eq!(rows.len(), 1);
        let ChatMessage::ToolResult(result) = &rows[0].message else { panic!("expected tool result"); };
        assert_eq!(result.tool_id, "read-1");
        assert_eq!(serde_json::to_string(&result.content).unwrap(), r#"{"raw":"synthetic output","toolUseResult":{"exitCode":0}}"#);
        assert_eq!(rows[0].provider_meta.as_ref().unwrap()["entryId"], "user-1");

        let AgentRuntimeEvent::Rows { rows } = receive(&mut events).await else { panic!("expected compaction"); };
        assert_eq!(rows.len(), 1);
        let ChatMessage::Compaction(summary) = &rows[0].message else { panic!("expected compaction"); };
        assert_eq!(summary.summary, "synthetic summary");
        assert_eq!(summary.trigger, CompactionTrigger::Auto);
        assert_eq!(summary.pre_tokens.map(|value| value.0), Some(1000.0));
        assert_eq!(summary.post_tokens.map(|value| value.0), Some(250.0));
        let source = rows[0].provider_meta.as_ref().unwrap();
        assert_eq!(source["entryId"], "summary-1");
        assert_eq!(garcon_js::json::as_number(&source["withinSourceOrdinal"]), Some(0.0));
        assert!(matches!(receive(&mut events).await, AgentRuntimeEvent::RunEnded { outcome: ProviderRunOutcome::Finished { .. }, .. }));
        process.transport.write_line("{}".into(), Default::default()).await.unwrap();
        assert_eq!(process.transport.exited().await.unwrap(), 0);
        assert!(events.try_recv().is_err());
    }).await;
}

#[tokio::test]
async fn a_real_cli_publishes_only_the_correlated_result_and_waits_for_provider_idle() {
    use garcon_interface::producer::AgentFinalResponse;

    async fn receive<T>(receiver: &mut mpsc::UnboundedReceiver<T>) -> T {
        tokio::time::timeout(Duration::from_secs(5), receiver.recv())
            .await
            .unwrap()
            .unwrap()
    }
    LocalSet::new().run_until(async {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("fake-claude-results");
        write_fake_cli(&script, r#"
read -r prompt || exit 1
case "$prompt" in *'"uuid":"submitted-input"'*) ;; *) exit 2 ;; esac
printf '%s\n' '{"type":"result","is_error":true,"result":"synthetic internal error"}'
printf '%s\n' '{"type":"command_lifecycle","state":"started","command_uuid":"submitted-input"}'
printf '%s\n' '{"type":"result","user_message_uuid":"foreign-input","result":"synthetic foreign output"}'
printf '%s\n' '{"type":"result","user_message_uuid":"submitted-input","result":"  synthetic result  "}'
printf '%s\n' '{"type":"result-received"}'
read -r release || exit 3
printf '%s\n' '{"type":"system","subtype":"session_state_changed","state":"idle"}'
read -r close || exit 4
"#);
        let runtime = ClaudeCli::new(Rc::new(move || script.as_os_str().to_owned()), Rc::new(Logger));
        let options = options(directory.path());
        let session = Rc::new(ClaudeRunningSession::with_clock(
            options.clone(), Rc::new(ManualClock::new(1234)),
        ));
        runtime.register_session(session.clone());
        let (publish, mut events) = mpsc::unbounded_channel();
        let turn = runtime.begin_turn(&session, runtime_operation("run-1".into(),
            Rc::new(move |event| publish.send(event).unwrap()))).unwrap();
        turn.protocol.borrow_mut().input_uuid = "submitted-input".into();
        let (signal, mut barrier) = mpsc::unbounded_channel();
        runtime.spawn_cli(&session, options, false, Rc::new(move |_, frame| signal.send(frame).unwrap())).await.unwrap();
        let process = session.process.borrow().clone().unwrap();
        process.transport.write_line(r#"{"type":"user","uuid":"submitted-input"}"#.into(), Default::default()).await.unwrap();
        assert_eq!(receive(&mut barrier).await["type"], "result-received");
        assert!(session.is_current_turn(&turn));
        assert!(matches!(receive(&mut events).await, AgentRuntimeEvent::Steerable));
        let AgentRuntimeEvent::Rows { rows } = receive(&mut events).await else { panic!("expected one rendered result"); };
        assert_eq!(rows.len(), 1);
        assert!(matches!(&rows[0].message, ChatMessage::Assistant(message)
            if message.content == "synthetic result" && message.timestamp == "1970-01-01T00:00:01.234Z"));
        assert!(events.try_recv().is_err());

        process.transport.write_line("{}".into(), Default::default()).await.unwrap();
        let AgentRuntimeEvent::RunEnded { outcome: ProviderRunOutcome::Finished { final_response: Some(AgentFinalResponse::Text { text }) }, .. }
            = receive(&mut events).await else { panic!("expected final response at provider idle"); };
        assert_eq!(text, "  synthetic result  ");
        assert!(session.active_turn.borrow().is_none());
        process.transport.write_line("{}".into(), Default::default()).await.unwrap();
        assert_eq!(process.transport.exited().await.unwrap(), 0);
    }).await;
}

#[test]
fn a_conversation_reset_supersedes_the_recorded_result_failure() {
    let runtime = ClaudeCli::new(Rc::new(|| "not-spawned".into()), Rc::new(Logger));
    let session = Rc::new(ClaudeRunningSession::new(options(Path::new("."))));
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
    turn.protocol
        .borrow_mut()
        .observe_input(&json!({"type":"command_lifecycle","state":"started","command_uuid":input}));
    assert!(runtime.on_control_or_lifecycle(&session, &json!({
        "type":"result","user_message_uuid":input,"is_error":true,"errors":["synthetic model error"]
    })));
    assert_eq!(
        turn.protocol.borrow().recorded_result_failure_message(),
        Some("synthetic model error")
    );
    assert!(runtime.on_control_or_lifecycle(
        &session,
        &json!({
            "type":"conversation_reset","new_conversation_id":"foreign-conversation"
        })
    ));
    let AgentRuntimeEvent::RunEnded {
        outcome: ProviderRunOutcome::Failed { error: Some(error) },
        ..
    } = events.try_recv().unwrap()
    else {
        panic!("expected reset failure");
    };
    assert_eq!(error.message.as_deref(), Some(CONVERSATION_RESET_FAILURE));
    assert_eq!(session.id, "synthetic-session");
    assert!(session.active_turn.borrow().is_none());
}

#[tokio::test]
async fn a_rejected_initialize_retires_the_cli_before_the_next_resume() {
    LocalSet::new().run_until(async {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("fake-claude-initialize");
        fs::write(&script, format!(r#"#!/bin/sh
{READ_INITIALIZE}
if [ ! -f synthetic-attempt ]; then
  : > synthetic-attempt
  printf '{{"type":"control_response","response":{{"subtype":"error","request_id":"%s","error":"initialize rejected"}}}}\n' "$request_id"
  read -r input && exit 4
  exit 0
fi
{ACK_INITIALIZE}
read -r input || exit 3
printf '%s\n' "$input"
read -r close || exit 3
"#)).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = ClaudeCli::new(Rc::new(move || script.as_os_str().to_owned()), Rc::new(Logger));
        let options = options(directory.path());
        let session = Rc::new(ClaudeRunningSession::new(options.clone()));
        runtime.register_session(session.clone());
        let (received, mut frames) = mpsc::unbounded_channel();
        let on_message: Rc<ClaudeStreamHandler> = Rc::new(move |_, frame| received.send(frame).unwrap());
        let error = runtime.spawn_cli(&session, options.clone(), true, on_message.clone()).await.unwrap_err();
        assert_eq!(error.to_string(), "initialize rejected");
        assert!(session.process.borrow().is_none());
        runtime.spawn_cli(&session, options, true, on_message).await.unwrap();
        let process = session.process.borrow().clone().unwrap();
        process.transport.write_line(r#"{"type":"synthetic-prompt"}"#.into(), Default::default()).await.unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(5), frames.recv()).await.unwrap().unwrap();
        assert_eq!(frame["type"], "synthetic-prompt");
        process.transport.write_line("{}".into(), Default::default()).await.unwrap();
        assert_eq!(process.transport.exited().await.unwrap(), 0);
    }).await;
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
        write_fake_cli(&script, r#"
printf '%s\n' '{"type":"control_request","request_id":"bash","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}'
read -r answer || exit 1
printf '{"type":"permission-observed","frame":%s}\n' "$answer"
printf '%s\n' '{"type":"control_request","request_id":"question","request":{"subtype":"can_use_tool","tool_name":"Ask_User-Question","tool_use_id":"tool-question","input":{"questions":[{"question":"Which?","options":[{"id":"a","label":"First","preview":"Synthetic preview"}]}]}}}'
read -r answer || exit 1
printf '{"type":"permission-observed","frame":%s}\n' "$answer"
printf '%s\n' '{"type":"control_request","request_id":"invalid-clock","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion"}}'
read -r answer || exit 1
printf '{"type":"permission-observed","frame":%s}\n' "$answer"
read -r proceed || exit 1
printf '%s\n' '{"type":"control_request","request_id":"cancel","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion"}}'
printf '%s\n' '{"type":"control_cancel_request","request_id":"cancel"}'
read -r close || exit 1
"#);
        let runtime = ClaudeCli::new(Rc::new(move || script.as_os_str().to_owned()), Rc::new(Logger));
        let mut options = options(directory.path());
        options.permission_mode = PermissionMode::ManualBypass;
        let clock = Rc::new(ManualClock::new(1234));
        let session = Rc::new(ClaudeRunningSession::with_clock(options.clone(), clock.clone()));
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
        let requested_tool: Value =
            garcon_js::json::from_slice(&serde_json::to_vec(&requested_tool).unwrap()).unwrap();
        assert_eq!(requested_tool["type"], "ask-user-question-tool-use");
        assert_eq!(requested_tool["timestamp"], "1970-01-01T00:00:01.234Z");
        let answer = PermissionDecisionPayload {
            allow: true, always_allow: Some(false),
            response: Some(PermissionDecisionResponse::Provider(json!({
                "type":"ask-user-question-response","outcome":"answered",
                "answers":[{"questionId":"Which?","selectedOptionIds":["a"]}]
            }).into())),
        };
        clock.set(i64::MAX);
        decide.respond(answer.clone()).await.unwrap();
        let answered = receive(&mut echoed).await;
        assert_eq!(answered["frame"]["response"]["request_id"], "question");
        let response = &answered["frame"]["response"]["response"];
        assert_eq!(response["toolUseID"], "tool-question");
        assert_eq!(response["updatedInput"]["answers"]["Which?"], "First");
        assert_eq!(response["updatedInput"]["annotations"]["Which?"]["preview"], "Synthetic preview");

        let invalid_clock = receive(&mut echoed).await;
        assert_eq!(invalid_clock["frame"]["response"],
            json!({"request_id":"invalid-clock", "subtype":"error", "error":"Invalid Date"}));
        assert!(runtime.pending_permissions.borrow().is_empty());
        assert!(events.try_recv().is_err());
        clock.set(1234);
        let process = session.process.borrow().clone().unwrap();
        process.transport.write_line("{}".into(), Default::default()).await.unwrap();
        let AgentRuntimeEvent::Permission { decision: Some(cancelled), .. } =
            receive(&mut events).await else { panic!("expected another structured question"); };
        assert!(matches!(receive(&mut events).await, AgentRuntimeEvent::Permission {
            lifecycle: AgentProviderPermissionLifecycle::Terminal(AgentTerminalPermission::Cancelled {
                permission_occurrence_id, ..
            }), ..
        } if permission_occurrence_id == cancelled.permission_occurrence_id()));
        assert_eq!(cancelled.respond(answer).await.unwrap_err().to_string(), "Claude permission occurrence is no longer pending");
        runtime.finish_turn(&session);
        process.transport.write_line("{}".into(), Default::default()).await.unwrap();
        assert_eq!(process.transport.exited().await.unwrap(), 0);
    }).await;
}

#[tokio::test]
async fn a_real_cli_exit_settles_the_active_turn_once_and_cancels_its_pending_permission() {
    LocalSet::new().run_until(async {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("fake-claude");
        write_fake_cli(&script, concat!(
            "read -r first || exit 1\n",
            "printf '%s\\n' '{\"type\":\"user\",\"uuid\":\"synthetic-steer\",\"isReplay\":true,\"parent_tool_use_id\":\"nested-tool\"}'\n",
            "printf '%s\\n' '{\"type\":\"fake-barrier\"}'\n",
            "printf '%s\\n' '{\"type\":\"stale-frame\"}'\n",
            "read -r second || exit 1\n",
            "exit 7\n",
        ));
        let runtime = ClaudeCli::new(Rc::new(move || script.as_os_str().to_owned()), Rc::new(Logger));
        let options = options(directory.path());
        let session = Rc::new(ClaudeRunningSession::new(options.clone()));
        runtime.register_session(session.clone());
        let (publish, mut events) = mpsc::unbounded_channel();
        let turn = runtime.begin_turn(&session, runtime_operation("run-1".into(), Rc::new(move |event| publish.send(event).unwrap()))).unwrap();
        let input = turn.protocol.borrow().input_uuid.clone();
        turn.protocol.borrow_mut().observe_input(&json!({"type":"command_lifecycle","state":"started","command_uuid":input}));
        turn.protocol.borrow_mut().mark_abort_requested();
        turn.steering.mark_submitted("synthetic-steer".into());
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
        assert_eq!(turn.steering.submitted_count(), 1);
        assert_eq!(turn.steering.settlement_failure_message(), None);
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
