//! Ports `common/terminal.ts`.

use std::fmt;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use garcon_js::{Number, is_integer, trim, utf16};

use crate::executors::is_executor_id;

pub const TERMINAL_SESSION_LIMIT: usize = 8;
pub const TERMINAL_REQUEST_ID_MAX_BYTES: usize = 256;
pub const TERMINAL_ID_MAX_BYTES: usize = 256;
pub const TERMINAL_MAX_INPUT_BYTES: usize = 64 * 1024;
pub const TERMINAL_TITLE_MAX_LENGTH: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalProcessStatus {
    Running,
    Exited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalServerAttachmentStatus {
    Attached,
    Detached,
}

/// One terminal as the server keeps it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMetadata {
    pub terminal_id: String,
    pub display_sequence: Number,
    pub title: Option<String>,
    pub initial_working_directory: String,
    pub process_status: TerminalProcessStatus,
    pub attachment_status: TerminalServerAttachmentStatus,
    pub created_at: String,
    pub exit_code: Option<Number>,
    pub latest_output_sequence: Number,
}

/// A piece of terminal output, as UTF-8 text.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputChunk {
    pub sequence: Number,
    pub data: String,
}

/// A piece of terminal output in base64, which keeps a split multi-byte
/// character intact.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEncodedOutputChunk {
    pub sequence: Number,
    pub data_base64: String,
}

/// A request to create a terminal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateRequest {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_terminal_runtime_id: Option<String>,
    pub requested_initial_working_directory: Option<String>,
}

/// A request to terminate a terminal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTerminateRequest {
    pub terminal_id: String,
    pub request_id: String,
}

/// A request to rename a terminal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRenameRequest {
    pub terminal_id: String,
    pub title: Option<String>,
}

/// The terminals of an executor.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalListResponse {
    pub success: bool,
    pub terminals: Vec<TerminalMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_runtime_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment_epoch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateResponse {
    pub success: bool,
    pub terminal: TerminalMetadata,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTerminateResponse {
    pub success: bool,
    pub terminal_id: String,
    pub terminal: Option<TerminalMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRenameResponse {
    pub success: bool,
    pub terminal_id: String,
    pub title: Option<String>,
}

/// One of the error codes a terminal stream reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TerminalErrorCode(&'static str);

impl TerminalErrorCode {
    pub const TERMINAL_NOT_FOUND: Self = Self("terminal-not-found");
    pub const TERMINAL_LIMIT: Self = Self("terminal-limit");
    pub const TERMINAL_VALIDATION: Self = Self("terminal-validation");
    pub const TERMINAL_TAKEOVER_REQUIRED: Self = Self("terminal-takeover-required");
    pub const TERMINAL_NOT_ATTACHED: Self = Self("terminal-not-attached");
    pub const TERMINAL_PROCESS_EXITED: Self = Self("terminal-process-exited");
    pub const TERMINAL_REPLAY_SEQUENCE: Self = Self("terminal-replay-sequence");
    pub const TERMINAL_BACKPRESSURE: Self = Self("terminal-backpressure");
    pub const TERMINAL_AUTH_EXPIRED: Self = Self("terminal-auth-expired");
    pub const TERMINAL_UNSUPPORTED: Self = Self("terminal-unsupported");
    pub const TERMINAL_UNAVAILABLE: Self = Self("terminal-unavailable");
    pub const TERMINAL_RUNTIME_CHANGED: Self = Self("terminal-runtime-changed");
    pub const TERMINAL_OUTCOME_UNKNOWN: Self = Self("terminal-outcome-unknown");
    pub const TERMINAL_INTERNAL: Self = Self("terminal-internal");

    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

impl fmt::Display for TerminalErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl Serialize for TerminalErrorCode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0)
    }
}

impl<'de> Deserialize<'de> for TerminalErrorCode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        terminal_error_code(&value).ok_or_else(|| {
            serde::de::Error::custom(format_args!("unknown terminal error code: {value}"))
        })
    }
}

