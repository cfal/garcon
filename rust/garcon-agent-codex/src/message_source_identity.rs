use garcon_contract::chat_types::ChatMessage;
use garcon_interface::native_message_source::NativeMessageSourceInput;
use garcon_js::{Number, trim};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMessageSourceIdentity {
    pub entry_id: String,
    pub within_source_ordinal: Number,
}

impl CodexMessageSourceIdentity {
    pub fn as_source_input(&self) -> NativeMessageSourceInput<'_> {
        NativeMessageSourceInput {
            entry_id: Some(&self.entry_id),
            within_source_ordinal: Some(self.within_source_ordinal.0),
            ..Default::default()
        }
    }
}

pub fn codex_message_source_identity(
    turn_id: Option<&str>,
    item_id: Option<&str>,
    message: &ChatMessage,
    fallback_ordinal: Number,
) -> Option<CodexMessageSourceIdentity> {
    let turn_id = turn_id.and_then(nonempty_string)?;
    if let Some(tool_id) = message_tool_id(message).and_then(nonempty_string) {
        return Some(CodexMessageSourceIdentity {
            entry_id: format!("turn:{turn_id}:tool:{tool_id}"),
            within_source_ordinal: Number(if matches!(message, ChatMessage::ToolResult(_)) {
                1.0
            } else {
                0.0
            }),
        });
    }
    let item_id = item_id.and_then(nonempty_string)?;
    Some(CodexMessageSourceIdentity {
        entry_id: format!("turn:{turn_id}:item:{item_id}"),
        within_source_ordinal: fallback_ordinal,
    })
}

pub(crate) fn message_tool_id(message: &ChatMessage) -> Option<&str> {
    match message {
        ChatMessage::ToolUse(tool) => Some(tool.tool_id()),
        ChatMessage::ToolResult(tool) => Some(&tool.tool_id),
        _ => None,
    }
}

pub fn codex_turn_id_from_entry_id(entry_id: &Value) -> Option<&str> {
    let (turn_id, _) = entry_id
        .as_str()
        .and_then(nonempty_string)?
        .strip_prefix("turn:")?
        .split_once(':')?;
    (!turn_id.is_empty()).then_some(turn_id)
}

fn nonempty_string(text: &str) -> Option<&str> {
    let text = trim(text);
    (!text.is_empty()).then_some(text)
}
