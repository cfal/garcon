//! Ports the controller's steering error constructors.

use std::error::Error;

use garcon_base::{
    domain_error::DomainError,
    errors::{DiagnosticError, ErrorMetadata},
};
use garcon_contract::error_codes::ErrorCode;
use serde::{Deserialize, Serialize};

pub const STEER_NOT_DELIVERED_MESSAGE: &str = "Steering input was not delivered.";
pub const STEER_OUTCOME_UNKNOWN_MESSAGE: &str =
    "Steering delivery could not be confirmed. Check the chat before sending it again.";
pub const QUEUE_STEER_FINALIZATION_FAILED_MESSAGE: &str = "Steering was accepted, but the queued message could not be finalized. The queue was paused for review.";
pub const QUEUE_STEER_RECOVERY_FAILED_MESSAGE: &str = "Steering was not delivered, and the queued message could not be restored safely. Refresh before continuing.";

pub fn steering_unsupported_error() -> DomainError {
    DomainError::new(
        ErrorCode::OPERATION_UNSUPPORTED,
        "This agent does not support steering",
        422,
        false,
    )
}

pub fn steer_turn_changed_error() -> DomainError {
    DomainError::new(
        ErrorCode::STEER_TURN_CHANGED,
        "The active turn changed before steering could be applied",
        409,
        false,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SteerDeliveryFailureOutcome {
    NotSent,
    Unknown,
}

#[derive(Debug, thiserror::Error)]
#[error("{domain}")]
pub struct SteerDeliveryError {
    #[source]
    pub domain: DomainError,
    pub outcome: SteerDeliveryFailureOutcome,
}

impl SteerDeliveryError {
    pub fn new(cause: Box<dyn Error>, outcome: SteerDeliveryFailureOutcome) -> Self {
        let (code, message) = match outcome {
            SteerDeliveryFailureOutcome::NotSent => {
                (ErrorCode::STEER_NOT_DELIVERED, STEER_NOT_DELIVERED_MESSAGE)
            }
            SteerDeliveryFailureOutcome::Unknown => (
                ErrorCode::STEER_OUTCOME_UNKNOWN,
                STEER_OUTCOME_UNKNOWN_MESSAGE,
            ),
        };
        Self {
            domain: DomainError::new(code, message, 500, false).with_cause(cause),
            outcome,
        }
    }
}

impl DiagnosticError for SteerDeliveryError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "SteerDeliveryError",
            code: Some(self.domain.code.as_str()),
        }
    }
}
