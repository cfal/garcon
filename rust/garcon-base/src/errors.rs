//! Extraction of messages and diagnostic codes from typed or structural errors.

use std::borrow::Cow;
use std::error::Error;
use std::io;

use garcon_contract::{
    chat_id::InvalidChatIdError, git_error::GitServiceError,
    server_runtime::ServerRuntimeContractError, terminal_error::TerminalError,
    ticket_validation::TicketValidationError,
};
use garcon_interface::errors::{AgentCallError, AgentIntegrationError};
use garcon_js::{InvalidTimeValue, json::as_number, number_to_string};
use serde_json::Value;

use crate::{
    domain_error::as_domain_error,
    executor_disconnect::ExecutorSessionLostError,
    http_body::MalformedJsonError,
    json_file_store::{
        AtomicJsonWriteError, CorruptStateFileError, ReadJsonStateError, WriteFileError,
    },
    keyed_lock::LockAborted,
    path_boundary::{ProjectBoundaryError, ProjectPathError},
    promise_timeout::PromiseTimeoutError,
    stored_json::MalformedStoredJsonError,
    workspace_lease::{
        AcquireWorkspaceLeaseError, LockHeldError, WorkspaceInUseError, WorkspaceLeaseCompromised,
    },
};

mod node_io_codes;

#[derive(Clone, Copy, Debug)]
pub struct ErrorMetadata<'a> {
    pub name: &'a str,
    pub code: Option<&'a str>,
}

impl<'a> ErrorMetadata<'a> {
    const fn named(name: &'a str) -> Self {
        Self { name, code: None }
    }

    const fn coded(name: &'a str, code: &'a str) -> Self {
        Self {
            name,
            code: Some(code),
        }
    }
}

/// Explicitly preserves a typed error's metadata across the diagnostic boundary.
pub trait DiagnosticError: Error + 'static {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_>;
}

#[derive(Clone, Copy)]
pub enum ErrorInput<'a> {
    Error(&'a (dyn Error + 'static)),
    Diagnostic(&'a dyn DiagnosticError),
    Json(&'a Value),
    Undefined,
}

impl<'a> ErrorInput<'a> {
    pub(crate) fn as_error(self) -> Option<&'a (dyn Error + 'static)> {
        match self {
            Self::Error(error) => Some(error),
            Self::Diagnostic(error) => Some(error),
            _ => None,
        }
    }
}

/// A foreign error with an explicit name and optional structured code.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct NamedError {
    pub name: String,
    pub message: String,
    pub code: Option<String>,
}

impl DiagnosticError for NamedError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: &self.name,
            code: self.code.as_deref(),
        }
    }
}

pub fn error_message<'a>(error: ErrorInput<'a>, fallback: Option<&'a str>) -> Cow<'a, str> {
    match error {
        ErrorInput::Error(error) => Cow::Owned(error.to_string()),
        ErrorInput::Diagnostic(error) => Cow::Owned(error.to_string()),
        ErrorInput::Json(value) => value
            .get("message")
            .and_then(Value::as_str)
            .or(fallback)
            .map(Cow::Borrowed)
            .unwrap_or_else(|| js_string(error)),
        ErrorInput::Undefined => Cow::Borrowed(fallback.unwrap_or("undefined")),
    }
}

pub fn has_node_error_code(error: ErrorInput<'_>, code: &str) -> bool {
    structured_error_code(error) == Some(code)
}

pub fn diagnostic_error_code(error: ErrorInput<'_>) -> &str {
    match error {
        ErrorInput::Error(error) => diagnostic_name(error_metadata(error)),
        ErrorInput::Diagnostic(error) => diagnostic_name(error.diagnostic_metadata()),
        _ => structured_error_code(error).unwrap_or("UNKNOWN"),
    }
}

fn diagnostic_name(metadata: ErrorMetadata<'_>) -> &str {
    metadata.code.unwrap_or(metadata.name)
}

fn structured_error_code(error: ErrorInput<'_>) -> Option<&str> {
    match error {
        ErrorInput::Json(value) => value.get("code").and_then(Value::as_str),
        ErrorInput::Error(error) => error_metadata(error).code,
        ErrorInput::Diagnostic(error) => error.diagnostic_metadata().code,
        ErrorInput::Undefined => None,
    }
}

