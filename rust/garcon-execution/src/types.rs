//! State-facing and operation-facing contracts from the controller types.ts.
//!
//! Coordinator option composition, turn runner wiring, delivery
//! envelopes for assembled commands, and the coordinator's
//! command/lifecycle/query facets belong to the wave 2 execution unit.

use garcon_base::{
    domain_error::DomainError,
    errors::{DiagnosticError, ErrorInput, ErrorMetadata},
};
use garcon_contract::{chat_stop::ChatStopOutcome, error_codes::ErrorCode};
use std::{error::Error, future::Future, pin::Pin, rc::Rc};

use async_trait::async_trait;
use garcon_contract::{
    async_user_questions::AsyncQuestionReply,
    chat_command_contracts::{QueueEntryPlacement, SteerDeliveryOutcome},
    user_message_presentation::UserMessagePresentation,
    ws_requests::AgentCommandImage,
};
use garcon_interface::{
    execution::AgentExecutionAdmission,
    services::{AgentSteerResult, AgentSteerTarget},
};
use garcon_js::Number;
use tokio_util::sync::CancellationToken;

use serde::{Deserialize, Serialize};

use crate::chat_execution_control_transitions::TransitionRejection;
use crate::control_state::{
    MAX_QUEUED_ATTACHMENT_BYTES, StoredChatExecutionControlState, StoredControlInput,
    clone_stored_chat_execution_control,
};
use crate::{
    execution_attempt::QueueExecutionAttempt,
    execution_ownership::{AdmissionAbortReason, ExecutionAdmission},
};
use crate::{
    session_types::{AgentSteerOptions, RunAgentTurnOptions},
    turn_identity::{TurnCommandType, TurnIdentity},
};

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