const TERMINAL_ERROR_CODES: &[TerminalErrorCode] = &[
    TerminalErrorCode::TERMINAL_NOT_FOUND,
    TerminalErrorCode::TERMINAL_LIMIT,
    TerminalErrorCode::TERMINAL_VALIDATION,
    TerminalErrorCode::TERMINAL_TAKEOVER_REQUIRED,
    TerminalErrorCode::TERMINAL_NOT_ATTACHED,
    TerminalErrorCode::TERMINAL_PROCESS_EXITED,
    TerminalErrorCode::TERMINAL_REPLAY_SEQUENCE,
    TerminalErrorCode::TERMINAL_BACKPRESSURE,
    TerminalErrorCode::TERMINAL_AUTH_EXPIRED,
    TerminalErrorCode::TERMINAL_UNSUPPORTED,
    TerminalErrorCode::TERMINAL_UNAVAILABLE,
    TerminalErrorCode::TERMINAL_RUNTIME_CHANGED,
    TerminalErrorCode::TERMINAL_OUTCOME_UNKNOWN,
    TerminalErrorCode::TERMINAL_INTERNAL,
];

/// The listed code `value` names.
fn terminal_error_code(value: &Value) -> Option<TerminalErrorCode> {
    let text = value.as_str()?;
    TERMINAL_ERROR_CODES
        .iter()
        .copied()
        .find(|code| code.as_str() == text)
}

/// Why a client attaches to a terminal: to read again what it missed, or to
/// take the terminal over from the client that held it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalAttachIntent {
    Restore,
    Takeover,
}

/// A message a client sends on a terminal stream.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TerminalStreamClientPayload {
    TerminalAttach {
        terminal_id: String,
        client_id: String,
        after_sequence: Number,
        intent: TerminalAttachIntent,
        #[serde(skip_serializing_if = "Option::is_none")]
        attachment_epoch: Option<String>,
    },
    TerminalInput {
        terminal_id: String,
        data: String,
    },
    TerminalResize {
        terminal_id: String,
        cols: Number,
        rows: Number,
    },
    TerminalDetach {
        terminal_id: String,
    },
}

/// A message a client sends on a terminal stream, with the attachment it
/// belongs to.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStreamClientMessage {
    #[serde(flatten)]
    pub payload: TerminalStreamClientPayload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment_id: Option<String>,
}

/// A message the server sends on a terminal stream.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TerminalStreamServerPayload {
    TerminalAttached {
        terminal: TerminalMetadata,
        replay: Vec<TerminalOutputChunk>,
    },
    TerminalOutput {
        terminal_id: String,
        sequence: Number,
        data: String,
    },
    TerminalReplayBatch {
        terminal_id: String,
        chunks: Vec<TerminalEncodedOutputChunk>,
    },
    TerminalOutputFragment {
        terminal_id: String,
        sequence: Number,
        fragment_index: Number,
        fragment_count: Number,
        data_base64: String,
    },
    TerminalStatus {
        terminal: TerminalMetadata,
    },
    TerminalTakenOver {
        terminal_id: String,
        replacement_client_id: String,
    },
    TerminalTerminated {
        terminal_id: String,
    },
    TerminalReplayTruncated {
        terminal_id: String,
        first_sequence: Number,
    },
    TerminalError {
        #[serde(skip_serializing_if = "Option::is_none")]
        terminal_id: Option<String>,
        code: TerminalErrorCode,
        message: String,
    },
}

/// A message the server sends on a terminal stream, with the attachment it
/// belongs to.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStreamServerMessage {
    #[serde(flatten)]
    pub payload: TerminalStreamServerPayload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment_id: Option<String>,
}

/// The terminal a server message is about, or `None` for an error that
/// concerns the whole connection.
pub fn terminal_id_for_message(message: &TerminalStreamServerMessage) -> Option<String> {
    let scoped = |terminal_id: &str| (!terminal_id.is_empty()).then(|| terminal_id.to_owned());
    match &message.payload {
        TerminalStreamServerPayload::TerminalOutput { terminal_id, .. }
        | TerminalStreamServerPayload::TerminalReplayBatch { terminal_id, .. }
        | TerminalStreamServerPayload::TerminalOutputFragment { terminal_id, .. }
        | TerminalStreamServerPayload::TerminalTakenOver { terminal_id, .. }
        | TerminalStreamServerPayload::TerminalTerminated { terminal_id }
        | TerminalStreamServerPayload::TerminalReplayTruncated { terminal_id, .. } => {
            scoped(terminal_id)
        }
        TerminalStreamServerPayload::TerminalError { terminal_id, .. } => {
            terminal_id.as_deref().and_then(scoped)
        }
        TerminalStreamServerPayload::TerminalAttached { terminal, .. }
        | TerminalStreamServerPayload::TerminalStatus { terminal } => {
            Some(terminal.terminal_id.clone())
        }
    }
}

