use garcon_interface::host::AgentLogger;
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::active_turn::ClaudeActiveTurn;

pub struct ClaudeInterruptSession<'a> {
    pub id: &'a str,
    pub chat_id: &'a str,
    pub process_id: Option<u32>,
    pub is_current: &'a dyn Fn(&ClaudeActiveTurn) -> bool,
}

pub struct ClaudeInterruptReceiptHandlers<'a> {
    pub logger: &'a dyn AgentLogger,
    pub finish: &'a dyn Fn(),
    pub clear_abort_timer: &'a dyn Fn(),
    pub arm_completion_fallback: &'a dyn Fn(),
    pub flush_deferred_idle: &'a dyn Fn(),
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

fn prefix(value: &str) -> String {
    String::from_utf16_lossy(&value.encode_utf16().take(8).collect::<Vec<_>>())
}

pub fn handle_claude_interrupt_receipt(
    session: ClaudeInterruptSession<'_>,
    active_turn: &ClaudeActiveTurn,
    value: &Value,
    handlers: ClaudeInterruptReceiptHandlers<'_>,
) -> bool {
    let cancelled = strings(&value["cancelled"]);
    let still_queued = strings(&value["still_queued"]);
    let steering = active_turn
        .steering
        .observe_interrupt_receipt(&cancelled, &still_queued);
    if steering.cancelled_count > 0 {
        (handlers.flush_deferred_idle)();
    }
    // The flush can settle this turn before the interrupt acknowledgement is handled.
    let turn_is_current = (session.is_current)(active_turn);
    let protocol = active_turn.protocol.borrow();
    let input_started = protocol.input_started();
    let input_cancelled = cancelled.contains(&protocol.input_uuid.as_str());
    let input_still_queued = still_queued.contains(&protocol.input_uuid.as_str());
    let input_id = prefix(&protocol.input_uuid);
    drop(protocol);
    let details = IndexMap::from_iter(
        [
            ("chatId", json!(session.chat_id)),
            ("runId", json!(active_turn.operation.run_id)),
            ("sessionId", json!(prefix(session.id))),
            ("processId", json!(session.process_id)),
            ("inputId", json!(input_id)),
            ("cancelledCount", json!(cancelled.len())),
            ("stillQueuedCount", json!(still_queued.len())),
            ("steeringCancelledCount", json!(steering.cancelled_count)),
            (
                "steeringStillQueuedCount",
                json!(steering.still_queued_count),
            ),
        ]
        .map(|(key, value)| (key.to_owned(), Opaque::from_value(value))),
    );
    if !input_started && input_cancelled {
        handlers.logger.info(
            "Claude CLI confirmed queued input cancellation",
            Some(&details),
        );
        if turn_is_current {
            (handlers.finish)();
        }
        return true;
    }
    if !input_started && !input_still_queued {
        handlers.logger.warn(
            "Claude CLI interrupt did not confirm queued input cancellation",
            Some(&details),
        );
        return false;
    }
    if input_still_queued {
        if turn_is_current {
            (handlers.clear_abort_timer)();
            active_turn.protocol.borrow_mut().mark_abort_rejected();
        }
        handlers.logger.warn(
            "Claude CLI interrupt left the submitted input queued",
            Some(&details),
        );
        return false;
    }
    if steering.still_queued_count > 0 {
        handlers.logger.warn(
            "Claude CLI interrupt left steering input queued",
            Some(&details),
        );
        if turn_is_current {
            (handlers.clear_abort_timer)();
            (handlers.arm_completion_fallback)();
        }
        return true;
    }
    handlers
        .logger
        .debug("Claude CLI acknowledged interrupt", Some(&details));
    if turn_is_current && input_started {
        (handlers.arm_completion_fallback)();
    }
    true
}

#[cfg(test)]
mod tests {
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };

    use garcon_agents_common::execution::runtime_events::runtime_operation;

    use super::*;

    struct Logger;
    impl AgentLogger for Logger {
        fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn warn(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    }

    #[test]
    fn receipts_follow_the_cli_queue_and_never_arm_a_replacement_turn() {
        let turn = ClaudeActiveTurn::new(0, runtime_operation("run-1".into(), Rc::new(|_| {})));
        let input = turn.protocol.borrow().input_uuid.clone();
        let calls = RefCell::new(Vec::new());
        let current = Cell::new(true);
        let settle_on_flush = Cell::new(false);
        let handle = |value: Value| {
            calls.borrow_mut().clear();
            let accepted = handle_claude_interrupt_receipt(
                ClaudeInterruptSession {
                    id: "session-1",
                    chat_id: "chat-1",
                    process_id: Some(42),
                    is_current: &|candidate| current.get() && std::ptr::eq(candidate, &turn),
                },
                &turn,
                &value,
                ClaudeInterruptReceiptHandlers {
                    logger: &Logger,
                    finish: &|| calls.borrow_mut().push("finish"),
                    clear_abort_timer: &|| calls.borrow_mut().push("clear"),
                    arm_completion_fallback: &|| calls.borrow_mut().push("arm"),
                    flush_deferred_idle: &|| {
                        calls.borrow_mut().push("flush");
                        if settle_on_flush.get() {
                            current.set(false);
                        }
                    },
                },
            );
            (accepted, calls.borrow().clone())
        };
        assert_eq!(
            handle(json!({"cancelled": [input]})),
            (true, vec!["finish"])
        );
        assert_eq!(handle(json!({"cancelled": [true, null]})), (false, vec![]));
        turn.protocol.borrow_mut().mark_abort_requested();
        assert_eq!(
            handle(json!({"still_queued": [input]})),
            (false, vec!["clear"])
        );
        assert!(!turn.protocol.borrow().abort_requested());

        turn.protocol.borrow_mut().observe_input(&json!({
            "type": "command_lifecycle", "command_uuid": input, "state": "started"
        }));
        assert_eq!(handle(json!({})), (true, vec!["arm"]));
        current.set(false);
        assert_eq!(handle(json!({})), (true, vec![]));
        current.set(true);

        turn.steering.mark_submitted("steer-1".into());
        assert_eq!(
            handle(json!({"still_queued": ["steer-1"]})),
            (true, vec!["clear", "arm"])
        );
        assert!(turn.steering.blocks_idle_settlement());
        assert_eq!(
            handle(json!({"cancelled": ["steer-1", "provider-internal"]})),
            (true, vec!["flush", "arm"])
        );
        assert!(!turn.steering.blocks_idle_settlement());

        settle_on_flush.set(true);
        turn.steering.mark_submitted("steer-2".into());
        turn.steering.remember_provider_idle();
        assert_eq!(
            handle(json!({"cancelled": ["steer-2"]})),
            (true, vec!["flush"])
        );
        assert!(!current.get());
    }
}