/// Reads a shared error's original class name and code independently.
pub fn error_metadata<'a>(error: &'a (dyn Error + 'static)) -> ErrorMetadata<'a> {
    if let Some(error) = error.downcast_ref::<io::Error>() {
        return ErrorMetadata {
            name: "Error",
            code: node_io_codes::node_io_code(error),
        };
    }
    if let Some(error) = error.downcast_ref::<NamedError>() {
        return error.diagnostic_metadata();
    }
    if let Some(error) = error.downcast_ref::<crate::ticket_error::TicketDomainError>() {
        return ErrorMetadata::coded(
            crate::ticket_error::TicketDomainError::NAME,
            garcon_contract::error_codes::ErrorCode::from(error.code).as_str(),
        );
    }
    if let Some(error) = as_domain_error(error) {
        return ErrorMetadata::coded(error.kind.name(), error.code.as_str());
    }
    if let Some(error) = as_agent_call_error(error) {
        return ErrorMetadata::coded("AgentCallError", error.code.as_str());
    }
    if let Some(error) = error.downcast_ref::<AgentIntegrationError>() {
        return ErrorMetadata::coded("AgentIntegrationError", error.code.as_str());
    }
    if let Some(error) = error.downcast_ref::<GitServiceError>() {
        return ErrorMetadata::coded("GitServiceError", error.code.as_str());
    }
    if let Some(error) = error.downcast_ref::<TerminalError>() {
        return ErrorMetadata::coded("TerminalError", error.code.as_str());
    }
    if error.is::<LockHeldError>() {
        return ErrorMetadata::coded("Error", LockHeldError::CODE);
    }
    if error.is::<WorkspaceInUseError>() {
        return ErrorMetadata::coded("WorkspaceInUseError", WorkspaceInUseError::CODE);
    }
    if error.is::<WorkspaceLeaseCompromised>() {
        return ErrorMetadata::coded("Error", WorkspaceLeaseCompromised::CODE);
    }

    // These Rust enums transparently hold the error that the original throws.
    if let Some(error) = error.downcast_ref::<ProjectPathError>() {
        return match error {
            ProjectPathError::Io(error) => error_metadata(error),
            ProjectPathError::Boundary(error) => error_metadata(error),
        };
    }
    if let Some(error) = error.downcast_ref::<AcquireWorkspaceLeaseError>() {
        return match error {
            AcquireWorkspaceLeaseError::Io(error) => error_metadata(error),
            AcquireWorkspaceLeaseError::InUse(error) => error_metadata(error),
        };
    }
    if let Some(error) = error.downcast_ref::<ReadJsonStateError>() {
        return match error {
            ReadJsonStateError::Io(error) => error_metadata(error),
            ReadJsonStateError::Corrupt(error) => error_metadata(error),
            ReadJsonStateError::Clock(error) => error_metadata(error),
        };
    }
    if let Some(error) = error.downcast_ref::<WriteFileError>() {
        return match error {
            WriteFileError::Io(error) => error_metadata(error),
            WriteFileError::Atomic(error) => error_metadata(error),
            WriteFileError::Json(_) => ErrorMetadata::named("TypeError"),
        };
    }

    macro_rules! named {
        ($($ty:ty => $name:expr),* $(,)?) => {
            $(if error.is::<$ty>() { return ErrorMetadata::named($name); })*
        };
    }
    named!(
        MalformedJsonError => "MalformedJsonError",
        MalformedStoredJsonError => "MalformedStoredJsonError",
        PromiseTimeoutError => "PromiseTimeoutError",
        ServerRuntimeContractError => "ServerRuntimeContractError",
        InvalidChatIdError => "InvalidChatIdError",
        TicketValidationError => "TicketValidationError",
        LockAborted => LockAborted::NAME,
        ProjectBoundaryError => "ProjectBoundaryError",
        AtomicJsonWriteError => "AtomicJsonWriteError",
        CorruptStateFileError => "CorruptStateFileError",
        InvalidTimeValue => "RangeError",
    );
    ErrorMetadata::named("Error")
}

pub(crate) fn as_agent_call_error<'a>(
    error: &'a (dyn Error + 'static),
) -> Option<&'a AgentCallError> {
    error.downcast_ref::<AgentCallError>().or_else(|| {
        error
            .downcast_ref::<ExecutorSessionLostError>()
            .map(|error| &**error)
    })
}

/// Formats a diagnostic value, using JavaScript's string form for JSON.
pub fn js_string(error: ErrorInput<'_>) -> Cow<'_, str> {
    match error {
        ErrorInput::Error(error) => Cow::Owned(error.to_string()),
        ErrorInput::Diagnostic(error) => Cow::Owned(error.to_string()),
        ErrorInput::Undefined => Cow::Borrowed("undefined"),
        ErrorInput::Json(Value::Null) => Cow::Borrowed("null"),
        ErrorInput::Json(Value::Bool(value)) => {
            Cow::Borrowed(if *value { "true" } else { "false" })
        }
        ErrorInput::Json(Value::String(value)) => Cow::Borrowed(value),
        ErrorInput::Json(value @ Value::Number(_)) => {
            // INFALLIBLE: every JSON number held by Value has a double representation.
            Cow::Owned(number_to_string(as_number(value).expect("JSON number")))
        }
        ErrorInput::Json(Value::Object(_)) => Cow::Borrowed("[object Object]"),
        ErrorInput::Json(Value::Array(values)) => Cow::Owned(
            values
                .iter()
                .map(|value| {
                    if value.is_null() {
                        Cow::Borrowed("")
                    } else {
                        js_string(ErrorInput::Json(value))
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_native_and_structural_messages_and_only_then_falls_back() {
        let native = std::io::Error::other("native failure");
        assert_eq!(
            error_message(ErrorInput::Error(&native), Some("unused")),
            "native failure"
        );
        let value = json!({"message":"structured failure"});
        assert_eq!(
            error_message(ErrorInput::Json(&value), None),
            "structured failure"
        );
        let code_only = json!({"code":"FAILED"});
        assert_eq!(
            error_message(ErrorInput::Json(&code_only), Some("Operation failed.")),
            "Operation failed."
        );
        assert_eq!(
            error_message(ErrorInput::Json(&code_only), None),
            "[object Object]"
        );
    }

    #[test]
    fn uses_string_codes_and_falls_back_to_the_error_kind() {
        let value = json!({"code":"FAILED"});
        assert!(has_node_error_code(ErrorInput::Json(&value), "FAILED"));
        assert_eq!(diagnostic_error_code(ErrorInput::Json(&value)), "FAILED");
        let value = json!({"code":35});
        assert!(!has_node_error_code(ErrorInput::Json(&value), "35"));
        assert_eq!(diagnostic_error_code(ErrorInput::Json(&value)), "UNKNOWN");
        assert_eq!(
            diagnostic_error_code(ErrorInput::Error(&std::io::Error::other("failed"))),
            "Error"
        );
    }
}
