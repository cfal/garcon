//! Ports `common/transcript-entry-categories.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat_types::ChatMessage;
use crate::transcript_notice_details::TranscriptNoticeDetail;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TranscriptEntryOptionalCategory {
    ToolCalls,
    ToolResults,
    Reasoning,
    Permissions,
    Diagnostics,
    Handoffs,
}

pub const TRANSCRIPT_ENTRY_OPTIONAL_CATEGORIES: &[TranscriptEntryOptionalCategory] = &[
    TranscriptEntryOptionalCategory::ToolCalls,
    TranscriptEntryOptionalCategory::ToolResults,
    TranscriptEntryOptionalCategory::Reasoning,
    TranscriptEntryOptionalCategory::Permissions,
    TranscriptEntryOptionalCategory::Diagnostics,
    TranscriptEntryOptionalCategory::Handoffs,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TranscriptEntryCategory {
    Conversation,
    #[serde(untagged)]
    Optional(TranscriptEntryOptionalCategory),
}

pub const TRANSCRIPT_ENTRY_CATEGORY_ALIASES: &[(&str, &[TranscriptEntryOptionalCategory])] = &[(
    "tools",
    &[
        TranscriptEntryOptionalCategory::ToolCalls,
        TranscriptEntryOptionalCategory::ToolResults,
    ],
)];

pub fn is_transcript_entry_optional_category(
    value: &Value,
) -> Option<TranscriptEntryOptionalCategory> {
    use TranscriptEntryOptionalCategory::*;
    match value.as_str()? {
        "tool-calls" => Some(ToolCalls),
        "tool-results" => Some(ToolResults),
        "reasoning" => Some(Reasoning),
        "permissions" => Some(Permissions),
        "diagnostics" => Some(Diagnostics),
        "handoffs" => Some(Handoffs),
        _ => None,
    }
}

pub fn canonical_transcript_entry_optional_categories(
    categories: impl IntoIterator<Item = TranscriptEntryOptionalCategory>,
) -> Vec<TranscriptEntryOptionalCategory> {
    let selected: std::collections::HashSet<_> = categories.into_iter().collect();
    TRANSCRIPT_ENTRY_OPTIONAL_CATEGORIES
        .iter()
        .copied()
        .filter(|category| selected.contains(category))
        .collect()
}

pub fn transcript_entry_category_for_message(message: &ChatMessage) -> TranscriptEntryCategory {
    use TranscriptEntryCategory::{Conversation, Optional};
    use TranscriptEntryOptionalCategory::*;
    match message {
        ChatMessage::ToolUse(_) => Optional(ToolCalls),
        ChatMessage::User(_)
        | ChatMessage::Assistant(_)
        | ChatMessage::CommandOutput(_)
        | ChatMessage::CommandResult(_)
        | ChatMessage::Compaction(_) => Conversation,
        ChatMessage::Thinking(_) => Optional(Reasoning),
        ChatMessage::ToolResult(_) => Optional(ToolResults),
        ChatMessage::PermissionRequest(_)
        | ChatMessage::PermissionResolved(_)
        | ChatMessage::PermissionCancelled(_)
        | ChatMessage::PermissionExpired(_) => Optional(Permissions),
        ChatMessage::Notice(notice)
            if matches!(
                &notice.detail,
                Some(TranscriptNoticeDetail::CarryoverMigrationQuarantine { artifact_id, error_code })
                    if !artifact_id.is_empty() && !error_code.is_empty()
            ) =>
        {
            Conversation
        }
        ChatMessage::Error(_) | ChatMessage::CliRow(_) | ChatMessage::Notice(_) => {
            Optional(Diagnostics)
        }
        ChatMessage::AgentSwitch(_) => Optional(Handoffs),
    }
}
