//! Ports `common/chat-transient-feed.ts`.

use std::collections::HashSet;

use garcon_js::{is_safe_integer, json::as_number};
use serde::Serialize;
use serde_json::Value;

use crate::async_user_questions::InvalidAsyncQuestionReply;
use crate::chat_types::{
    NonNoticeChatMessage, PermissionRequestMessage, parse_non_notice_chat_message,
};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransientFeedRow {
    pub permission_occurrence_id: String,
    pub run_id: String,
    pub transcript: TransientFeedRowPosition,
    pub display_order: u64,
    pub message: PermissionRequestMessage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransientFeedRowPosition {
    pub transcript_view_id: String,
    pub after_ordinal: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ChatTransientFeedMutationBody {
    Upsert { row: Box<TransientFeedRow> },
    Remove { permission_occurrence_id: String },
    ClearRun { run_id: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTransientFeedMutation {
    pub server_instance_id: String,
    pub chat_id: String,
    pub transcript_view_id: String,
    pub transient_revision: u64,
    pub mutation: ChatTransientFeedMutationBody,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTransientFeedSnapshot {
    pub server_instance_id: String,
    pub chat_id: String,
    pub transcript_view_id: String,
    pub transient_revision: u64,
    pub rows: Vec<TransientFeedRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTransientControlAction {
    pub server_instance_id: String,
    pub chat_id: String,
    pub run_id: String,
    pub permission_occurrence_id: String,
}

pub fn parse_transient_feed_row(
    value: &Value,
) -> Result<Option<TransientFeedRow>, InvalidAsyncQuestionReply> {
    let position = &value["transcript"];
    let message = &value["message"];
    if !value.is_object() || !position.is_object() || !message.is_object() {
        return Ok(None);
    }
    let permission_occurrence_id = required_string(&value["permissionOccurrenceId"]);
    let run_id = required_string(&value["runId"]);
    let transcript_view_id = required_string(&position["transcriptViewId"]);
    let after_ordinal = nonnegative_integer(&position["afterOrdinal"]);
    let display_order = nonnegative_integer(&value["displayOrder"]);
    let parsed_message = parse_non_notice_chat_message(message)?;
    let (
        Some(permission_occurrence_id),
        Some(run_id),
        Some(transcript_view_id),
        Some(after_ordinal),
        Some(display_order),
        Some(NonNoticeChatMessage::PermissionRequest(message)),
    ) = (
        permission_occurrence_id,
        run_id,
        transcript_view_id,
        after_ordinal,
        display_order,
        parsed_message,
    )
    else {
        return Ok(None);
    };
    if message.permission_occurrence_id != permission_occurrence_id {
        return Ok(None);
    }
    Ok(Some(TransientFeedRow {
        permission_occurrence_id,
        run_id,
        transcript: TransientFeedRowPosition {
            transcript_view_id,
            after_ordinal,
        },
        display_order,
        message,
    }))
}

pub fn parse_chat_transient_feed_snapshot(
    value: &Value,
) -> Result<Option<ChatTransientFeedSnapshot>, InvalidAsyncQuestionReply> {
    let Some(input_rows) = value["rows"].as_array() else {
        return Ok(None);
    };
    let base = parse_feed_base(value);
    let rows = parse_rows(input_rows)?;
    let (Some(base), Some(rows)) = (base, rows) else {
        return Ok(None);
    };
    if rows
        .iter()
        .any(|row| row.transcript.transcript_view_id != base.transcript_view_id)
    {
        return Ok(None);
    }
    Ok(Some(ChatTransientFeedSnapshot {
        server_instance_id: base.server_instance_id,
        chat_id: base.chat_id,
        transcript_view_id: base.transcript_view_id,
        transient_revision: base.transient_revision,
        rows,
    }))
}

pub fn parse_chat_transient_feed_mutation(
    value: &Value,
) -> Result<Option<ChatTransientFeedMutation>, InvalidAsyncQuestionReply> {
    let mutation = &value["mutation"];
    let Some(base) = parse_feed_base(value) else {
        return Ok(None);
    };
    let mutation = match mutation["kind"].as_str() {
        Some("upsert") => {
            let Some(row) = parse_transient_feed_row(&mutation["row"])? else {
                return Ok(None);
            };
            if row.transcript.transcript_view_id != base.transcript_view_id {
                return Ok(None);
            }
            ChatTransientFeedMutationBody::Upsert { row: Box::new(row) }
        }
        Some("remove") => {
            let Some(permission_occurrence_id) =
                required_string(&mutation["permissionOccurrenceId"])
            else {
                return Ok(None);
            };
            ChatTransientFeedMutationBody::Remove {
                permission_occurrence_id,
            }
        }
        Some("clear-run") => {
            let Some(run_id) = required_string(&mutation["runId"]) else {
                return Ok(None);
            };
            ChatTransientFeedMutationBody::ClearRun { run_id }
        }
        _ => return Ok(None),
    };
    Ok(Some(ChatTransientFeedMutation {
        server_instance_id: base.server_instance_id,
        chat_id: base.chat_id,
        transcript_view_id: base.transcript_view_id,
        transient_revision: base.transient_revision,
        mutation,
    }))
}

pub fn parse_chat_transient_control_action(value: &Value) -> Option<ChatTransientControlAction> {
    Some(ChatTransientControlAction {
        server_instance_id: required_string(&value["serverInstanceId"])?,
        chat_id: required_string(&value["chatId"])?,
        run_id: required_string(&value["runId"])?,
        permission_occurrence_id: required_string(&value["permissionOccurrenceId"])?,
    })
}

struct FeedBase {
    server_instance_id: String,
    chat_id: String,
    transcript_view_id: String,
    transient_revision: u64,
}

fn parse_feed_base(value: &Value) -> Option<FeedBase> {
    Some(FeedBase {
        server_instance_id: required_string(&value["serverInstanceId"])?,
        chat_id: required_string(&value["chatId"])?,
        transcript_view_id: required_string(&value["transcriptViewId"])?,
        transient_revision: nonnegative_integer(&value["transientRevision"])?,
    })
}

fn parse_rows(
    values: &[Value],
) -> Result<Option<Vec<TransientFeedRow>>, InvalidAsyncQuestionReply> {
    let mut rows = Vec::with_capacity(values.len());
    let mut occurrences = HashSet::new();
    for value in values {
        let Some(row) = parse_transient_feed_row(value)? else {
            return Ok(None);
        };
        if !occurrences.insert(row.permission_occurrence_id.clone()) {
            return Ok(None);
        }
        rows.push(row);
    }
    Ok(Some(rows))
}

fn required_string(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

fn nonnegative_integer(value: &Value) -> Option<u64> {
    as_number(value)
        .filter(|&n| is_safe_integer(n) && n >= 0.0)
        .map(|n| n as u64)
}
