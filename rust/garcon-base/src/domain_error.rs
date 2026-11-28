//! Ports `server/common/domain-error.ts`.

use std::error::Error;
use std::fmt;

use garcon_contract::{
    chat_view::ChatHistoryState, error_codes::ErrorCode,
    project_resolution::ProjectUnavailableReason,
};

use crate::errors::{DiagnosticError, ErrorMetadata};

/// An error the server reports to a client with a structured code, the HTTP
/// status to answer with, and whether sending the request again can succeed.
#[derive(Debug)]
pub struct DomainError {
    pub code: ErrorCode,
    pub message: String,
    pub status: u16,
    pub retryable: bool,
    /// The error class the original names, with the fields a subclass adds.
    pub kind: DomainErrorKind,
    /// The error that caused this one, as `ErrorOptions.cause` holds it.
    pub cause: Option<Box<dyn Error>>,
}

/// Which error class a `DomainError` is: `DomainError` itself, or
/// `ValidationDomainError` or `ProjectUnavailableError`, which extend it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DomainErrorKind {
    Domain,
    Validation,
    ProjectUnavailable {
        project_path: String,
        reason: ProjectUnavailableReason,
    },
}

impl DomainErrorKind {
    /// The name the original gives the error.
    pub fn name(&self) -> &'static str {
        match self {
            DomainErrorKind::Domain => "DomainError",
            DomainErrorKind::Validation => "ValidationDomainError",
            DomainErrorKind::ProjectUnavailable { .. } => "ProjectUnavailableError",
        }
    }
}

impl DomainError {
    /// Creates the error. The original defaults the status to 400 and makes
    /// the error not retryable; a caller passes both.
    pub fn new(
        code: ErrorCode,
        message: impl Into<String>,
        status: u16,
        retryable: bool,
    ) -> DomainError {
        DomainError {
            code,
            message: message.into(),
            status,
            retryable,
            kind: DomainErrorKind::Domain,
            cause: None,
        }
    }

    /// Creates a `ValidationDomainError`: a request the server could not read,
    /// answered with 400.
    pub fn new_validation(message: impl Into<String>) -> DomainError {
        DomainError {
            kind: DomainErrorKind::Validation,
            ..DomainError::new(ErrorCode::VALIDATION_FAILED, message, 400, false)
        }
    }

    /// Creates a `ProjectUnavailableError`: a project path that cannot be
    /// used, answered with 409.
    pub fn new_project_unavailable(
        project_path: impl Into<String>,
        reason: ProjectUnavailableReason,
    ) -> DomainError {
        let project_path = project_path.into();
        let message = format!("Project folder unavailable ({reason}): {project_path}");
        DomainError {
            kind: DomainErrorKind::ProjectUnavailable {
                project_path,
                reason,
            },
            ..DomainError::new(ErrorCode::PROJECT_UNAVAILABLE, message, 409, false)
        }
    }

    /// The same error, caused by `cause`.
    pub fn with_cause(self, cause: Box<dyn Error>) -> DomainError {
        DomainError {
            cause: Some(cause),
            ..self
        }
    }
}

impl fmt::Display for DomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for DomainError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.cause
            .as_deref()
            .map(|cause| cause as &(dyn Error + 'static))
    }
}

/// A domain error whose caller can also inspect the degraded history state.
#[derive(Debug)]
pub struct TranscriptHistoryUnavailableError {
    domain: DomainError,
    pub history_state: ChatHistoryState,
}

impl TranscriptHistoryUnavailableError {
    pub fn new(
        history_error_code: impl Into<String>,
        retryable: bool,
        cause: Option<Box<dyn Error>>,
    ) -> Self {
        Self {
            domain: DomainError {
                cause,
                ..DomainError::new(
                    ErrorCode::TRANSCRIPT_UNAVAILABLE,
                    "The transcript ledger is unavailable",
                    422,
                    retryable,
                )
            },
            history_state: ChatHistoryState::Degraded {
                error_code: history_error_code.into(),
                retryable,
            },
        }
    }

    pub fn domain_error(&self) -> &DomainError {
        &self.domain
    }
}

impl DiagnosticError for TranscriptHistoryUnavailableError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: self.domain.kind.name(),
            code: Some(self.domain.code.as_str()),
        }
    }
}

impl fmt::Display for TranscriptHistoryUnavailableError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.domain, formatter)
    }
}

impl Error for TranscriptHistoryUnavailableError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.domain.source()
    }
}

pub const TRANSCRIPT_UNAVAILABLE_MESSAGE: &str = "Chat transcript is unavailable.";
pub const TRANSCRIPT_TEMPORARILY_UNAVAILABLE_MESSAGE: &str =
    "Chat transcript is temporarily unavailable. Retry the request.";

/// The message for a chat whose transcript cannot be read: it says whether
/// sending the request again can succeed.
pub fn transcript_unavailable_message(retryable: bool) -> &'static str {
    if retryable {
        TRANSCRIPT_TEMPORARILY_UNAVAILABLE_MESSAGE
    } else {
        TRANSCRIPT_UNAVAILABLE_MESSAGE
    }
}