fn record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn non_empty_string(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !trim(text).is_empty())
}

/// The string `value` names a terminal by, when it is a short enough name.
fn terminal_identifier(value: &Value) -> Option<&str> {
    let identifier = non_empty_string(value)?;
    (identifier.len() <= TERMINAL_ID_MAX_BYTES).then_some(identifier)
}

/// An executor ID as the original casts it, where `is_executor_id` accepted it.
fn executor_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|_| is_executor_id(value))
}

/// A property the original leaves out when it is absent and requires to name
/// a terminal when it is present.
fn optional_terminal_identifier(input: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    match input.get(key) {
        None => Some(None),
        Some(value) => terminal_identifier(value).map(|identifier| Some(identifier.to_owned())),
    }
}

fn non_negative_integer(value: &Value) -> Option<Number> {
    let number = value.as_f64()?;
    (is_integer(number) && number >= 0.0).then_some(Number(number))
}

fn positive_integer(value: &Value) -> Option<Number> {
    let number = value.as_f64()?;
    (is_integer(number) && number > 0.0).then_some(Number(number))
}

static BASE64_STRING_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the original holds the same pattern as a regular expression literal.
    Regex::new(r"^[A-Za-z0-9+/]*={0,2}$").expect("the base64 string pattern compiles")
});

fn base64_string(value: &Value) -> Option<&str> {
    let text = value.as_str()?;
    (utf16::len(text).is_multiple_of(4) && BASE64_STRING_PATTERN.is_match(text)).then_some(text)
}

// `TextEncoder` measures a string in UTF-8 bytes, which is `str::len`.
fn is_title_control_character(character: char) -> bool {
    matches!(character, '\u{0000}'..='\u{001f}' | '\u{007f}')
}

/// A title as the server stores it: invalid, cleared (`null`), or set.
enum Title<'a> {
    Invalid,
    Cleared,
    Text(&'a str),
}

fn normalize_terminal_title(value: &Value) -> Title<'_> {
    if value.is_null() {
        return Title::Cleared;
    }
    let Some(text) = value.as_str() else {
        return Title::Invalid;
    };
    if text.chars().any(is_title_control_character) {
        return Title::Invalid;
    }
    let title = trim(text);
    if title.is_empty() {
        return Title::Cleared;
    }
    if utf16::len(title) <= TERMINAL_TITLE_MAX_LENGTH {
        Title::Text(title)
    } else {
        Title::Invalid
    }
}

fn parse_normalized_terminal_title(value: &Value) -> Title<'_> {
    match normalize_terminal_title(value) {
        // A string is kept only as it is, already trimmed.
        Title::Text(title) if value.as_str() == Some(title) => Title::Text(title),
        Title::Cleared if value.is_null() => Title::Cleared,
        _ => Title::Invalid,
    }
}

/// Reads a request to create a terminal.
pub fn parse_terminal_create_request(value: &Value) -> Option<TerminalCreateRequest> {
    let input = record(value)?;
    let request_id = non_empty_string(input.get("requestId")?)?;
    if request_id.len() > TERMINAL_REQUEST_ID_MAX_BYTES {
        return None;
    }
    let executor_id = match input.get("executorId") {
        None => None,
        Some(value) => Some(executor_id(value)?.to_owned()),
    };
    let expected_terminal_runtime_id = match input.get("expectedTerminalRuntimeId") {
        None => None,
        Some(expected) => Some(terminal_identifier(expected)?.to_owned()),
    };
    let requested_initial_working_directory = match input.get("requestedInitialWorkingDirectory")? {
        Value::Null => None,
        directory @ Value::String(_) => Some(directory.as_str()?.to_owned()),
        _ => return None,
    };
    Some(TerminalCreateRequest {
        request_id: request_id.to_owned(),
        executor_id,
        expected_terminal_runtime_id,
        requested_initial_working_directory,
    })
}

