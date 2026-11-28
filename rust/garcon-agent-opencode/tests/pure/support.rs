//! Shared by the tests of the pure modules: a recorded argument as the
//! port's event type, and the state of a turn or a session as the recorder's
//! oracle reads it (`tests/oracles/turn-state.ts`).

use std::cell::RefCell;
use std::rc::Rc;

use garcon_agent_opencode::agents::opencode::sse_events::{OpenCodeAssistantTerminal, SseEvent};
use garcon_agent_opencode::agents::opencode::turn_events::{
    OpenCodeSession, OpenCodeTurnContext, SessionData, SessionStatus, create_open_code_turn_context,
};
use garcon_agents_common::execution::runtime_events::{AgentRuntimeEvent, AgentRuntimeOperation};
use garcon_contract::chat_modes::{PermissionMode, is_permission_mode};
use garcon_contract::chat_types::ToolUseChatMessage;
use garcon_interface::host::AgentLogger;
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use serde_json::{Map, Value};

/// The wall clock the oracle fixes while a recorded call runs.
pub const FIXED_NOW: i64 = 1_700_000_000_012;

/// The prompt part ID the oracle gives every turn it builds.
pub const ORACLE_PROMPT_PART_ID: &str = "prt_oracle";

// The events a turn's operation published.
pub type Published = Rc<RefCell<Vec<Value>>>;

#[derive(Default)]
pub struct RecordingLogger {
    pub lines: RefCell<Vec<Value>>,
}

impl AgentLogger for RecordingLogger {
    fn debug(&self, message: &str, fields: Option<&IndexMap<String, garcon_js::json::Opaque>>) {
        self.record("debug", message, fields);
    }

    fn info(&self, message: &str, fields: Option<&IndexMap<String, garcon_js::json::Opaque>>) {
        self.record("info", message, fields);
    }

    fn warn(&self, message: &str, fields: Option<&IndexMap<String, garcon_js::json::Opaque>>) {
        self.record("warn", message, fields);
    }

    fn error(&self, message: &str, fields: Option<&IndexMap<String, garcon_js::json::Opaque>>) {
        self.record("error", message, fields);
    }
}

impl RecordingLogger {
    fn record(
        &self,
        level: &str,
        message: &str,
        fields: Option<&IndexMap<String, garcon_js::json::Opaque>>,
    ) {
        let fields = fields.map(|fields| {
            Value::Object(
                fields
                    .iter()
                    .map(|(key, value)| (key.clone(), value.as_value().clone()))
                    .collect(),
            )
        });
        self.lines.borrow_mut().push(serde_json::json!({
            "level": level,
            "message": message,
            "fields": fields,
        }));
    }
}

// A logger that keeps every line it is given.
pub fn recording_logger() -> Rc<RecordingLogger> {
    Rc::default()
}

// A string argument, and the empty string for any other value.
pub fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

// A message of the port as JSON text, read back in the port's own key order.
pub fn message_value(message: &impl Serialize) -> Value {
    let bytes = serde_json::to_vec(message).expect("a message serializes");
    garcon_js::json::from_slice(&bytes).expect("a message is JSON")
}

