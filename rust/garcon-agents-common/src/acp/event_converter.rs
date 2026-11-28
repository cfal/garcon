//! Ports `server-agents/common/src/acp/event-converter.ts`.

use std::borrow::Cow;
use std::hash::BuildHasher;
use std::rc::Rc;
use std::sync::LazyLock;

use garcon_contract::chat_command_contracts::PermissionDecisionPayload;
use garcon_contract::chat_types::{ChatMessage, ToolUseChatMessage};
use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value};

use super::protocol::AcpSessionUpdateNotification;

#[derive(Debug, Clone, PartialEq)]
pub struct AcpSessionUpdateContext {
    pub chat_id: String,
    pub session_id: String,
    pub timestamp: String,
}

/// A request of another method the agent needs answered before it goes on.
pub struct AcpCustomRequest<'a> {
    pub method: &'a str,
    pub permission_occurrence_id: &'a str,
    pub params: &'a Value,
}

/// Why a permission request, a turn, or a session ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpRetireReason {
    Cancelled,
    SessionComplete,
    Aborted,
}

impl AcpRetireReason {
    /// The name the original passes as a string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::SessionComplete => "session-complete",
            Self::Aborted => "aborted",
        }
    }
}

/// A request the runtime holds for the user's answer.
pub struct AcpBlockingRequestToolUse {
    pub tool: ToolUseChatMessage,
    pub response_for_decision: Rc<dyn Fn(&PermissionDecisionPayload) -> Value>,
    pub response_for_cancellation: Rc<dyn Fn(AcpRetireReason) -> Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcpRuntimeBoundary {
    Stderr,
    PermissionRequest { tool_call_id: String },
    PermissionSettlement { tool_call_id: String },
}

pub trait AcpEventConverter {
    fn begin_turn(&self, _session_id: &str) {}
    #[expect(
        clippy::wrong_self_convention,
        reason = "keeps the original's name, fromSessionUpdate"
    )]
    fn from_session_update(
        &self,
        notification: &AcpSessionUpdateNotification,
        context: &AcpSessionUpdateContext,
    ) -> Vec<ChatMessage>;
    fn permission_tool_use(
        &self,
        _tool_call: &Map<String, Value>,
        _context: &AcpSessionUpdateContext,
    ) -> Option<ToolUseChatMessage> {
        None
    }
    fn custom_request_tool_use(
        &self,
        _request: &AcpCustomRequest<'_>,
        _context: &AcpSessionUpdateContext,
    ) -> Option<AcpBlockingRequestToolUse> {
        None
    }
    // Publishes earlier pending rows without settling the turn or the call awaiting approval.
    fn flush_pending(
        &self,
        _context: &AcpSessionUpdateContext,
        _boundary: &AcpRuntimeBoundary,
    ) -> Vec<ChatMessage> {
        Vec::new()
    }
    fn end_turn(&self, _session_id: &str, _context: &AcpSessionUpdateContext) -> Vec<ChatMessage> {
        Vec::new()
    }
    // Returns and clears a failure the agent reported in-band before ending the turn normally.
    fn take_turn_failure(&self, _session_id: &str) -> Option<String> {
        None
    }
    // Drops per-session state once the runtime retires the session.
    fn release_session(&self, _session_id: &str) {}
}

/// Tool call statuses that settle a call; every one but `completed` is an error.
pub const ACP_TERMINAL_TOOL_STATUSES: [&str; 5] =
    ["completed", "failed", "errored", "rejected", "cancelled"];

pub fn is_acp_terminal_tool_status(status: &str) -> bool {
    ACP_TERMINAL_TOOL_STATUSES.contains(&status)
}

/// Bounds a converter's per-session tool collections; the oldest entry goes first.
pub const MAX_TOOL_ENTRIES_PER_SESSION: usize = 512;

/// A converter's per-session collection: a set of tool ids or a map keyed by them.
pub trait ToolEntries {
    fn entry_count(&self) -> usize;
    fn first_key(&self) -> Option<String>;
    fn remove(&mut self, key: &str);
}