/// Reads a request to terminate a terminal.
pub fn parse_terminal_terminate_request(value: &Value) -> Option<TerminalTerminateRequest> {
    let input = record(value)?;
    let terminal_id = terminal_identifier(input.get("terminalId")?)?;
    let request_id = non_empty_string(input.get("requestId")?)?;
    (request_id.len() <= TERMINAL_REQUEST_ID_MAX_BYTES).then(|| TerminalTerminateRequest {
        terminal_id: terminal_id.to_owned(),
        request_id: request_id.to_owned(),
    })
}

/// Reads a request to rename a terminal.
pub fn parse_terminal_rename_request(value: &Value) -> Option<TerminalRenameRequest> {
    let input = record(value)?;
    let terminal_id = terminal_identifier(input.get("terminalId")?)?;
    let title = match normalize_terminal_title(input.get("title")?) {
        Title::Invalid => return None,
        Title::Cleared => None,
        Title::Text(title) => Some(title.to_owned()),
    };
    Some(TerminalRenameRequest {
        terminal_id: terminal_id.to_owned(),
        title,
    })
}

fn parse_terminal_stream_client_payload(value: &Value) -> Option<TerminalStreamClientPayload> {
    let input = record(value)?;
    let terminal_id = terminal_identifier(input.get("terminalId")?)?;
    let message_type = input.get("type")?.as_str()?;
    let payload = match message_type {
        "terminal-detach" => TerminalStreamClientPayload::TerminalDetach {
            terminal_id: terminal_id.to_owned(),
        },
        "terminal-attach" => {
            let client_id = non_empty_string(input.get("clientId")?)?;
            let after_sequence = non_negative_integer(input.get("afterSequence")?)?;
            let intent = match input.get("intent")?.as_str()? {
                "restore" => TerminalAttachIntent::Restore,
                "takeover" => TerminalAttachIntent::Takeover,
                _ => return None,
            };
            // A present epoch that names no terminal is kept as empty.
            let attachment_epoch = input
                .get("attachmentEpoch")
                .map(|epoch| terminal_identifier(epoch).unwrap_or("").to_owned());
            TerminalStreamClientPayload::TerminalAttach {
                terminal_id: terminal_id.to_owned(),
                client_id: client_id.to_owned(),
                after_sequence,
                intent,
                attachment_epoch,
            }
        }
        "terminal-input" if input.get("data").is_some_and(Value::is_string) => {
            let data = input.get("data")?.as_str()?;
            if data.len() > TERMINAL_MAX_INPUT_BYTES {
                return None;
            }
            TerminalStreamClientPayload::TerminalInput {
                terminal_id: terminal_id.to_owned(),
                data: data.to_owned(),
            }
        }
        "terminal-resize" => {
            let cols = positive_integer(input.get("cols")?)?;
            let rows = positive_integer(input.get("rows")?)?;
            TerminalStreamClientPayload::TerminalResize {
                terminal_id: terminal_id.to_owned(),
                cols,
                rows,
            }
        }
        _ => return None,
    };
    Some(payload)
}

/// Reads one terminal as the server keeps it.
pub fn parse_terminal_metadata(value: &Value) -> Option<TerminalMetadata> {
    let input = record(value)?;
    let terminal_id = terminal_identifier(input.get("terminalId")?)?;
    let display_sequence = positive_integer(input.get("displaySequence")?)?;
    let latest_output_sequence = non_negative_integer(input.get("latestOutputSequence")?)?;
    let title = match parse_normalized_terminal_title(input.get("title")?) {
        Title::Invalid => return None,
        Title::Cleared => None,
        Title::Text(title) => Some(title.to_owned()),
    };
    let initial_working_directory = input.get("initialWorkingDirectory")?.as_str()?;
    let created_at = input.get("createdAt")?.as_str()?;
    let process_status = match input.get("processStatus")?.as_str()? {
        "running" => TerminalProcessStatus::Running,
        "exited" => TerminalProcessStatus::Exited,
        _ => return None,
    };
    let attachment_status = match input.get("attachmentStatus")?.as_str()? {
        "attached" => TerminalServerAttachmentStatus::Attached,
        "detached" => TerminalServerAttachmentStatus::Detached,
        _ => return None,
    };
    let exit_code = match input.get("exitCode")? {
        Value::Null => None,
        // A JavaScript `number` is anything JSON holds as one.
        exit_code @ Value::Number(_) => Some(Number(exit_code.as_f64()?)),
        _ => return None,
    };
    Some(TerminalMetadata {
        terminal_id: terminal_id.to_owned(),
        display_sequence,
        title,
        initial_working_directory: initial_working_directory.to_owned(),
        process_status,
        attachment_status,
        created_at: created_at.to_owned(),
        exit_code,
        latest_output_sequence,
    })
}

