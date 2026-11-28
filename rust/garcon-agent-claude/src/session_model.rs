use std::{cell::RefCell, rc::Rc};

use futures::future::LocalBoxFuture;
use garcon_agents_common::execution::admission::assert_execution_open;
use garcon_interface::{
    execution::AgentExecutionAdmission, host::AgentLogger, resources::ExecutorResult,
};
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::{
    cli_control::{ClaudeControlBroker, ClaudeControlRequestOptions},
    context_window_control::update_claude_context_window,
    model_context::resolve_claude_model,
    runtime_state::{ClaudeRunningSession, ClaudeSessionProcess},
};

pub struct ClaudeSessionModelOptions<'a> {
    pub execution_admission: Option<&'a dyn AgentExecutionAdmission>,
    pub control_broker: &'a ClaudeControlBroker,
    pub logger: &'a dyn AgentLogger,
    pub is_current_session: &'a dyn Fn() -> bool,
    pub retire_process: &'a dyn Fn() -> LocalBoxFuture<'a, ExecutorResult<()>>,
    pub resume_process: &'a dyn Fn() -> LocalBoxFuture<'a, ExecutorResult<()>>,
}

pub async fn configure_claude_session_model(
    session: &ClaudeRunningSession,
    desired_model: &str,
    options: ClaudeSessionModelOptions<'_>,
) -> ExecutorResult<()> {
    let current = resolve_claude_model(&session.current_model.borrow())?;
    let desired = resolve_claude_model(desired_model)?;
    let process = session.process.borrow().clone();
    if let Some(process) = process
        && current.auto_compact_window != desired.auto_compact_window
    {
        // Automatic policy is captured by the CLI at startup, not restored by clearing a live flag.
        if let (Some(_), Some(window)) = (current.auto_compact_window, desired.auto_compact_window)
        {
            if try_update_context_window(
                session,
                &process,
                &current.model,
                &desired.model,
                window,
                &options,
            )
            .await?
            {
                session.current_model.replace(desired_model.to_owned());
            }
        } else {
            (options.retire_process)().await?;
        }
    }
    if session.process.borrow().is_none() {
        assert_current_session(&options)?;
        (options.resume_process)().await?;
    }
    let needs_model_control = session.process.borrow().is_some()
        && session.current_model.borrow().as_str() != desired_model;
    if needs_model_control {
        options
            .control_broker
            .request(
                &session.id,
                json!({"subtype":"set_model", "model":desired.model}).into(),
                Default::default(),
            )
            .await?;
    }
    session.current_model.replace(desired_model.to_owned());
    Ok(())
}

async fn try_update_context_window(
    session: &ClaudeRunningSession,
    process: &ClaudeSessionProcess,
    current_model: &str,
    desired_model: &str,
    window: u32,
    options: &ClaudeSessionModelOptions<'_>,
) -> ExecutorResult<bool> {
    let assert_current_process = || {
        assert_current_session(options)?;
        if !session.is_current_process(&process.identity) || session.active_turn.borrow().is_some()
        {
            return Err("Claude process changed during context-window configuration".into());
        }
        Ok(())
    };
    let last_control = Rc::new(RefCell::new("get_settings".to_owned()));
    let result = update_claude_context_window(
        |request| {
            let last_control = last_control.clone();
            async move {
                assert_current_process()?;
                last_control.replace(request["subtype"].as_str().unwrap_or_default().to_owned());
                let response = options
                    .control_broker
                    .request(
                        &session.id,
                        request,
                        ClaudeControlRequestOptions {
                            signal: options
                                .execution_admission
                                .map(|admission| admission.signal().clone()),
                            ..Default::default()
                        },
                    )
                    .await?;
                assert_current_process()?;
                Ok(response)
            }
        },
        current_model,
        desired_model,
        window,
    )
    .await
    .and_then(|()| assert_current_process());
    if result.is_ok() {
        options.logger.info(
            "Claude context window updated without restarting",
            Some(&details(
                session,
                process,
                [
                    ("model", json!(desired_model)),
                    ("autoCompactWindow", json!(window)),
                ],
            )),
        );
        return Ok(true);
    }
    // Settings and CLI errors may contain credentials; only the failed operation is logged.
    options.logger.warn(
        "Claude context-window update failed; resuming with startup settings",
        Some(&details(
            session,
            process,
            [("controlSubtype", json!(last_control.take()))],
        )),
    );
    if (options.is_current_session)() && session.is_current_process(&process.identity) {
        (options.retire_process)().await?;
    }
    assert_current_session(options)?;
    Ok(false)
}

fn assert_current_session(options: &ClaudeSessionModelOptions<'_>) -> ExecutorResult<()> {
    if let Some(admission) = options.execution_admission {
        assert_execution_open(admission)?;
    }
    if !(options.is_current_session)() {
        return Err("Claude session ended during model configuration".into());
    }
    Ok(())
}

