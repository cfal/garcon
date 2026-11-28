//! State-facing and operation-facing contracts from the controller types.ts.
//!
//! Coordinator option composition, turn runner and settlement wiring, delivery
//! and admission envelopes for assembled commands, and the coordinator's
//! command/lifecycle/query facets belong to the wave 2 execution unit.

use garcon_base::{
    domain_error::DomainError,
    errors::{DiagnosticError, ErrorMetadata},
};
use garcon_contract::{chat_stop::ChatStopOutcome, error_codes::ErrorCode};
use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::chat_execution_control_transitions::TransitionRejection;
use crate::control_state::{
    MAX_QUEUED_ATTACHMENT_BYTES, StoredChatExecutionControlState, StoredControlInput,
    clone_stored_chat_execution_control,
};
use crate::execution_ownership::ExecutionAdmission;
use crate::turn_identity::TurnIdentity;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueEntryMutationCode {
    NotFound,
    AlreadySent,
    InFlight,
    RevisionConflict,
    ReorderConflict,
}

impl From<QueueEntryMutationCode> for ErrorCode {
    fn from(value: QueueEntryMutationCode) -> Self {
        match value {
            QueueEntryMutationCode::NotFound => ErrorCode::QUEUE_ENTRY_NOT_FOUND,
            QueueEntryMutationCode::AlreadySent => ErrorCode::QUEUE_ENTRY_ALREADY_SENT,
            QueueEntryMutationCode::InFlight => ErrorCode::QUEUE_ENTRY_IN_FLIGHT,
            QueueEntryMutationCode::RevisionConflict => ErrorCode::QUEUE_ENTRY_REVISION_CONFLICT,
            QueueEntryMutationCode::ReorderConflict => ErrorCode::QUEUE_ENTRY_REORDER_CONFLICT,
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{domain}")]
pub struct QueueEntryMutationError {
    #[source]
    pub domain: DomainError,
    pub control: Box<StoredChatExecutionControlState>,
}

impl QueueEntryMutationError {
    pub fn new(
        code: QueueEntryMutationCode,
        message: impl Into<String>,
        control: &StoredChatExecutionControlState,
    ) -> Self {
        let status = if code == QueueEntryMutationCode::NotFound {
            404
        } else {
            409
        };
        Self {
            domain: DomainError::new(code.into(), message, status, false),
            control: Box::new(clone_stored_chat_execution_control(control)),
        }
    }
}

impl DiagnosticError for QueueEntryMutationError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "QueueEntryMutationError",
            code: Some(self.domain.code.as_str()),
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{domain}")]
pub struct QueuePauseChangedError {
    #[source]
    pub domain: DomainError,
    pub control: Box<StoredChatExecutionControlState>,
}

impl QueuePauseChangedError {
    pub fn new(control: &StoredChatExecutionControlState) -> Self {
        Self {
            domain: DomainError::new(
                ErrorCode::QUEUE_PAUSE_CHANGED,
                "The queue pause changed before it could be resumed",
                409,
                false,
            ),
            control: Box::new(clone_stored_chat_execution_control(control)),
        }
    }
}

impl DiagnosticError for QueuePauseChangedError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "QueuePauseChangedError",
            code: Some(self.domain.code.as_str()),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ControlTransitionError {
    #[error(transparent)]
    Domain(#[from] DomainError),
    #[error(transparent)]
    Mutation(#[from] QueueEntryMutationError),
    #[error(transparent)]
    Pause(#[from] QueuePauseChangedError),
}

impl ControlTransitionError {
    pub fn domain_error(&self) -> &DomainError {
        match self {
            Self::Domain(error) => error,
            Self::Mutation(error) => &error.domain,
            Self::Pause(error) => &error.domain,
        }
    }
}

impl DiagnosticError for ControlTransitionError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        match self {
            Self::Domain(error) => ErrorMetadata {
                name: error.kind.name(),
                code: Some(error.code.as_str()),
            },
            Self::Mutation(error) => error.diagnostic_metadata(),
            Self::Pause(error) => error.diagnostic_metadata(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCommandMutationResult {
    pub entry_id: String,
    pub control: StoredChatExecutionControlState,
    pub duplicate: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StopActiveTurnResult {
    pub outcome: ChatStopOutcome,
    pub control: StoredChatExecutionControlState,
}

pub type ServerControlInput = StoredControlInput;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DrainSuppressionReason {
    Abort,
    ManualStop,
    Deletion,
}

#[derive(Debug, Clone)]
pub struct DirectTurnReservation {
    pub chat_id: String,
    pub reservation_id: String,
    pub execution_admission: Rc<ExecutionAdmission>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSnapshotReservation {
    pub chat_id: String,
    pub reservation_id: String,
}

pub fn execution_turn_identity(turn: &TurnIdentity) -> Option<TurnIdentity> {
    let identity = TurnIdentity {
        turn_id: turn.turn_id.as_ref().filter(|id| !id.is_empty()).cloned(),
        client_request_id: turn
            .client_request_id
            .as_ref()
            .filter(|id| !id.is_empty())
            .cloned(),
    };
    (identity.turn_id.is_some() || identity.client_request_id.is_some()).then_some(identity)
}

pub fn transition_error(
    rejection: &TransitionRejection,
    control: &StoredChatExecutionControlState,
) -> ControlTransitionError {
    use QueueEntryMutationCode as Code;
    use TransitionRejection::*;
    let entry_error = |code, message| QueueEntryMutationError::new(code, message, control).into();
    match rejection {
        ValidationFailed => DomainError::new(ErrorCode::VALIDATION_FAILED, "content or attachments are required", 400, false).into(),
        IdempotencyConflict { client_message_id } => DomainError::new(
            ErrorCode::IDEMPOTENCY_CONFLICT,
            format!("Client message {client_message_id} was already queued with different content"), 409, false,
        ).into(),
        QueueEntryNotFound { .. } => entry_error(Code::NotFound, "This queued message is no longer available"),
        QueueEntryAlreadySent { .. } => entry_error(Code::AlreadySent, "This queued message has already been sent"),
        QueueEntryInFlight { .. } => entry_error(Code::InFlight, "This queued message is already being steered"),
        QueueEntryRevisionConflict { .. } => entry_error(Code::RevisionConflict, "This queued message changed before it could be saved"),
        QueueEntryReorderConflict => entry_error(Code::ReorderConflict, "The queue order changed before the item could be moved"),
        QueuePauseChanged => QueuePauseChangedError::new(control).into(),
        ControlInputQueueFull => DomainError::new(ErrorCode::CONTROL_INPUT_QUEUE_FULL, "The inter-agent control input lane is full", 409, false).into(),
        QueueAttachmentsFull => DomainError::new(
            ErrorCode::QUEUE_ATTACHMENTS_FULL,
            format!(
                "Queued attachments are limited to {} MB per chat. Send or remove queued messages with attachments first.",
                MAX_QUEUED_ATTACHMENT_BYTES / (1024 * 1024),
            ),
            409, false,
        ).into(),
    }
}
