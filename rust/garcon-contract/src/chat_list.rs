//! Ports `common/chat-list.ts`.

use garcon_js::{OptionalNullable, is_safe_integer, json::as_number};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::agent_integration::{AgentSettingsEnvelope, parse_agent_settings_envelope};
use crate::api_providers::ApiProtocol;
use crate::chat_activity::{ChatActivityStatus, is_chat_activity_status};
use crate::chat_id::{ChatId, parse_chat_id};
use crate::chat_modes::{PermissionMode, ThinkingMode, is_permission_mode, is_thinking_mode};
use crate::chat_parentage::{ChatLineage, parse_chat_lineage};
use crate::chat_types::ChatProcessingPhase;
use crate::executors::{ExecutorId, is_executor_id};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatListEntry {
    pub id: ChatId,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub executor_id: OptionalNullable<ExecutorId>,
    pub parent_chat_id: Option<ChatId>,
    pub lineage: Option<ChatLineage>,
    pub agent_id: String,
    pub agent_ownership_epoch: String,
    pub model: Option<String>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub api_provider_id: OptionalNullable<String>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub model_endpoint_id: OptionalNullable<String>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub model_protocol: OptionalNullable<ApiProtocol>,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub agent_settings: AgentSettingsEnvelope,
    pub title: String,
    pub project_path: String,
    pub order_group: ChatOrderGroup,
    pub tags: Vec<String>,
    pub activity: ChatListActivity,
    pub preview: ChatListPreview,
    pub is_pinned: bool,
    pub is_archived: bool,
    pub is_active: bool,
    pub is_processing: bool,
    pub processing_phase: Option<ChatProcessingPhase>,
    pub activity_status: Option<ChatActivityStatus>,
    pub can_reload_from_native_history: bool,
    pub is_unread: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatOrderGroup {
    Pinned,
    Orphan,
    Normal,
    Archived,
    // The original validates `String(orderGroup)` but returns the input.
    #[serde(untagged)]
    CoercedArray([Box<ChatOrderGroup>; 1]),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatListActivity {
    pub created_at: Option<String>,
    pub last_activity_at: Option<String>,
    pub last_read_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatListPreview {
    pub last_message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatListResponse {
    pub sessions: Vec<ChatListEntry>,
    pub total: u64,
    pub last_selected_chat_id: Option<ChatId>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChatListContractError {
    #[error("Invalid chat list response: {0}")]
    Field(String),
    #[error("No default value")]
    OrderGroupCoercion,
}

impl ChatListContractError {
    pub fn new(message: impl Into<String>) -> Self {
        Self::Field(message.into())
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Field(_) => "ChatListContractError",
            Self::OrderGroupCoercion => "TypeError",
        }
    }
}

pub fn parse_chat_list_response(value: &Value) -> Result<ChatListResponse, ChatListContractError> {
    use ChatListContractError::Field;
    let sessions = value["sessions"]
        .as_array()
        .ok_or_else(|| Field("sessions".into()))?;
    let total = as_number(&value["total"])
        .filter(|&n| is_safe_integer(n) && n >= 0.0)
        .ok_or_else(|| Field("total".into()))? as u64;
    let sessions = sessions
        .iter()
        .enumerate()
        .map(|(index, entry)| parse_chat_list_entry(entry, index))
        .collect::<Result<Vec<_>, _>>()?;
    if total != sessions.len() as u64 {
        return Err(Field("total does not match sessions".into()));
    }
    let last_selected_chat_id =
        nullable(value.get("lastSelectedChatId"), |id| parse_chat_id(id).ok())
            .ok_or_else(|| Field("lastSelectedChatId".into()))?;
    Ok(ChatListResponse {
        sessions,
        total,
        last_selected_chat_id,
    })
}

fn parse_chat_list_entry(
    value: &Value,
    index: usize,
) -> Result<ChatListEntry, ChatListContractError> {
    use ChatListContractError::Field;
    let entry = value
        .as_object()
        .ok_or_else(|| Field(format!("sessions[{index}]")))?;
    let field = |name: &str| Field(format!("sessions[{index}].{name}"));
    let id = parse_chat_id(&value["id"]).map_err(|_| field("id"))?;
    if entry.contains_key("parentChat") {
        return Err(field("parentChat is no longer supported"));
    }
    let parent_chat_id = nullable(entry.get("parentChatId"), |parent| {
        parse_chat_id(parent).ok().filter(|parent| *parent != id)
    })
    .ok_or_else(|| field("parentChatId"))?;
    let lineage = nullable(entry.get("lineage"), |lineage| {
        parse_chat_lineage(lineage).filter(|lineage| lineage.source_chat_id != id)
    })
    .ok_or_else(|| field("lineage"))?;
    let agent_id = nonempty_string(&value["agentId"]).ok_or_else(|| field("agentId"))?;
    let executor_id = optional_nullable(entry.get("executorId"), |id| {
        id.as_str()
            .filter(|_| is_executor_id(id))
            .map(str::to_owned)
    })
    .ok_or_else(|| field("executorId"))?;
    let agent_ownership_epoch = nonempty_string(&value["agentOwnershipEpoch"])
        .ok_or_else(|| field("agentOwnershipEpoch"))?;
    let model = nullable(entry.get("model"), nonempty_string).ok_or_else(|| field("model"))?;
    let api_provider_id = optional_nullable(entry.get("apiProviderId"), nonempty_string)
        .ok_or_else(|| field("apiProviderId"))?;
    let model_endpoint_id = optional_nullable(entry.get("modelEndpointId"), nonempty_string)
        .ok_or_else(|| field("modelEndpointId"))?;
    let model_protocol = optional_nullable(entry.get("modelProtocol"), |protocol| {
        match protocol.as_str()? {
            "anthropic-messages" => Some(ApiProtocol::AnthropicMessages),
            "openai-compatible" => Some(ApiProtocol::OpenAiCompatible),
            _ => None,
        }
    })
    .ok_or_else(|| field("modelProtocol"))?;
    let permission_mode =
        is_permission_mode(&value["permissionMode"]).ok_or_else(|| field("permissionMode"))?;
    let thinking_mode =
        is_thinking_mode(&value["thinkingMode"]).ok_or_else(|| field("thinkingMode"))?;
    let agent_settings = parse_agent_settings_envelope(&value["agentSettings"])
        .filter(|settings| settings.owner_id == agent_id)
        .ok_or_else(|| field("agentSettings"))?;
    let title = string(&value["title"]).ok_or_else(|| field("title"))?;
    let project_path = string(&value["projectPath"]).ok_or_else(|| field("projectPath"))?;
    let order_group =
        parse_order_group(&value["orderGroup"])?.ok_or_else(|| field("orderGroup"))?;
    let tags = value["tags"]
        .as_array()
        .and_then(|tags| tags.iter().map(string).collect::<Option<Vec<_>>>())
        .ok_or_else(|| field("tags"))?;
    let activity = parse_activity(
        value["activity"]
            .as_object()
            .ok_or_else(|| field("activity"))?,
        field,
    )?;
    let preview = parse_preview(
        value["preview"]
            .as_object()
            .ok_or_else(|| field("preview"))?,
        field,
    )?;
    let boolean = |name: &str| value[name].as_bool().ok_or_else(|| field(name));
    let is_pinned = boolean("isPinned")?;
    let is_archived = boolean("isArchived")?;
    let is_active = boolean("isActive")?;
    let is_processing = boolean("isProcessing")?;
    let can_reload_from_native_history = boolean("canReloadFromNativeHistory")?;
    let is_unread = boolean("isUnread")?;
    let activity_status = nullable(entry.get("activityStatus"), is_chat_activity_status)
        .ok_or_else(|| field("activityStatus"))?;
    let processing_phase = nullable(entry.get("processingPhase"), |phase| {
        match phase.as_str()? {
            "running" => Some(ChatProcessingPhase::Running),
            "stopping" => Some(ChatProcessingPhase::Stopping),
            "reconnecting" => Some(ChatProcessingPhase::Reconnecting),
            _ => None,
        }
    })
    .ok_or_else(|| field("processingPhase"))?;
    let processing = processing_phase.is_some();
    if is_processing != processing || is_active != processing {
        return Err(field("processing state"));
    }
    if is_pinned != (order_group == ChatOrderGroup::Pinned) {
        return Err(field("isPinned"));
    }
    if is_archived != (order_group == ChatOrderGroup::Archived) {
        return Err(field("isArchived"));
    }
    Ok(ChatListEntry {
        id,
        executor_id,
        parent_chat_id,
        lineage,
        agent_id,
        agent_ownership_epoch,
        model,
        api_provider_id,
        model_endpoint_id,
        model_protocol,
        permission_mode,
        thinking_mode,
        agent_settings,
        title,
        project_path,
        order_group,
        tags,
        activity,
        preview,
        is_pinned,
        is_archived,
        is_active,
        is_processing,
        processing_phase,
        activity_status,
        can_reload_from_native_history,
        is_unread,
    })
}

fn parse_order_group(value: &Value) -> Result<Option<ChatOrderGroup>, ChatListContractError> {
    if value
        .as_object()
        .is_some_and(|raw| raw.contains_key("toString"))
    {
        return Err(ChatListContractError::OrderGroupCoercion);
    }
    if let Some(items) = value.as_array() {
        if let [item] = items.as_slice() {
            return parse_order_group(item)
                .map(|group| group.map(|group| ChatOrderGroup::CoercedArray([Box::new(group)])));
        }
        // Multiple elements cannot spell an order group, but String(array)
        // still coerces each element and can throw before that check.
        for item in items {
            parse_order_group(item)?;
        }
        return Ok(None);
    }
    Ok(match value.as_str() {
        Some("pinned") => Some(ChatOrderGroup::Pinned),
        Some("orphan") => Some(ChatOrderGroup::Orphan),
        Some("normal") => Some(ChatOrderGroup::Normal),
        Some("archived") => Some(ChatOrderGroup::Archived),
        _ => None,
    })
}

fn parse_activity(
    raw: &Map<String, Value>,
    field: impl Fn(&str) -> ChatListContractError,
) -> Result<ChatListActivity, ChatListContractError> {
    Ok(ChatListActivity {
        created_at: nullable(raw.get("createdAt"), string)
            .ok_or_else(|| field("activity.createdAt"))?,
        last_activity_at: nullable(raw.get("lastActivityAt"), string)
            .ok_or_else(|| field("activity.lastActivityAt"))?,
        last_read_at: nullable(raw.get("lastReadAt"), string)
            .ok_or_else(|| field("activity.lastReadAt"))?,
    })
}

fn parse_preview(
    raw: &Map<String, Value>,
    field: impl Fn(&str) -> ChatListContractError,
) -> Result<ChatListPreview, ChatListContractError> {
    let last_message = raw
        .get("lastMessage")
        .and_then(string)
        .ok_or_else(|| field("preview.lastMessage"))?;
    let first_message = match raw.get("firstMessage") {
        Some(value) => Some(string(value).ok_or_else(|| field("preview.firstMessage"))?),
        None => None,
    };
    Ok(ChatListPreview {
        last_message,
        first_message,
    })
}

fn string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn nonempty_string(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

fn nullable<T>(
    value: Option<&Value>,
    parse: impl FnOnce(&Value) -> Option<T>,
) -> Option<Option<T>> {
    match value? {
        Value::Null => Some(None),
        value => parse(value).map(Some),
    }
}

fn optional_nullable<T>(
    value: Option<&Value>,
    parse: impl FnOnce(&Value) -> Option<T>,
) -> Option<OptionalNullable<T>> {
    match value {
        None => Some(OptionalNullable::ABSENT),
        Some(Value::Null) => Some(OptionalNullable::NULL),
        Some(value) => parse(value).map(OptionalNullable::some),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLastSelectedChatRequest {
    pub chat_id: Option<ChatId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLastSelectedChatResponse {
    pub success: bool,
    pub last_selected_chat_id: Option<ChatId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkChatsReadEntry {
    pub chat_id: ChatId,
    pub last_read_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MarkChatsReadRequest {
    pub entries: Vec<MarkChatsReadEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MarkChatsReadResponse {
    pub success: bool,
    pub results: Vec<MarkChatsReadEntry>,
}