fn parse_terminal_stream_server_payload(value: &Value) -> Option<TerminalStreamServerPayload> {
    let input = record(value)?;
    let message_type = input.get("type")?.as_str()?;
    let payload = match message_type {
        "terminal-attached" => {
            let terminal = parse_terminal_metadata(input.get("terminal")?)?;
            let replay = input
                .get("replay")?
                .as_array()?
                .iter()
                .map(|value| {
                    let chunk = record(value)?;
                    Some(TerminalOutputChunk {
                        sequence: positive_integer(chunk.get("sequence")?)?,
                        data: chunk.get("data")?.as_str()?.to_owned(),
                    })
                })
                .collect::<Option<Vec<_>>>()?;
            TerminalStreamServerPayload::TerminalAttached { terminal, replay }
        }
        "terminal-output" => TerminalStreamServerPayload::TerminalOutput {
            terminal_id: terminal_identifier(input.get("terminalId")?)?.to_owned(),
            sequence: positive_integer(input.get("sequence")?)?,
            data: input.get("data")?.as_str()?.to_owned(),
        },
        "terminal-replay-batch" => {
            let terminal_id = terminal_identifier(input.get("terminalId")?)?;
            let chunks = input
                .get("chunks")?
                .as_array()?
                .iter()
                .map(|value| {
                    let chunk = record(value)?;
                    Some(TerminalEncodedOutputChunk {
                        sequence: positive_integer(chunk.get("sequence")?)?,
                        data_base64: base64_string(chunk.get("dataBase64")?)?.to_owned(),
                    })
                })
                .collect::<Option<Vec<_>>>()?;
            TerminalStreamServerPayload::TerminalReplayBatch {
                terminal_id: terminal_id.to_owned(),
                chunks,
            }
        }
        "terminal-output-fragment" => {
            let terminal_id = terminal_identifier(input.get("terminalId")?)?;
            let sequence = positive_integer(input.get("sequence")?)?;
            let fragment_index = non_negative_integer(input.get("fragmentIndex")?)?;
            let fragment_count = positive_integer(input.get("fragmentCount")?)?;
            let data_base64 = base64_string(input.get("dataBase64")?)?;
            (fragment_index.0 < fragment_count.0).then_some(
                TerminalStreamServerPayload::TerminalOutputFragment {
                    terminal_id: terminal_id.to_owned(),
                    sequence,
                    fragment_index,
                    fragment_count,
                    data_base64: data_base64.to_owned(),
                },
            )?
        }
        "terminal-status" => TerminalStreamServerPayload::TerminalStatus {
            terminal: parse_terminal_metadata(input.get("terminal")?)?,
        },
        "terminal-taken-over" => TerminalStreamServerPayload::TerminalTakenOver {
            terminal_id: terminal_identifier(input.get("terminalId")?)?.to_owned(),
            replacement_client_id: non_empty_string(input.get("replacementClientId")?)?.to_owned(),
        },
        "terminal-terminated" => TerminalStreamServerPayload::TerminalTerminated {
            terminal_id: terminal_identifier(input.get("terminalId")?)?.to_owned(),
        },
        "terminal-replay-truncated" => TerminalStreamServerPayload::TerminalReplayTruncated {
            terminal_id: terminal_identifier(input.get("terminalId")?)?.to_owned(),
            first_sequence: positive_integer(input.get("firstSequence")?)?,
        },
        "terminal-error" => {
            let terminal_id = optional_terminal_identifier(input, "terminalId")?;
            let code = terminal_error_code(input.get("code")?)?;
            let message = input.get("message")?.as_str()?;
            TerminalStreamServerPayload::TerminalError {
                terminal_id,
                code,
                message: message.to_owned(),
            }
        }
        _ => return None,
    };
    Some(payload)
}