// A tool-use message the OpenCode converters produce, as the recorder
// encodes the original's class instance: the class name and its own fields.
pub fn tool_use_instance(message: &ToolUseChatMessage) -> Value {
    use ToolUseChatMessage as Message;
    let name = match message {
        Message::Bash { .. } => "BashToolUseMessage",
        Message::Exec { .. } => "ExecToolUseMessage",
        Message::Read { .. } => "ReadToolUseMessage",
        Message::Edit { .. } => "EditToolUseMessage",
        Message::Write { .. } => "WriteToolUseMessage",
        Message::ApplyPatch { .. } => "ApplyPatchToolUseMessage",
        Message::Grep { .. } => "GrepToolUseMessage",
        Message::Glob { .. } => "GlobToolUseMessage",
        Message::WebSearch { .. } => "WebSearchToolUseMessage",
        Message::WebFetch { .. } => "WebFetchToolUseMessage",
        Message::TodoWrite { .. } => "TodoWriteToolUseMessage",
        Message::TodoRead { .. } => "TodoReadToolUseMessage",
        Message::Task { .. } => "TaskToolUseMessage",
        Message::WriteStdin { .. } => "WriteStdinToolUseMessage",
        Message::UpdatePlan { .. } => "UpdatePlanToolUseMessage",
        Message::EnterPlanMode { .. } => "EnterPlanModeToolUseMessage",
        Message::ExitPlanMode { .. } => "ExitPlanModeToolUseMessage",
        Message::AskUserQuestion { .. } => "AskUserQuestionToolUseMessage",
        Message::External { .. } => "ExternalToolUseMessage",
        Message::Unknown { .. } => "UnknownToolUseMessage",
        Message::RequestPermissions { .. } => "RequestPermissionsToolUseMessage",
        other => {
            unreachable!(
                "the OpenCode converters never produce {}",
                other.message_type()
            )
        }
    };
    let Value::Object(fields) = message_value(message) else {
        unreachable!("a tool-use message serializes to an object")
    };
    garcon_cases::markers::instance(name, fields)
}

// The recorded `SSEEvent` as the port's event.
pub fn event(value: &Value) -> SseEvent {
    SseEvent {
        id: value.get("id").and_then(Value::as_str).map(str::to_owned),
        kind: text(value.get("type").unwrap_or(&Value::Null)).to_owned(),
        properties: value.get("properties").and_then(Value::as_object).cloned(),
    }
}

// A permission mode by name, and the default for any other value.
pub fn permission_mode(value: Option<&Value>) -> PermissionMode {
    value
        .and_then(is_permission_mode)
        .unwrap_or(PermissionMode::Default)
}

// A terminal as the oracle's JSON state names it.
pub fn terminal_value(terminal: &OpenCodeAssistantTerminal) -> Value {
    match terminal {
        OpenCodeAssistantTerminal::Finished { message_id } => {
            serde_json::json!({ "outcome": "finished", "messageId": message_id })
        }
        OpenCodeAssistantTerminal::Failed { message_id, error } => {
            let mut fields = Map::from_iter([
                ("outcome".to_owned(), Value::from("failed")),
                ("messageId".to_owned(), Value::from(message_id.clone())),
            ]);
            if let Some(error) = error {
                fields.insert("error".to_owned(), Value::from(error.clone()));
            }
            Value::Object(fields)
        }
        OpenCodeAssistantTerminal::Aborted { message_id } => {
            serde_json::json!({ "outcome": "aborted", "messageId": message_id })
        }
    }
}

