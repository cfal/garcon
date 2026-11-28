use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
};

use garcon_agents_common::execution::runtime_events::{
    AgentRuntimeEvent, ProviderRunOutcome, runtime_rows,
};
use garcon_contract::chat_types::ChatMessage;
use garcon_interface::{
    host::AgentLogger, native_message_source::NativeSourced, producer::AgentRunFailureDetail,
};
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde_json::json;

use crate::active_turn::ClaudeActiveTurn;

pub struct ClaudeTurnPublisher {
    logger: Rc<dyn AgentLogger>,
}

impl ClaudeTurnPublisher {
    pub fn new(logger: Rc<dyn AgentLogger>) -> Self {
        Self { logger }
    }

    pub fn event(&self, session_id: &str, turn: &ClaudeActiveTurn, event: AgentRuntimeEvent) {
        let kind = match &event {
            AgentRuntimeEvent::Rows { .. } => "rows",
            AgentRuntimeEvent::Session { .. } => "session",
            AgentRuntimeEvent::Notice { .. } => "notice",
            AgentRuntimeEvent::Permission { .. } => "permission",
            AgentRuntimeEvent::RunEnded { .. } => "run-ended",
            AgentRuntimeEvent::Steerable => "steerable",
        };
        // A publisher failure must not leave a turn waiting for settlement.
        if let Err(error) = catch_unwind(AssertUnwindSafe(|| (turn.operation.publish)(event))) {
            let error = error
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| error.downcast_ref::<&str>().copied())
                .unwrap_or("Unknown error");
            let prefix =
                String::from_utf16_lossy(&session_id.encode_utf16().take(8).collect::<Vec<_>>());
            let fields = IndexMap::from_iter(
                [
                    ("sessionId", json!(prefix)),
                    ("runId", json!(turn.operation.run_id)),
                    ("eventType", json!(kind)),
                    ("error", json!(error)),
                ]
                .map(|(key, value)| (key.to_owned(), Opaque::from_value(value))),
            );
            self.logger
                .warn("Claude publisher rejected an event", Some(&fields));
        }
    }

    pub fn messages(
        &self,
        session_id: &str,
        turn: &ClaudeActiveTurn,
        messages: Vec<NativeSourced<ChatMessage>>,
    ) {
        if messages.is_empty() {
            return;
        }
        self.event(
            session_id,
            turn,
            AgentRuntimeEvent::Rows {
                rows: runtime_rows(messages),
            },
        );
    }

    pub fn finished(&self, session_id: &str, turn: &ClaudeActiveTurn) {
        let final_response = {
            let protocol = turn.protocol.borrow();
            if protocol.abort_requested() || protocol.clean_abort_result_seen() {
                None
            } else {
                protocol.final_response.clone()
            }
        };
        self.run_ended(
            session_id,
            turn,
            ProviderRunOutcome::Finished { final_response },
        );
    }

    pub fn failed(&self, session_id: &str, turn: &ClaudeActiveTurn, message: String) {
        self.run_ended(
            session_id,
            turn,
            ProviderRunOutcome::Failed {
                error: Some(AgentRunFailureDetail {
                    code: "PROVIDER_FAILURE".into(),
                    message: Some(message),
                }),
            },
        );
    }

    fn run_ended(&self, session_id: &str, turn: &ClaudeActiveTurn, outcome: ProviderRunOutcome) {
        self.event(
            session_id,
            turn,
            AgentRuntimeEvent::RunEnded {
                run_id: turn.operation.run_id.clone(),
                outcome,
                working_directory: None,
            },
        );
    }
}
