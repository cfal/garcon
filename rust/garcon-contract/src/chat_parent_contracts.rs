//! Ports `common/chat-parent-contracts.ts`.

use serde::Serialize;
use serde_json::Value;

use crate::chat_id::{ChatId, parse_chat_id};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetChatParentRequest {
    pub chat_id: ChatId,
    pub parent_chat_id: Option<ChatId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetChatParentResponse {
    pub success: bool,
    pub chat_id: ChatId,
    pub parent_chat_id: Option<ChatId>,
    pub changed: bool,
}

fn only_keys(value: &Value, expected: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|raw| raw.keys().all(|key| expected.contains(&key.as_str())))
}

fn parent_chat_id(value: &Value) -> Option<Option<ChatId>> {
    match value.get("parentChatId")? {
        Value::Null => Some(None),
        value => parse_chat_id(value).ok().map(Some),
    }
}

pub fn parse_set_chat_parent_request(value: &Value) -> Option<SetChatParentRequest> {
    if !only_keys(value, &["chatId", "parentChatId"]) {
        return None;
    }
    Some(SetChatParentRequest {
        chat_id: parse_chat_id(&value["chatId"]).ok()?,
        parent_chat_id: parent_chat_id(value)?,
    })
}

pub fn parse_set_chat_parent_response(value: &Value) -> Option<SetChatParentResponse> {
    if !only_keys(value, &["success", "chatId", "parentChatId", "changed"])
        || value["success"] != true
    {
        return None;
    }
    let changed = value["changed"].as_bool()?;
    let chat_id = parse_chat_id(&value["chatId"]).ok()?;
    let parent_chat_id = parent_chat_id(value)?;
    if parent_chat_id.as_ref() == Some(&chat_id) {
        return None;
    }
    Some(SetChatParentResponse {
        success: true,
        chat_id,
        parent_chat_id,
        changed,
    })
}
