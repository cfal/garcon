use std::{rc::Rc, time::Duration};

use garcon_interface::host::AgentLogger;
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    cli_protocol::{
        ClaudeProviderSessionState, ClaudeReportedSessionState, claude_background_task_count,
        claude_provider_session_state,
    },
    runtime_state::ClaudeRunningSession,
};

type SessionHandler = Rc<dyn Fn(&Rc<ClaudeRunningSession>)>;
type FailSession = Rc<dyn Fn(&Rc<ClaudeRunningSession>, String)>;

#[derive(Clone)]
pub struct ClaudeProviderStateHandlers {
    pub logger: Rc<dyn AgentLogger>,
    pub finish: SessionHandler,
    pub fail: FailSession,
    pub retire: SessionHandler,
    pub steering_idle_fence_timeout: Duration,
}

fn log_fields<const N: usize>(fields: [(&str, Value); N]) -> IndexMap<String, Opaque> {
    IndexMap::from_iter(fields.map(|(key, value)| (key.to_owned(), Opaque::from_value(value))))
}

fn prefix(value: &str) -> String {
    String::from_utf16_lossy(&value.encode_utf16().take(8).collect::<Vec<_>>())
}

pub fn flush_deferred_claude_provider_idle(
    session: &Rc<ClaudeRunningSession>,
    handlers: &ClaudeProviderStateHandlers,
) {
    if session.provider_state.get() == ClaudeProviderSessionState::Idle
        && session
            .active_turn
            .borrow()
            .as_ref()
            .is_some_and(|turn| turn.steering.has_deferred_idle())
    {
        settle_claude_provider_idle(session, handlers);
    }
}

fn settle_claude_provider_idle(
    session: &Rc<ClaudeRunningSession>,
    handlers: &ClaudeProviderStateHandlers,
) {
    let Some(turn) = session.active_turn.borrow().clone() else {
        return;
    };
    let protocol = turn.protocol.borrow();
    if !protocol.input_started() {
        return;
    }
    let steering = &turn.steering;
    steering.remember_provider_idle();
    let details = log_fields([
        ("chatId", json!(session.chat_id)),
        ("runId", json!(turn.operation.run_id)),
        ("sessionId", json!(prefix(&session.id))),
        ("processId", json!(session.process_id())),
        ("inputId", json!(prefix(&protocol.input_uuid))),
        ("outputMessages", json!(protocol.output_message_count())),
        ("resultSeen", json!(protocol.has_accepted_result())),
        (
            "backgroundTaskCount",
            json!(session.background_task_count.get()),
        ),
        (
            "backgroundContinuationPending",
            json!(protocol.background_continuation_pending()),
        ),
        ("steeringReservations", json!(steering.reservation_count())),
        ("submittedSteers", json!(steering.submitted_count())),
        ("activeSteers", json!(steering.active_count())),
    ]);

    if steering.blocks_idle_settlement() {
        drop(protocol);
        handlers.logger.debug(
            "Claude CLI provider idle deferred for steering work",
            Some(&details),
        );
        let session = Rc::downgrade(session);
        let active_turn = Rc::downgrade(&turn);
        let handlers = handlers.clone();
        let timeout = handlers.steering_idle_fence_timeout;
        steering.defer_idle(
            move || {
                let Some((session, turn)) = session.upgrade().zip(active_turn.upgrade()) else {
                    return;
                };
                if !session.is_current_turn(&turn)
                    || session.provider_state.get() != ClaudeProviderSessionState::Idle
                    || !turn.steering.blocks_idle_settlement()
                {
                    return;
                }
                handlers.logger.warn(
                    "Claude CLI remained idle across accepted steering work",
                    Some(&details),
                );
                (handlers.fail)(
                    &session,
                    "Claude CLI did not make progress on accepted steering input.".into(),
                );
                (handlers.retire)(&session);
            },
            timeout,
        );
        return;
    }

    if !protocol.has_accepted_result() {
        drop(protocol);
        handlers.logger.warn(
            "Claude CLI became idle before producing a result for the submitted input",
            Some(&details),
        );
        (handlers.fail)(
            session,
            "Claude CLI became idle before the submitted message produced a terminal result."
                .into(),
        );
        (handlers.retire)(session);
        return;
    }
    // Provider idle and the task count distinguish turn boundaries from run completion.
    // https://github.com/anthropics/claude-agent-sdk-python/blob/f7529348747235da34af3ed202251228ff31db08/src/claude_agent_sdk/_internal/query.py#L870-L907
    if protocol.background_continuation_pending()
        && !protocol.abort_requested()
        && session.background_task_count.get() > 0
    {
        drop(protocol);
        handlers.logger.info(
            "Claude CLI became idle while a background continuation remains pending",
            Some(&details),
        );
        return;
    }
    let retire_after_settlement =
        protocol.background_continuation_pending() && protocol.abort_requested();
    if retire_after_settlement {
        session.background_task_count.set(0);
    }
    let failure = protocol
        .settlement_failure_message()
        .or_else(|| steering.settlement_failure_message());
    let clean_abort = protocol.clean_abort_result_seen();
    drop(protocol);
    if let Some(failure) = failure {
        handlers
            .logger
            .warn("Claude CLI run settled with an error", Some(&details));
        (handlers.fail)(session, failure);
    } else {
        handlers.logger.info(
            if clean_abort {
                "Claude CLI run stopped after an interrupt"
            } else {
                "Claude CLI run settled at provider idle"
            },
            Some(&details),
        );
        (handlers.finish)(session);
    }
    if retire_after_settlement {
        (handlers.retire)(session);
    }
}

