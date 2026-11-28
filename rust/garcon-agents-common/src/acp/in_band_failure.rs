//! Ports `server-agents/common/src/acp/in-band-failure.ts`.
//!
//! Agents such as Antigravity report some failures as a marked message chunk
//! and then end the turn normally. The chunk counts as a failure only if
//! nothing follows it before the turn ends; any further output means the
//! chunk was ordinary text that quoted the marker.

use std::rc::Rc;

use garcon_js::utf16;
use serde_json::{Map, Value};

use super::event_converter::{acp_content_text, as_object, as_string};

/// What a splitter reads in a message chunk: its text and the failure it reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpSplitChunk {
    pub text: String,
    pub failure: Option<String>,
}

/// Splits a message chunk into its text and an in-band failure it reports.
pub type AcpFailureSplitter = Rc<dyn Fn(&str) -> AcpSplitChunk>;

const TEXT_OUTPUT_UPDATES: [&str; 3] = [
    "agent_message_chunk",
    "agent_message",
    "agent_thought_chunk",
];

/// Text and new calls disprove a candidate failure; progress on a known tool
/// can arrive after one.
pub const ACP_NEW_OUTPUT_UPDATES: [&str; 4] = [
    "agent_message_chunk",
    "agent_message",
    "agent_thought_chunk",
    "tool_call",
];

pub fn is_acp_new_output_update(update_type: &str) -> bool {
    ACP_NEW_OUTPUT_UPDATES.contains(&update_type)
}

fn is_empty_text(content: &Value) -> bool {
    match content {
        Value::Array(items) => items.iter().all(is_empty_text),
        Value::String(text) if text.is_empty() => true,
        _ => {
            as_object(content).get("type").and_then(Value::as_str) == Some("text")
                && acp_content_text(content).is_empty()
        }
    }
}

/// The update type that new-output checks see: a tool_call_update reports on
/// an earlier call, except when it is the first frame of a call.
pub fn acp_output_update_type(
    update: &Map<String, Value>,
    is_known_call: impl Fn(&str) -> bool,
) -> Option<String> {
    let update_type = update.get("sessionUpdate").and_then(as_string);
    if update_type.is_some_and(|kind| TEXT_OUTPUT_UPDATES.contains(&kind))
        && is_empty_text(update.get("content").unwrap_or(&Value::Null))
    {
        return None;
    }
    let update_type = update_type?;
    if update_type != "tool_call_update" {
        return Some(update_type.to_owned());
    }
    // Without a call id the update reports on an earlier call as well.
    let earlier_call = match update.get("toolCallId").and_then(as_string) {
        None | Some("") => true,
        Some(tool_call_id) => is_known_call(tool_call_id),
    };
    Some(
        if earlier_call {
            update_type
        } else {
            "tool_call"
        }
        .to_owned(),
    )
}

pub struct AcpInBandFailure {
    split: AcpFailureSplitter,
    pending: Option<(String, String)>,
}

impl AcpInBandFailure {
    pub fn new(split: AcpFailureSplitter) -> Self {
        Self {
            split,
            pending: None,
        }
    }

    /// Returns held-back text that turned out to be ordinary output, or ''.
    pub fn continue_on(&mut self, update_type: Option<&str>) -> String {
        let Some((_, text)) = self.pending.as_ref() else {
            return String::new();
        };
        if !update_type.is_some_and(is_acp_new_output_update) {
            return String::new();
        }
        let text = text.clone();
        self.pending = None;
        text
    }

    /// Returns the chunk's text to publish now; a candidate failure is held back.
    pub fn offer(&mut self, chunk: &str) -> String {
        let split = (self.split)(chunk);
        // An empty failure is no failure.
        if let Some(failure) = split.failure.filter(|failure| !failure.is_empty()) {
            let held = utf16::slice(chunk, utf16::len(&split.text) as isize, None).to_owned();
            self.pending = Some((failure, held));
        }
        split.text
    }

    pub fn take(&mut self) -> Option<String> {
        let failure = self.pending.as_ref().map(|(failure, _)| failure.clone());
        self.pending = None;
        failure
    }

    pub fn reset(&mut self) {
        self.pending = None;
    }
}