impl<S: BuildHasher> ToolEntries for IndexSet<String, S> {
    fn entry_count(&self) -> usize {
        self.len()
    }

    fn first_key(&self) -> Option<String> {
        self.first().cloned()
    }

    fn remove(&mut self, key: &str) {
        self.shift_remove(key);
    }
}

impl<V, S: BuildHasher> ToolEntries for IndexMap<String, V, S> {
    fn entry_count(&self) -> usize {
        self.len()
    }

    fn first_key(&self) -> Option<String> {
        self.keys().next().cloned()
    }

    fn remove(&mut self, key: &str) {
        self.shift_remove(key);
    }
}

pub fn evict_oldest_tool_entry(entries: &mut impl ToolEntries) {
    if entries.entry_count() <= MAX_TOOL_ENTRIES_PER_SESSION {
        return;
    }
    if let Some(oldest) = entries.first_key() {
        entries.remove(&oldest);
    }
}

static EMPTY_OBJECT: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);

pub fn as_object(value: &Value) -> &Map<String, Value> {
    match value {
        Value::Object(entries) => entries,
        _ => &EMPTY_OBJECT,
    }
}

pub fn as_string(value: &Value) -> Option<&str> {
    value.as_str()
}

/// Text of an ACP content block, a bare string, or a list of either.
pub fn acp_content_text(value: &Value) -> Cow<'_, str> {
    match value {
        Value::String(text) => Cow::Borrowed(text),
        Value::Array(items) => Cow::Owned(items.iter().map(acp_content_text).collect()),
        _ => {
            let raw = as_object(value);
            let candidate = ["text", "content", "delta"]
                .into_iter()
                .find_map(|key| raw.get(key).filter(|value| !value.is_null()));
            Cow::Borrowed(candidate.and_then(Value::as_str).unwrap_or(""))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_object_is_returned_itself_and_any_other_value_as_empty() {
        let object = json!({"a": 1});
        assert!(std::ptr::eq(
            as_object(&object),
            object.as_object().unwrap()
        ));
        for other in [Value::Null, json!([]), json!("text"), json!(1), json!(true)] {
            assert!(as_object(&other).is_empty());
        }
    }

    #[test]
    fn evicting_keeps_the_order_and_the_values_of_a_map() {
        let keys = |count: usize| {
            (0..count)
                .map(|index| (format!("call-{index}"), index))
                .collect::<Vec<_>>()
        };
        let mut entries: IndexMap<String, usize> = keys(513).into_iter().collect();
        evict_oldest_tool_entry(&mut entries);
        assert_eq!(entries.len(), MAX_TOOL_ENTRIES_PER_SESSION);
        assert_eq!(entries.keys().next().map(String::as_str), Some("call-1"));
        assert_eq!(entries.get("call-512"), Some(&512));
        evict_oldest_tool_entry(&mut entries);
        assert_eq!(entries.len(), MAX_TOOL_ENTRIES_PER_SESSION);

        let mut entries: IndexSet<String> = keys(514).into_iter().map(|(key, _)| key).collect();
        evict_oldest_tool_entry(&mut entries);
        assert_eq!(entries.len(), 513);
        assert_eq!(entries.first().map(String::as_str), Some("call-1"));
    }

    #[test]
    fn terminal_statuses_and_retire_reasons_keep_their_names() {
        for status in ["completed", "failed", "errored", "rejected", "cancelled"] {
            assert!(is_acp_terminal_tool_status(status));
        }
        for status in ["", "pending", "in_progress", "Completed"] {
            assert!(!is_acp_terminal_tool_status(status));
        }
        assert_eq!(AcpRetireReason::Cancelled.as_str(), "cancelled");
        assert_eq!(
            AcpRetireReason::SessionComplete.as_str(),
            "session-complete"
        );
        assert_eq!(AcpRetireReason::Aborted.as_str(), "aborted");
    }
}
