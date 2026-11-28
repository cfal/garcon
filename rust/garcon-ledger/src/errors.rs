use std::error::Error;

use garcon_base::{
    errors::{DiagnosticError, ErrorMetadata, error_metadata},
    stored_json::MalformedStoredJsonError,
};
use garcon_contract::async_user_questions::InvalidAsyncQuestionReply;
use serde::Serialize;

use crate::{
    failure_fences::SharedLedgerFailure,
    sqlite_operations::{QueryFailure, SqliteError, TransactionFailure},
};

#[derive(Debug, thiserror::Error)]
pub enum LedgerError {
    #[error("{0}")]
    Ledger(String),
    #[error("Transcript ledger is fenced for chat {chat_id}")]
    Fenced {
        chat_id: String,
        #[source]
        cause: Box<dyn Error>,
    },
    #[error("Transcript ledger has no current view for chat {chat_id}")]
    ViewNotInitialized { chat_id: String },
    #[error("Transcript view {requested_view_id} was replaced by {current_view_id}")]
    StaleView {
        chat_id: String,
        requested_view_id: String,
        current_view_id: String,
    },
    #[error("{0}")]
    InvalidReplayRequest(String),
    #[error("Client message {client_message_id} was already submitted with different content")]
    SubmissionConflict { client_message_id: String },
    #[error("{0}")]
    Schema(String),
    #[error("Transcript ledger for chat {chat_id} closed during a bulk operation")]
    BulkOperationAbandoned { chat_id: String },
    #[error("Transcript ledger checkpoint did not complete")]
    IncompleteCheckpoint {
        busy_frames: i64,
        log_frames: i64,
        checkpointed_frames: i64,
    },
    #[error("This permission request is no longer actionable")]
    PermissionNotActionable,
}

impl DiagnosticError for LedgerError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        let name = match self {
            Self::Ledger(_) => "LedgerError",
            Self::Fenced { .. } => "LedgerFencedError",
            Self::ViewNotInitialized { .. } => "TranscriptViewNotInitializedError",
            Self::StaleView { .. } => "StaleTranscriptViewError",
            Self::InvalidReplayRequest(_) => "InvalidTranscriptReplayRequestError",
            Self::SubmissionConflict { .. } => "SubmissionConflictError",
            Self::Schema(_) => "LedgerSchemaError",
            Self::BulkOperationAbandoned { .. } => "LedgerBulkOperationAbandonedError",
            Self::IncompleteCheckpoint { .. } => "IncompleteLedgerCheckpointError",
            Self::PermissionNotActionable => "PermissionNotActionableError",
        };
        ErrorMetadata { name, code: None }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("Transcript producer sink is closed")]
pub struct TranscriptSinkClosedError;

impl DiagnosticError for TranscriptSinkClosedError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "TranscriptSinkClosedError",
            code: None,
        }
    }
}

pub const UNDECODABLE_LEDGER_ROW: &str = "UNDECODABLE_LEDGER_ROW";

#[derive(Debug, thiserror::Error)]
#[error("Stored transcript row is invalid")]
pub struct UndecodableLedgerRowError {
    #[source]
    pub cause: LedgerCodecError,
}

impl DiagnosticError for UndecodableLedgerRowError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "UndecodableLedgerRowError",
            code: Some(UNDECODABLE_LEDGER_ROW),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LedgerCodecError {
    #[error("{0}")]
    Type(String),
    #[error("Invalid agent switch executor")]
    InvalidAgentSwitchExecutor,
    #[error(transparent)]
    MalformedStoredJson(#[from] MalformedStoredJsonError),
    #[error(transparent)]
    InvalidAsyncQuestionReply(#[from] InvalidAsyncQuestionReply),
    #[error(transparent)]
    Serialize(#[from] serde_json::Error),
}

impl DiagnosticError for LedgerCodecError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        let name = match self {
            Self::Type(_) | Self::InvalidAsyncQuestionReply(_) | Self::Serialize(_) => "TypeError",
            Self::InvalidAgentSwitchExecutor => "Error",
            Self::MalformedStoredJson(_) => "MalformedStoredJsonError",
        };
        ErrorMetadata { name, code: None }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeFenceDiagnostic {
    pub cause_name: String,
    pub cause_code: String,
}

pub fn safe_fence_diagnostic(error: &(dyn Error + 'static)) -> SafeFenceDiagnostic {
    let cause = match error.downcast_ref::<LedgerError>() {
        Some(LedgerError::Fenced { cause, .. }) => Some(cause.as_ref()),
        _ => None,
    };
    let metadata = cause.map(cause_metadata);
    SafeFenceDiagnostic {
        cause_name: safe_field(metadata.map(|m| m.name), u8::is_ascii_alphabetic, |b| {
            b.is_ascii_alphanumeric()
        }),
        cause_code: safe_field(metadata.and_then(|m| m.code), u8::is_ascii_uppercase, |b| {
            b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'
        }),
    }
}

fn cause_metadata<'a>(cause: &'a (dyn Error + 'static)) -> ErrorMetadata<'a> {
    if let Some(error) = cause.downcast_ref::<SqliteError>() {
        return error.diagnostic_metadata();
    }
    if let Some(error) = cause.downcast_ref::<QueryFailure>() {
        return cause_metadata(error.0.as_ref());
    }
    if let Some(error) = cause.downcast_ref::<TransactionFailure>() {
        return cause_metadata(error.cause.as_ref());
    }
    if let Some(error) = cause.downcast_ref::<SharedLedgerFailure>()
        && let Some(source) = error.source()
    {
        return cause_metadata(source);
    }
    if let Some(error) = cause.downcast_ref::<UndecodableLedgerRowError>() {
        return error.diagnostic_metadata();
    }
    if let Some(error) = cause.downcast_ref::<TranscriptSinkClosedError>() {
        return error.diagnostic_metadata();
    }
    if let Some(error) = cause.downcast_ref::<LedgerError>() {
        return error.diagnostic_metadata();
    }
    if let Some(error) = cause.downcast_ref::<LedgerCodecError>() {
        return error.diagnostic_metadata();
    }
    error_metadata(cause)
}

fn safe_field(
    value: Option<&str>,
    first: impl Fn(&u8) -> bool,
    rest: impl Fn(u8) -> bool,
) -> String {
    value
        .filter(|value| {
            value.len() <= 64
                && value.as_bytes().first().is_some_and(first)
                && value.bytes().skip(1).all(rest)
        })
        .unwrap_or("UNKNOWN")
        .into()
}