fn details<const N: usize>(
    session: &ClaudeRunningSession,
    process: &ClaudeSessionProcess,
    fields: [(&str, Value); N],
) -> IndexMap<String, Opaque> {
    let prefix = String::from_utf16_lossy(&session.id.encode_utf16().take(8).collect::<Vec<_>>());
    [
        ("chatId", json!(session.chat_id)),
        ("sessionId", json!(prefix)),
        ("processId", json!(process.transport.pid())),
    ]
    .into_iter()
    .chain(fields)
    .map(|(key, value)| (key.to_owned(), value.into()))
    .collect()
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use garcon_contract::chat_modes::{PermissionMode, ThinkingMode};
    use tokio::task::LocalSet;

    use crate::{
        cli_process_transport::{
            ClaudeProcessTransport, ClaudeProcessTransportOptions, ClaudeSubprocess,
        },
        session_options::ClaudeSessionOptions,
    };

    use super::*;

    struct Logger;
    impl AgentLogger for Logger {
        fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn warn(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    }

    #[tokio::test]
    async fn a_live_cap_change_is_kept_only_after_verification_then_restarts_on_failure() {
        LocalSet::new().run_until(async {
            let session = ClaudeRunningSession::new(ClaudeSessionOptions {
                agent_session_id: "session-1".into(), session_id: "session-1".into(),
                chat_id: "chat-1".into(), project_path: ".".into(), model: "synthetic-model[500k]".into(),
                permission_mode: PermissionMode::Default, thinking_mode: ThinkingMode::None,
                claude_thinking_mode: None, env_overrides: None,
            });
            let transport = ClaudeProcessTransport::new(ClaudeProcessTransportOptions {
                process: ClaudeSubprocess {
                    stdin: None, stdout: None, stderr: None, pid: None,
                    exited: Box::pin(std::future::pending()),
                    kill: Rc::new(|_| panic!("no actual process")),
                },
                logger: Rc::new(Logger), session_id: session.id.clone(),
                on_message: Rc::new(|_| {}), on_failure: Rc::new(|_| {}), on_eof: Rc::new(|| {}),
                on_exit: Rc::new(|_| {}), max_stdout_frame_bytes: None,
            });
            session.process.replace(Some(ClaudeSessionProcess { identity: Rc::new(()), transport }));
            let reported = Rc::new(Cell::new(600_000));
            let controls = Rc::new(RefCell::new(Vec::new()));
            let broker = Rc::<ClaudeControlBroker>::new_cyclic(|broker| {
                let broker = broker.clone();
                let reported = reported.clone();
                let controls = controls.clone();
                ClaudeControlBroker::new(Rc::new(move |session_id, frame| {
                    let request = garcon_js::json::parse(&frame).unwrap();
                    let subtype = request["request"]["subtype"].as_str().unwrap();
                    controls.borrow_mut().push(subtype.to_owned());
                    let result = match subtype {
                        "get_settings" => json!({"sources":[{"source":"flagSettings","settings":{"env":{"OLD":"preserved"}}}]}),
                        "get_context_usage" => json!({"model":"synthetic-model","autocompactSource":"env","rawMaxTokens":reported.get()}),
                        "apply_flag_settings" => {
                            assert_eq!(request["request"]["settings"]["env"]["OLD"], "preserved");
                            json!({})
                        }
                        _ => panic!("unexpected control {subtype}"),
                    };
                    assert!(broker.upgrade().unwrap().handle_response(&session_id, &json!({
                        "type":"control_response","response":{"subtype":"success","request_id":request["request_id"],"response":result}
                    })));
                    Box::pin(async { Ok(()) })
                }))
            });
            let calls = RefCell::new(Vec::new());
            let retire_process = || -> LocalBoxFuture<'_, ExecutorResult<()>> { Box::pin(async {
                calls.borrow_mut().push("retire");
                session.process.take();
                Ok(())
            }) };
            let resume_process = || -> LocalBoxFuture<'_, ExecutorResult<()>> { Box::pin(async {
                calls.borrow_mut().push("resume");
                Ok(())
            }) };
            let options = || ClaudeSessionModelOptions {
                execution_admission: None, control_broker: &broker, logger: &Logger,
                is_current_session: &|| true, retire_process: &retire_process, resume_process: &resume_process,
            };
            configure_claude_session_model(&session, "synthetic-model[600k]", options()).await.unwrap();
            assert_eq!(&*session.current_model.borrow(), "synthetic-model[600k]");
            assert_eq!(&*controls.borrow(), &["get_settings", "apply_flag_settings", "get_context_usage"]);
            assert!(calls.borrow().is_empty());

            controls.borrow_mut().clear();
            configure_claude_session_model(&session, "synthetic-model[700k]", options()).await.unwrap();
            assert_eq!(&*calls.borrow(), &["retire", "resume"]);
            assert_eq!(&*session.current_model.borrow(), "synthetic-model[700k]");
        }).await;
    }
}
