//! Ports `server-agents/antigravity/src/agents/antigravity/antigravity-acp-event-converter.ts`.

use std::cell::RefCell;
use std::mem;
use std::rc::Rc;

use garcon_agents_common::acp::event_converter::{
    AcpEventConverter, AcpRuntimeBoundary, AcpSessionUpdateContext, MAX_TOOL_ENTRIES_PER_SESSION,
    acp_content_text, as_object, evict_oldest_tool_entry, is_acp_terminal_tool_status,
};
use garcon_agents_common::acp::in_band_failure::{
    AcpInBandFailure, AcpSplitChunk, acp_output_update_type,
};
use garcon_contract::chat_types::{
    AssistantMessage, ChatMessage, ErrorMessage, ThinkingMessage, ToolUseChatMessage,
};
use garcon_js::{trim, trim_end};
use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value};

use crate::tool_call_snapshot::{TrackedCall, merge_call, needs_more_evidence, tool_call_result};
use crate::tool_use_converter::{antigravity_tool_call, convert_antigravity_tool_use};

const WARNING_MARKER: &str = "\n\u{26a0} ";
const EXECUTOR_MARKER: &str = "\n\u{26a0} agent executor error: ";

struct DeferredCall {
    call: TrackedCall,
    preceding: Vec<ChatMessage>,
}

struct SessionState {
    assistant_text: String,
    answer_started: bool,
    thinking_text: String,
    failure: AcpInBandFailure,
    emitted_tool_ids: IndexSet<String>,
    completed_tool_ids: IndexSet<String>,
    calls: IndexMap<String, TrackedCall>,
    permissions: IndexMap<String, TrackedCall>,
    deferred: IndexMap<String, DeferredCall>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            assistant_text: String::new(),
            answer_started: false,
            thinking_text: String::new(),
            failure: AcpInBandFailure::new(Rc::new(split_executor_error)),
            emitted_tool_ids: IndexSet::new(),
            completed_tool_ids: IndexSet::new(),
            calls: IndexMap::new(),
            permissions: IndexMap::new(),
            deferred: IndexMap::new(),
        }
    }
}

impl SessionState {
    fn has_published_call(&self, id: &str) -> bool {
        self.emitted_tool_ids.contains(id)
            || self.calls.contains_key(id)
            || self.completed_tool_ids.contains(id)
    }
}

fn remember_call(calls: &mut IndexMap<String, TrackedCall>, call: TrackedCall) {
    calls.insert(call.tool_call_id.clone(), call);
    evict_oldest_tool_entry(calls);
}

/// Agy streams upstream failures in-band; a marker quoted mid-answer is ordinary text.
pub fn split_executor_error(text: &str) -> AcpSplitChunk {
    let index = if text.starts_with(EXECUTOR_MARKER) {
        Some(0)
    } else {
        text.rfind(EXECUTOR_MARKER)
    };
    if let Some(index) = index
        && (index == 0 || !trim_end(&text[index + 1..]).contains('\n'))
    {
        return AcpSplitChunk {
            text: text[..index].to_owned(),
            failure: Some(format!(
                "Antigravity {}",
                trim(&text[index + WARNING_MARKER.len()..])
            )),
        };
    }
    AcpSplitChunk {
        text: text.to_owned(),
        failure: None,
    }
}

#[derive(Default)]
pub struct AntigravityAcpEventConverter {
    sessions: RefCell<IndexMap<String, SessionState>>,
}

impl AcpEventConverter for AntigravityAcpEventConverter {
    fn begin_turn(&self, id: &str) {
        let mut sessions = self.sessions.borrow_mut();
        let session = sessions.entry(id.to_owned()).or_default();
        session.assistant_text.clear();
        session.answer_started = false;
        session.thinking_text.clear();
        session.failure.reset();
    }

