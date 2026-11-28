//! Ports `common/chat-order-sort.ts`.

use garcon_js::date_parse::date_parse;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat_id::{CHAT_ID_LENGTH, chat_id_created_at};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatOrderSortKey {
    Created,
    Activity,
}

pub const CHAT_ORDER_SORT_KEYS: &[ChatOrderSortKey] =
    &[ChatOrderSortKey::Created, ChatOrderSortKey::Activity];

pub fn is_chat_order_sort_key(value: &Value) -> Option<ChatOrderSortKey> {
    match value.as_str()? {
        "created" => Some(ChatOrderSortKey::Created),
        "activity" => Some(ChatOrderSortKey::Activity),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOrderTimestamps {
    pub id: String,
    pub created_at: Option<String>,
    pub last_activity_at: Option<String>,
}

pub type ChatOrderIdComparator<'a> = dyn Fn(&str, &str) -> f64 + 'a;

fn chat_id_time_ms(id: &str) -> Option<i64> {
    if id.len() != CHAT_ID_LENGTH || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    chat_id_created_at(id).ok()
}

pub fn chat_creation_time_ms(chat: &ChatOrderTimestamps) -> i64 {
    chat.created_at
        .as_deref()
        .and_then(date_parse)
        .or_else(|| chat_id_time_ms(&chat.id))
        .unwrap_or_default()
}

pub fn chat_activity_time_ms(chat: &ChatOrderTimestamps) -> i64 {
    let last_activity = chat
        .last_activity_at
        .as_deref()
        .and_then(date_parse)
        .unwrap_or_default();
    let created = chat
        .created_at
        .as_deref()
        .and_then(date_parse)
        .unwrap_or_default();
    let id = chat_id_time_ms(&chat.id).unwrap_or_default();
    last_activity.max(created).max(id)
}

pub fn compare_chat_order_newest_first(
    sort_key: ChatOrderSortKey,
) -> impl Fn(&ChatOrderTimestamps, &ChatOrderTimestamps) -> f64 {
    let time_for = match sort_key {
        ChatOrderSortKey::Created => chat_creation_time_ms,
        ChatOrderSortKey::Activity => chat_activity_time_ms,
    };
    move |left, right| time_for(right) as f64 - time_for(left) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_equal_ranks_stable() {
        let mut chats = ["z", "a", "c"].map(|id| ChatOrderTimestamps {
            id: id.to_owned(),
            created_at: None,
            last_activity_at: None,
        });
        let compare = compare_chat_order_newest_first(ChatOrderSortKey::Created);
        chats.sort_by(|left, right| compare(left, right).total_cmp(&0.0));
        assert_eq!(chats.map(|chat| chat.id), ["z", "a", "c"]);
    }
}