/// Reads the terminals of an executor.
pub fn parse_terminal_list_response(value: &Value) -> Option<TerminalListResponse> {
    let input = record(value)?;
    if input.get("success") != Some(&Value::Bool(true)) {
        return None;
    }
    let terminals = input
        .get("terminals")?
        .as_array()?
        .iter()
        .map(parse_terminal_metadata)
        .collect::<Option<Vec<_>>>()?;
    let terminal_runtime_id = optional_terminal_identifier(input, "terminalRuntimeId")?;
    let attachment_epoch = optional_terminal_identifier(input, "attachmentEpoch")?;
    Some(TerminalListResponse {
        success: true,
        terminals,
        terminal_runtime_id,
        attachment_epoch,
    })
}

/// Reads the reply to a request to create a terminal.
pub fn parse_terminal_create_response(value: &Value) -> Option<TerminalCreateResponse> {
    let input = record(value)?;
    if input.get("success") != Some(&Value::Bool(true)) {
        return None;
    }
    Some(TerminalCreateResponse {
        success: true,
        terminal: parse_terminal_metadata(input.get("terminal")?)?,
    })
}

/// Reads the reply to a request to terminate a terminal.
pub fn parse_terminal_terminate_response(value: &Value) -> Option<TerminalTerminateResponse> {
    let input = record(value)?;
    if input.get("success") != Some(&Value::Bool(true)) {
        return None;
    }
    let terminal_id = terminal_identifier(input.get("terminalId")?)?;
    let terminal = match input.get("terminal")? {
        Value::Null => None,
        terminal => Some(parse_terminal_metadata(terminal)?),
    };
    Some(TerminalTerminateResponse {
        success: true,
        terminal_id: terminal_id.to_owned(),
        terminal,
    })
}

/// Reads the reply to a request to rename a terminal.
pub fn parse_terminal_rename_response(value: &Value) -> Option<TerminalRenameResponse> {
    let input = record(value)?;
    if input.get("success") != Some(&Value::Bool(true)) {
        return None;
    }
    let terminal_id = terminal_identifier(input.get("terminalId")?)?;
    let title = match parse_normalized_terminal_title(input.get("title")?) {
        Title::Invalid => return None,
        Title::Cleared => None,
        Title::Text(title) => Some(title.to_owned()),
    };
    Some(TerminalRenameResponse {
        success: true,
        terminal_id: terminal_id.to_owned(),
        title,
    })
}

pub fn clone_terminal_metadata(metadata: &TerminalMetadata) -> TerminalMetadata {
    metadata.clone()
}

/// Reads a message a client sends on a terminal stream, with the attachment
/// it belongs to.
pub fn parse_terminal_stream_client_message(value: &Value) -> Option<TerminalStreamClientMessage> {
    let input = record(value)?;
    Some(TerminalStreamClientMessage {
        payload: parse_terminal_stream_client_payload(value)?,
        attachment_id: optional_terminal_identifier(input, "attachmentId")?,
    })
}

