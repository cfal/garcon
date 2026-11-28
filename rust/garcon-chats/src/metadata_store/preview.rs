use garcon_contract::chat_types::ChatMessage;
use garcon_js::utf16;
use serde_json::Value;

use super::{ChatMetadata, ChatMetadataIdentity, MetadataSource};

pub(super) fn first_preview(text: &str) -> String {
    bounded_preview(text, 4096)
}

pub(super) fn last_preview(text: &str) -> String {
    bounded_preview(text, 512)
}

fn bounded_preview(text: &str, maximum: usize) -> String {
    // A preview need not scan the rest of a transcript-sized message body.
    let bound = text.floor_char_boundary((maximum + 1) * 4);
    let prefix = utf16::truncate(&text[..bound], maximum);
    if prefix.len() == text.len() {
        text.into()
    } else {
        format!("{prefix}\u{2026}")
    }
}

pub(crate) fn text(message: &ChatMessage) -> &str {
    match message {
        ChatMessage::User(message) => &message.content,
        ChatMessage::Assistant(message) => &message.content,
        ChatMessage::CommandOutput(message) => &message.content,
        _ => "",
    }
}

pub(crate) fn timestamp(message: &ChatMessage) -> &str {
    match message {
        ChatMessage::User(message) => &message.timestamp,
        ChatMessage::Assistant(message) => &message.timestamp,
        ChatMessage::CommandOutput(message) => &message.timestamp,
        ChatMessage::CommandResult(message) => &message.timestamp,
        ChatMessage::Thinking(message) => &message.timestamp,
        ChatMessage::ToolUse(message) => message.timestamp(),
        ChatMessage::ToolResult(message) => &message.timestamp,
        ChatMessage::Error(message) => &message.timestamp,
        ChatMessage::Notice(message) => &message.timestamp,
        ChatMessage::CliRow(message) => &message.timestamp,
        ChatMessage::PermissionRequest(message) => &message.timestamp,
        ChatMessage::PermissionResolved(message) => &message.timestamp,
        ChatMessage::PermissionCancelled(message) => &message.timestamp,
        ChatMessage::PermissionExpired(message) => &message.timestamp,
        ChatMessage::Compaction(message) => &message.timestamp,
        ChatMessage::AgentSwitch(message) => &message.timestamp,
    }
}

pub(super) fn latest_timestamp(messages: &[ChatMessage]) -> Option<&str> {
    let mut latest = None;
    for next in messages.iter().map(timestamp) {
        if latest
            .is_none_or(|current: &str| current.is_empty() || utf16::cmp(next, current).is_gt())
        {
            latest = Some(next);
        }
    }
    latest
}

pub(super) fn normalize_persisted(chat_id: &str, value: &Value) -> Option<ChatMetadata> {
    let first_message = first_preview(value.get("firstMessage")?.as_str()?);
    let string = |key| value.get(key).and_then(Value::as_str);
    let identity = value.get("identity").and_then(|value| {
        Some(ChatMetadataIdentity {
            carry_over_revision: value.get("carryOverRevision")?.as_str()?.into(),
            agent_ownership_epoch: value.get("agentOwnershipEpoch")?.as_str()?.into(),
        })
    });
    Some(ChatMetadata {
        chat_id: chat_id.into(),
        transcript_view_id: string("transcriptViewId").map(str::to_owned),
        created_at: string("createdAt").map(str::to_owned),
        last_activity: string("lastActivity").map(str::to_owned),
        last_message: last_preview(string("lastMessage").unwrap_or(&first_message)),
        first_message,
        source: match string("source") {
            Some("live") => MetadataSource::Live,
            Some("agent-preview") => MetadataSource::AgentPreview,
            _ => MetadataSource::Startup,
        },
        identity,
    })
}
