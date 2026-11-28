use garcon_interface::producer::AgentFinalResponse;
use garcon_js::{
    Number,
    json::{Opaque, as_number},
    trim,
};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeApiRetryDiagnostics {
    pub attempt: Option<Number>,
    pub max_retries: Option<Number>,
    pub delay_ms: Option<Number>,
    pub error_status: Option<Opaque>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClaudeTurnStartSource {
    Lifecycle,
    Replay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClaudeTurnTerminalState {
    Completed,
    Cancelled,
    Discarded,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClaudeTurnPhase {
    #[default]
    Submitted,
    Started,
    Interrupting,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeProviderSessionState {
    #[default]
    Unknown,
    Running,
    RequiresAction,
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeReportedSessionState {
    Running,
    RequiresAction,
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClaudeTurnInputEvent {
    Started { source: ClaudeTurnStartSource },
    TerminalBeforeStart { state: ClaudeTurnTerminalState },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClaudeResultCorrelation {
    BeforeStart,
    Input,
    Continuation,
    Mismatched,
}

fn text(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| !value.is_empty())
}

fn utf16_prefix(value: &str, limit: usize) -> String {
    String::from_utf16_lossy(&value.encode_utf16().take(limit).collect::<Vec<_>>())
}

fn scalar_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        text.to_owned()
    } else if let Some(number) = as_number(value) {
        garcon_js::number_to_string(number)
    } else {
        value.to_string()
    }
}

pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(_) => {
            as_number(value).is_some_and(|number| number != 0.0 && !number.is_nan())
        }
        Value::Array(_) | Value::Object(_) => true,
    }
}

// Mirrors CLI-raised errors[] and API-failed success frames in the SDK.
// https://github.com/anthropics/claude-agent-sdk-python/blob/a8b1e285/src/claude_agent_sdk/_internal/query.py#L55-L80
pub fn claude_result_failure_message(message: &Value) -> String {
    let errors: Vec<_> = message["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(trim)
        .filter(|line| !line.is_empty() && !line.starts_with("[ede_diagnostic]"))
        .collect();
    if !errors.is_empty() {
        return utf16_prefix(&errors.join("\n"), 4_000);
    }
    if let Some(result) = message["result"]
        .as_str()
        .map(trim)
        .filter(|text| !text.is_empty())
    {
        return utf16_prefix(result, 4_000);
    }
    let outcome = text(&message["subtype"])
        .filter(|outcome| *outcome != "success")
        .or_else(|| text(&message["terminal_reason"]))
        .unwrap_or("unknown error");
    let status = &message["api_error_status"];
    if status.is_null() {
        format!("Claude CLI turn failed: {outcome}")
    } else {
        format!(
            "Claude CLI turn failed: {outcome} (API status {})",
            scalar_text(status)
        )
    }
}

pub fn claude_provider_session_state(message: &Value) -> Option<ClaudeReportedSessionState> {
    if message["type"] != "system" || message["subtype"] != "session_state_changed" {
        return None;
    }
    match message["state"].as_str()? {
        "running" => Some(ClaudeReportedSessionState::Running),
        "requires_action" => Some(ClaudeReportedSessionState::RequiresAction),
        "idle" => Some(ClaudeReportedSessionState::Idle),
        _ => None,
    }
}

pub fn claude_background_task_count(message: &Value) -> Option<usize> {
    if message["type"] != "system" || message["subtype"] != "background_tasks_changed" {
        return None;
    }
    Some(message["tasks"].as_array()?.len())
}

pub struct ClaudeTurnState {
    pub final_response: Option<AgentFinalResponse>,
    pub input_uuid: String,
    phase: ClaudeTurnPhase,
    input_started: bool,
    output_message_count: usize,
    assistant_content_seen: bool,
    assistant_content_version: usize,
    last_result_assistant_content_version: usize,
    accepted_result_count: usize,
    result_failure: Option<String>,
    clean_abort_result_seen: bool,
    background_continuation_pending: bool,
    background_task_count: usize,
    last_api_retry: Option<ClaudeApiRetryDiagnostics>,
    result_before_start: Option<Opaque>,
}

impl ClaudeTurnState {
    pub fn new(input_uuid: String, background_task_count: usize) -> Self {
        Self {
            final_response: None,
            input_uuid,
            phase: ClaudeTurnPhase::Submitted,
            input_started: false,
            output_message_count: 0,
            assistant_content_seen: false,
            assistant_content_version: 0,
            last_result_assistant_content_version: 0,
            accepted_result_count: 0,
            result_failure: None,
            clean_abort_result_seen: false,
            background_continuation_pending: background_task_count > 0,
            background_task_count,
            last_api_retry: None,
            result_before_start: None,
        }
    }

    pub fn phase(&self) -> ClaudeTurnPhase {
        self.phase
    }
    pub fn input_started(&self) -> bool {
        self.input_started
    }
    pub fn abort_requested(&self) -> bool {
        self.phase == ClaudeTurnPhase::Interrupting
    }
    pub fn output_message_count(&self) -> usize {
        self.output_message_count
    }
    pub fn assistant_content_seen(&self) -> bool {
        self.assistant_content_seen
    }
    pub fn assistant_content_since_last_result(&self) -> bool {
        self.assistant_content_version > self.last_result_assistant_content_version
    }
    pub fn has_accepted_result(&self) -> bool {
        self.accepted_result_count > 0
    }
    pub fn clean_abort_result_seen(&self) -> bool {
        self.clean_abort_result_seen
    }
    pub fn background_continuation_pending(&self) -> bool {
        self.background_continuation_pending
    }
    pub fn recorded_result_failure_message(&self) -> Option<&str> {
        self.result_failure.as_deref()
    }

    pub fn observe_input(&mut self, message: &Value) -> Option<ClaudeTurnInputEvent> {
        if self.input_started {
            return None;
        }
        let command = message["type"] == "command_lifecycle"
            && message["command_uuid"].as_str() == Some(&self.input_uuid);
        let started = if command && message["state"] == "started" {
            Some(ClaudeTurnStartSource::Lifecycle)
        } else if message["type"] == "user"
            && message["isReplay"] == true
            && message["uuid"].as_str() == Some(&self.input_uuid)
        {
            Some(ClaudeTurnStartSource::Replay)
        } else {
            None
        };
        if let Some(source) = started {
            self.input_started = true;
            if !self.abort_requested() {
                self.phase = ClaudeTurnPhase::Started;
            }
            self.result_before_start = None;
            return Some(ClaudeTurnInputEvent::Started { source });
        }
        if command {
            let state = match message["state"].as_str()? {
                "completed" => ClaudeTurnTerminalState::Completed,
                "cancelled" => ClaudeTurnTerminalState::Cancelled,
                "discarded" => ClaudeTurnTerminalState::Discarded,
                _ => return None,
            };
            return Some(ClaudeTurnInputEvent::TerminalBeforeStart { state });
        }
        None
    }

    pub fn mark_abort_requested(&mut self) {
        self.phase = ClaudeTurnPhase::Interrupting;
    }
    pub fn mark_abort_rejected(&mut self) {
        self.phase = if self.input_started {
            ClaudeTurnPhase::Started
        } else {
            ClaudeTurnPhase::Submitted
        };
    }
    pub fn observe_background_task_count(&mut self, count: usize) {
        self.background_task_count = count;
        if count > 0 {
            self.background_continuation_pending = true;
        }
    }
    pub fn clear_recorded_result_failure(&mut self) {
        self.result_failure = None;
    }
    pub fn record_result_before_start(&mut self, message: Opaque) {
        if !self.input_started {
            self.result_before_start = Some(message);
        }
    }
    pub fn take_result_before_start(&mut self) -> Option<Opaque> {
        self.result_before_start.take()
    }
    pub fn add_output_messages(&mut self, count: usize, assistant_content_seen: bool) {
        self.output_message_count += count;
        self.assistant_content_seen |= assistant_content_seen;
        if assistant_content_seen {
            self.assistant_content_version += 1;
        }
    }

    pub fn record_api_retry(&mut self, message: &Value) -> ClaudeApiRetryDiagnostics {
        let retry = ClaudeApiRetryDiagnostics {
            attempt: as_number(&message["attempt"]).map(Number),
            max_retries: as_number(&message["max_retries"]).map(Number),
            delay_ms: as_number(&message["retry_delay_ms"]).map(Number),
            error_status: message
                .get("error_status")
                .filter(|status| !status.is_null())
                .cloned()
                .map(Opaque::from_value),
            error: message["error"]
                .as_str()
                .map(|error| utf16_prefix(error, 200)),
        };
        if self.input_started {
            self.last_api_retry = Some(retry.clone());
        }
        retry
    }

    pub fn correlate_result(&self, message: &Value) -> ClaudeResultCorrelation {
        if !self.input_started {
            return ClaudeResultCorrelation::BeforeStart;
        }
        if self.has_accepted_result() {
            return ClaudeResultCorrelation::Continuation;
        }
        // A merged result's singular UUID may name only its last input.
        // https://github.com/anthropics/claude-agent-sdk-python/blob/3184360393a92ca8a6ec7bbbdee571afd1ce1c56/src/claude_agent_sdk/types.py#L1805-L1824
        let singular = &message["user_message_uuid"];
        let inputs = message["user_message_uuids"]
            .as_array()
            .map_or(&[][..], Vec::as_slice);
        if (!truthy(singular) && inputs.is_empty())
            || singular.as_str() == Some(&self.input_uuid)
            || inputs
                .iter()
                .any(|input| input.as_str() == Some(&self.input_uuid))
        {
            ClaudeResultCorrelation::Input
        } else {
            ClaudeResultCorrelation::Mismatched
        }
    }

    pub fn record_accepted_result(&mut self, message: &Value) {
        let is_error = truthy(&message["is_error"]);
        self.final_response = (!is_error)
            .then(|| message["result"].as_str())
            .flatten()
            .map(|text| AgentFinalResponse::Text {
                text: text.to_owned(),
            });
        let continuation = self.has_accepted_result();
        self.accepted_result_count += 1;
        self.last_result_assistant_content_version = self.assistant_content_version;
        // The empty snapshot precedes its notification; a continuation result proves consumption.
        if continuation && self.background_continuation_pending && self.background_task_count == 0 {
            self.background_continuation_pending = false;
        }
        if !is_error {
            return;
        }
        if self.abort_requested()
            && matches!(
                message["terminal_reason"].as_str(),
                Some("aborted_streaming" | "aborted_tools")
            )
        {
            self.clean_abort_result_seen = true;
            return;
        }
        if self.result_failure.is_none() {
            self.result_failure = Some(claude_result_failure_message(message));
        }
    }

    pub fn settlement_failure_message(&self) -> Option<String> {
        if let Some(error) = self.result_failure.as_ref() {
            return Some(error.clone());
        }
        if self.clean_abort_result_seen || self.assistant_content_seen {
            return None;
        }
        Some(self.empty_completion_failure_message())
    }

    pub fn empty_completion_failure_message(&self) -> String {
        let base = "Claude CLI completed the submitted message without producing a response.";
        let Some(retry) = &self.last_api_retry else {
            return base.to_owned();
        };
        let status = retry.error_status.as_ref().map_or_else(
            || "unknown status".to_owned(),
            |status| scalar_text(status.as_value()),
        );
        let error = retry
            .error
            .as_deref()
            .filter(|text| !text.is_empty())
            .map_or_else(String::new, |suffix| format!(" {suffix}"));
        let attempt = retry
            .attempt
            .map_or_else(String::new, |attempt| match retry.max_retries {
                Some(max) => format!(
                    " (attempt {}/{})",
                    attempt.to_js_string(),
                    max.to_js_string()
                ),
                None => format!(" (attempt {})", attempt.to_js_string()),
            });
        format!("{base} Last API retry: {status}{error}{attempt}.")
    }
}

// Subagent content belongs to a separate native JSONL.
// https://github.com/anthropics/claude-agent-sdk-python/blob/a39c96edf8cc414e640620ff3360f17475db0bd9/src/claude_agent_sdk/_internal/sessions.py#L1328-L1344
pub fn is_claude_subagent_content(message: &Value) -> bool {
    matches!(message["type"].as_str(), Some("assistant" | "user"))
        && text(&message["parent_tool_use_id"]).is_some()
}

#[cfg(test)]
mod tests;
