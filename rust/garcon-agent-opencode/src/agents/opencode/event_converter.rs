//! Ports `server-agents/opencode/src/agents/opencode/event-converter.ts`.

use garcon_agents_common::shared::normalize_util::normalize_tool_result_content;
use garcon_contract::chat_types::{
    AssistantMessage, ChatMessage, ThinkingMessage, ToolResultMessage,
};
use garcon_interface::{
    host::AgentLogger,
    native_message_source::{
        NativeMessageSourceInput, NativeSourced, attach_native_message_source,
    },
};
use garcon_js::{Clock, json::Opaque};
use serde_json::{Value, json};

use super::{
    sse_events::SseEvent, tool_result_converter::normalize_open_code_tool_result_content,
    tool_use_converter::convert_open_code_tool_use, turn_events::OpenCodeTurnContext,
};
use crate::js::{log_fields, prop, truthy};

pub fn convert_open_code_event_to_chat_messages(
    event: &SseEvent,
    turn: &OpenCodeTurnContext,
    logger: &dyn AgentLogger,
    clock: &dyn Clock,
) -> Option<Vec<NativeSourced<ChatMessage>>> {
    // INFALLIBLE: Wall-clock time fits a JavaScript Date.
    let now = garcon_js::to_iso_string(clock.now_ms()).expect("valid wall clock time");
    let info = event.property("info");
    let part = event.property("part");
    let role_from_event = [
        prop(info, "role"),
        prop(part, "role"),
        prop(prop(part, "snapshot"), "role"),
        prop(event.property("message"), "role"),
    ]
    .into_iter()
    .find(|value| truthy(value));
    let warn = |message| {
        logger.warn(
            message,
            Some(&log_fields([("eventType", json!(event.kind))])),
        )
    };
    match event.kind.as_str() {
        "message.updated" => {
            let Some(message_id) = prop(info, "id").as_str().filter(|id| !id.is_empty()) else {
                warn("OpenCode event is missing a message ID");
                return None;
            };
            if let Some(role) = prop(info, "role")
                .as_str()
                .filter(|role| !role.is_empty() && *role != "user")
            {
                turn.borrow_mut()
                    .message_roles
                    .insert(message_id.to_owned(), role.to_owned());
            }
            Some(Vec::new())
        }
        "message.part.updated" => {
            let Some(part_id) = prop(part, "id").as_str().filter(|id| !id.is_empty()) else {
                warn("OpenCode event is missing a part ID");
                return None;
            };
            if turn.borrow().published_part_ids.contains(part_id) {
                return None;
            }
            let Some(message_id) = prop(part, "messageID").as_str().filter(|id| !id.is_empty())
            else {
                warn("OpenCode event is missing a message ID");
                return None;
            };
            if role_from_event.is_none() && !turn.borrow().message_roles.contains_key(message_id) {
                return None;
            }
            let mut messages = Vec::new();
            let part_type = prop(part, "type").as_str();
            if part_type == Some("tool") {
                let state = prop(part, "state");
                let status = prop(state, "status").as_str();
                if matches!(status, Some("completed" | "error")) {
                    let tool_use = convert_open_code_tool_use(&now, part);
                    let is_error = status == Some("error");
                    let content = if is_error {
                        let failure = prop(state, "error");
                        let failure = if truthy(failure) {
                            failure.clone()
                        } else {
                            Value::from("Error")
                        };
                        normalize_tool_result_content(Some(&Opaque::from_value(failure)))
                    } else {
                        normalize_open_code_tool_result_content(prop(part, "tool"), state)
                    };
                    let result = ToolResultMessage::new(
                        now,
                        tool_use.tool_id().to_owned(),
                        content,
                        is_error,
                        None,
                    );
                    messages.push(NativeSourced::new(ChatMessage::ToolUse(tool_use)));
                    messages.push(NativeSourced::new(ChatMessage::ToolResult(result)));
                }
            } else {
                if let Some(part_type @ ("text" | "reasoning")) = part_type {
                    turn.borrow_mut()
                        .assistant_part_types
                        .insert(part_id.to_owned(), part_type.to_owned());
                }
                if let Some(text) = prop(part, "text").as_str().filter(|text| !text.is_empty()) {
                    let part_type = turn.borrow_mut().assistant_part_types.shift_remove(part_id);
                    let Some(part_type) = part_type else {
                        warn("OpenCode final text part was not observed earlier");
                        return None;
                    };
                    let message = if part_type == "text" {
                        ChatMessage::Assistant(AssistantMessage {
                            timestamp: now,
                            content: text.to_owned(),
                            questions: None,
                        })
                    } else {
                        ChatMessage::Thinking(ThinkingMessage {
                            timestamp: now,
                            content: text.to_owned(),
                        })
                    };
                    messages.push(NativeSourced::new(message));
                }
            }
            if !messages.is_empty() {
                attach_part_identity(&mut messages, part_id);
                turn.borrow_mut()
                    .published_part_ids
                    .insert(part_id.to_owned());
            }
            Some(messages)
        }
        _ => Some(Vec::new()),
    }
}

fn attach_part_identity(rows: &mut [NativeSourced<ChatMessage>], part_id: &str) {
    for (ordinal, row) in rows.iter_mut().enumerate() {
        attach_native_message_source(
            row,
            Some(NativeMessageSourceInput {
                entry_id: Some(part_id),
                within_source_ordinal: Some(ordinal as f64),
                ..Default::default()
            }),
        );
    }
}
