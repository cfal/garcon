//! Ports `common/chat-activity.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatActivityStatus {
    Working,
    Complete,
    Error,
    PendingUserAction,
}

pub const CHAT_ACTIVITY_STATUSES: &[ChatActivityStatus] = &[
    ChatActivityStatus::Working,
    ChatActivityStatus::Complete,
    ChatActivityStatus::Error,
    ChatActivityStatus::PendingUserAction,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRunOutcome {
    Finished,
    Failed,
    Interrupted,
}

pub fn is_chat_activity_status(value: &Value) -> Option<ChatActivityStatus> {
    match value.as_str()? {
        "working" => Some(ChatActivityStatus::Working),
        "complete" => Some(ChatActivityStatus::Complete),
        "error" => Some(ChatActivityStatus::Error),
        "pending-user-action" => Some(ChatActivityStatus::PendingUserAction),
        _ => None,
    }
}
