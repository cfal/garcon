//! Ports the queued steering error and its optional control snapshot.

use std::error::Error;

use garcon_base::{
    domain_error::DomainError,
    errors::{DiagnosticError, ErrorMetadata},
};
use garcon_contract::chat_command_contracts::{CommandErrorCode, SteerDeliveryOutcome};

use crate::control_state::{StoredChatExecutionControlState, clone_stored_chat_execution_control};

#[derive(Debug, thiserror::Error)]
#[error("{domain}")]
pub struct QueueEntrySteerError {
    #[source]
    pub domain: DomainError,
    pub delivery_outcome: SteerDeliveryOutcome,
    pub control: Option<Box<StoredChatExecutionControlState>>,
}

impl QueueEntrySteerError {
    pub fn new(
        code: CommandErrorCode,
        message: impl Into<String>,
        status: u16,
        delivery_outcome: SteerDeliveryOutcome,
        control: Option<&StoredChatExecutionControlState>,
        cause: Option<Box<dyn Error>>,
    ) -> Self {
        let mut domain = DomainError::new(code.into(), message, status, false);
        domain.cause = cause;
        Self {
            domain,
            delivery_outcome,
            control: control.map(|control| Box::new(clone_stored_chat_execution_control(control))),
        }
    }
}

impl DiagnosticError for QueueEntrySteerError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "QueueEntrySteerError",
            code: Some(self.domain.code.as_str()),
        }
    }
}
