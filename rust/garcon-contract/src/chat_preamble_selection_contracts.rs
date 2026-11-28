//! Ports `common/chat-preamble-selection-contracts.ts`.

use std::{collections::HashSet, sync::LazyLock};

use garcon_js::{OptionalNullable, array_index, is_safe_integer, json::as_number, trim};
use regex::Regex;
use serde::{Deserialize, Serialize, Serializer, ser::SerializeStruct};
use serde_json::{Map, Value};

use crate::{
    agents::{AgentId, is_agent_id},
    chat_id::{ChatId, parse_chat_id},
    command_request_validation::{
        CommandRequestValidationError, is_command_correlation_id_within_limit, request_record,
        required_chat_id, required_command_correlation_id,
    },
    executors::{ExecutorId, LOCAL_EXECUTOR_ID, parse_executor_id},
    preambles::{
        ChatPreambleSelection, PREAMBLE_MAX_COUNT, PreambleId, PreambleSelectionProjection,
        is_preamble_id, normalize_chat_preamble_selection, normalize_ordered_preamble_ids,
        normalize_preamble_selection_projection,
    },
    tags::normalize_tags,
};

pub const CHAT_PREAMBLE_SELECTION_BODY_MAX_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPreambleSelectionTargetResponse {
    pub success: bool,
    pub chat_id: String,
    pub transcript_view_id: String,
    pub canonical_project_path: String,
    #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
    pub executor_id: OptionalNullable<ExecutorId>,
    pub selection: ChatPreambleSelection,
    pub projection: PreambleSelectionProjection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChatPreambleSelectionRequest {
    pub chat_id: ChatId,
    pub transcript_view_id: String,
    pub client_request_id: String,
    pub client_message_id: String,
    pub expected_revision: u64,
    pub ordered_preamble_ids: Vec<PreambleId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreambleSelectionCommandType {
    ChatPreamblesUpdate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreambleSelectionUpdateStatus {
    Updated,
    Unchanged,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChatPreambleSelectionResponse {
    pub success: bool,
    pub command_type: PreambleSelectionCommandType,
    pub client_request_id: String,
    pub client_message_id: String,
    pub chat_id: String,
    pub transcript_view_id: String,
    pub status: PreambleSelectionUpdateStatus,
    pub mutation_revision: u64,
    pub notice_ordinal: Option<u64>,
    pub selection: ChatPreambleSelection,
    pub projection: PreambleSelectionProjection,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreambleSelectionPreviewRequest {
    pub project_path: String,
    pub agent_id: AgentId,
    #[serde(default)]
    pub executor_id: OptionalNullable<ExecutorId>,
    pub tags: Vec<String>,
    pub ordered_preamble_ids: Option<Vec<PreambleId>>,
}

impl Serialize for PreambleSelectionPreviewRequest {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let has_executor = !self.executor_id.is_absent();
        let explicit = self.ordered_preamble_ids.is_some();
        let mut record = serializer.serialize_struct(
            "PreambleSelectionPreviewRequest",
            3 + usize::from(has_executor) + usize::from(explicit),
        )?;
        // The original orders executorId differently in its two branches.
        if has_executor && !explicit {
            record.serialize_field("executorId", &self.executor_id)?;
        }
        record.serialize_field("projectPath", &self.project_path)?;
        record.serialize_field("agentId", &self.agent_id)?;
        if has_executor && explicit {
            record.serialize_field("executorId", &self.executor_id)?;
        }
        record.serialize_field("tags", &self.tags)?;
        if let Some(ids) = &self.ordered_preamble_ids {
            record.serialize_field("orderedPreambleIds", ids)?;
        }
        record.end()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreambleSelectionPreviewResponse {
    pub success: bool,
    pub canonical_project_path: String,
    #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
    pub executor_id: OptionalNullable<ExecutorId>,
    pub ordered_preamble_ids: Vec<PreambleId>,
    pub projection: PreambleSelectionProjection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Value", into = "Value")]
pub enum PreambleSelectionCommittedState {
    Committed,
    Unknown,
}

impl TryFrom<Value> for PreambleSelectionCommittedState {
    type Error = &'static str;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        match value {
            Value::Bool(true) => Ok(Self::Committed),
            Value::String(value) if value == "unknown" => Ok(Self::Unknown),
            _ => Err("selectionCommitted must be true or unknown"),
        }
    }
}

impl From<PreambleSelectionCommittedState> for Value {
    fn from(state: PreambleSelectionCommittedState) -> Self {
        match state {
            PreambleSelectionCommittedState::Committed => Value::Bool(true),
            PreambleSelectionCommittedState::Unknown => Value::String("unknown".to_owned()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PreambleSelectionPartialErrorCode {
    #[serde(rename = "PREAMBLE_SELECTION_NOTICE_FAILED")]
    NoticeFailed,
    #[serde(rename = "PREAMBLE_SELECTION_SAVE_UNKNOWN")]
    SaveUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreambleSelectionPartialErrorBody {
    pub success: bool,
    pub error_code: PreambleSelectionPartialErrorCode,
    pub message: String,
    pub retryable: bool,
    pub selection_committed: PreambleSelectionCommittedState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<ChatPreambleSelection>,
}

fn required_ordered_preamble_ids(
    value: &[Value],
) -> Result<Vec<PreambleId>, CommandRequestValidationError> {
    if value.len() > PREAMBLE_MAX_COUNT {
        return Err(CommandRequestValidationError::new(
            "orderedPreambleIds is too long",
        ));
    }
    let mut seen = HashSet::new();
    let mut ids = Vec::with_capacity(value.len());
    for item in value {
        let Some(id) = item.as_str().filter(|_| is_preamble_id(item)) else {
            return Err(CommandRequestValidationError::new(
                "orderedPreambleIds contains an invalid preamble ID",
            ));
        };
        if !seen.insert(id) {
            return Err(CommandRequestValidationError::new(
                "orderedPreambleIds contains a duplicate ID",
            ));
        }
        ids.push(id.to_owned());
    }
    Ok(ids)
}

pub fn parse_update_chat_preamble_selection_request(
    value: &Value,
) -> Result<UpdateChatPreambleSelectionRequest, CommandRequestValidationError> {
    let body = strict_record(
        value,
        &[
            "chatId",
            "transcriptViewId",
            "clientRequestId",
            "clientMessageId",
            "expectedRevision",
            "orderedPreambleIds",
        ],
    )?;
    let ordered_preamble_ids = body
        .get("orderedPreambleIds")
        .and_then(Value::as_array)
        .ok_or_else(|| CommandRequestValidationError::new("orderedPreambleIds is required"))?;
    let expected_revision = body
        .get("expectedRevision")
        .and_then(non_negative_safe_integer)
        .ok_or_else(|| {
            CommandRequestValidationError::new("expectedRevision must be a nonnegative integer")
        })?;
    Ok(UpdateChatPreambleSelectionRequest {
        chat_id: required_chat_id(body, "chatId")?,
        transcript_view_id: required_transcript_view_id(body, "transcriptViewId")?.to_owned(),
        client_request_id: required_command_correlation_id(body, "clientRequestId")?.to_owned(),
        client_message_id: required_command_correlation_id(body, "clientMessageId")?.to_owned(),
        expected_revision,
        ordered_preamble_ids: required_ordered_preamble_ids(ordered_preamble_ids)?,
    })
}

pub fn parse_preamble_selection_preview_request(
    value: &Value,
) -> Result<PreambleSelectionPreviewRequest, CommandRequestValidationError> {
    let body = strict_record(
        value,
        &[
            "executorId",
            "projectPath",
            "agentId",
            "tags",
            "orderedPreambleIds",
        ],
    )?;
    let executor_id = parse_optional_executor_id(body)
        .ok_or_else(|| CommandRequestValidationError::new("executorId is invalid"))?;
    let project_path = body
        .get("projectPath")
        .and_then(Value::as_str)
        .filter(|path| !trim(path).is_empty())
        .ok_or_else(|| CommandRequestValidationError::new("projectPath is required"))?;
    let agent_id = body
        .get("agentId")
        .filter(|value| is_agent_id(value))
        .and_then(Value::as_str)
        .ok_or_else(|| CommandRequestValidationError::new("agentId is invalid"))?;
    let raw_tags = body
        .get("tags")
        .and_then(Value::as_array)
        .filter(|tags| tags.iter().all(Value::is_string))
        .ok_or_else(|| CommandRequestValidationError::new("tags must be an array of strings"))?;
    let tags = normalize_tags(raw_tags);
    if tags.len() != raw_tags.len()
        || tags
            .iter()
            .zip(raw_tags)
            .any(|(tag, raw)| raw.as_str() != Some(tag))
    {
        return Err(CommandRequestValidationError::new(
            "tags must be normalized, unique, and sorted",
        ));
    }
    let ordered_preamble_ids = match body.get("orderedPreambleIds") {
        None => None,
        Some(value) => {
            let ids = value.as_array().ok_or_else(|| {
                CommandRequestValidationError::new("orderedPreambleIds must be an array")
            })?;
            Some(required_ordered_preamble_ids(ids)?)
        }
    };
    Ok(PreambleSelectionPreviewRequest {
        project_path: project_path.to_owned(),
        agent_id: agent_id.to_owned(),
        executor_id,
        tags,
        ordered_preamble_ids,
    })
}

fn projection_partitions_selection(
    projection: &PreambleSelectionProjection,
    ids: &[PreambleId],
) -> bool {
    let eligible: HashSet<_> = projection
        .eligible_preambles
        .iter()
        .map(|entry| &entry.id)
        .collect();
    let unavailable: HashSet<_> = projection
        .unavailable
        .iter()
        .map(|entry| &entry.id)
        .collect();
    if eligible.len() + unavailable.len() != ids.len() {
        return false;
    }
    let mut expected_eligible = Vec::new();
    let mut expected_unavailable = Vec::new();
    for id in ids {
        if eligible.contains(id) {
            expected_eligible.push(id);
        } else if unavailable.contains(id) {
            expected_unavailable.push(id);
        } else {
            return false;
        }
    }
    expected_eligible
        .into_iter()
        .eq(projection.eligible_preambles.iter().map(|entry| &entry.id))
        && expected_unavailable
            .into_iter()
            .eq(projection.unavailable.iter().map(|entry| &entry.id))
}

pub fn parse_chat_preamble_selection_target_response(
    value: &Value,
) -> Option<ChatPreambleSelectionTargetResponse> {
    let response = response_record(
        value,
        &[
            "executorId",
            "success",
            "chatId",
            "transcriptViewId",
            "canonicalProjectPath",
            "selection",
            "projection",
        ],
    )?;
    if response.get("success")?.as_bool() != Some(true) {
        return None;
    }
    let executor_id = parse_optional_executor_id(response)?;
    let selection = normalize_chat_preamble_selection(response.get("selection")?)?;
    let projection = normalize_preamble_selection_projection(response.get("projection")?)?;
    let chat_id = response_chat_id(response.get("chatId")?)?;
    let transcript_view_id = transcript_view_id(response.get("transcriptViewId")?)?;
    let canonical_project_path = non_empty_string(response.get("canonicalProjectPath")?)?;
    if !projection_partitions_selection(&projection, &selection.ordered_preamble_ids) {
        return None;
    }
    Some(ChatPreambleSelectionTargetResponse {
        success: true,
        chat_id: chat_id.to_owned(),
        transcript_view_id: transcript_view_id.to_owned(),
        canonical_project_path: canonical_project_path.to_owned(),
        executor_id,
        selection,
        projection,
    })
}

pub fn parse_update_chat_preamble_selection_response(
    value: &Value,
) -> Option<UpdateChatPreambleSelectionResponse> {
    let response = response_record(
        value,
        &[
            "success",
            "commandType",
            "clientRequestId",
            "clientMessageId",
            "chatId",
            "transcriptViewId",
            "status",
            "mutationRevision",
            "noticeOrdinal",
            "selection",
            "projection",
        ],
    )?;
    if response.get("success")?.as_bool() != Some(true)
        || response.get("commandType")?.as_str()? != "chat-preambles-update"
    {
        return None;
    }
    let client_request_id = response_correlation_id(response.get("clientRequestId")?)?;
    let client_message_id = response_correlation_id(response.get("clientMessageId")?)?;
    let chat_id = response_chat_id(response.get("chatId")?)?;
    let transcript_view_id = transcript_view_id(response.get("transcriptViewId")?)?;
    let notice = response.get("noticeOrdinal")?;
    let status = match response.get("status")?.as_str()? {
        "updated" if !notice.is_null() => PreambleSelectionUpdateStatus::Updated,
        "unchanged" if notice.is_null() => PreambleSelectionUpdateStatus::Unchanged,
        "duplicate" if !notice.is_null() => PreambleSelectionUpdateStatus::Duplicate,
        _ => return None,
    };
    let mutation_revision = non_negative_safe_integer(response.get("mutationRevision")?)?;
    let notice_ordinal = if notice.is_null() {
        None
    } else {
        Some(non_negative_safe_integer(notice).filter(|&number| number >= 1)?)
    };
    let selection = normalize_chat_preamble_selection(response.get("selection")?)?;
    let projection = normalize_preamble_selection_projection(response.get("projection")?)?;
    if !projection_partitions_selection(&projection, &selection.ordered_preamble_ids) {
        return None;
    }
    if if status == PreambleSelectionUpdateStatus::Duplicate {
        selection.revision < mutation_revision
    } else {
        selection.revision != mutation_revision
    } {
        return None;
    }
    Some(UpdateChatPreambleSelectionResponse {
        success: true,
        command_type: PreambleSelectionCommandType::ChatPreamblesUpdate,
        client_request_id: client_request_id.to_owned(),
        client_message_id: client_message_id.to_owned(),
        chat_id: chat_id.to_owned(),
        transcript_view_id: transcript_view_id.to_owned(),
        status,
        mutation_revision,
        notice_ordinal,
        selection,
        projection,
    })
}

pub fn parse_preamble_selection_preview_response(
    value: &Value,
) -> Option<PreambleSelectionPreviewResponse> {
    let response = response_record(
        value,
        &[
            "executorId",
            "success",
            "canonicalProjectPath",
            "orderedPreambleIds",
            "projection",
        ],
    )?;
    if response.get("success")?.as_bool() != Some(true) {
        return None;
    }
    let executor_id = parse_optional_executor_id(response)?;
    let projection = normalize_preamble_selection_projection(response.get("projection")?)?;
    let canonical_project_path = non_empty_string(response.get("canonicalProjectPath")?)?;
    let ordered_preamble_ids = normalize_ordered_preamble_ids(response.get("orderedPreambleIds")?)?;
    if !projection_partitions_selection(&projection, &ordered_preamble_ids) {
        return None;
    }
    Some(PreambleSelectionPreviewResponse {
        success: true,
        canonical_project_path: canonical_project_path.to_owned(),
        executor_id,
        ordered_preamble_ids,
        projection,
    })
}

pub fn parse_preamble_selection_partial_error(
    value: &Value,
) -> Option<PreambleSelectionPartialErrorBody> {
    let response = response_record(
        value,
        &[
            "success",
            "errorCode",
            "message",
            "retryable",
            "selectionCommitted",
            "selection",
        ],
    )?;
    if response.get("success")?.as_bool() != Some(false) {
        return None;
    }
    let error_code = match response.get("errorCode")?.as_str()? {
        "PREAMBLE_SELECTION_NOTICE_FAILED" => PreambleSelectionPartialErrorCode::NoticeFailed,
        "PREAMBLE_SELECTION_SAVE_UNKNOWN" => PreambleSelectionPartialErrorCode::SaveUnknown,
        _ => return None,
    };
    let message = non_empty_string(response.get("message")?)?;
    if response.get("retryable")?.as_bool() != Some(false) {
        return None;
    }
    let selection_committed =
        PreambleSelectionCommittedState::try_from(response.get("selectionCommitted")?.clone())
            .ok()?;
    if (error_code == PreambleSelectionPartialErrorCode::NoticeFailed)
        != (selection_committed == PreambleSelectionCommittedState::Committed)
    {
        return None;
    }
    let selection = match response.get("selection") {
        Some(value) => Some(normalize_chat_preamble_selection(value)?),
        None if error_code == PreambleSelectionPartialErrorCode::NoticeFailed => return None,
        None => None,
    };
    Some(PreambleSelectionPartialErrorBody {
        success: false,
        error_code,
        message: message.to_owned(),
        retryable: false,
        selection_committed,
        selection,
    })
}

fn strict_record<'a>(
    value: &'a Value,
    keys: &[&str],
) -> Result<&'a Map<String, Value>, CommandRequestValidationError> {
    let body = request_record(value)?;
    if let Some(key) = body
        .keys()
        .filter(|key| !keys.contains(&key.as_str()))
        .min_by_key(|key| array_index(key).unwrap_or(u64::MAX))
    {
        return Err(CommandRequestValidationError::new(format!(
            "{key} is not supported"
        )));
    }
    Ok(body)
}

static TRANSCRIPT_VIEW_ID: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the UUID shape is a valid regular expression.
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        .expect("transcript view ID pattern")
});

fn required_transcript_view_id<'a>(
    body: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, CommandRequestValidationError> {
    let value = required_command_correlation_id(body, field)?;
    if !TRANSCRIPT_VIEW_ID.is_match(value) {
        return Err(CommandRequestValidationError::new(format!(
            "{field} must be a transcript view UUID"
        )));
    }
    Ok(value)
}

fn response_record<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    let raw = value.as_object()?;
    raw.keys()
        .all(|key| keys.contains(&key.as_str()))
        .then_some(raw)
}

fn response_chat_id(value: &Value) -> Option<&str> {
    parse_chat_id(value).ok()?;
    value.as_str()
}

fn transcript_view_id(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|value| TRANSCRIPT_VIEW_ID.is_match(value))
}

fn response_correlation_id(value: &Value) -> Option<&str> {
    non_empty_string(value)
        .filter(|value| trim(value) == *value && is_command_correlation_id_within_limit(value))
}

fn non_empty_string(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| !value.is_empty())
}

fn non_negative_safe_integer(value: &Value) -> Option<u64> {
    let number = as_number(value)?;
    (is_safe_integer(number) && number >= 0.0).then_some(number as u64)
}

fn parse_optional_executor_id(raw: &Map<String, Value>) -> Option<OptionalNullable<ExecutorId>> {
    let executor_id = parse_executor_id(raw.get("executorId").unwrap_or(&Value::Null))?;
    Some(if executor_id == LOCAL_EXECUTOR_ID {
        OptionalNullable::ABSENT
    } else {
        OptionalNullable::some(executor_id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_strict_update_request_and_rejects_malformed_identities() {
        let good = json!({"chatId":"1783725900000200","transcriptViewId":"12345678-1234-4123-8123-123456789abc","clientRequestId":"req-1","clientMessageId":"msg-1","expectedRevision":3,"orderedPreambleIds":[]});
        assert_eq!(
            json!(parse_update_chat_preamble_selection_request(&good).unwrap()),
            good
        );
        let mut bad = good;
        bad["chatId"] = json!("invalid");
        bad["expectedRevision"] = json!(-1);
        assert_eq!(
            parse_update_chat_preamble_selection_request(&bad)
                .unwrap_err()
                .message,
            "expectedRevision must be a nonnegative integer"
        );
        bad["extra"] = json!(true);
        bad["12"] = json!(true);
        bad["3"] = json!(true);
        assert_eq!(
            parse_update_chat_preamble_selection_request(&bad)
                .unwrap_err()
                .message,
            "3 is not supported"
        );
    }

    #[test]
    fn refuses_a_projection_that_reorders_the_selection() {
        let one = "3502b645-222b-49d2-ac39-1c91f9fb1174";
        let two = "80becfa6-c9c7-4b31-9190-fd23c0bedf9c";
        let mut response = json!({"success":true,"canonicalProjectPath":"/work","orderedPreambleIds":[one,two],"projection":{"catalogRevision":1,"eligiblePreambles":[{"id":one,"title":"One"},{"id":two,"title":"Two"}],"unavailable":[]}});
        assert!(parse_preamble_selection_preview_response(&response).is_some());
        response["orderedPreambleIds"] = json!([two, one]);
        assert!(parse_preamble_selection_preview_response(&response).is_none());
    }
}
