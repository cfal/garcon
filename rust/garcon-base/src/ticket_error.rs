//! HTTP and retry policies for ticket domain errors.

use std::{error::Error, fmt, ops::Deref};

use garcon_contract::{
    error_codes::ErrorCode,
    ticket_validation::TicketValidationError,
    tickets::{Ticket, TicketComment, TicketErrorCode},
};

use crate::domain_error::DomainError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct TicketErrorPolicy {
    pub status: u16,
    pub retryable: bool,
}

pub fn ticket_error_policy(code: TicketErrorCode) -> TicketErrorPolicy {
    let (status, retryable) = match ErrorCode::from(code) {
        ErrorCode::TICKET_VALIDATION_FAILED => (400, false),
        ErrorCode::TICKET_UNAUTHORIZED => (401, false),
        ErrorCode::TICKET_FORBIDDEN | ErrorCode::TICKET_COMMANDS_DISABLED => (403, false),
        ErrorCode::TICKET_NOT_FOUND
        | ErrorCode::TICKET_COMMENT_NOT_FOUND
        | ErrorCode::TICKET_CHAT_NOT_FOUND => (404, false),
        ErrorCode::TICKET_STORE_CHANGED
        | ErrorCode::TICKET_REVISION_CONFLICT
        | ErrorCode::TICKET_COMMENT_REVISION_CONFLICT
        | ErrorCode::TICKET_ALREADY_CLAIMED
        | ErrorCode::TICKET_REQUEST_CONFLICT
        | ErrorCode::TICKET_RELATIONSHIP_CYCLE
        | ErrorCode::TICKET_INVALID_TRANSITION
        | ErrorCode::TICKET_LIMIT_REACHED
        | ErrorCode::TICKET_SOURCE_UNAVAILABLE => (409, false),
        ErrorCode::TICKET_COLLECTION_CHANGED => (409, true),
        ErrorCode::TICKET_REQUEST_TOO_LARGE | ErrorCode::TICKET_RESULT_TOO_LARGE => (413, false),
        ErrorCode::TICKET_PROJECT_UNAVAILABLE => (503, true),
        ErrorCode::TICKET_STORAGE_UNAVAILABLE => (503, false),
        ErrorCode::TICKET_INTERNAL_ERROR => (500, false),
        // INFALLIBLE: covers every registered ErrorCode with the TICKET_ prefix.
        _ => unreachable!("registered ticket code has no error policy"),
    };
    TicketErrorPolicy { status, retryable }
}

#[derive(Debug)]
pub struct TicketDomainError {
    domain: DomainError,
    pub code: TicketErrorCode,
    pub current_ticket: Option<Ticket>,
    pub current_comment: Option<TicketComment>,
}

impl TicketDomainError {
    pub const NAME: &'static str = "TicketDomainError";

    pub fn new(
        code: TicketErrorCode,
        message: impl Into<String>,
        current_ticket: Option<Ticket>,
        current_comment: Option<TicketComment>,
    ) -> Self {
        let policy = ticket_error_policy(code);
        Self {
            domain: DomainError::new(code.into(), message, policy.status, policy.retryable),
            code,
            current_ticket,
            current_comment,
        }
    }
}

impl Deref for TicketDomainError {
    type Target = DomainError;
    fn deref(&self) -> &DomainError {
        &self.domain
    }
}

impl fmt::Display for TicketDomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.domain, formatter)
    }
}

impl Error for TicketDomainError {}

impl From<TicketValidationError> for TicketDomainError {
    fn from(error: TicketValidationError) -> Self {
        // INFALLIBLE: TICKET_VALIDATION_FAILED is a registered ticket code.
        let code = TicketErrorCode::try_from(ErrorCode::TICKET_VALIDATION_FAILED)
            .expect("ticket validation code");
        Self::new(code, error.to_string(), None, None)
    }
}

pub fn validate_ticket_input<T, E: Into<Box<dyn Error>>>(
    parse: impl FnOnce() -> Result<T, E>,
) -> Result<T, Box<dyn Error>> {
    parse().map_err(
        |error| match error.into().downcast::<TicketValidationError>() {
            Ok(error) => Box::new(TicketDomainError::from(*error)),
            Err(error) => error,
        },
    )
}
