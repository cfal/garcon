//! Ports `common/chat-details.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ChatTranscriptSourceDto {
    FilesystemPath { value: String },
    ProviderReference { value: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCarryOverHandoffDto {
    pub agent_id: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCarryOverSegmentDto {
    pub id: String,
    pub agent_id: String,
    pub model: String,
    pub captured_at: String,
    pub stored_message_count: u64,
    pub visible_message_count: u64,
    pub truncated: bool,
    pub trailing_handoff: Option<ChatCarryOverHandoffDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCarryOverDetailsDto {
    pub revision: String,
    pub archived_message_count: u64,
    pub segments: Vec<ChatCarryOverSegmentDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDetailsResponse {
    pub chat_id: String,
    pub first_message: String,
    pub created_at: Option<String>,
    pub last_activity_at: Option<String>,
    pub agent_session_id: Option<String>,
    pub transcript_source: Option<ChatTranscriptSourceDto>,
    pub carry_over: ChatCarryOverDetailsDto,
}
