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

#[cfg(test)]
mod tests {
    use garcon_base::errors::{ErrorInput, diagnostic_error_code};

    use super::*;

    #[test]
    fn concrete_git_domain_error_keeps_its_diagnostic_metadata() {
        let error = GitDomainError::new("MUTATION_OUTCOME_UNKNOWN", "synthetic failure");
        assert_eq!(error.diagnostic_metadata().name, "GitDomainError");
        assert_eq!(
            diagnostic_error_code(ErrorInput::Diagnostic(&error)),
            "MUTATION_OUTCOME_UNKNOWN"
        );
    }
}