// The terminal the oracle's JSON state names.
pub fn terminal(value: &Value) -> Option<OpenCodeAssistantTerminal> {
    let message_id = || text(value.get("messageId").unwrap_or(&Value::Null)).to_owned();
    match value.get("outcome").and_then(Value::as_str)? {
        "finished" => Some(OpenCodeAssistantTerminal::Finished {
            message_id: message_id(),
        }),
        "failed" => Some(OpenCodeAssistantTerminal::Failed {
            message_id: message_id(),
            error: value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        "aborted" => Some(OpenCodeAssistantTerminal::Aborted {
            message_id: message_id(),
        }),
        _ => None,
    }
}

fn flag(state: &Value, key: &str) -> Option<bool> {
    state.get(key).map(|value| value == &Value::Bool(true))
}

fn string_list(state: &Value, key: &str) -> Vec<String> {
    state
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .map(str::to_owned)
        .collect()
}

// A turn from the oracle's JSON state.
pub fn build_turn(state: &Value, published: Option<Published>) -> OpenCodeTurnContext {
    let operation = AgentRuntimeOperation {
        run_id: match state.get("runId") {
            Some(Value::String(run_id)) => run_id.clone(),
            _ => "run-oracle".to_owned(),
        },
        publish: Rc::new(move |event| {
            if let (Some(published), AgentRuntimeEvent::Steerable) = (&published, event) {
                published
                    .borrow_mut()
                    .push(serde_json::json!({ "type": "steerable" }));
            }
        }),
    };
    let turn = create_open_code_turn_context(
        operation,
        state.get("compaction") == Some(&Value::Bool(true)),
        &|| String::new(),
    );
    {
        let mut data = turn.borrow_mut();
        data.provider_prompt_part_id = match state.get("providerPromptPartId") {
            Some(Value::String(part_id)) => part_id.clone(),
            _ => ORACLE_PROMPT_PART_ID.to_owned(),
        };
        if let Some(value) = state.get("providerMessageId") {
            data.provider_message_id = value.as_str().map(str::to_owned);
        }
        if let Some(value) = flag(state, "providerPromptRequestCompleted") {
            data.provider_prompt_request_completed = value;
        }
        if let Some(value) = flag(state, "providerSteeringDeliveryUnconfirmed") {
            data.provider_steering_delivery_unconfirmed = value;
        }
        if let Some(value) = state.get("lastRetryNoticeKey") {
            data.last_retry_notice_key = value.as_str().map(str::to_owned);
        }
        if let Some(value) = flag(state, "manualCompactionBoundaryPublished") {
            data.manual_compaction_boundary_published = value;
        }
        for value in string_list(state, "providerContinuationMessageIds") {
            data.provider_continuation_message_ids.insert(value);
        }
        for value in string_list(state, "automaticCompactionMessageIds") {
            data.automatic_compaction_message_ids.insert(value);
        }
        for value in string_list(state, "recentEventIds") {
            data.recent_event_ids.insert(value);
        }
        for value in string_list(state, "providerSteeringPartIds") {
            data.provider_steering_part_ids.insert(value);
        }
        for value in string_list(state, "pendingSteeringMessageIds") {
            data.pending_steering_message_ids.insert(value);
        }
        for value in string_list(state, "observedUserMessageIds") {
            data.observed_user_message_ids.insert(value);
        }
        for value in string_list(state, "assistantMessageIds") {
            data.assistant_message_ids.insert(value);
        }
        for value in string_list(state, "publishedPartIds") {
            data.published_part_ids.insert(value);
        }
        let entries = |key: &str| state.get(key).and_then(Value::as_object);
        for (id, value) in entries("assistantTerminals").into_iter().flatten() {
            if let Some(value) = terminal(value) {
                data.assistant_terminals.insert(id.clone(), value);
            }
        }
        for (id, value) in entries("messageRoles").into_iter().flatten() {
            if let Some(value) = value.as_str() {
                data.message_roles.insert(id.clone(), value.to_owned());
            }
        }
        for (id, value) in entries("assistantPartTypes").into_iter().flatten() {
            if let Some(value) = value.as_str() {
                data.assistant_part_types
                    .insert(id.clone(), value.to_owned());
            }
        }
    }
    turn
}

fn indexed(values: &IndexSet<String>) -> Value {
    Value::Array(
        values
            .iter()
            .map(|value| Value::String(value.clone()))
            .collect(),
    )
}

fn string_map(values: &IndexMap<String, String>) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect(),
    )
}

// A map with its keys in the order JavaScript enumerates them.
pub fn javascript_object(map: Map<String, Value>) -> Value {
    let mut value = Value::Object(map);
    garcon_js::json::normalize(&mut value);
    value
}

