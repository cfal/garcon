//! Ports `common/chat-id-discovery.ts`.

use garcon_js::trim;
use serde_json::Value;

use crate::chat_id::{ChatId, parse_chat_id};
use crate::transcript_notice_details::ChatIdDiscoveryFailureReason;

pub const CHAT_ID_DISCLOSURE_OPEN: &str = "<garcon-chat-id>";
pub const CHAT_ID_DISCLOSURE_CLOSE: &str = "</garcon-chat-id>";
pub const CHAT_ID_DISCOVERY_NOTICE_TITLE: &str = "Chat ID auto-discovery";

pub fn chat_id_disclosure_content(chat_id: &ChatId) -> String {
    format!("{CHAT_ID_DISCLOSURE_OPEN}{chat_id}{CHAT_ID_DISCLOSURE_CLOSE}")
}

pub fn parse_chat_id_disclosure(content: &str) -> Option<ChatId> {
    let value = trim(content)
        .strip_prefix(CHAT_ID_DISCLOSURE_OPEN)?
        .strip_suffix(CHAT_ID_DISCLOSURE_CLOSE)?;
    parse_chat_id(&Value::String(value.to_owned())).ok()
}

pub fn chat_id_disclosure_notice_content(chat_id: &ChatId) -> String {
    format!("Sent chat ID {chat_id} to agent.")
}

pub fn chat_id_discovery_failure_content(reason: ChatIdDiscoveryFailureReason) -> &'static str {
    match reason {
        ChatIdDiscoveryFailureReason::Disabled => "Chat ID auto-discovery is disabled.",
        ChatIdDiscoveryFailureReason::DeliveryFailed => {
            "Garcon could not send the chat ID to the agent."
        }
    }
}
