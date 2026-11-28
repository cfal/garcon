//! Ports `server-agents/interface/src/contracts/transcript.ts`.

use garcon_contract::{
    agent_integration::AgentSettingsEnvelope, transcript_seed::NativeSeedReceipt,
};
use garcon_js::json::Opaque;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AgentTranscriptSourceLocation {
    FilesystemPath { value: String },
    ProviderReference { value: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNativeSessionRef {
    pub owner_id: String,
    pub schema_version: u64,
    pub value: Opaque,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatReference {
    pub chat_id: String,
    pub agent_id: String,
    pub agent_session_id: Option<String>,
    pub project_path: String,
    pub model: String,
    pub native_session: Option<AgentNativeSessionRef>,
    pub carry_over_revision: String,
    pub native_seed_receipt: Option<NativeSeedReceipt>,
    pub settings: AgentSettingsEnvelope,
}