/// Reads a message the server sends on a terminal stream, with the attachment
/// it belongs to.
pub fn parse_terminal_stream_server_message(value: &Value) -> Option<TerminalStreamServerMessage> {
    let input = record(value)?;
    Some(TerminalStreamServerMessage {
        payload: parse_terminal_stream_server_payload(value)?,
        attachment_id: optional_terminal_identifier(input, "attachmentId")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const METADATA: &str = r#"{"terminalId":"terminal-1","displaySequence":1,"title":null,"initialWorkingDirectory":"/workspace","processStatus":"running","attachmentStatus":"detached","createdAt":"2026-07-13T00:00:00.000Z","exitCode":null,"latestOutputSequence":2}"#;

    /// What a parser made of a value, as the JSON the original writes for it,
    /// and `None` where the original returns `null`.
    fn written<T: Serialize>(value: Option<T>) -> Option<String> {
        value.map(|value| serde_json::to_string(&value).unwrap())
    }

    /// `JSON.parse(JSON.stringify(message))`, for a message written as the
    /// original's object literal serializes.
    fn wire(message: &str) -> Value {
        garcon_js::json::parse(message).unwrap()
    }

    #[test]
    fn parses_control_requests_and_responses() {
        let expect = |actual: Option<String>, expected: &str| {
            assert_eq!(actual.as_deref(), Some(expected));
        };
        expect(
            written(parse_terminal_create_request(&json!({
                "requestId": "create-1",
                "requestedInitialWorkingDirectory": "/workspace",
            }))),
            r#"{"requestId":"create-1","requestedInitialWorkingDirectory":"/workspace"}"#,
        );
        expect(
            written(parse_terminal_terminate_request(&json!({
                "terminalId": "terminal-1",
                "requestId": "delete-1",
            }))),
            r#"{"terminalId":"terminal-1","requestId":"delete-1"}"#,
        );
        expect(
            written(parse_terminal_rename_request(&json!({
                "terminalId": "terminal-1",
                "title": "  Build logs  ",
            }))),
            r#"{"terminalId":"terminal-1","title":"Build logs"}"#,
        );
        expect(
            written(parse_terminal_rename_request(
                &json!({ "terminalId": "terminal-1", "title": "   " }),
            )),
            r#"{"terminalId":"terminal-1","title":null}"#,
        );
        expect(
            written(parse_terminal_list_response(
                &json!({ "success": true, "terminals": [wire(METADATA)] }),
            )),
            &format!(r#"{{"success":true,"terminals":[{METADATA}]}}"#),
        );
        expect(
            written(parse_terminal_create_response(
                &json!({ "success": true, "terminal": wire(METADATA) }),
            )),
            &format!(r#"{{"success":true,"terminal":{METADATA}}}"#),
        );
        expect(
            written(parse_terminal_terminate_response(&json!({
                "success": true,
                "terminalId": "terminal-1",
                "terminal": wire(METADATA),
            }))),
            &format!(r#"{{"success":true,"terminalId":"terminal-1","terminal":{METADATA}}}"#),
        );
        expect(
            written(parse_terminal_rename_response(&json!({
                "success": true,
                "terminalId": "terminal-1",
                "title": "Build logs",
            }))),
            r#"{"success":true,"terminalId":"terminal-1","title":"Build logs"}"#,
        );
    }

    #[test]
    fn requires_normalized_titles_in_terminal_metadata_and_responses() {
        let mut missing_title = wire(METADATA);
        missing_title.as_object_mut().unwrap().shift_remove("title");
        assert_eq!(parse_terminal_metadata(&missing_title), None);
        let mut padded_title = wire(METADATA);
        padded_title["title"] = json!(" Build logs ");
        assert_eq!(parse_terminal_metadata(&padded_title), None);
        assert_eq!(
            parse_terminal_rename_response(&json!({
                "success": true,
                "terminalId": "terminal-1",
                "title": "",
            })),
            None
        );
    }

    #[test]
    fn round_trips_every_client_stream_message() {
        let messages = [
            r#"{"type":"terminal-attach","terminalId":"terminal-1","clientId":"client-1","afterSequence":0,"intent":"restore"}"#,
            r#"{"type":"terminal-input","terminalId":"terminal-1","data":"pwd\n"}"#,
            r#"{"type":"terminal-detach","terminalId":"terminal-1","attachmentId":"attachment"}"#,
            r#"{"type":"terminal-resize","terminalId":"terminal-1","cols":120,"rows":40}"#,
        ];
        for message in messages {
            let message_parsed = parse_terminal_stream_client_message(&wire(message)).unwrap();
            assert_eq!(serde_json::to_string(&message_parsed).unwrap(), message);
        }
    }

    #[test]
    fn round_trips_every_server_stream_message() {
        let metadata = METADATA.trim_start_matches('{').trim_end_matches('}');
        let messages = [
            format!(r#"{{"type":"terminal-attached","terminal":{{{metadata}}},"replay":[{{"sequence":2,"data":"ok"}}]}}"#),
            r#"{"type":"terminal-output","terminalId":"terminal-1","sequence":3,"data":"next"}"#.to_owned(),
            r#"{"type":"terminal-replay-batch","terminalId":"terminal-1","chunks":[{"sequence":3,"dataBase64":"bmV4dA=="}]}"#.to_owned(),
            r#"{"type":"terminal-output-fragment","terminalId":"terminal-1","sequence":3,"fragmentIndex":0,"fragmentCount":1,"dataBase64":"bmV4dA=="}"#.to_owned(),
            format!(r#"{{"type":"terminal-status","terminal":{{{metadata}}}}}"#),
            r#"{"type":"terminal-taken-over","terminalId":"terminal-1","replacementClientId":"client-2"}"#.to_owned(),
            r#"{"type":"terminal-terminated","terminalId":"terminal-1"}"#.to_owned(),
            r#"{"type":"terminal-replay-truncated","terminalId":"terminal-1","firstSequence":2}"#.to_owned(),
            r#"{"type":"terminal-error","terminalId":"terminal-1","code":"terminal-not-attached","message":"Not attached"}"#.to_owned(),
        ];
        for message in &messages {
            let parsed = parse_terminal_stream_server_message(&wire(message)).unwrap();
            assert_eq!(serde_json::to_string(&parsed).unwrap(), *message);
            assert_eq!(
                terminal_id_for_message(&parsed).as_deref(),
                Some("terminal-1")
            );
        }
    }

    #[test]
    fn leaves_connection_wide_terminal_errors_unscoped() {
        let message = parse_terminal_stream_server_message(&wire(
            r#"{"type":"terminal-error","code":"terminal-auth-expired","message":"Terminal authorization expired."}"#,
        ))
        .unwrap();
        assert_eq!(terminal_id_for_message(&message), None);
    }

    #[test]
    fn rejects_malformed_and_oversized_messages() {
        assert_eq!(
            parse_terminal_create_request(&json!({
                "requestId": "",
                "requestedInitialWorkingDirectory": null,
            })),
            None
        );
        assert_eq!(
            parse_terminal_terminate_request(&json!({ "terminalId": "terminal-1" })),
            None
        );
        assert_eq!(
            parse_terminal_create_request(&json!({
                "requestId": "x".repeat(257),
                "requestedInitialWorkingDirectory": null,
            })),
            None
        );
        assert_eq!(
            parse_terminal_terminate_request(&json!({
                "terminalId": "terminal-1",
                "requestId": "x".repeat(257),
            })),
            None
        );
        assert_eq!(
            parse_terminal_rename_request(&json!({ "terminalId": "terminal-1" })),
            None
        );
        assert_eq!(
            parse_terminal_rename_request(&json!({
                "terminalId": "terminal-1",
                "title": "x".repeat(TERMINAL_TITLE_MAX_LENGTH + 1),
            })),
            None
        );
        assert_eq!(
            parse_terminal_rename_request(&json!({
                "terminalId": "terminal-1",
                "title": "build\nlogs",
            })),
            None
        );
        assert_eq!(
            parse_terminal_terminate_request(&json!({
                "terminalId": "x".repeat(257),
                "requestId": "delete-1",
            })),
            None
        );
        assert_eq!(
            parse_terminal_stream_client_message(&json!({
                "type": "terminal-attach",
                "terminalId": "terminal-1",
                "clientId": "client-1",
                "afterSequence": -1,
                "intent": "restore",
            })),
            None
        );
        assert_eq!(
            parse_terminal_stream_client_message(&json!({
                "type": "terminal-resize",
                "terminalId": "terminal-1",
                "cols": 0,
                "rows": 24,
            })),
            None
        );
        assert_eq!(
            parse_terminal_stream_client_message(&json!({
                "type": "terminal-input",
                "terminalId": "terminal-1",
                "data": "x".repeat(TERMINAL_MAX_INPUT_BYTES + 1),
            })),
            None
        );
        assert_eq!(
            parse_terminal_stream_server_message(&json!({
                "type": "terminal-error",
                "code": "unknown-code",
                "message": "No",
            })),
            None
        );
    }

    #[test]
    fn echoes_integers_beyond_the_safe_range_as_javascript_writes_them() {
        let message = parse_terminal_stream_client_message(&wire(
            r#"{"type":"terminal-resize","terminalId":"terminal-1","cols":1e21,"rows":40}"#,
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_string(&message).unwrap(),
            r#"{"type":"terminal-resize","terminalId":"terminal-1","cols":1e+21,"rows":40}"#
        );
    }

    #[test]
    fn lists_every_error_code_once() {
        let mut codes: Vec<&str> = TERMINAL_ERROR_CODES
            .iter()
            .map(|code| code.as_str())
            .collect();
        let total = codes.len();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), total);
        assert_eq!(total, 14);
        for code in TERMINAL_ERROR_CODES {
            assert_eq!(terminal_error_code(&json!(code.as_str())), Some(*code));
            assert_eq!(code.to_string(), code.as_str());
        }
        for value in [
            json!("unknown-code"),
            json!("terminal_not_found"),
            json!(null),
        ] {
            assert_eq!(terminal_error_code(&value), None, "{value}");
        }
    }
}
