//! Drives accepted commands through the coordinator and queue-control ports.
//! Queued input is only recorded here as queue control; the drainer owns the
//! synchronous durable admission before it dispatches the turn.

use std::{error::Error, future::Future, rc::Rc};

use async_trait::async_trait;
use garcon_base::{
    domain_error::DomainError,
    errors::{DiagnosticError, ErrorMetadata},
    log::{Logger, ScopedLogger, create_logger},
};
use garcon_contract::{
    chat_command_contracts::{CommandErrorCode, SteerDeliveryOutcome},
    error_codes::ErrorCode,
    queue_state::AutomaticQueuePauseKind,
    user_message_presentation::UserMessagePresentation,
};
use garcon_interface::execution::AgentExecutionAdmission;

use crate::{
    chat_execution_control_operations::{
        ChatExecutionControlOperations, QueueEntryMutationResult, QueueMoveResult, ReservedSteer,
    },
    chat_execution_control_transitions::{
        DeleteQueueEntryInput, MoveQueueEntryInput, ObservedQueueEntry, QueueCommandIdentity,
        QueueEntryInput, ReplaceQueueEntryInput,
    },
    control_state::{
        StoredChatExecutionControlState, StoredQueueEntryStatus, StoredQueueSubmissionIdentity,
        has_pending_turn_input,
    },
    execution_errors::{execution_domain_error, is_recoverable_preamble_admission_error},
    execution_ownership::AdmissionAbortReason,
    queue_steer_error::QueueEntrySteerError,
    runtime_router_errors::is_lost_launch_reply,
    session_types::{AgentSteerOptions, RunAgentTurnOptions},
    steering_errors::{
        QUEUE_STEER_FINALIZATION_FAILED_MESSAGE, QUEUE_STEER_RECOVERY_FAILED_MESSAGE,
        STEER_NOT_DELIVERED_MESSAGE, STEER_OUTCOME_UNKNOWN_MESSAGE, SteerDeliveryError,
        SteerDeliveryFailureOutcome,
    },
    turn_identity::TurnIdentity,
    types::{
        AcceptedDirectInput, AcceptedDirectOperation, AcceptedExecutionCommand,
        AcceptedQueueCreate, AcceptedQueueDelete, AcceptedQueueEntrySteer,
        AcceptedQueueEntrySteerMark, AcceptedQueueEntrySteerOutcome, AcceptedQueueMove,
        AcceptedQueueReplace, AcceptedQueueSteerCreate, AcceptedSteerInput, AcceptedSteerOutcome,
        AfterPendingRegistered, BeforeFailureRelease, CapturedSteerTarget, CommandSettlementPort,
        DirectDispatch, DirectInputPreparation, DirectInputPreparationContext,
        DirectInputScheduleOutcome, DirectTurnReservation, ExecutionOperationResult,
        LocalExecutionFuture, PreScheduleFailure, ProjectAdmissionPort, QueueCommandMutationResult,
        QueueEntryMutationError, QueuePauseChangedError, UserInputAdmissionOptions,
    },
};

pub struct AcceptedSteerDelivery<'a> {
    pub chat_id: &'a str,
    pub content: &'a str,
    pub provider_content: &'a str,
    pub options: AgentSteerOptions,
    pub target: &'a CapturedSteerTarget,
    pub after_pending_registered: AfterPendingRegistered<'a>,
    pub user_message_presentation: Option<UserMessagePresentation>,
}

