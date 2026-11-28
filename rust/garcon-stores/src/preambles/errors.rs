//! Ports `server/controller/preambles/errors.ts`.

use garcon_base::errors::{DiagnosticError, ErrorMetadata};
use garcon_contract::preambles::{Preamble, PreambleErrorCode};

use super::{
    Result,
    catalog_budget::{Violation, composition_violation},
};

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct PreambleDomainError {
    pub code: PreambleErrorCode,
    pub message: String,
    pub status: u16,
    pub retryable: bool,
}

impl PreambleDomainError {
    pub fn new(code: PreambleErrorCode, message: impl Into<String>, status: u16) -> Self {
        Self {
            code,
            message: message.into(),
            status,
            retryable: false,
        }
    }
}

impl DiagnosticError for PreambleDomainError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "PreambleDomainError",
            code: Some(self.code.as_str()),
        }
    }
}

pub(super) fn assert_catalog_composition(preambles: &[Preamble]) -> Result<()> {
    let Some(violation) = composition_violation(preambles)? else {
        return Ok(());
    };
    let (code, message, status, path) = match violation {
        Violation::FileContextSeparator { project_path } => (
            PreambleErrorCode::VALIDATION_FAILED,
            "contain a reserved separator",
            400,
            project_path,
        ),
        Violation::CombinedLimit { project_path, .. } => (
            PreambleErrorCode::COMBINED_LIMIT_EXCEEDED,
            "exceed the maximum length",
            422,
            project_path,
        ),
    };
    let scope = path.as_deref().unwrap_or("the global scope");
    Err(PreambleDomainError::new(
        code,
        format!("Combined matching preambles {message} at {scope}"),
        status,
    )
    .into())
}
