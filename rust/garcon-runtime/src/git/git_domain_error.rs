//! Ports `server/runtime/git/git-domain-error.ts`.

use garcon_base::errors::{DiagnosticError, ErrorMetadata};

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct GitDomainError {
    pub code: String,
    pub message: String,
}

impl GitDomainError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl DiagnosticError for GitDomainError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "GitDomainError",
            code: Some(&self.code),
        }
    }
}
