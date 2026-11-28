//! Ports `server/controller/snippets/errors.ts`.

use garcon_base::errors::{DiagnosticError, ErrorMetadata};
use garcon_contract::snippets::SnippetErrorCode;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct SnippetDomainError {
    pub code: SnippetErrorCode,
    pub message: String,
    pub status: u16,
    pub retryable: bool,
}

impl SnippetDomainError {
    pub fn new(code: SnippetErrorCode, message: impl Into<String>, status: u16) -> Self {
        Self {
            code,
            message: message.into(),
            status,
            retryable: false,
        }
    }
}

impl DiagnosticError for SnippetDomainError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "SnippetDomainError",
            code: Some(self.code.as_str()),
        }
    }
}