    fn permission_tool_use(
        &self,
        raw: &Map<String, Value>,
        context: &AcpSessionUpdateContext,
    ) -> Option<ToolUseChatMessage> {
        let call = antigravity_tool_call(raw)?;
        let mut sessions = self.sessions.borrow_mut();
        let session = sessions.entry(context.session_id.clone()).or_default();
        let deferred = session.deferred.get_mut(&call.tool_call_id);
        let calls = if session.calls.contains_key(&call.tool_call_id) {
            &mut session.calls
        } else {
            &mut session.permissions
        };
        let previous = deferred
            .as_ref()
            .map(|deferred| &deferred.call)
            .or_else(|| calls.get(&call.tool_call_id));
        let mut resolved = merge_call(previous, call, None);
        if let Some(deferred) = deferred {
            deferred.call = resolved.clone();
        } else {
            remember_call(calls, resolved.clone());
        }
        // A provisional display title is not evidence of what the user is approving.
        resolved.plan_title = None;
        Some(convert_antigravity_tool_use(&context.timestamp, &resolved))
    }

    fn from_session_update(
        &self,
        notification: &Map<String, Value>,
        context: &AcpSessionUpdateContext,
    ) -> Vec<ChatMessage> {
        let update = as_object(notification.get("update").unwrap_or(&Value::Null));
        let mut sessions = self.sessions.borrow_mut();
        let session = sessions.entry(context.session_id.clone()).or_default();
        let output_type = acp_output_update_type(update, |id| {
            session.has_published_call(id)
                || session.deferred.contains_key(id)
                || session.permissions.contains_key(id)
        });
        let restored = session.failure.continue_on(output_type.as_deref());
        let timestamp = &context.timestamp;
        let mut messages = if restored.is_empty() {
            Vec::new()
        } else {
            append_answer(session, &restored, timestamp)
        };
        let content = || acp_content_text(update.get("content").unwrap_or(&Value::Null));
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message" | "agent_message_chunk") => {
                let text = session.failure.offer(&content());
                messages.extend(append_answer(session, &text, timestamp));
            }
            Some("agent_thought_chunk") => session.thinking_text.push_str(&content()),
            Some("tool_call" | "tool_call_update") => {
                messages.extend(tool_call_update(session, update, timestamp))
            }
            _ => {}
        }
        messages
    }

    fn end_turn(&self, id: &str, context: &AcpSessionUpdateContext) -> Vec<ChatMessage> {
        let mut sessions = self.sessions.borrow_mut();
        let Some(session) = sessions.get_mut(id) else {
            return Vec::new();
        };
        let timestamp = &context.timestamp;
        let mut rows = emit_deferred(session, timestamp, None);
        rows.extend(flush(session, timestamp));
        if let Some(content) = session.failure.take().filter(|text| !text.is_empty()) {
            rows.push(ChatMessage::Error(ErrorMessage {
                timestamp: timestamp.clone(),
                content,
            }));
        }
        rows
    }

    fn release_session(&self, id: &str) {
        self.sessions.borrow_mut().shift_remove(id);
    }

    fn flush_pending(
        &self,
        context: &AcpSessionUpdateContext,
        boundary: &AcpRuntimeBoundary,
    ) -> Vec<ChatMessage> {
        let mut sessions = self.sessions.borrow_mut();
        let Some(session) = sessions
            .get_mut(&context.session_id)
            .filter(|session| !session.deferred.is_empty())
        else {
            return Vec::new();
        };
        let id = match boundary {
            AcpRuntimeBoundary::Stderr => return emit_deferred(session, &context.timestamp, None),
            AcpRuntimeBoundary::PermissionRequest { tool_call_id }
            | AcpRuntimeBoundary::PermissionSettlement { tool_call_id } => tool_call_id,
        };
        if session.has_published_call(id) {
            return Vec::new();
        }
        let mut rows = emit_deferred(session, &context.timestamp, Some(id));
        if let Some(target) = session.deferred.get_mut(id) {
            rows.append(&mut target.preceding);
        } else if matches!(boundary, AcpRuntimeBoundary::PermissionRequest { .. }) {
            rows.extend(flush(session, &context.timestamp));
        }
        rows
    }

    fn take_turn_failure(&self, id: &str) -> Option<String> {
        self.sessions.borrow_mut().get_mut(id)?.failure.take()
    }
}