pub fn handle_claude_provider_lifecycle_message(
    message: &Value,
    session: &Rc<ClaudeRunningSession>,
    handlers: &ClaudeProviderStateHandlers,
) -> bool {
    let turn = session.active_turn.borrow().clone();
    let run_id = turn.as_ref().map(|turn| turn.operation.run_id.as_str());
    if let Some(count) = claude_background_task_count(message) {
        let previous = session.background_task_count.replace(count);
        if let Some(turn) = &turn {
            let mut protocol = turn.protocol.borrow_mut();
            if protocol.input_started() {
                protocol.observe_background_task_count(count);
            }
        }
        handlers.logger.debug(
            "Claude CLI background tasks changed",
            Some(&log_fields([
                ("chatId", json!(session.chat_id)),
                ("runId", json!(run_id)),
                ("sessionId", json!(prefix(&session.id))),
                ("processId", json!(session.process_id())),
                ("previousCount", json!(previous)),
                ("nextCount", json!(count)),
            ])),
        );
        return true;
    }
    let next = match claude_provider_session_state(message) {
        Some(ClaudeReportedSessionState::Running) => ClaudeProviderSessionState::Running,
        Some(ClaudeReportedSessionState::RequiresAction) => {
            ClaudeProviderSessionState::RequiresAction
        }
        Some(ClaudeReportedSessionState::Idle) => ClaudeProviderSessionState::Idle,
        None => return false,
    };
    let previous = session.provider_state.replace(next);
    session.last_activity_at.set(Instant::now());
    let (started, result_seen) = turn
        .as_ref()
        .map(|turn| {
            let protocol = turn.protocol.borrow();
            (protocol.input_started(), protocol.has_accepted_result())
        })
        .unwrap_or_default();
    handlers.logger.debug(
        "Claude CLI session state changed",
        Some(&log_fields([
            ("chatId", json!(session.chat_id)),
            ("runId", json!(run_id)),
            ("sessionId", json!(prefix(&session.id))),
            ("processId", json!(session.process_id())),
            ("previous", json!(previous)),
            ("next", json!(next)),
            ("inputStarted", json!(started)),
            ("resultSeen", json!(result_seen)),
            (
                "backgroundTaskCount",
                json!(session.background_task_count.get()),
            ),
        ])),
    );
    if turn.is_none() {
        if matches!(
            next,
            ClaudeProviderSessionState::Running | ClaudeProviderSessionState::RequiresAction
        ) && !session.unowned_provider_activity.replace(true)
        {
            handlers.logger.warn(
                "Claude CLI emitted provider activity without an active Garcon turn",
                Some(&log_fields([
                    ("chatId", json!(session.chat_id)),
                    ("sessionId", json!(prefix(&session.id))),
                    ("processId", json!(session.process_id())),
                    ("previous", json!(previous)),
                    ("next", json!(next)),
                    (
                        "backgroundTaskCount",
                        json!(session.background_task_count.get()),
                    ),
                ])),
            );
        } else if next == ClaudeProviderSessionState::Idle
            && session.unowned_provider_activity.replace(false)
        {
            (handlers.retire)(session);
        }
    } else if next == ClaudeProviderSessionState::Idle && started {
        settle_claude_provider_idle(session, handlers);
    }
    true
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use garcon_agents_common::execution::runtime_events::runtime_operation;
    use garcon_contract::chat_modes::{PermissionMode, ThinkingMode};

    use crate::{
        active_turn::ClaudeActiveTurn, session_options::ClaudeSessionOptions,
        steering::CLAUDE_STEER_IDLE_FENCE_TIMEOUT,
    };

    use super::*;

    struct Logger;
    impl AgentLogger for Logger {
        fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn warn(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    }

    #[test]
    fn provider_idle_cannot_finish_an_outstanding_background_continuation_or_steer() {
        let session = Rc::new(ClaudeRunningSession::new(ClaudeSessionOptions {
            agent_session_id: "session-1".into(),
            session_id: "session-1".into(),
            chat_id: "chat-1".into(),
            project_path: "synthetic-cwd".into(),
            model: "synthetic-model".into(),
            permission_mode: PermissionMode::Default,
            thinking_mode: ThinkingMode::None,
            claude_thinking_mode: None,
            env_overrides: None,
        }));
        let turn = Rc::new(ClaudeActiveTurn::new(
            0,
            runtime_operation("run-1".into(), Rc::new(|_| {})),
        ));
        session.active_turn.replace(Some(turn.clone()));
        let input = turn.protocol.borrow().input_uuid.clone();
        let ended = Rc::new(RefCell::new(Vec::new()));
        let handlers = ClaudeProviderStateHandlers {
            logger: Rc::new(Logger),
            finish: Rc::new({
                let ended = ended.clone();
                move |_| ended.borrow_mut().push("finish".to_owned())
            }),
            fail: Rc::new({
                let ended = ended.clone();
                move |_, error| ended.borrow_mut().push(error)
            }),
            retire: Rc::new({
                let ended = ended.clone();
                move |_| ended.borrow_mut().push("retire".to_owned())
            }),
            steering_idle_fence_timeout: CLAUDE_STEER_IDLE_FENCE_TIMEOUT,
        };
        let deliver =
            |message| handle_claude_provider_lifecycle_message(&message, &session, &handlers);
        let idle = || json!({"type":"system","subtype":"session_state_changed","state":"idle"});
        let tasks = |tasks: Value| json!({"type":"system","subtype":"background_tasks_changed","tasks":tasks});
        assert!(deliver(idle()));
        assert!(ended.borrow().is_empty());
        turn.protocol.borrow_mut().observe_input(
            &json!({"type":"command_lifecycle","state":"started","command_uuid":input}),
        );
        turn.protocol.borrow_mut().add_output_messages(1, true);
        turn.protocol
            .borrow_mut()
            .record_accepted_result(&json!({"result":"ok"}));
        assert!(deliver(tasks(json!([{}]))));
        assert!(deliver(idle()));
        assert!(ended.borrow().is_empty());
        assert!(deliver(tasks(json!([]))));
        assert!(ended.borrow().is_empty());
        let reservation = turn.steering.reserve_delivery();
        assert!(deliver(idle()));
        assert!(turn.steering.has_deferred_idle());
        assert!(ended.borrow().is_empty());
        drop(reservation);
        flush_deferred_claude_provider_idle(&session, &handlers);
        assert_eq!(&*ended.borrow(), &["finish"]);

        session.active_turn.take();
        assert!(deliver(
            json!({"type":"system","subtype":"session_state_changed","state":"running"})
        ));
        assert!(deliver(idle()));
        assert_eq!(&*ended.borrow(), &["finish", "retire"]);
    }
}
