//! Ports `common/chat-tags-contracts.ts`.

use garcon_js::trim;
use serde::Serialize;
use serde_json::Value;

use crate::tags::normalize_tags;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetChatTagsRequest {
    pub chat_id: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetChatTagsResponse {
    pub success: bool,
    pub chat_id: String,
    pub tags: Vec<String>,
    pub changed: bool,
}

fn only_keys(value: &Value, expected: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|raw| raw.keys().all(|key| expected.contains(&key.as_str())))
}

pub fn parse_set_chat_tags_request(value: &Value) -> Option<SetChatTagsRequest> {
    if !only_keys(value, &["chatId", "tags"]) {
        return None;
    }
    let chat_id = trim(value["chatId"].as_str()?);
    let tags = value["tags"].as_array()?;
    if chat_id.is_empty() || !tags.iter().all(Value::is_string) {
        return None;
    }
    Some(SetChatTagsRequest {
        chat_id: chat_id.to_owned(),
        tags: normalize_tags(tags),
    })
}

pub fn parse_set_chat_tags_response(value: &Value) -> Option<SetChatTagsResponse> {
    if !only_keys(value, &["success", "chatId", "tags", "changed"]) || value["success"] != true {
        return None;
    }
    let raw_id = value["chatId"].as_str()?;
    let raw_tags = value["tags"]
        .as_array()
        .filter(|tags| tags.iter().all(Value::is_string))?;
    let changed = value["changed"].as_bool()?;
    let chat_id = trim(raw_id);
    let tags = normalize_tags(raw_tags);
    if chat_id.is_empty()
        || chat_id != raw_id
        || tags.len() != raw_tags.len()
        || tags
            .iter()
            .zip(raw_tags)
            .any(|(tag, raw)| raw != tag.as_str())
    {
        return None;
    }
    Some(SetChatTagsResponse {
        success: true,
        chat_id: chat_id.to_owned(),
        tags,
        changed,
    })
}