/// Whether `error` is a `DomainError` or one of its subclasses.
/// Its fields are read through `as_domain_error(error)`.
pub fn is_domain_error(error: &(dyn Error + 'static)) -> bool {
    as_domain_error(error).is_some()
}

pub fn as_domain_error<'a>(error: &'a (dyn Error + 'static)) -> Option<&'a DomainError> {
    error
        .downcast_ref::<DomainError>()
        .or_else(|| {
            error
                .downcast_ref::<crate::ticket_error::TicketDomainError>()
                .map(|error| &**error)
        })
        .or_else(|| {
            error
                .downcast_ref::<TranscriptHistoryUnavailableError>()
                .map(TranscriptHistoryUnavailableError::domain_error)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_keeps_its_fields() {
        let error = DomainError::new(
            ErrorCode::SESSION_NOT_FOUND,
            "Session not found",
            404,
            false,
        );
        assert_eq!(error.code, ErrorCode::SESSION_NOT_FOUND);
        assert_eq!(error.message, "Session not found");
        assert_eq!(error.status, 404);
        assert!(!error.retryable);
        assert_eq!(error.kind, DomainErrorKind::Domain);
        assert_eq!(error.kind.name(), "DomainError");
        assert!(error.cause.is_none());
        assert!(error.source().is_none());
        assert_eq!(error.to_string(), "Session not found");
        assert!(DomainError::new(ErrorCode::INTERNAL_ERROR, "A failure", 500, true).retryable);
    }

    #[test]
    fn a_validation_error_is_a_domain_error_that_is_not_retryable() {
        let error = DomainError::new_validation("Invalid provider ID");
        assert_eq!(error.code, ErrorCode::VALIDATION_FAILED);
        assert_eq!(error.message, "Invalid provider ID");
        assert_eq!(error.status, 400);
        assert!(!error.retryable);
        assert_eq!(error.kind, DomainErrorKind::Validation);
        assert_eq!(error.kind.name(), "ValidationDomainError");
    }

    #[test]
    fn a_project_unavailable_error_names_the_reason_and_the_path() {
        for (reason, name) in [
            (ProjectUnavailableReason::NotFound, "not-found"),
            (ProjectUnavailableReason::NotADirectory, "not-a-directory"),
            (ProjectUnavailableReason::OutsideBase, "outside-base"),
            (
                ProjectUnavailableReason::PermissionDenied,
                "permission-denied",
            ),
        ] {
            let error = DomainError::new_project_unavailable("/work/project", reason);
            assert_eq!(error.code, ErrorCode::PROJECT_UNAVAILABLE);
            assert_eq!(
                error.message,
                format!("Project folder unavailable ({name}): /work/project")
            );
            assert_eq!(error.status, 409);
            assert!(!error.retryable);
            assert_eq!(
                error.kind,
                DomainErrorKind::ProjectUnavailable {
                    project_path: "/work/project".to_owned(),
                    reason,
                }
            );
            assert_eq!(error.kind.name(), "ProjectUnavailableError");
        }
    }

    #[test]
    fn the_transcript_message_follows_whether_trying_again_can_succeed() {
        assert_eq!(
            transcript_unavailable_message(false),
            "Chat transcript is unavailable."
        );
        assert_eq!(
            transcript_unavailable_message(true),
            "Chat transcript is temporarily unavailable. Retry the request."
        );
        assert_eq!(
            transcript_unavailable_message(false),
            TRANSCRIPT_UNAVAILABLE_MESSAGE
        );
        assert_eq!(
            transcript_unavailable_message(true),
            TRANSCRIPT_TEMPORARILY_UNAVAILABLE_MESSAGE
        );
    }

    #[test]
    fn a_caused_error_reports_its_cause() {
        #[derive(Debug)]
        struct Failure;
        impl fmt::Display for Failure {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("the disk is full")
            }
        }
        impl Error for Failure {}

        let error = DomainError::new(
            ErrorCode::CHAT_PARENT_SAVE_FAILED,
            "Chat parent could not be saved",
            503,
            true,
        )
        .with_cause(Box::new(Failure));
        assert_eq!(
            error.source().map(ToString::to_string).as_deref(),
            Some("the disk is full")
        );
        assert_eq!(
            error.cause.as_deref().map(ToString::to_string).as_deref(),
            Some("the disk is full")
        );
        // The cause does not change what the error says.
        assert_eq!(error.to_string(), "Chat parent could not be saved");
        assert!(error.source().and_then(|cause| cause.source()).is_none());
    }

    #[test]
    fn is_recognized_through_an_error_reference() {
        let boxed: Box<dyn Error> = Box::new(DomainError::new_validation("x"));
        let reference: &(dyn Error + 'static) = boxed.as_ref();
        assert!(is_domain_error(reference));
        let error = reference
            .downcast_ref::<DomainError>()
            .expect("a validation error is a domain error");
        assert_eq!(error.code, ErrorCode::VALIDATION_FAILED);
        assert!(is_domain_error(&DomainError::new_project_unavailable(
            "/p",
            ProjectUnavailableReason::PermissionDenied
        )));

        #[derive(Debug)]
        struct Other;
        impl fmt::Display for Other {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("other")
            }
        }
        impl Error for Other {}
        assert!(!is_domain_error(&Other));
        let other: Box<dyn Error> = Box::new(Other);
        assert!(!is_domain_error(other.as_ref()));
    }

    #[test]
    fn an_erased_history_error_keeps_its_domain_fields_and_concrete_state() {
        let error: Box<dyn Error> =
            TranscriptHistoryUnavailableError::new("SYNTHETIC_HISTORY_ERROR", true, None).into();
        let domain = as_domain_error(error.as_ref()).unwrap();
        assert_eq!(domain.code, ErrorCode::TRANSCRIPT_UNAVAILABLE);
        assert_eq!(domain.status, 422);
        assert!(domain.retryable);
        let history = error
            .downcast_ref::<TranscriptHistoryUnavailableError>()
            .unwrap();
        assert_eq!(
            history.history_state,
            ChatHistoryState::Degraded {
                error_code: "SYNTHETIC_HISTORY_ERROR".into(),
                retryable: true,
            }
        );
    }
}