#[async_trait(?Send)]
pub trait AcceptedInputCoordinator {
    fn request_drain(&self, chat_id: &str, context: &str) -> ExecutionOperationResult<()>;
    fn reserve_direct(
        &self,
        chat_id: &str,
        turn: &TurnIdentity,
    ) -> ExecutionOperationResult<DirectTurnReservation>;
    fn checkpoint(&self, reservation: &DirectTurnReservation) -> ExecutionOperationResult<()>;
    fn has_matching_input(
        &self,
        chat_id: &str,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool>;
    async fn admit_input(
        &self,
        chat_id: &str,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool>;
    fn discard_prepared_input(
        &self,
        chat_id: &str,
        client_message_id: Option<&str>,
    ) -> ExecutionOperationResult<()>;
    async fn release_direct(
        &self,
        reservation: &DirectTurnReservation,
    ) -> ExecutionOperationResult<()>;
    fn run_direct(
        self: Rc<Self>,
        reservation: DirectTurnReservation,
        content: String,
        options: RunAgentTurnOptions,
        dispatch: Option<DirectDispatch>,
        before_failure_release: Option<BeforeFailureRelease>,
    ) -> LocalExecutionFuture<'static>;
    fn track_dispatch(&self, task: LocalExecutionFuture<'static>) -> ExecutionOperationResult<()>;
    async fn steer(
        &self,
        input: AcceptedSteerDelivery<'_>,
    ) -> ExecutionOperationResult<AcceptedSteerOutcome>;
}

#[async_trait(?Send)]
pub trait AcceptedInputControls {
    async fn create(
        &self,
        chat: &str,
        input: &QueueEntryInput,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<QueueEntryMutationResult>;
    async fn replace(
        &self,
        chat: &str,
        input: &ReplaceQueueEntryInput,
    ) -> ExecutionOperationResult<QueueEntryMutationResult>;
    async fn delete(
        &self,
        chat: &str,
        input: &DeleteQueueEntryInput,
    ) -> ExecutionOperationResult<QueueCommandMutationResult>;
    async fn move_entry(
        &self,
        chat: &str,
        input: &MoveQueueEntryInput,
    ) -> ExecutionOperationResult<QueueMoveResult>;
    async fn create_steer(
        &self,
        chat: &str,
        content: &str,
        command: &QueueCommandIdentity,
        submission: &StoredQueueSubmissionIdentity,
    ) -> ExecutionOperationResult<QueueCommandMutationResult>;
    async fn mark_steer(
        &self,
        chat: &str,
        input: &ObservedQueueEntry,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState>;
    async fn reserve_steer(
        &self,
        chat: &str,
        input: &ObservedQueueEntry,
    ) -> ExecutionOperationResult<ReservedSteer>;
    async fn consume_steer(
        &self,
        chat: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState>;
    async fn release_steer(
        &self,
        chat: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState>;
    async fn requeue_and_pause(
        &self,
        chat: &str,
        entry_id: &str,
        kind: AutomaticQueuePauseKind,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState>;
    async fn read(&self, chat: &str) -> ExecutionOperationResult<StoredChatExecutionControlState>;
}

#[async_trait(?Send)]
impl AcceptedInputControls for ChatExecutionControlOperations {
    async fn create(
        &self,
        chat: &str,
        input: &QueueEntryInput,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<QueueEntryMutationResult> {
        ChatExecutionControlOperations::create(self, chat, input, deadline).await
    }
    async fn replace(
        &self,
        chat: &str,
        input: &ReplaceQueueEntryInput,
    ) -> ExecutionOperationResult<QueueEntryMutationResult> {
        ChatExecutionControlOperations::replace(self, chat, input).await
    }
    async fn delete(
        &self,
        chat: &str,
        input: &DeleteQueueEntryInput,
    ) -> ExecutionOperationResult<QueueCommandMutationResult> {
        ChatExecutionControlOperations::delete(self, chat, input).await
    }
    async fn move_entry(
        &self,
        chat: &str,
        input: &MoveQueueEntryInput,
    ) -> ExecutionOperationResult<QueueMoveResult> {
        ChatExecutionControlOperations::move_entry(self, chat, input).await
    }
    async fn create_steer(
        &self,
        chat: &str,
        content: &str,
        command: &QueueCommandIdentity,
        submission: &StoredQueueSubmissionIdentity,
    ) -> ExecutionOperationResult<QueueCommandMutationResult> {
        ChatExecutionControlOperations::create_steer(self, chat, content, command, submission).await
    }
    async fn mark_steer(
        &self,
        chat: &str,
        input: &ObservedQueueEntry,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        ChatExecutionControlOperations::mark_steer(self, chat, input).await
    }
    async fn reserve_steer(
        &self,
        chat: &str,
        input: &ObservedQueueEntry,
    ) -> ExecutionOperationResult<ReservedSteer> {
        ChatExecutionControlOperations::reserve_steer(self, chat, input).await
    }
    async fn consume_steer(
        &self,
        chat: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        ChatExecutionControlOperations::consume_steer(self, chat, entry_id).await
    }
    async fn release_steer(
        &self,
        chat: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        ChatExecutionControlOperations::release_steer(self, chat, entry_id).await
    }
    async fn requeue_and_pause(
        &self,
        chat: &str,
        entry_id: &str,
        kind: AutomaticQueuePauseKind,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        ChatExecutionControlOperations::requeue_and_pause(self, chat, entry_id, kind).await
    }
    async fn read(&self, chat: &str) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        ChatExecutionControlOperations::read(self, chat).await
    }
}

pub struct AcceptedInputDeps {
    pub controls: Rc<dyn AcceptedInputControls>,
    pub coordinator: Rc<dyn AcceptedInputCoordinator>,
    pub project_admission: Rc<dyn ProjectAdmissionPort>,
}

pub struct AcceptedInputHandler {
    controls: Rc<dyn AcceptedInputControls>,
    coordinator: Rc<dyn AcceptedInputCoordinator>,
    project_admission: Rc<dyn ProjectAdmissionPort>,
    performance_now: Box<dyn Fn() -> f64>,
    new_id: Box<dyn Fn() -> String>,
    logger: ScopedLogger,
}

impl AcceptedInputHandler {
    pub fn new(
        deps: AcceptedInputDeps,
        performance_now: impl Fn() -> f64 + 'static,
        new_id: impl Fn() -> String + 'static,
    ) -> Self {
        Self {
            controls: deps.controls,
            coordinator: deps.coordinator,
            project_admission: deps.project_admission,
            performance_now: Box::new(performance_now),
            new_id: Box::new(new_id),
            logger: create_logger("accepted-input"),
        }
    }

    pub async fn enqueue(
        &self,
        input: AcceptedQueueCreate,
    ) -> ExecutionOperationResult<QueueEntryMutationResult> {
        let command = input.command.for_settlement();
        let result = async {
            let result = self
                .controls
                .create(
                    &command.chat_id,
                    &QueueEntryInput {
                        content: input.content,
                        images: input.images,
                        command: Some(queue_identity(&input.command)),
                        submission: Some(StoredQueueSubmissionIdentity {
                            client_message_id: input.client_message_id,
                            transcript_view_id: input.transcript_view_id,
                            excluded_resend_ordinals: input
                                .excluded_resend_ordinals
                                .filter(|list| !list.is_empty()),
                        }),
                    },
                    input.admission_deadline,
                )
                .await?;
            input
                .settlement
                .settle_queue_mutation(&command, &result.value.entry_id)
                .await?;
            self.coordinator
                .request_drain(&command.chat_id, "accepted enqueue")?;
            Ok(result)
        }
        .await;
        settle_queue_failure(&*input.settlement, &command, result).await
    }

    pub async fn replace(
        &self,
        input: AcceptedQueueReplace,
    ) -> ExecutionOperationResult<QueueEntryMutationResult> {
        let command = input.command.for_settlement();
        let result = async {
            let result = self
                .controls
                .replace(
                    &command.chat_id,
                    &ReplaceQueueEntryInput {
                        entry_id: input.command.entry_id.clone(),
                        content: input.content,
                        expected_revision: input.expected_revision,
                        command: Some(queue_identity(&input.command)),
                    },
                )
                .await?;
            input
                .settlement
                .settle_queue_mutation(&command, &result.value.entry_id)
                .await?;
            Ok(result)
        }
        .await;
        settle_queue_failure(&*input.settlement, &command, result).await
    }

    pub async fn delete(
        &self,
        input: AcceptedQueueDelete,
    ) -> ExecutionOperationResult<QueueCommandMutationResult> {
        let command = input.command.for_settlement();
        let result = async {
            let result = self
                .controls
                .delete(
                    &command.chat_id,
                    &DeleteQueueEntryInput {
                        entry_id: input.command.entry_id.clone(),
                        command: Some(queue_identity(&input.command)),
                    },
                )
                .await?;
            input
                .settlement
                .settle_queue_mutation(&command, &result.entry_id)
                .await?;
            Ok(result)
        }
        .await;
        settle_queue_failure(&*input.settlement, &command, result).await
    }

    pub async fn move_entry(
        &self,
        input: AcceptedQueueMove,
    ) -> ExecutionOperationResult<QueueMoveResult> {
        let command = input.command.for_settlement();
        let result = async {
            let result = self
                .controls
                .move_entry(
                    &command.chat_id,
                    &MoveQueueEntryInput {
                        entry_id: input.command.entry_id.clone(),
                        target_entry_id: input.target_entry_id,
                        placement: input.placement,
                        expected_reorder_revision: input.expected_reorder_revision,
                        expected_source_revision: input.expected_source_revision,
                        expected_target_revision: input.expected_target_revision,
                        command: Some(queue_identity(&input.command)),
                    },
                )
                .await?;
            input
                .settlement
                .settle_queue_mutation(&command, &result.entry_id)
                .await?;
            Ok(result)
        }
        .await;
        settle_queue_failure(&*input.settlement, &command, result).await
    }

    pub async fn schedule(
        &self,
        input: AcceptedDirectInput,
    ) -> ExecutionOperationResult<DirectInputScheduleOutcome> {
        let Some(reservation) = self.prepare_direct(&input).await? else {
            return Ok(DirectInputScheduleOutcome::Duplicate);
        };
        let signal = reservation.execution_admission.signal().clone();
        let command = input.command;
        let settlement = input.settlement;
        let before: BeforeFailureRelease = Box::new(move |error| {
            Box::pin(async move {
                if !signal.is_cancelled() {
                    settlement
                        .settle_operation_failure(&command, error.as_ref().as_ref())
                        .await?;
                }
                Ok(())
            })
        });
        let task = self.coordinator.clone().run_direct(
            reservation,
            input.content,
            input.options,
            input.dispatch,
            Some(before),
        );
        self.coordinator.track_dispatch(Box::pin(async move {
            if let Err(error) = task.await {
                create_logger("accepted-input").error(&format!("commands: run failed: {error}"));
            }
            Ok(())
        }))?;
        Ok(DirectInputScheduleOutcome::Scheduled)
    }

    pub async fn run_initial(&self, input: AcceptedDirectInput) -> ExecutionOperationResult<()> {
        let Some(reservation) = self.prepare_direct(&input).await? else {
            return Ok(());
        };
        let before: BeforeFailureRelease = Box::new(move |error| {
            Box::pin(settle_initial_failure(
                input.command,
                input.preparation,
                input.settlement,
                error,
            ))
        });
        self.coordinator
            .clone()
            .run_direct(
                reservation,
                input.content,
                input.options,
                input.dispatch,
                Some(before),
            )
            .await
    }

    pub async fn schedule_operation(
        &self,
        input: AcceptedDirectOperation,
    ) -> ExecutionOperationResult<()> {
        let options = self.with_turn_identifiers(&input.command);
        let reservation = match self
            .coordinator
            .reserve_direct(&input.command.chat_id, &options.identity())
        {
            Ok(reservation) => reservation,
            Err(error) => {
                record_admission_failure(&*input.settlement, &input.command, error.as_ref())
                    .await?;
                return Err(error);
            }
        };
        let chat = &input.command.chat_id;
        let prepared: ExecutionOperationResult<()> = async {
            self.coordinator.checkpoint(&reservation)?;
            let control = self
                .checkpoint_after(&reservation, self.controls.read(chat))
                .await?;
            assert_direct_control_available(&control)?;
            self.checkpoint_after(
                &reservation,
                self.project_admission
                    .assert_available(chat, input.admission_deadline),
            )
            .await?;
            self.checkpoint_after(
                &reservation,
                input
                    .settlement
                    .mark_scheduled(&input.command, options.turn_id.as_deref()),
            )
            .await
        }
        .await;
        if let Err(mut failure) = prepared {
            if let Err(error) = self.coordinator.release_direct(&reservation).await {
                failure = aggregate_failure(
                    Rc::new(failure),
                    error,
                    format!("Failed to release direct operation for {chat}"),
                );
            }
            if let Err(error) =
                record_admission_failure(&*input.settlement, &input.command, failure.as_ref()).await
            {
                failure = aggregate_failure(
                    Rc::new(failure),
                    error,
                    format!("Failed to settle direct operation admission for {chat}"),
                );
            }
            return Err(failure);
        }
        let task = self.coordinator.clone().run_direct(
            reservation,
            String::new(),
            options,
            Some(input.dispatch),
            None,
        );
        self.coordinator.track_dispatch(Box::pin(async move {
            if let Err(error) = task.await {
                let logger = create_logger("accepted-input");
                logger.error(&format!("compact: failed to compact chat: {error}"));
                if let Err(error) = input
                    .settlement
                    .settle_operation_failure(&input.command, error.as_ref())
                    .await
                {
                    logger.error(&format!(
                        "compact: failed to record command failure: {error}"
                    ));
                }
            }
            Ok(())
        }))
    }

    pub async fn steer(
        &self,
        input: AcceptedSteerInput,
    ) -> ExecutionOperationResult<AcceptedSteerOutcome> {
        let result: ExecutionOperationResult<_> = async {
            let outcome = self
                .deliver_steer(
                    &input,
                    &input.command,
                    &input.content,
                    input.question_reply.clone(),
                    input.user_message_presentation.clone(),
                )
                .await?;
            settle_steer_outcome(&*input.settlement, &input.command, &outcome).await?;
            Ok(outcome)
        }
        .await;
        if let Err(error) = &result {
            input
                .settlement
                .settle_steer_failure(&input.command, error.as_ref(), None)
                .await?;
        }
        result
    }

    pub async fn enqueue_steer(
        &self,
        input: AcceptedQueueSteerCreate,
    ) -> ExecutionOperationResult<QueueCommandMutationResult> {
        let command = input.command.for_settlement();
        let result: ExecutionOperationResult<_> = async {
            let result = self
                .controls
                .create_steer(
                    &command.chat_id,
                    &input.content,
                    &queue_identity(&input.command),
                    &StoredQueueSubmissionIdentity {
                        client_message_id: input.client_message_id,
                        transcript_view_id: input.transcript_view_id,
                        excluded_resend_ordinals: None,
                    },
                )
                .await?;
            input
                .settlement
                .settle_queue_mutation(&command, &result.entry_id)
                .await?;
            self.coordinator
                .request_drain(&command.chat_id, "accepted steer queued")?;
            Ok(result)
        }
        .await;
        if let Err(error) = &result {
            input
                .settlement
                .settle_steer_failure(&command, error.as_ref(), None)
                .await?;
        }
        result
    }

    pub async fn mark_queue_entry_steer(
        &self,
        input: AcceptedQueueEntrySteerMark,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        let command = input.command.for_settlement();
        let control = match self
            .controls
            .mark_steer(
                &command.chat_id,
                &ObservedQueueEntry {
                    entry_id: input.command.entry_id.clone(),
                    expected_revision: input.expected_revision,
                    expected_reorder_revision: input.expected_reorder_revision,
                },
            )
            .await
        {
            Ok(control) => control,
            Err(error) => {
                let wrapped = queue_steer_error(error, SteerDeliveryOutcome::NotSent, None);
                self.settle_queue_steer_failure(
                    &*input.settlement,
                    &command,
                    &wrapped,
                    SteerDeliveryOutcome::NotSent,
                )
                .await;
                return Err(Box::new(wrapped));
            }
        };
        input
            .settlement
            .settle_queue_mutation(&command, &input.command.entry_id)
            .await?;
        self.coordinator
            .request_drain(&command.chat_id, "queued message kept as a steer")?;
        Ok(control)
    }

    pub async fn steer_queue_entry(
        &self,
        input: AcceptedQueueEntrySteer,
    ) -> ExecutionOperationResult<AcceptedQueueEntrySteerOutcome> {
        let command = input.steer.command.for_settlement();
        let chat = command.chat_id.as_str();
        let entry_id = &input.steer.command.entry_id;
        let settlement = &*input.steer.settlement;
        let reservation = match self
            .controls
            .reserve_steer(
                chat,
                &ObservedQueueEntry {
                    entry_id: entry_id.clone(),
                    expected_revision: input.expected_revision,
                    expected_reorder_revision: input.expected_reorder_revision,
                },
            )
            .await
        {
            Ok(reservation) => reservation,
            Err(error) => {
                let wrapped = queue_steer_error(error, SteerDeliveryOutcome::NotSent, None);
                self.settle_queue_steer_failure(
                    settlement,
                    &command,
                    &wrapped,
                    SteerDeliveryOutcome::NotSent,
                )
                .await;
                return Err(Box::new(wrapped));
            }
        };
        let outcome = match self
            .deliver_steer(
                &input.steer,
                &command,
                &reservation.entry.content,
                None,
                None,
            )
            .await
        {
            Ok(outcome) => outcome,
            Err(error) => {
                let wrapped = if error
                    .downcast_ref::<SteerDeliveryError>()
                    .is_some_and(|error| error.outcome == SteerDeliveryFailureOutcome::Unknown)
                {
                    self.finish_unknown_queue_steer(settlement, &command, entry_id, error)
                        .await
                } else {
                    self.release_rejected_queue_steer(settlement, &command, entry_id, error)
                        .await
                };
                return Err(Box::new(wrapped));
            }
        };
        let control = match self.controls.consume_steer(chat, entry_id).await {
            Ok(control) => control,
            Err(error) => {
                return Err(Box::new(
                    self.fail_accepted_queue_finalization(settlement, &command, entry_id, error)
                        .await,
                ));
            }
        };
        self.coordinator
            .request_drain(chat, "queued steer consumed")?;
        if let Err(error) = settle_steer_outcome(settlement, &command, &outcome).await {
            self.logger.error(&format!(
                "queued steer ledger settlement failed: {chat}/{entry_id}: {error}"
            ));
        }
        Ok(AcceptedQueueEntrySteerOutcome { outcome, control })
    }

    pub async fn recover_queue_entry_steer(
        &self,
        chat_id: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        let control = self.controls.read(chat_id).await?;
        let source = control.entries.iter().find(|entry| entry.id == entry_id);
        if !source.is_some_and(|entry| {
            matches!(
                entry.status,
                StoredQueueEntryStatus::Queued | StoredQueueEntryStatus::Steering
            )
        }) {
            return Ok(control);
        }
        self.requeue_completion_uncertain(chat_id, entry_id).await
    }

    async fn deliver_steer<EntryId>(
        &self,
        input: &AcceptedSteerInput<EntryId>,
        command: &AcceptedExecutionCommand,
        content: &str,
        question_reply: Option<garcon_contract::async_user_questions::AsyncQuestionReply>,
        user_message_presentation: Option<UserMessagePresentation>,
    ) -> ExecutionOperationResult<AcceptedSteerOutcome> {
        self.coordinator
            .steer(AcceptedSteerDelivery {
                chat_id: &command.chat_id,
                content,
                provider_content: &input.provider_content,
                options: AgentSteerOptions {
                    client_request_id: command.client_request_id.clone(),
                    client_message_id: input.client_message_id.clone(),
                    transcript_view_id: input.transcript_view_id.clone(),
                    question_reply,
                },
                target: &input.target,
                after_pending_registered: Box::new(|turn_id| {
                    Box::pin(async move {
                        input
                            .settlement
                            .mark_scheduled(command, Some(&turn_id))
                            .await
                    })
                }),
                user_message_presentation,
            })
            .await
    }

    async fn requeue_completion_uncertain(
        &self,
        chat_id: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        self.controls
            .requeue_and_pause(
                chat_id,
                entry_id,
                AutomaticQueuePauseKind::CompletionUncertain,
            )
            .await
    }

    async fn finish_unknown_queue_steer(
        &self,
        settlement: &dyn CommandSettlementPort,
        command: &AcceptedExecutionCommand,
        entry_id: &str,
        error: Box<dyn Error>,
    ) -> QueueEntrySteerError {
        let chat = command.chat_id.as_str();
        let result: ExecutionOperationResult<_> = async {
            let control = self.controls.consume_steer(chat, entry_id).await?;
            self.coordinator
                .request_drain(chat, "unconfirmed queued steer consumed")?;
            Ok(control)
        }
        .await;
        let wrapped = match result {
            Ok(control) => queue_steer_error(error, SteerDeliveryOutcome::Unknown, Some(&control)),
            Err(consume_error) if is_missing_session(consume_error.as_ref()) => {
                queue_steer_error(consume_error, SteerDeliveryOutcome::Unknown, None)
            }
            Err(_) => {
                let control = match self.requeue_completion_uncertain(chat, entry_id).await {
                    Ok(control) => Some(control),
                    Err(pause_error) => {
                        self.logger.error(&format!("unconfirmed queued steer recovery failed: {chat}/{entry_id}: {pause_error}"));
                        None
                    }
                };
                queue_steer_error(error, SteerDeliveryOutcome::Unknown, control.as_ref())
            }
        };
        self.settle_queue_steer_failure(
            settlement,
            command,
            &wrapped,
            SteerDeliveryOutcome::Unknown,
        )
        .await;
        wrapped
    }

    async fn release_rejected_queue_steer(
        &self,
        settlement: &dyn CommandSettlementPort,
        command: &AcceptedExecutionCommand,
        entry_id: &str,
        error: Box<dyn Error>,
    ) -> QueueEntrySteerError {
        let chat = command.chat_id.as_str();
        let result: ExecutionOperationResult<_> = async {
            let control = self.controls.release_steer(chat, entry_id).await?;
            self.coordinator
                .request_drain(chat, "rejected queued steer released")?;
            Ok(control)
        }
        .await;
        let wrapped = match result {
            Ok(control) => queue_steer_error(error, SteerDeliveryOutcome::NotSent, Some(&control)),
            Err(release_error) if is_missing_session(release_error.as_ref()) => {
                queue_steer_error(release_error, SteerDeliveryOutcome::NotSent, None)
            }
            Err(release_error) => match self.requeue_completion_uncertain(chat, entry_id).await {
                Ok(control) => {
                    queue_steer_error(error, SteerDeliveryOutcome::NotSent, Some(&control))
                }
                Err(recovery_error) => QueueEntrySteerError::new(
                    queue_steer_domain_error_code(ErrorCode::QUEUE_STEER_RECOVERY_FAILED),
                    QUEUE_STEER_RECOVERY_FAILED_MESSAGE,
                    500,
                    SteerDeliveryOutcome::NotSent,
                    None,
                    Some(aggregate_failure(
                        Rc::new(release_error),
                        recovery_error,
                        String::new(),
                    )),
                ),
            },
        };
        self.settle_queue_steer_failure(
            settlement,
            command,
            &wrapped,
            SteerDeliveryOutcome::NotSent,
        )
        .await;
        wrapped
    }

    async fn fail_accepted_queue_finalization(
        &self,
        settlement: &dyn CommandSettlementPort,
        command: &AcceptedExecutionCommand,
        entry_id: &str,
        error: Box<dyn Error>,
    ) -> QueueEntrySteerError {
        let wrapped = if is_missing_session(error.as_ref()) {
            queue_steer_error(error, SteerDeliveryOutcome::Accepted, None)
        } else {
            let chat = command.chat_id.as_str();
            let control = match self.requeue_completion_uncertain(chat, entry_id).await {
                Ok(control) => Some(control),
                Err(pause_error) => {
                    self.logger.error(&format!(
                        "accepted queued steer recovery failed: {chat}/{entry_id}: {pause_error}"
                    ));
                    None
                }
            };
            QueueEntrySteerError::new(
                queue_steer_domain_error_code(ErrorCode::QUEUE_STEER_FINALIZATION_FAILED),
                QUEUE_STEER_FINALIZATION_FAILED_MESSAGE,
                500,
                SteerDeliveryOutcome::Accepted,
                control.as_ref(),
                Some(error),
            )
        };
        self.settle_queue_steer_failure(
            settlement,
            command,
            &wrapped,
            SteerDeliveryOutcome::Accepted,
        )
        .await;
        wrapped
    }

    async fn settle_queue_steer_failure(
        &self,
        settlement: &dyn CommandSettlementPort,
        command: &AcceptedExecutionCommand,
        error: &(dyn Error + 'static),
        outcome: SteerDeliveryOutcome,
    ) {
        if let Err(error) = settlement
            .settle_steer_failure(command, error, Some(outcome))
            .await
        {
            self.logger.error(&format!(
                "queued steer failure settlement failed: {}/{}: {error}",
                command.chat_id,
                command.entry_id.as_deref().unwrap_or_default()
            ));
        }
    }

    async fn prepare_direct(
        &self,
        input: &AcceptedDirectInput,
    ) -> ExecutionOperationResult<Option<DirectTurnReservation>> {
        let chat = input.command.chat_id.as_str();
        let reservation = match self
            .coordinator
            .reserve_direct(chat, &input.options.identity())
        {
            Ok(reservation) => reservation,
            Err(error) => {
                record_admission_failure(&*input.settlement, &input.command, error.as_ref())
                    .await?;
                return Err(error);
            }
        };
        let result: ExecutionOperationResult<bool> = async {
            self.coordinator.checkpoint(&reservation)?;
            let admission = UserInputAdmissionOptions::from_run_options(
                &input.options,
                input.user_message_presentation.clone(),
            );
            let duplicate =
                self.coordinator
                    .has_matching_input(chat, &input.content, &admission)?;
            // The original explicitly resolves the matching check through a promise.
            tokio::task::yield_now().await;
            self.coordinator.checkpoint(&reservation)?;
            if duplicate {
                input
                    .settlement
                    .settle_duplicate_input(&input.command)
                    .await?;
                self.coordinator.release_direct(&reservation).await?;
                return Ok(false);
            }
            let control = self
                .checkpoint_after(&reservation, self.controls.read(chat))
                .await?;
            assert_direct_control_available(&control)?;
            let preparing = (self.performance_now)();
            if let Some(preparation) = &input.preparation {
                self.checkpoint_after(
                    &reservation,
                    preparation.prepare(DirectInputPreparationContext {
                        signal: reservation.execution_admission.signal(),
                        assert_admission_active: &|| self.coordinator.checkpoint(&reservation),
                    }),
                )
                .await?;
            } else {
                // The original awaits Promise.resolve even when preparation is absent.
                tokio::task::yield_now().await;
                self.coordinator.checkpoint(&reservation)?;
            }
            let prepared = (self.performance_now)();
            let deadline = match (input.preparation.is_some(), input.admission_deadline) {
                (true, Some(deadline)) => {
                    let shifted = deadline + prepared - preparing;
                    Some(if prepared.is_nan() || shifted.is_nan() {
                        f64::NAN
                    } else {
                        prepared.max(shifted)
                    })
                }
                (_, deadline) => deadline,
            };
            self.checkpoint_after(
                &reservation,
                self.project_admission.assert_available(chat, deadline),
            )
            .await?;
            let inserted = self
                .checkpoint_after(
                    &reservation,
                    self.coordinator
                        .admit_input(chat, &input.content, &admission),
                )
                .await?;
            if !inserted {
                input
                    .settlement
                    .settle_duplicate_input(&input.command)
                    .await?;
                self.coordinator.release_direct(&reservation).await?;
                return Ok(false);
            }
            self.checkpoint_after(
                &reservation,
                input
                    .settlement
                    .mark_scheduled(&input.command, input.options.turn_id.as_deref()),
            )
            .await?;
            Ok(true)
        }
        .await;
        let mut failure = match result {
            Ok(true) => return Ok(Some(reservation)),
            Ok(false) => return Ok(None),
            Err(error) => error,
        };
        let retain_prepared_target = input.preparation.is_some()
            && is_recoverable_preamble_admission_error(failure.as_ref());
        let mut retryable = !retain_prepared_target;
        let mut preserve_fork_preparation = false;
        if let Some(preparation) = &input.preparation
            && !retain_prepared_target
            && let Err(compensation_error) = preparation.compensate().await
        {
            retryable = false;
            preserve_fork_preparation = true;
            failure = aggregate_failure(
                Rc::new(failure),
                compensation_error,
                format!(
                    "Failed to prepare and roll back {} for {chat}",
                    preparation.operation().as_str()
                ),
            );
        }
        let release = async {
            self.coordinator
                .discard_prepared_input(chat, input.options.client_message_id.as_deref())?;
            self.coordinator.release_direct(&reservation).await
        }
        .await;
        if let Err(error) = release {
            failure = aggregate_failure(
                Rc::new(failure),
                error,
                format!("Failed to release direct input for {chat}"),
            );
        }
        if let Err(error) = input
            .settlement
            .mark_pre_schedule_failure(
                &input.command,
                PreScheduleFailure {
                    error: failure.as_ref(),
                    retryable,
                    preserve_fork_preparation,
                },
            )
            .await
        {
            failure = aggregate_failure(
                Rc::new(failure),
                error,
                format!("Failed to settle direct input admission for {chat}"),
            );
        }
        Err(failure)
    }

    async fn checkpoint_after<T>(
        &self,
        reservation: &DirectTurnReservation,
        future: impl Future<Output = ExecutionOperationResult<T>>,
    ) -> ExecutionOperationResult<T> {
        let result = future.await?;
        self.coordinator.checkpoint(reservation)?;
        Ok(result)
    }

    fn with_turn_identifiers(&self, command: &AcceptedExecutionCommand) -> RunAgentTurnOptions {
        RunAgentTurnOptions {
            client_request_id: Some(command.client_request_id.clone()),
            client_message_id: Some((self.new_id)()),
            turn_id: command.turn_id.clone().or_else(|| Some((self.new_id)())),
            ..RunAgentTurnOptions::default()
        }
    }
}

async fn settle_queue_failure<T>(
    settlement: &dyn CommandSettlementPort,
    command: &AcceptedExecutionCommand,
    result: ExecutionOperationResult<T>,
) -> ExecutionOperationResult<T> {
    if let Err(error) = &result {
        settlement
            .settle_queue_mutation_failure(command, error.as_ref())
            .await?;
    }
    result
}

async fn settle_steer_outcome(
    settlement: &dyn CommandSettlementPort,
    command: &AcceptedExecutionCommand,
    outcome: &AcceptedSteerOutcome,
) -> ExecutionOperationResult<()> {
    if outcome.duplicate {
        settlement.settle_duplicate_input(command).await
    } else {
        settlement
            .settle_steer_success(command, &outcome.turn_id)
            .await
    }
}

async fn settle_initial_failure(
    command: AcceptedExecutionCommand,
    preparation: Option<Rc<dyn DirectInputPreparation>>,
    settlement: Rc<dyn CommandSettlementPort>,
    error: AdmissionAbortReason,
) -> ExecutionOperationResult<()> {
    let mut failure = None;
    if let Some(preparation) = preparation
        && !is_lost_launch_reply(error.as_ref().as_ref())
        && let Err(compensation_error) = preparation.compensate().await
    {
        failure = Some(aggregate_failure(
            Rc::clone(&error),
            compensation_error,
            format!(
                "Failed to roll back {} for {}",
                preparation.operation().as_str(),
                command.chat_id
            ),
        ));
    }
    let current = failure.as_deref().unwrap_or(error.as_ref().as_ref());
    if let Err(settlement_error) = settlement.settle_operation_failure(&command, current).await {
        let primary = failure.map_or(error, Rc::new);
        failure = Some(aggregate_failure(
            primary,
            settlement_error,
            format!("Failed to settle initial input for {}", command.chat_id),
        ));
    }
    failure.map_or(Ok(()), Err)
}

async fn record_admission_failure(
    settlement: &dyn CommandSettlementPort,
    command: &AcceptedExecutionCommand,
    error: &(dyn Error + 'static),
) -> ExecutionOperationResult<()> {
    settlement
        .mark_pre_schedule_failure(
            command,
            PreScheduleFailure {
                error,
                retryable: true,
                preserve_fork_preparation: false,
            },
        )
        .await
}

fn assert_direct_control_available(
    control: &StoredChatExecutionControlState,
) -> ExecutionOperationResult<()> {
    if !has_pending_turn_input(control) && control.pause.is_none() {
        return Ok(());
    }
    Err(Box::new(DomainError::new(
        ErrorCode::SESSION_BUSY,
        "Chat execution is blocked by pending control state",
        409,
        true,
    )))
}

fn queue_identity(command: &AcceptedExecutionCommand<String>) -> QueueCommandIdentity {
    QueueCommandIdentity {
        key: command.key.clone(),
        entry_id: command.entry_id.clone(),
    }
}

fn is_missing_session(error: &(dyn Error + 'static)) -> bool {
    execution_domain_error(error).is_some_and(|domain| domain.code == ErrorCode::SESSION_NOT_FOUND)
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ExecutionAggregateError {
    pub primary: AdmissionAbortReason,
    pub secondary: Box<dyn Error>,
    pub message: String,
}

impl DiagnosticError for ExecutionAggregateError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "AggregateError",
            code: None,
        }
    }
}

pub(crate) fn aggregate_failure(
    primary: AdmissionAbortReason,
    secondary: Box<dyn Error>,
    message: String,
) -> Box<dyn Error> {
    Box::new(ExecutionAggregateError {
        primary,
        secondary,
        message,
    })
}

fn queue_steer_error(
    error: Box<dyn Error>,
    delivery_outcome: SteerDeliveryOutcome,
    control: Option<&StoredChatExecutionControlState>,
) -> QueueEntrySteerError {
    let error = match error.downcast::<QueueEntrySteerError>() {
        Ok(error) => return *error,
        Err(error) => error,
    };
    if let Some(domain) = execution_domain_error(error.as_ref()) {
        let intrinsic_control = error
            .downcast_ref::<QueueEntryMutationError>()
            .map(|error| error.control.as_ref())
            .or_else(|| {
                error
                    .downcast_ref::<QueuePauseChangedError>()
                    .map(|error| error.control.as_ref())
            });
        let code = queue_steer_domain_error_code(domain.code);
        let message = domain.message.clone();
        let status = domain.status;
        let control = control.or(intrinsic_control).cloned();
        return QueueEntrySteerError::new(
            code,
            message,
            status,
            delivery_outcome,
            control.as_ref(),
            Some(error),
        );
    }
    let (code, message) = if delivery_outcome == SteerDeliveryOutcome::Unknown {
        (
            ErrorCode::STEER_OUTCOME_UNKNOWN,
            STEER_OUTCOME_UNKNOWN_MESSAGE,
        )
    } else {
        (ErrorCode::STEER_NOT_DELIVERED, STEER_NOT_DELIVERED_MESSAGE)
    };
    QueueEntrySteerError::new(
        queue_steer_domain_error_code(code),
        message,
        500,
        delivery_outcome,
        control,
        Some(error),
    )
}

fn queue_steer_domain_error_code(code: ErrorCode) -> CommandErrorCode {
    let code = match code {
        ErrorCode::VALIDATION_FAILED
        | ErrorCode::SESSION_NOT_FOUND
        | ErrorCode::QUEUE_ENTRY_NOT_FOUND
        | ErrorCode::QUEUE_ENTRY_ALREADY_SENT
        | ErrorCode::QUEUE_ENTRY_IN_FLIGHT
        | ErrorCode::QUEUE_ENTRY_REVISION_CONFLICT
        | ErrorCode::QUEUE_ENTRY_REORDER_CONFLICT
        | ErrorCode::STEER_NOT_DELIVERED
        | ErrorCode::STEER_OUTCOME_UNKNOWN
        | ErrorCode::STEER_PROVIDER_REJECTED
        | ErrorCode::STEER_TURN_UNAVAILABLE
        | ErrorCode::STEER_TURN_CHANGED
        | ErrorCode::STEER_TURN_NOT_STEERABLE
        | ErrorCode::STEER_CAPACITY_EXHAUSTED
        | ErrorCode::QUEUE_STEER_FINALIZATION_FAILED
        | ErrorCode::QUEUE_STEER_RECOVERY_FAILED
        | ErrorCode::OPERATION_UNSUPPORTED
        | ErrorCode::SERVER_SHUTTING_DOWN => code,
        _ => ErrorCode::INTERNAL_ERROR,
    };
    // INFALLIBLE: each arm maps to a registered CommandErrorCode.
    CommandErrorCode::try_from(code).expect("queue steer command error code")
}
