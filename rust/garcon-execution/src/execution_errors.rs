//! Ports the controller's execution error constructors.

use garcon_base::domain_error::DomainError;
use garcon_contract::error_codes::ErrorCode;

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
