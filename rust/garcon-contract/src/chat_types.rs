//! Shared transcript message contracts.

mod tool_use;

pub use crate::chat_message_coercion::{AskUserQuestionOption, AskUserQuestionPrompt};
pub use tool_use::{
    BackgroundTaskAction, CodexSubagentAction, CodexSubagentDetails, CodexSubagentInputItem,
    CodexSubagentLifecycleSource, CodexSubagentState, CodexSubagentStatus, ToolUseChatMessage,
    codex_subagent_source_fingerprint, codex_subagent_source_fingerprint_utf16,
    parse_tool_use_message,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatProcessingPhase {
    Running,
    Stopping,
    Reconnecting,
}

pub const CHAT_PROCESSING_PHASES: &[ChatProcessingPhase] = &[
    ChatProcessingPhase::Running,
    ChatProcessingPhase::Stopping,
    ChatProcessingPhase::Reconnecting,
];

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatProcessingEntry {
    pub chat_id: String,
    pub phase: ChatProcessingPhase,
}
