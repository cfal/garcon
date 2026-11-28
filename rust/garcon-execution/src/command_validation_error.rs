//! Ports the controller's standalone command validation error.

use garcon_base::errors::{DiagnosticError, ErrorMetadata};
use garcon_contract::error_codes::ErrorCode;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct CommandValidationError {
    pub code: ErrorCode,
    pub message: String,
    pub status: u16,
    pub retryable: bool,
}

impl CommandValidationError {
    pub fn new(code: ErrorCode, message: impl Into<String>, status: u16, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            status,
            retryable,
        }
    }
}

impl DiagnosticError for CommandValidationError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "CommandValidationError",
            code: Some(self.code.as_str()),
        }
    }
}
