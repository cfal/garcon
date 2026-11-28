//! Ports `common/share-types.ts`.

use garcon_js::json::Opaque;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedChatOrigin {
    pub transcript_view_id: String,
    pub last_ordinal: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedChatSnapshot {
    pub share_token: String,
    pub chat_id: String,
    pub title: String,
    pub agent_id: String,
    pub model: String,
    pub project_path: String,
    pub shared_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<SharedChatOrigin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frozen_message_count: Option<u64>,
    pub messages: Vec<Opaque>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareChatResponse {
    pub success: bool,
    pub share_token: String,
    pub share_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatusResponse {
    pub is_shared: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub share_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub share_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSharedChatSnapshot {
    pub share_token: String,
    pub title: String,
    pub agent_id: String,
    pub model: String,
    pub shared_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frozen_message_count: Option<u64>,
    pub messages: Vec<Opaque>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GetSharedChatResponse {
    pub snapshot: PublicSharedChatSnapshot,
    pub page: SharedChatMessagePage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedChatMessagePage {
    pub snapshot_version: String,
    pub total_messages: u64,
    pub start: u64,
    pub end: u64,
    pub next_before: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevokeShareResponse {
    pub success: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_opaque_messages_with_javascript_numbers() {
        let snapshot: PublicSharedChatSnapshot = garcon_js::json::from_str(
            r#"{"shareToken":"fixture","title":"Share","agentId":"codex","model":"model","sharedAt":"time","messages":[{"n":1.0,"big":9007199254740993,"exp21":1e21,"small":1e-7}]}"#,
        ).unwrap();
        assert_eq!(
            serde_json::to_string(&snapshot).unwrap(),
            r#"{"shareToken":"fixture","title":"Share","agentId":"codex","model":"model","sharedAt":"time","messages":[{"n":1,"big":9007199254740992,"exp21":1e+21,"small":1e-7}]}"#,
        );
    }
}
