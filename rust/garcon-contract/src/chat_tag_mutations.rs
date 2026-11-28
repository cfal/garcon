//! Ports `common/chat-tag-mutations.ts`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::chat_boards::{ChatBoardCatalog, ChatBoardColumnId, ChatBoardId};
use crate::tags::normalize_tags;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceChatTagsRequest {
    pub chat_id: String,
    pub expected_tags: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyChatTagDeltaRequest {
    pub chat_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add_tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remove_tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ChatTagTransitionTarget {
    Column {
        column_id: ChatBoardColumnId,
        #[serde(skip_serializing_if = "Option::is_none")]
        selected_target_tags: Option<Vec<String>>,
    },
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionChatTagsRequest {
    pub chat_id: String,
    pub board_id: ChatBoardId,
    pub source_column_id: ChatBoardColumnId,
    pub target: ChatTagTransitionTarget,
    pub expected_catalog_revision: u64,
    pub expected_tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTagsMutationResponse {
    pub success: bool,
    pub chat_id: String,
    pub tags: Vec<String>,
    pub added_tags: Vec<String>,
    pub removed_tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverChatTagsResponse {
    pub success: bool,
    pub chat_id: String,
    pub tags: Vec<String>,
}

fn string_array(value: &Value) -> Option<Vec<String>> {
    let raw = value.as_array()?;
    if !raw.iter().all(Value::is_string) {
        return None;
    }
    let normalized = normalize_tags(raw);
    (normalized.len() == raw.len()
        && normalized
            .iter()
            .zip(raw)
            .all(|(tag, item)| Some(tag.as_str()) == item.as_str()))
    .then_some(normalized)
}

fn has_only_keys(value: &Map<String, Value>, keys: &[&str]) -> bool {
    value.keys().all(|key| keys.contains(&key.as_str()))
}

pub fn normalize_chat_tags_mutation_response(value: &Value) -> Option<ChatTagsMutationResponse> {
    let raw = value.as_object()?;
    if !has_only_keys(
        raw,
        &["success", "chatId", "tags", "addedTags", "removedTags"],
    ) || raw.get("success")?.as_bool() != Some(true)
    {
        return None;
    }
    let chat_id = raw.get("chatId")?.as_str()?.into();
    let tags = string_array(raw.get("tags")?)?;
    let added_tags = string_array(raw.get("addedTags")?)?;
    let removed_tags = string_array(raw.get("removedTags")?)?;
    Some(ChatTagsMutationResponse {
        success: true,
        chat_id,
        tags,
        added_tags,
        removed_tags,
    })
}

pub fn normalize_recover_chat_tags_response(value: &Value) -> Option<RecoverChatTagsResponse> {
    let raw = value.as_object()?;
    if !has_only_keys(raw, &["success", "chatId", "tags"])
        || raw.get("success")?.as_bool() != Some(true)
    {
        return None;
    }
    let chat_id = raw.get("chatId")?.as_str()?.into();
    let tags = string_array(raw.get("tags")?)?;
    Some(RecoverChatTagsResponse {
        success: true,
        chat_id,
        tags,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChatTagConflictCode {
    #[serde(rename = "CHAT_TAG_REVISION_CONFLICT")]
    ChatTagRevisionConflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTagConflictResponse {
    pub success: bool,
    pub error: String,
    pub error_code: ChatTagConflictCode,
    pub retryable: bool,
    pub current_tags: Vec<String>,
}

pub fn normalize_chat_tag_conflict_response(value: &Value) -> Option<ChatTagConflictResponse> {
    let raw = value.as_object()?;
    if !has_only_keys(
        raw,
        &["success", "error", "errorCode", "retryable", "currentTags"],
    ) || raw.get("success")?.as_bool() != Some(false)
    {
        return None;
    }
    let error = raw.get("error")?.as_str()?.into();
    if raw.get("errorCode")?.as_str() != Some(CHAT_TAG_ERROR_CODES.revision_conflict)
        || raw.get("retryable")?.as_bool() != Some(true)
    {
        return None;
    }
    let current_tags = string_array(raw.get("currentTags")?)?;
    Some(ChatTagConflictResponse {
        success: false,
        error,
        error_code: ChatTagConflictCode::ChatTagRevisionConflict,
        retryable: true,
        current_tags,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChatBoardTransitionConflictCode {
    ChatTagRevisionConflict,
    ChatBoardRevisionConflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatBoardTransitionConflictResponse {
    pub success: bool,
    pub error_code: ChatBoardTransitionConflictCode,
    pub retryable: bool,
    pub current_tags: Vec<String>,
    pub catalog: ChatBoardCatalog,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatTagErrorCodes {
    pub validation_failed: &'static str,
    pub revision_conflict: &'static str,
    pub save_failed: &'static str,
    pub save_unknown: &'static str,
}

pub const CHAT_TAG_ERROR_CODES: ChatTagErrorCodes = ChatTagErrorCodes {
    validation_failed: "CHAT_TAG_VALIDATION_FAILED",
    revision_conflict: "CHAT_TAG_REVISION_CONFLICT",
    save_failed: "CHAT_TAG_SAVE_FAILED",
    save_unknown: "CHAT_TAG_SAVE_UNKNOWN",
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChatTagSaveFailedCode {
    ChatTagSaveFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChatTagSaveUnknownCode {
    ChatTagSaveUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum CommandTagMutationOutcome {
    Applied {
        added_tags: Vec<String>,
    },
    NotApplied {
        error_code: ChatTagSaveFailedCode,
        retryable: bool,
    },
    Unknown {
        error_code: ChatTagSaveUnknownCode,
        recovery_required: bool,
    },
}

pub fn normalize_command_tag_mutation_outcome(value: &Value) -> Option<CommandTagMutationOutcome> {
    let raw = value.as_object()?;
    match raw.get("status")?.as_str()? {
        "applied" => {
            if !has_only_keys(raw, &["status", "addedTags"]) {
                return None;
            }
            let added_tags = string_array(raw.get("addedTags")?)?;
            Some(CommandTagMutationOutcome::Applied { added_tags })
        }
        "not-applied" => {
            if !has_only_keys(raw, &["status", "errorCode", "retryable"])
                || raw.get("errorCode")?.as_str() != Some(CHAT_TAG_ERROR_CODES.save_failed)
                || raw.get("retryable")?.as_bool() != Some(true)
            {
                return None;
            }
            Some(CommandTagMutationOutcome::NotApplied {
                error_code: ChatTagSaveFailedCode::ChatTagSaveFailed,
                retryable: true,
            })
        }
        "unknown" => {
            if !has_only_keys(raw, &["status", "errorCode", "recoveryRequired"])
                || raw.get("errorCode")?.as_str() != Some(CHAT_TAG_ERROR_CODES.save_unknown)
                || raw.get("recoveryRequired")?.as_bool() != Some(true)
            {
                return None;
            }
            Some(CommandTagMutationOutcome::Unknown {
                error_code: ChatTagSaveUnknownCode::ChatTagSaveUnknown,
                recovery_required: true,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_canonical_mutation_and_recovery_responses() {
        let response = json!({"success":true,"chatId":"chat-1","tags":["ready","web"],"addedTags":["ready"],"removedTags":[]});
        assert_eq!(
            serde_json::to_value(normalize_chat_tags_mutation_response(&response).unwrap())
                .unwrap(),
            response
        );
        let recovery = json!({"success":true,"chatId":"chat-1","tags":["ready"]});
        assert_eq!(
            serde_json::to_value(normalize_recover_chat_tags_response(&recovery).unwrap()).unwrap(),
            recovery
        );
    }

    #[test]
    fn rejects_unknown_keys_and_noncanonical_tag_arrays() {
        let response = json!({"success":true,"chatId":"chat-1","tags":["Ready"],"addedTags":[],"removedTags":[]});
        assert!(normalize_chat_tags_mutation_response(&response).is_none());
        let recovery = json!({"success":true,"chatId":"chat-1","tags":[],"extra":true});
        assert!(normalize_recover_chat_tags_response(&recovery).is_none());
    }

    #[test]
    fn parses_every_accepted_command_tag_outcome() {
        for value in [
            json!({"status":"applied","addedTags":["ready"]}),
            json!({"status":"not-applied","errorCode":"CHAT_TAG_SAVE_FAILED","retryable":true}),
            json!({"status":"unknown","errorCode":"CHAT_TAG_SAVE_UNKNOWN","recoveryRequired":true}),
        ] {
            assert_eq!(
                serde_json::to_value(normalize_command_tag_mutation_outcome(&value).unwrap())
                    .unwrap(),
                value
            );
        }
    }
}
