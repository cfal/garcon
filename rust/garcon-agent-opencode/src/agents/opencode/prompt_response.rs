//! Ports `server-agents/opencode/src/agents/opencode/prompt-response.ts`.

use std::error::Error;

use garcon_interface::producer::AgentFinalResponse;
use serde_json::{Map, Value};

use super::sse_events::{SseEvent, is_compaction_assistant};
use crate::js::{error, prop};

/// The final answer of a turn, when its prompt response carried text.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnFinalResponse {
    pub message_id: String,
    pub response: AgentFinalResponse,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodePromptResponse {
    pub message_id: String,
    pub response_parent_id: Option<String>,
    pub message_event: SseEvent,
    pub parts: Vec<Value>,
    pub is_compaction: bool,
    pub final_response: Option<TurnFinalResponse>,
}

pub fn parse_open_code_prompt_response(
    result: &Value,
    session_id: &str,
) -> Result<OpenCodePromptResponse, Box<dyn Error>> {
    let response = prop(result, "data").as_object();
    let info = response.and_then(|response| prop(response, "info").as_object());
    let missing = || {
        error(
            "Error",
            "OpenCode prompt response is missing its assistant message",
        )
    };
    let Some(info) = info.filter(|info| prop(info, "role").as_str() == Some("assistant")) else {
        return Err(missing());
    };
    let Some(message_id) = prop(info, "id").as_str().filter(|id| !id.is_empty()) else {
        return Err(missing());
    };

    let is_compaction = is_compaction_assistant(info);
    let parts = response
        .and_then(|response| prop(response, "parts").as_array())
        .cloned()
        .unwrap_or_default();
    let text_parts: Vec<&str> = parts
        .iter()
        .filter_map(|part| {
            let part = part.as_object()?;
            (prop(part, "type").as_str() == Some("text")
                && prop(part, "messageID").as_str() == Some(message_id))
            .then(|| prop(part, "text").as_str())
            .flatten()
        })
        .collect();
    let final_response = (!is_compaction && !text_parts.is_empty()).then(|| TurnFinalResponse {
        message_id: message_id.to_owned(),
        response: AgentFinalResponse::Text {
            text: text_parts.join("\n\n"),
        },
    });
    Ok(OpenCodePromptResponse {
        message_id: message_id.to_owned(),
        response_parent_id: prop(info, "parentID")
            .as_str()
            .filter(|parent| !parent.is_empty())
            .map(str::to_owned),
        message_event: SseEvent {
            id: None,
            kind: "message.updated".to_owned(),
            properties: Some(Map::from_iter([
                ("sessionID".to_owned(), Value::String(session_id.to_owned())),
                ("info".to_owned(), Value::Object(info.clone())),
            ])),
        },
        parts,
        is_compaction,
        final_response,
    })
}