fn tool_call_update(
    session: &mut SessionState,
    update: &Map<String, Value>,
    timestamp: &str,
) -> Vec<ChatMessage> {
    let Some(parsed) = antigravity_tool_call(update)
        .filter(|parsed| !session.completed_tool_ids.contains(&parsed.tool_call_id))
    else {
        return Vec::new();
    };
    let id = parsed.tool_call_id.clone();
    let status = update
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let terminal = is_acp_terminal_tool_status(status);
    let previous = session
        .deferred
        .get(&id)
        .map(|pending| &pending.call)
        .or_else(|| session.calls.get(&id))
        .or_else(|| session.permissions.get(&id))
        .cloned();
    let call = merge_call(previous.as_ref(), parsed, Some(update));
    session.permissions.shift_remove(&id);
    let mut messages = Vec::new();
    if !session.has_published_call(&id) {
        let row = convert_antigravity_tool_use(timestamp, &call);
        if !terminal && needs_more_evidence(&call, &row) {
            if let Some(pending) = session.deferred.get_mut(&id) {
                pending.call = call;
                return Vec::new();
            }
            return defer_call(session, call, timestamp);
        }
        messages.extend(emit_deferred(session, timestamp, Some(&id)));
        match session.deferred.shift_remove(&id) {
            Some(pending) => messages.extend(pending.preceding),
            None => messages.extend(flush(session, timestamp)),
        }
        messages.push(ChatMessage::ToolUse(row));
        remember(&mut session.emitted_tool_ids, id.clone());
    }
    if !terminal {
        remember_call(&mut session.calls, call);
        return messages;
    }
    messages.extend(emit_deferred(session, timestamp, None));
    messages.extend(flush(session, timestamp));
    remember(&mut session.completed_tool_ids, id.clone());
    session.calls.shift_remove(&id);
    messages.push(ChatMessage::ToolResult(tool_call_result(
        timestamp,
        &call,
        update,
        status,
        previous.as_ref(),
    )));
    messages
}

fn defer_call(session: &mut SessionState, call: TrackedCall, timestamp: &str) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    if session.deferred.len() >= MAX_TOOL_ENTRIES_PER_SESSION
        && let Some((_, pending)) = session.deferred.shift_remove_index(0)
    {
        messages.extend(publish_deferred(session, timestamp, pending));
    }
    let mut preceding = flush(session, timestamp);
    if session.deferred.is_empty() {
        messages.append(&mut preceding);
    }
    session
        .deferred
        .insert(call.tool_call_id.clone(), DeferredCall { call, preceding });
    messages
}

fn emit_deferred(
    session: &mut SessionState,
    timestamp: &str,
    before_id: Option<&str>,
) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    while let Some((id, _)) = session.deferred.first() {
        if Some(id.as_str()) == before_id {
            break;
        }
        if let Some((_, pending)) = session.deferred.shift_remove_index(0) {
            messages.extend(publish_deferred(session, timestamp, pending));
        }
    }
    messages
}

fn publish_deferred(
    session: &mut SessionState,
    timestamp: &str,
    pending: DeferredCall,
) -> Vec<ChatMessage> {
    let DeferredCall {
        call,
        mut preceding,
    } = pending;
    remember(&mut session.emitted_tool_ids, call.tool_call_id.clone());
    preceding.push(ChatMessage::ToolUse(convert_antigravity_tool_use(
        timestamp, &call,
    )));
    remember_call(&mut session.calls, call);
    preceding
}

fn remember(ids: &mut IndexSet<String>, id: String) {
    ids.insert(id);
    evict_oldest_tool_entry(ids);
}

fn append_answer(session: &mut SessionState, text: &str, timestamp: &str) -> Vec<ChatMessage> {
    session.assistant_text.push_str(text);
    if session.answer_started || trim(text).is_empty() {
        return Vec::new();
    }
    session.answer_started = true;
    if session.deferred.is_empty() {
        flush_thinking(session, timestamp)
    } else {
        Vec::new()
    }
}

fn flush_thinking(session: &mut SessionState, timestamp: &str) -> Vec<ChatMessage> {
    let content = mem::take(&mut session.thinking_text);
    if trim(&content).is_empty() {
        return Vec::new();
    }
    vec![ChatMessage::Thinking(ThinkingMessage {
        timestamp: timestamp.to_owned(),
        content,
    })]
}

fn flush(session: &mut SessionState, timestamp: &str) -> Vec<ChatMessage> {
    let mut messages = flush_thinking(session, timestamp);
    let content = mem::take(&mut session.assistant_text);
    if mem::take(&mut session.answer_started) {
        messages.push(ChatMessage::Assistant(AssistantMessage {
            timestamp: timestamp.to_owned(),
            content,
            questions: None,
        }));
    }
    messages
}
