//! Ports `server-agents/opencode/src/agents/opencode/sse-events.ts`.

use std::{collections::VecDeque, error::Error};

use futures::{Stream, StreamExt, stream::LocalBoxStream};
use garcon_contract::chat_message_coercion::as_record;
use garcon_interface::resources::ExecutorResult;
use garcon_js::{number_to_string, to_iso_string};
use serde_json::{Map, Value};

use super::sdk_client::{OpenCodeClient, OpenCodeEnvelopes};
use crate::js::{AbortSignal, error, prop, truthy};

/// One event of the server-wide `/global/event` stream.
#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub id: Option<String>,
    pub kind: String,
    pub properties: Option<Map<String, Value>>,
}

impl SseEvent {
    /// The property `key` of the event: `null` where the original read `undefined`.
    pub(crate) fn property(&self, key: &str) -> &Value {
        prop(&self.properties, key)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenCodeAssistantTerminal {
    Finished {
        message_id: String,
    },
    Failed {
        message_id: String,
        error: Option<String>,
    },
    Aborted {
        message_id: String,
    },
}

impl OpenCodeAssistantTerminal {
    pub fn message_id(&self) -> &str {
        match self {
            OpenCodeAssistantTerminal::Finished { message_id }
            | OpenCodeAssistantTerminal::Failed { message_id, .. }
            | OpenCodeAssistantTerminal::Aborted { message_id } => message_id,
        }
    }
}

// The server-wide /global/event stream wraps each per-instance event in an envelope.
// The normalizer drops durable sync copies before they reach turn processing.
pub fn unwrap_global_event(envelope: &Value) -> Option<SseEvent> {
    let payload = prop(as_record(envelope), "payload").as_object()?;
    let kind = prop(payload, "type").as_str()?;
    if kind == "sync" {
        return None;
    }
    Some(SseEvent {
        id: prop(payload, "id").as_str().map(str::to_owned),
        kind: kind.to_owned(),
        properties: prop(payload, "properties").as_object().cloned(),
    })
}

pub async fn stream_global_events(
    client: &dyn OpenCodeClient,
    signal: &AbortSignal,
    on_connected: impl FnMut() + 'static,
) -> ExecutorResult<LocalBoxStream<'static, ExecutorResult<SseEvent>>> {
    let stream = client.global_events(signal).await?;
    let state = (stream, signal.clone(), on_connected, false);
    Ok(futures::stream::try_unfold(
        state,
        |(mut stream, signal, mut on_connected, mut connected)| async move {
            loop {
                let next = tokio::select! {
                    biased;
                    () = signal.token().cancelled() => return Err(signal.abort_reason().into()),
                    next = stream.next() => next,
                };
                let Some(envelope) = next else {
                    return Err(error(
                        "Error",
                        if connected {
                            "OpenCode event stream ended"
                        } else {
                            "OpenCode event stream ended before server.connected"
                        },
                    ));
                };
                let Some(event) = unwrap_global_event(&envelope?) else {
                    continue;
                };
                if event.kind == "server.connected" {
                    connected = true;
                    on_connected();
                    continue;
                }
                if !connected {
                    return Err(error(
                        "Error",
                        format!(
                            "OpenCode event stream emitted {} before server.connected",
                            event.kind
                        ),
                    ));
                }
                return Ok(Some((event, (stream, signal, on_connected, connected))));
            }
        },
    )
    .boxed_local())
}

// The SDK converts CRLF and CR separately on every newly decoded read. A CR
// at one chunk's end followed by LF in the next becomes two LFs there too.
pub(crate) fn read_sdk_events<T, E>(
    body: impl Stream<Item = Result<T, E>> + 'static,
    signal: AbortSignal,
) -> OpenCodeEnvelopes
where
    T: AsRef<[u8]>,
    E: Into<Box<dyn Error>>,
{
    let state = (Box::pin(body), signal, SdkEventFrames::default());
    futures::stream::try_unfold(state, |(mut body, signal, mut frames)| async move {
        loop {
            if let Some(event) = frames.ready.pop_front() {
                return Ok(Some((event, (body, signal, frames))));
            }
            let next = tokio::select! {
                biased;
                () = signal.token().cancelled() => return Err(signal.abort_reason().into()),
                next = body.next() => next,
            };
            let Some(chunk) = next else {
                return Ok(None);
            };
            frames.push(chunk.map_err(Into::into)?.as_ref());
        }
    })
    .boxed_local()
}

#[derive(Default)]
struct SdkEventFrames {
    buffer: Vec<u8>,
    checked_bom: bool,
    ready: VecDeque<Value>,
}

impl SdkEventFrames {
    fn push(&mut self, bytes: &[u8]) {
        let previous = self.buffer.len();
        let mut bytes = bytes.iter().copied().peekable();
        while let Some(byte) = bytes.next() {
            if byte == b'\r' {
                bytes.next_if_eq(&b'\n');
                self.buffer.push(b'\n');
            } else {
                self.buffer.push(byte);
            }
        }
        let mut start = 0;
        let mut index = previous.saturating_sub(1);
        if !self.checked_bom {
            if self.buffer.len() < 3 && b"\xef\xbb\xbf".starts_with(&self.buffer) {
                return;
            }
            self.checked_bom = true;
            if self.buffer.starts_with(b"\xef\xbb\xbf") {
                start = 3;
                index = 3;
            }
        }
        while index + 1 < self.buffer.len() {
            if self.buffer[index..].starts_with(b"\n\n") {
                if let Some(event) = sdk_frame_data(&self.buffer[start..index]) {
                    self.ready.push_back(event);
                }
                index += 2;
                start = index;
            } else {
                index += 1;
            }
        }
        self.buffer.drain(..start);
    }
}

fn sdk_frame_data(chunk: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(chunk);
    let lines: Vec<&str> = text
        .split('\n')
        .filter_map(|line| line.strip_prefix("data:").map(garcon_js::trim_start))
        .collect();
    if lines.is_empty() {
        return None;
    }
    let data = lines.join("\n");
    Some(garcon_js::json::parse(&data).unwrap_or_else(|_| Value::String(data)))
}

pub fn open_code_assistant_terminal(event: &SseEvent) -> Option<OpenCodeAssistantTerminal> {
    if event.kind != "message.updated" {
        return None;
    }
    let info = event.property("info").as_object()?;
    let message_id = prop(info, "id")
        .as_str()
        .filter(|id| !id.is_empty())?
        .to_owned();
    if prop(info, "role").as_str() != Some("assistant") {
        return None;
    }
    let time = prop(info, "time").as_object()?;
    if !prop(time, "completed").is_number() {
        return None;
    }

    if let Some(failure) = prop(info, "error").as_object() {
        if prop(failure, "name").as_str() == Some("MessageAbortedError") {
            return Some(OpenCodeAssistantTerminal::Aborted { message_id });
        }
        return Some(OpenCodeAssistantTerminal::Failed {
            message_id,
            error: Some(open_code_error_message(failure)),
        });
    }

    let finish = prop(info, "finish");
    if finish.as_str() == Some("error") {
        return Some(OpenCodeAssistantTerminal::Failed {
            message_id,
            error: Some("OpenCode session failed".to_owned()),
        });
    }
    if finish
        .as_str()
        .is_none_or(|finish| finish.is_empty() || finish == "tool-calls" || finish == "unknown")
    {
        return None;
    }
    Some(OpenCodeAssistantTerminal::Finished { message_id })
}

pub fn is_open_code_compaction_assistant(info: &Value) -> bool {
    info.as_object().is_some_and(is_compaction_assistant)
}

pub(crate) fn is_compaction_assistant(info: &Map<String, Value>) -> bool {
    prop(info, "role").as_str() == Some("assistant")
        && (prop(info, "summary") == &Value::Bool(true)
            || prop(info, "mode").as_str() == Some("compaction")
            || prop(info, "agent").as_str() == Some("compaction"))
}

// OpenCode marks every provider-created automatic compaction control part with auto=true.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/session/compaction.ts#L513-L536
pub fn is_open_code_compaction_control_part(event: &SseEvent) -> bool {
    compaction_part(event, false)
}

// A summarize-kicked manual compaction carries auto !== true on its control part;
// the running compaction turn adopts it to acquire its provider message identity.
pub fn is_open_code_manual_compaction_control_part(event: &SseEvent) -> bool {
    compaction_part(event, true)
}

fn compaction_part(event: &SseEvent, manual: bool) -> bool {
    if event.kind != "message.part.updated" {
        return false;
    }
    let part = event.property("part");
    part.as_object().is_some_and(|part| {
        prop(part, "type").as_str() == Some("compaction")
            && (prop(part, "auto") == &Value::Bool(true)) != manual
    })
}

// The metadata key distinguishes compaction continuation from other synthetic text parts.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/session/compaction.ts#L486-L501
pub fn is_open_code_compaction_continuation_part(event: &SseEvent) -> bool {
    if event.kind != "message.part.updated" {
        return false;
    }
    let part = event.property("part");
    let Some(part) = part.as_object() else {
        return false;
    };
    if prop(part, "type").as_str() != Some("text") || prop(part, "synthetic") != &Value::Bool(true)
    {
        return false;
    }
    prop(prop(part, "metadata"), "compaction_continue") == &Value::Bool(true)
}

/// The session an event belongs to, as the payload names it. A non-string value
/// comes back as it is, because the original returns it unchanged; `None` is
/// the original's `undefined`.
pub fn extract_session_id(event: &SseEvent) -> Option<Value> {
    let properties = &event.properties;
    let last = event.kind.starts_with("session.").then(|| {
        prop(properties, "info")
            .as_object()
            .and_then(|info| info.get("id"))
    });
    [
        prop(properties, "sessionID"),
        prop(prop(properties, "part"), "sessionID"),
        prop(prop(properties, "info"), "sessionID"),
    ]
    .into_iter()
    .find(|value| truthy(value))
    // `a || b || c` is `c` when every operand is falsy, even a defined falsy `c`.
    .or_else(|| last.flatten())
    .cloned()
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeSessionRetryStatus {
    pub attempt: f64,
    pub message: String,
    pub next_attempt_at: Option<String>,
}

// Reads the retry arm of the typed session.status union. Retry classification
// is upstream's decision; only the payload discriminant is inspected here.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/schema/src/session-status-event.ts#L9-L32
pub fn open_code_session_retry_status(
    event: &SseEvent,
) -> Result<Option<OpenCodeSessionRetryStatus>, Box<dyn Error>> {
    if event.kind != "session.status" {
        return Ok(None);
    }
    let Some(status) = event.property("status").as_object() else {
        return Ok(None);
    };
    if prop(status, "type").as_str() != Some("retry") {
        return Ok(None);
    }
    let Some(message) = prop(status, "message")
        .as_str()
        .filter(|message| !garcon_js::trim(message).is_empty())
    else {
        return Ok(None);
    };
    let attempt = number(prop(status, "attempt")).unwrap_or(0.0);
    let next_attempt_at = match number(prop(status, "next")) {
        Some(next) if next.abs() > 8_640_000_000_000_000.0 => {
            return Err(crate::js::error("RangeError", "Invalid Date"));
        }
        Some(next) => Some(
            to_iso_string(next as i64)
                .map_err(|_| crate::js::error("RangeError", "Invalid Date"))?,
        ),
        None => None,
    };
    Ok(Some(OpenCodeSessionRetryStatus {
        attempt,
        message: garcon_js::trim(message).to_owned(),
        next_attempt_at,
    }))
}

fn number(value: &Value) -> Option<f64> {
    garcon_js::json::as_number(value).filter(|value| value.is_finite())
}

pub fn open_code_retry_notice_text(retry: &OpenCodeSessionRetryStatus) -> String {
    let attempt = if retry.attempt > 0.0 {
        format!(" (attempt {})", number_to_string(retry.attempt))
    } else {
        String::new()
    };
    let message = retry.message.strip_suffix('.').unwrap_or(&retry.message);
    let next = match retry
        .next_attempt_at
        .as_deref()
        .filter(|next| !next.is_empty())
    {
        Some(next) => format!(" Next attempt at {next}."),
        None => String::new(),
    };
    format!("Model provider retrying{attempt}: {message}.{next}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCodeRetryNotice {
    pub key: String,
    pub title: String,
    pub content: String,
}

// One notice per distinct scheduled attempt: the key identifies the attempt so
// stream replays and repeated status frames do not append duplicate rows.
pub fn open_code_retry_notice(
    event: &SseEvent,
) -> Result<Option<OpenCodeRetryNotice>, Box<dyn Error>> {
    let Some(retry) = open_code_session_retry_status(event)? else {
        return Ok(None);
    };
    Ok(Some(OpenCodeRetryNotice {
        key: format!(
            "{}:{}:{}",
            number_to_string(retry.attempt),
            retry.next_attempt_at.as_deref().unwrap_or(""),
            retry.message
        ),
        title: "Provider retry".to_owned(),
        content: open_code_retry_notice_text(&retry),
    }))
}

pub fn extract_text_parts(parts: &Value) -> String {
    let Some(parts) = parts.as_array() else {
        return String::new();
    };
    let texts = parts
        .iter()
        .filter(|part| {
            prop(part, "type").as_str() == Some("text") && prop(part, "text").is_string()
        })
        .map(|part| garcon_js::trim(part["text"].as_str().unwrap_or_default()))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();
    garcon_js::trim(&texts.join("\n")).to_owned()
}

fn open_code_error_message(error: &Map<String, Value>) -> String {
    let data = prop(error, "data").as_object();
    let data_message = data
        .map(|data| prop(data, "message"))
        .and_then(|message| message.as_str().map(garcon_js::trim))
        .filter(|message| !message.is_empty());
    if let Some(message) = data_message {
        return message.to_owned();
    }
    let name = prop(error, "name")
        .as_str()
        .map(garcon_js::trim)
        .filter(|name| !name.is_empty());
    name.map_or_else(|| "OpenCode session failed".to_owned(), str::to_owned)
}