pub fn execution_error_input<'a>(error: &'a (dyn Error + 'static)) -> ErrorInput<'a> {
    if let Some(error) = error.downcast_ref::<ControlTransitionError>() {
        ErrorInput::Diagnostic(error)
    } else if let Some(error) = error.downcast_ref::<QueueEntryMutationError>() {
        ErrorInput::Diagnostic(error)
    } else if let Some(error) = error.downcast_ref::<QueuePauseChangedError>() {
        ErrorInput::Diagnostic(error)
    } else if let Some(error) =
        error.downcast_ref::<crate::queue_steer_error::QueueEntrySteerError>()
    {
        ErrorInput::Diagnostic(error)
    } else if let Some(error) = error.downcast_ref::<crate::steering_errors::SteerDeliveryError>() {
        ErrorInput::Diagnostic(error)
    } else if let Some(error) = error.downcast_ref::<crate::command_ledger::CommandLedgerError>() {
        ErrorInput::Diagnostic(error)
    } else if let Some(error) =
        error.downcast_ref::<crate::accepted_input_transcript::MissingAcceptedInputRequestId>()
    {
        ErrorInput::Diagnostic(error)
    } else if let Some(error) =
        error.downcast_ref::<crate::accepted_input_handler::ExecutionAggregateError>()
    {
        ErrorInput::Diagnostic(error)
    } else {
        ErrorInput::Error(error)
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

pub type ExecutionOperationResult<T> = Result<T, Box<dyn Error>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UserInputCommandType {
    ChatStart,
    AgentRun,
    ForkRun,
    AgentCompact,
    Steer,
}

impl From<TurnCommandType> for UserInputCommandType {
    fn from(command_type: TurnCommandType) -> Self {
        match command_type {
            TurnCommandType::ChatStart => Self::ChatStart,
            TurnCommandType::AgentRun => Self::AgentRun,
            TurnCommandType::ForkRun => Self::ForkRun,
            TurnCommandType::AgentCompact => Self::AgentCompact,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct UserInputAdmissionOptions {
    pub client_request_id: Option<String>,
    pub client_message_id: Option<String>,
    pub transcript_view_id: Option<String>,
    pub turn_id: Option<String>,
    pub model: Option<String>,
    pub images: Option<Vec<AgentCommandImage>>,
    pub excluded_resend_ordinals: Option<Vec<Number>>,
    pub question_reply: Option<AsyncQuestionReply>,
    pub command_type: Option<UserInputCommandType>,
    pub created_at: Option<String>,
    pub user_message_presentation: Option<UserMessagePresentation>,
}

impl UserInputAdmissionOptions {
    pub(crate) fn from_run_options(
        options: &RunAgentTurnOptions,
        user_message_presentation: Option<UserMessagePresentation>,
    ) -> Self {
        Self {
            client_request_id: options.client_request_id.clone(),
            client_message_id: options.client_message_id.clone(),
            transcript_view_id: options.transcript_view_id.clone(),
            turn_id: options.turn_id.clone(),
            model: options.model.clone(),
            images: options.images.clone(),
            excluded_resend_ordinals: options.excluded_resend_ordinals.clone(),
            question_reply: options.question_reply.clone(),
            command_type: options.command_type.map(Into::into),
            created_at: options.created_at.clone(),
            user_message_presentation,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedExecutionCommand<EntryId = Option<String>> {
    pub key: String,
    pub chat_id: String,
    pub client_request_id: String,
    pub turn_id: Option<String>,
    pub entry_id: EntryId,
}

impl AcceptedExecutionCommand<String> {
    pub(crate) fn for_settlement(&self) -> AcceptedExecutionCommand {
        AcceptedExecutionCommand {
            key: self.key.clone(),
            chat_id: self.chat_id.clone(),
            client_request_id: self.client_request_id.clone(),
            turn_id: self.turn_id.clone(),
            entry_id: Some(self.entry_id.clone()),
        }
    }
}

pub struct PreScheduleFailure<'a> {
    pub error: &'a (dyn Error + 'static),
    pub retryable: bool,
    pub preserve_fork_preparation: bool,
}

#[async_trait(?Send)]
pub trait CommandSettlementPort {
    async fn mark_scheduled(
        &self,
        command: &AcceptedExecutionCommand,
        turn_id: Option<&str>,
    ) -> ExecutionOperationResult<()>;
    async fn mark_pre_schedule_failure(
        &self,
        command: &AcceptedExecutionCommand,
        failure: PreScheduleFailure<'_>,
    ) -> ExecutionOperationResult<()>;
    async fn settle_queue_mutation(
        &self,
        command: &AcceptedExecutionCommand,
        entry_id: &str,
    ) -> ExecutionOperationResult<()>;
    async fn settle_queue_mutation_failure(
        &self,
        command: &AcceptedExecutionCommand,
        error: &(dyn Error + 'static),
    ) -> ExecutionOperationResult<()>;
    async fn settle_steer_success(
        &self,
        command: &AcceptedExecutionCommand,
        turn_id: &str,
    ) -> ExecutionOperationResult<()>;
    async fn settle_steer_failure(
        &self,
        command: &AcceptedExecutionCommand,
        error: &(dyn Error + 'static),
        delivery_outcome: Option<SteerDeliveryOutcome>,
    ) -> ExecutionOperationResult<()>;
    async fn settle_operation_failure(
        &self,
        command: &AcceptedExecutionCommand,
        error: &(dyn Error + 'static),
    ) -> ExecutionOperationResult<()>;
    async fn settle_duplicate_input(
        &self,
        command: &AcceptedExecutionCommand,
    ) -> ExecutionOperationResult<()>;
}

pub type LocalExecutionFuture<'a, T = ()> =
    Pin<Box<dyn Future<Output = ExecutionOperationResult<T>> + 'a>>;
pub type DirectDispatch =
    Box<dyn FnOnce(Rc<dyn AgentExecutionAdmission>) -> LocalExecutionFuture<'static>>;
pub type BeforeFailureRelease =
    Box<dyn FnOnce(AdmissionAbortReason) -> LocalExecutionFuture<'static>>;
pub type AfterPendingRegistered<'a> = Box<dyn FnOnce(String) -> LocalExecutionFuture<'a> + 'a>;
pub type PrepareSteerDelivery<'a> = Box<dyn FnOnce() -> LocalExecutionFuture<'a> + 'a>;

#[async_trait(?Send)]
pub trait AgentTurnRunnerPort {
    async fn run_agent_turn(
        &self,
        chat_id: &str,
        command: &str,
        options: RunAgentTurnOptions,
    ) -> ExecutionOperationResult<()>;
    async fn capture_steer_target(
        &self,
        chat_id: &str,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<Option<AgentSteerTarget>>;
    async fn steer_input(
        &self,
        chat_id: &str,
        input: &str,
        options: &AgentSteerOptions,
        target: Option<&AgentSteerTarget>,
        prepare_delivery: PrepareSteerDelivery<'_>,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<AgentSteerResult>;
    async fn abort_session(&self, chat_id: &str) -> ExecutionOperationResult<bool>;
    fn is_chat_running(&self, chat_id: &str) -> bool;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectInputPreparationOperation {
    ChatStart,
    ForkRun,
    AgentHandoff,
}

impl DirectInputPreparationOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ChatStart => "chat-start",
            Self::ForkRun => "fork-run",
            Self::AgentHandoff => "agent-handoff",
        }
    }
}

pub struct DirectInputPreparationContext<'a> {
    pub signal: &'a CancellationToken,
    pub assert_admission_active: &'a dyn Fn() -> ExecutionOperationResult<()>,
}

#[async_trait(?Send)]
pub trait DirectInputPreparation {
    fn operation(&self) -> DirectInputPreparationOperation;
    async fn prepare(
        &self,
        context: DirectInputPreparationContext<'_>,
    ) -> ExecutionOperationResult<()>;
    async fn compensate(&self) -> ExecutionOperationResult<()>;
}

pub struct AcceptedDirectInput {
    pub command: AcceptedExecutionCommand,
    pub content: String,
    pub options: RunAgentTurnOptions,
    pub settlement: Rc<dyn CommandSettlementPort>,
    pub preparation: Option<Rc<dyn DirectInputPreparation>>,
    pub dispatch: Option<DirectDispatch>,
    pub user_message_presentation: Option<UserMessagePresentation>,
    pub admission_deadline: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DirectInputScheduleOutcome {
    Scheduled,
    Duplicate,
}

pub struct AcceptedDirectOperation {
    pub command: AcceptedExecutionCommand,
    pub settlement: Rc<dyn CommandSettlementPort>,
    pub dispatch: DirectDispatch,
    pub admission_deadline: Option<f64>,
}

pub struct AcceptedQueueCreate {
    pub command: AcceptedExecutionCommand<String>,
    pub content: String,
    pub images: Vec<AgentCommandImage>,
    pub client_message_id: String,
    pub transcript_view_id: String,
    pub excluded_resend_ordinals: Option<Vec<Number>>,
    pub settlement: Rc<dyn CommandSettlementPort>,
    pub admission_deadline: Option<f64>,
}

pub struct AcceptedQueueReplace {
    pub command: AcceptedExecutionCommand<String>,
    pub content: String,
    pub expected_revision: u64,
    pub settlement: Rc<dyn CommandSettlementPort>,
}

pub struct AcceptedQueueDelete {
    pub command: AcceptedExecutionCommand<String>,
    pub settlement: Rc<dyn CommandSettlementPort>,
}

pub struct AcceptedQueueMove {
    pub command: AcceptedExecutionCommand<String>,
    pub target_entry_id: String,
    pub placement: QueueEntryPlacement,
    pub expected_reorder_revision: u64,
    pub expected_source_revision: u64,
    pub expected_target_revision: u64,
    pub settlement: Rc<dyn CommandSettlementPort>,
}

#[derive(Debug, Clone)]
pub struct CapturedSteerTarget {
    pub attempt: Rc<QueueExecutionAttempt>,
    pub turn_id: String,
    pub client_request_id: Option<String>,
    pub provider_target: Option<AgentSteerTarget>,
    pub deadline: Option<f64>,
}

impl CapturedSteerTarget {
    pub fn identity(&self) -> TurnIdentity {
        TurnIdentity {
            turn_id: Some(self.turn_id.clone()),
            client_request_id: self.client_request_id.clone(),
        }
    }
}

pub enum CapturedControlOffer {
    Delivered,
    AfterTurn { attempt: Rc<QueueExecutionAttempt> },
}

pub struct AcceptedSteerInput<EntryId = Option<String>> {
    pub question_reply: Option<AsyncQuestionReply>,
    pub command: AcceptedExecutionCommand<EntryId>,
    pub content: String,
    pub provider_content: String,
    pub client_message_id: String,
    pub transcript_view_id: String,
    pub target: CapturedSteerTarget,
    pub settlement: Rc<dyn CommandSettlementPort>,
    pub user_message_presentation: Option<UserMessagePresentation>,
}

pub struct AcceptedQueueEntrySteer {
    pub steer: AcceptedSteerInput<String>,
    pub expected_revision: u64,
    pub expected_reorder_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedSteerOutcome {
    pub turn_id: String,
    pub duplicate: bool,
}

#[derive(Debug, Serialize)]
pub struct AcceptedQueueEntrySteerOutcome {
    #[serde(flatten)]
    pub outcome: AcceptedSteerOutcome,
    pub control: StoredChatExecutionControlState,
}

pub struct AcceptedQueueSteerCreate {
    pub command: AcceptedExecutionCommand<String>,
    pub content: String,
    pub client_message_id: String,
    pub transcript_view_id: String,
    pub settlement: Rc<dyn CommandSettlementPort>,
}

pub struct AcceptedQueueEntrySteerMark {
    pub command: AcceptedExecutionCommand<String>,
    pub expected_revision: u64,
    pub expected_reorder_revision: u64,
    pub settlement: Rc<dyn CommandSettlementPort>,
}

#[async_trait(?Send)]
pub trait ProjectAdmissionPort {
    async fn assert_available(
        &self,
        chat_id: &str,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<()>;
}

pub trait QueuedAttachmentAdmissionPort {
    fn assert_supported(
        &self,
        chat_id: &str,
        attachments: &[AgentCommandImage],
    ) -> ExecutionOperationResult<()>;
}

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