/// The turn as the oracle reads it back.
pub fn snapshot_turn(turn: &OpenCodeTurnContext) -> Value {
    let data = turn.borrow();
    let mut snapshot = serde_json::json!({
        "providerMessageId": data.provider_message_id,
        "providerPromptPartId": data.provider_prompt_part_id,
        "providerPromptRequestCompleted": data.provider_prompt_request_completed,
        "providerSteeringDeliveryUnconfirmed": data.provider_steering_delivery_unconfirmed,
        "lastRetryNoticeKey": data.last_retry_notice_key,
        "providerContinuationMessageIds": indexed(&data.provider_continuation_message_ids),
        "automaticCompactionMessageIds": indexed(&data.automatic_compaction_message_ids),
        "recentEventIds": indexed(&data.recent_event_ids),
        "providerSteeringPartIds": indexed(&data.provider_steering_part_ids),
        "pendingSteeringMessageIds": indexed(&data.pending_steering_message_ids),
        "observedUserMessageIds": indexed(&data.observed_user_message_ids),
        "assistantMessageIds": indexed(&data.assistant_message_ids),
        "assistantTerminals": Value::Object(
            data.assistant_terminals
                .iter()
                .map(|(id, value)| (id.clone(), terminal_value(value)))
                .collect(),
        ),
        "publishedPartIds": indexed(&data.published_part_ids),
        "messageRoles": string_map(&data.message_roles),
        "assistantPartTypes": string_map(&data.assistant_part_types),
    });
    if let Some(final_response) = &data.final_response {
        let fields = snapshot.as_object_mut().expect("the snapshot is an object");
        fields.insert(
            "finalResponse".to_owned(),
            serde_json::json!({
                "messageId": final_response.message_id,
                "response": message_value(&final_response.response),
            }),
        );
    }
    snapshot
}

// A session from the oracle's JSON state.
pub fn build_session(state: &Value) -> OpenCodeSession {
    OpenCodeSession::new(SessionData {
        status: match state.get("status").and_then(Value::as_str) {
            Some("running") => SessionStatus::Running,
            Some("aborted") => SessionStatus::Aborted,
            _ => SessionStatus::Completed,
        },
        aborting: state.get("aborting").and_then(Value::as_bool),
        chat_id: match state.get("chatId") {
            Some(Value::String(chat_id)) => chat_id.clone(),
            _ => "chat-oracle".to_owned(),
        },
        model: state
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
        thinking_variant: state
            .get("thinkingVariant")
            .and_then(Value::as_str)
            .map(str::to_owned),
        permission_mode: permission_mode(state.get("permissionMode")),
        directory: state
            .get("directory")
            .and_then(Value::as_str)
            .map(str::to_owned),
        started_at: "1970-01-01T00:00:00.000Z".to_owned(),
        last_activity_at: state
            .get("lastActivityAt")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        provider_work_requires_quiescence: state["providerWorkRequiresQuiescence"]
            == Value::Bool(true),
        active_steering_deliveries: state
            .get("activeSteeringDeliveries")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        deferred_terminal: state.get("deferredTerminal").and_then(terminal),
        pending_steering_revert_message_id: state
            .get("pendingSteeringRevertMessageId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        turn: build_turn(state.get("turn").unwrap_or(&Value::Null), None),
    })
}

/// The session as the oracle reads it back.
pub fn snapshot_session(session: &OpenCodeSession) -> Value {
    let data = session.borrow();
    serde_json::json!({
        "status": match data.status {
            SessionStatus::Running => "running",
            SessionStatus::Completed => "completed",
            SessionStatus::Aborted => "aborted",
        },
        "aborting": data.aborting,
        "chatId": data.chat_id,
        "model": data.model,
        "thinkingVariant": data.thinking_variant,
        "permissionMode": data.permission_mode.as_str(),
        "directory": data.directory,
        "startedAt": data.started_at,
        "lastActivityAt": data.last_activity_at,
        "providerWorkRequiresQuiescence": data.provider_work_requires_quiescence,
        "activeSteeringDeliveries": data.active_steering_deliveries,
        "deferredTerminal": data.deferred_terminal.as_ref().map(terminal_value),
        "pendingSteeringRevertMessageId": data.pending_steering_revert_message_id,
        "turn": snapshot_turn(&data.turn),
    })
}
