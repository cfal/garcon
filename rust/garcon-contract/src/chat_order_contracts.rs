//! Ports `common/chat-order-contracts.ts`.

use garcon_js::trim;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat_order_sort::{ChatOrderSortKey, is_chat_order_sort_key};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PersistedChatOrderGroup {
    Pinned,
    Normal,
    Archived,
}

impl PersistedChatOrderGroup {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pinned => "pinned",
            Self::Normal => "normal",
            Self::Archived => "archived",
        }
    }
}

pub const PERSISTED_CHAT_ORDER_GROUPS: &[PersistedChatOrderGroup] = &[
    PersistedChatOrderGroup::Pinned,
    PersistedChatOrderGroup::Normal,
    PersistedChatOrderGroup::Archived,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatOrderBoundary {
    Top,
    Bottom,
}

pub const CHAT_ORDER_BOUNDARIES: &[ChatOrderBoundary] =
    &[ChatOrderBoundary::Top, ChatOrderBoundary::Bottom];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRelativePosition {
    Before,
    After,
}

pub const CHAT_RELATIVE_POSITIONS: &[ChatRelativePosition] =
    &[ChatRelativePosition::Before, ChatRelativePosition::After];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ChatOrderPlacement {
    Relative(RelativeChatOrderPlacement),
    Boundary(BoundaryChatOrderPlacement),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RelativeKind {
    Relative,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelativeChatOrderPlacement {
    kind: RelativeKind,
    pub reference_chat_id: String,
    pub position: ChatRelativePosition,
}

impl RelativeChatOrderPlacement {
    pub fn new(reference_chat_id: String, position: ChatRelativePosition) -> Self {
        Self {
            kind: RelativeKind::Relative,
            reference_chat_id,
            position,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum BoundaryKind {
    Boundary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundaryChatOrderPlacement {
    kind: BoundaryKind,
    pub boundary: ChatOrderBoundary,
}

impl BoundaryChatOrderPlacement {
    pub fn new(boundary: ChatOrderBoundary) -> Self {
        Self {
            kind: BoundaryKind::Boundary,
            boundary,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderChatRequest {
    pub chat_id: String,
    pub placement: ChatOrderPlacement,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderChatResponse {
    pub success: bool,
    pub chat_id: String,
    pub order_group: PersistedChatOrderGroup,
    pub changed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReorderChatErrorCode {
    ValidationFailed,
    SessionNotFound,
    OrderCrossGroup,
    InternalError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderChatErrorResponse {
    success: bool,
    pub error: String,
    pub error_code: ReorderChatErrorCode,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl ReorderChatErrorResponse {
    pub fn new(
        error: String,
        error_code: ReorderChatErrorCode,
        retryable: bool,
        details: Option<String>,
    ) -> Self {
        Self {
            success: false,
            error,
            error_code,
            retryable,
            details,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SortChatOrderRequest {
    pub sort_key: ChatOrderSortKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SortChatOrderResponse {
    pub success: bool,
    pub sort_key: ChatOrderSortKey,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetChatPinnedRequest {
    pub chat_id: String,
    pub is_pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetChatArchivedRequest {
    pub chat_id: String,
    pub is_archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetChatOrderStateResponse {
    pub success: bool,
    pub chat_id: String,
    pub order_group: PersistedChatOrderGroup,
    pub is_pinned: bool,
    pub is_archived: bool,
    pub changed: bool,
}

fn has_only_keys(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|raw| raw.keys().all(|key| keys.contains(&key.as_str())))
}

fn nonempty_string(value: &Value) -> Option<String> {
    let string = trim(value.as_str()?);
    (!string.is_empty()).then(|| string.to_owned())
}

fn order_group(value: &Value) -> Option<PersistedChatOrderGroup> {
    let name = value.as_str()?;
    PERSISTED_CHAT_ORDER_GROUPS
        .iter()
        .copied()
        .find(|group| group.as_str() == name)
}

pub fn parse_reorder_chat_request(value: &Value) -> Option<ReorderChatRequest> {
    if !has_only_keys(value, &["chatId", "placement"]) {
        return None;
    }
    let chat_id = nonempty_string(&value["chatId"])?;
    let placement = &value["placement"];
    let placement = match placement["kind"].as_str()? {
        "boundary" => {
            if !has_only_keys(placement, &["kind", "boundary"]) {
                return None;
            }
            let boundary = match placement["boundary"].as_str()? {
                "top" => ChatOrderBoundary::Top,
                "bottom" => ChatOrderBoundary::Bottom,
                _ => return None,
            };
            ChatOrderPlacement::Boundary(BoundaryChatOrderPlacement::new(boundary))
        }
        "relative" => {
            if !has_only_keys(placement, &["kind", "referenceChatId", "position"]) {
                return None;
            }
            let reference_chat_id = nonempty_string(&placement["referenceChatId"])?;
            if reference_chat_id == chat_id {
                return None;
            }
            let position = match placement["position"].as_str()? {
                "before" => ChatRelativePosition::Before,
                "after" => ChatRelativePosition::After,
                _ => return None,
            };
            ChatOrderPlacement::Relative(RelativeChatOrderPlacement::new(
                reference_chat_id,
                position,
            ))
        }
        _ => return None,
    };
    Some(ReorderChatRequest { chat_id, placement })
}

pub fn parse_reorder_chat_response(value: &Value) -> Option<ReorderChatResponse> {
    if value["success"] != true {
        return None;
    }
    let changed = value["changed"].as_bool()?;
    let chat_id = nonempty_string(&value["chatId"])?;
    let order_group = order_group(&value["orderGroup"])?;
    Some(ReorderChatResponse {
        success: true,
        chat_id,
        order_group,
        changed,
    })
}

pub fn parse_sort_chat_order_request(value: &Value) -> Option<SortChatOrderRequest> {
    if !has_only_keys(value, &["sortKey"]) {
        return None;
    }
    let sort_key = is_chat_order_sort_key(&value["sortKey"])?;
    Some(SortChatOrderRequest { sort_key })
}

pub fn parse_sort_chat_order_response(value: &Value) -> Option<SortChatOrderResponse> {
    if !has_only_keys(value, &["success", "sortKey", "changed"]) || value["success"] != true {
        return None;
    }
    let changed = value["changed"].as_bool()?;
    let sort_key = is_chat_order_sort_key(&value["sortKey"])?;
    Some(SortChatOrderResponse {
        success: true,
        sort_key,
        changed,
    })
}

pub fn parse_set_chat_pinned_request(value: &Value) -> Option<SetChatPinnedRequest> {
    if !has_only_keys(value, &["chatId", "isPinned"]) {
        return None;
    }
    let chat_id = nonempty_string(&value["chatId"])?;
    let is_pinned = value["isPinned"].as_bool()?;
    Some(SetChatPinnedRequest { chat_id, is_pinned })
}

pub fn parse_set_chat_archived_request(value: &Value) -> Option<SetChatArchivedRequest> {
    if !has_only_keys(value, &["chatId", "isArchived"]) {
        return None;
    }
    let chat_id = nonempty_string(&value["chatId"])?;
    let is_archived = value["isArchived"].as_bool()?;
    Some(SetChatArchivedRequest {
        chat_id,
        is_archived,
    })
}

pub fn parse_set_chat_order_state_response(value: &Value) -> Option<SetChatOrderStateResponse> {
    if !has_only_keys(
        value,
        &[
            "success",
            "chatId",
            "orderGroup",
            "isPinned",
            "isArchived",
            "changed",
        ],
    ) || value["success"] != true
    {
        return None;
    }
    let is_pinned = value["isPinned"].as_bool()?;
    let is_archived = value["isArchived"].as_bool()?;
    let changed = value["changed"].as_bool()?;
    let chat_id = nonempty_string(&value["chatId"])?;
    let order_group = order_group(&value["orderGroup"])?;
    if is_pinned != (order_group == PersistedChatOrderGroup::Pinned)
        || is_archived != (order_group == PersistedChatOrderGroup::Archived)
    {
        return None;
    }
    Some(SetChatOrderStateResponse {
        success: true,
        chat_id,
        order_group,
        is_pinned,
        is_archived,
        changed,
    })
}
