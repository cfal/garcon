//! Ports the controller's execution error constructors.

use std::error::Error;

use garcon_base::domain_error::{DomainError, as_domain_error};
use garcon_contract::error_codes::ErrorCode;

use crate::{
    queue_steer_error::QueueEntrySteerError,
    steering_errors::SteerDeliveryError,
    types::{QueueEntryMutationError, QueuePauseChangedError},
};

pub(crate) fn execution_domain_error<'a>(
    error: &'a (dyn Error + 'static),
) -> Option<&'a DomainError> {
    as_domain_error(error)
        .or_else(|| {
            error
                .downcast_ref::<QueueEntryMutationError>()
                .map(|error| &error.domain)
        })
        .or_else(|| {
            error
                .downcast_ref::<QueuePauseChangedError>()
                .map(|error| &error.domain)
        })
        .or_else(|| {
            error
                .downcast_ref::<QueueEntrySteerError>()
                .map(|error| &error.domain)
        })
        .or_else(|| {
            error
                .downcast_ref::<SteerDeliveryError>()
                .map(|error| &error.domain)
        })
}

/// Ports `isRecoverablePreambleAdmissionError` in controller/preambles/selection.ts.
/// The eventual selection port uses this predicate rather than defining another.
pub fn is_recoverable_preamble_admission_error(error: &(dyn Error + 'static)) -> bool {
    execution_domain_error(error).is_some_and(|error| {
        matches!(
            error.code,
            ErrorCode::PREAMBLE_SELECTION_COMPOSITION_INVALID
                | ErrorCode::PREAMBLE_SLASH_COMMAND_BLOCKED
        )
    })
}

pub fn control_input_blocked_error() -> DomainError {
    DomainError::new(
        ErrorCode::SESSION_BUSY,
        "Server control input is currently blocked",
        409,
        true,
    )
}

pub fn server_shutting_down_error() -> DomainError {
    DomainError::new(
        ErrorCode::SERVER_SHUTTING_DOWN,
        "The server is shutting down",
        503,
        true,
    )
}

pub fn chat_not_found_error() -> DomainError {
    DomainError::new(
        ErrorCode::SESSION_NOT_FOUND,
        "Session not found",
        404,
        false,
    )
}
