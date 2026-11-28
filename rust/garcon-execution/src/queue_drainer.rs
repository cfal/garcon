//! The shared selection/admission lock covers dequeue and synchronous transcript
//! admission. A queued adapter must commit before dequeue and must not take the
//! same lock again or use the async direct-admission path.

use std::{error::Error, rc::Rc};

use async_trait::async_trait;
use garcon_base::{
    domain_error::{DomainError, DomainErrorKind},
    keyed_lock::KeyedLock,
    log::{Logger, ScopedLogger, create_logger},
};

use crate::{
    chat_execution_control_operations::{
        ChatExecutionControlOperations, ControlChangeResult, DequeuedTurn, DequeuedTurnAdmission,
    },
    chat_execution_control_transitions::{DequeuedTurnInput, FailurePauseCause},
    control_state::{
        StoredChatExecutionControlState, StoredControlInputEntry, StoredQueueEntryStatus,
        has_pending_turn_input,
    },
    execution_attempt::QueueExecutionAttempt,
    execution_errors::{execution_domain_error, is_recoverable_preamble_admission_error},
    execution_ownership::ExecutionOwnership,
    session_types::RunAgentTurnOptions,
    turn_finalization_tracker::QueuedTurnFinalizationOutcome,
    turn_identity::TurnCommandType,
    types::{
        AgentTurnRunnerPort, DrainSuppressionReason, ExecutionOperationResult,
        LocalExecutionFuture, ProjectAdmissionPort, QueuedAttachmentAdmissionPort,
        execution_turn_identity,
    },
};

pub type QueueDequeueAdmission<'a> =
    Box<dyn FnOnce(&DequeuedTurnInput) -> ExecutionOperationResult<DequeuedTurnAdmission> + 'a>;
pub type SelectionAdmissionOperation<'a> =
    Box<dyn FnOnce() -> LocalExecutionFuture<'a, Option<DequeuedTurn>> + 'a>;
pub type QueueDrainOptionsResolver = dyn Fn(&str) -> ExecutionOperationResult<RunAgentTurnOptions>;

#[async_trait(?Send)]
pub trait QueueSelectionAdmission {
    async fn run_selection_admission_exclusive(
        &self,
        chat_id: &str,
        operation: SelectionAdmissionOperation<'_>,
    ) -> ExecutionOperationResult<Option<DequeuedTurn>>;
}

#[async_trait(?Send)]
impl QueueSelectionAdmission for KeyedLock {
    async fn run_selection_admission_exclusive(
        &self,
        chat_id: &str,
        operation: SelectionAdmissionOperation<'_>,
    ) -> ExecutionOperationResult<Option<DequeuedTurn>> {
        self.run_exclusive(&format!("chat:{chat_id}"), operation, None)
            .await?
    }
}

#[async_trait(?Send)]
pub trait QueueDispatchControls {
    async fn read(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState>;
    async fn pause_for_unavailable_project(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<ControlChangeResult>;
    async fn pause_after_failure(
        &self,
        chat_id: &str,
        cause: &FailurePauseCause,
    ) -> ExecutionOperationResult<()>;
    async fn dequeue_next_turn(
        &self,
        chat_id: &str,
        admit: QueueDequeueAdmission<'_>,
    ) -> ExecutionOperationResult<Option<DequeuedTurn>>;
}

#[async_trait(?Send)]
impl QueueDispatchControls for ChatExecutionControlOperations {
    async fn read(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        ChatExecutionControlOperations::read(self, chat_id).await
    }

    async fn pause_for_unavailable_project(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<ControlChangeResult> {
        ChatExecutionControlOperations::pause_for_unavailable_project(self, chat_id).await
    }

    async fn pause_after_failure(
        &self,
        chat_id: &str,
        cause: &FailurePauseCause,
    ) -> ExecutionOperationResult<()> {
        ChatExecutionControlOperations::pause_after_failure(self, chat_id, cause).await
    }

    async fn dequeue_next_turn(
        &self,
        chat_id: &str,
        admit: QueueDequeueAdmission<'_>,
    ) -> ExecutionOperationResult<Option<DequeuedTurn>> {
        ChatExecutionControlOperations::dequeue_next_turn(self, chat_id, admit).await
    }
}

pub trait QueueDispatchCallbacks {
    fn can_dispatch(&self, _chat_id: &str) -> bool {
        true
    }
    fn is_shutting_down(&self) -> bool;
    fn register_queued(
        &self,
        chat_id: &str,
        content: &str,
        options: &RunAgentTurnOptions,
    ) -> ExecutionOperationResult<bool>;
    fn append_control_receipt(
        &self,
        chat_id: &str,
        entry: &StoredControlInputEntry,
    ) -> ExecutionOperationResult<()>;
    fn is_control_input_view_current(
        &self,
        chat_id: &str,
        view_id: &str,
    ) -> ExecutionOperationResult<bool>;
    fn discard_prepared_input(
        &self,
        chat_id: &str,
        client_message_id: Option<&str>,
    ) -> ExecutionOperationResult<()>;
    fn publish_idle(&self, chat_id: &str) -> ExecutionOperationResult<()>;
    fn publish_project_unavailable(
        &self,
        chat_id: &str,
        error: &DomainError,
    ) -> ExecutionOperationResult<()>;
    fn publish_turn_failed(
        &self,
        chat_id: &str,
        message: &str,
        options: &RunAgentTurnOptions,
    ) -> ExecutionOperationResult<()>;
    fn publish_turn_started(&self, chat_id: &str, run_id: &str) -> ExecutionOperationResult<()>;
    fn retire_attempt(
        &self,
        chat_id: &str,
        attempt: &Rc<QueueExecutionAttempt>,
    ) -> ExecutionOperationResult<()>;
}

pub struct QueueDispatchDeps {
    pub ownership: Rc<ExecutionOwnership>,
    pub controls: Rc<dyn QueueDispatchControls>,
    pub turn_runner: Rc<dyn AgentTurnRunnerPort>,
    pub get_drain_options: Box<QueueDrainOptionsResolver>,
    pub selection_admission: Rc<dyn QueueSelectionAdmission>,
    pub project_admission: Rc<dyn ProjectAdmissionPort>,
    pub attachment_admission: Rc<dyn QueuedAttachmentAdmissionPort>,
    pub callbacks: Rc<dyn QueueDispatchCallbacks>,
}

#[derive(Debug, thiserror::Error)]
#[error("Queue dispatch halted before admission")]
struct QueueDispatchHalted;

#[derive(Debug, thiserror::Error)]
#[error("Queued input admission did not produce dispatch options")]
struct MissingDispatchOptions;

pub struct QueueDrainer {
    deps: QueueDispatchDeps,
    new_id: Box<dyn Fn() -> String>,
    logger: ScopedLogger,
}

impl QueueDrainer {
    pub fn new(deps: QueueDispatchDeps, new_id: impl Fn() -> String + 'static) -> Self {
        Self {
            deps,
            new_id: Box::new(new_id),
            logger: create_logger("queue-dispatch"),
        }
    }

    fn should_halt(&self, chat_id: &str) -> bool {
        let deps = &self.deps;
        // Original QueueDrainer dispatch fence; the execution API contract keeps it private.
        deps.callbacks.is_shutting_down()
            || !deps.callbacks.can_dispatch(chat_id)
            || deps
                .ownership
                .has_suppression(chat_id, DrainSuppressionReason::Abort)
            || deps
                .ownership
                .has_suppression(chat_id, DrainSuppressionReason::Deletion)
            || deps
                .ownership
                .has_suppression(chat_id, DrainSuppressionReason::ManualStop)
            || deps.ownership.has_direct(chat_id)
            || deps.turn_runner.is_chat_running(chat_id)
    }

    pub async fn run(&self, chat_id: &str) -> ExecutionOperationResult<()> {
        let QueueDispatchDeps {
            ownership,
            controls,
            callbacks,
            ..
        } = &self.deps;
        while !self.should_halt(chat_id) {
            if let Some(lingering) = ownership.attempt(chat_id) {
                let control = controls.read(chat_id).await?;
                if !has_pending_turn_input(&control) {
                    return Ok(());
                }
                lingering.wait_until_settled().await;
                continue;
            }
            let pending = controls.read(chat_id).await?;
            if !has_pending_turn_input(&pending) || pending.pause.is_some() {
                callbacks.publish_idle(chat_id)?;
                return Ok(());
            }
            if pending
                .entries
                .iter()
                .any(|entry| entry.status == StoredQueueEntryStatus::Steering)
                || self.should_halt(chat_id)
            {
                return Ok(());
            }
            if !pending.entries.is_empty()
                && let Err(error) = self
                    .deps
                    .project_admission
                    .assert_available(chat_id, None)
                    .await
            {
                let Some(project_error) = execution_domain_error(error.as_ref()).filter(|error| {
                    matches!(error.kind, DomainErrorKind::ProjectUnavailable { .. })
                }) else {
                    return Err(error);
                };
                if self.should_halt(chat_id) {
                    return Ok(());
                }
                let paused = controls.pause_for_unavailable_project(chat_id).await?;
                if !paused.changed {
                    continue;
                }
                callbacks.publish_project_unavailable(chat_id, project_error)?;
                return Ok(());
            }
            if self.should_halt(chat_id) {
                return Ok(());
            }

            let (mut options, mut admission) = (None, QueueAdmissionState::default());
            let result = self
                .deps
                .selection_admission
                .run_selection_admission_exclusive(
                    chat_id,
                    Box::new(|| {
                        Box::pin(controls.dequeue_next_turn(
                            chat_id,
                            Box::new(|input| {
                                self.admit_dequeue(chat_id, input, &mut options, &mut admission)
                            }),
                        ))
                    }),
                )
                .await;
            let result = match result {
                Err(error) if error.is::<QueueDispatchHalted>() => return Ok(()),
                Err(error) => {
                    if let (Some(entry_id), Some(options)) =
                        (admission.attachment_entry_id, options.as_ref())
                    {
                        if execution_domain_error(error.as_ref())
                            .is_some_and(|domain| domain.retryable)
                        {
                            return Ok(());
                        }
                        let message = error.to_string();
                        self.logger.warn(&format!("queue: queued attachments unsupported by the current selection: {chat_id}/{entry_id}: {message}"));
                        controls
                            .pause_after_failure(
                                chat_id,
                                &FailurePauseCause::QueuedTurnFailed { entry_id },
                            )
                            .await?;
                        callbacks.publish_turn_failed(chat_id, &message, options)?;
                        return Ok(());
                    }
                    if admission.input_inserted {
                        callbacks.discard_prepared_input(
                            chat_id,
                            options
                                .as_ref()
                                .and_then(|options| options.client_message_id.as_deref()),
                        )?;
                    }
                    return Err(error);
                }
                Ok(Some(result)) => result,
                Ok(None) => {
                    let control = controls.read(chat_id).await?;
                    if !has_pending_turn_input(&control) {
                        callbacks.publish_idle(chat_id)?;
                    }
                    return Ok(());
                }
            };
            let options = options.ok_or(MissingDispatchOptions)?;
            if let Some(failure) = admission.failure {
                let code = execution_domain_error(failure.as_ref())
                    .map_or("UNKNOWN", |error| error.code.as_str());
                self.logger.warn(&format!(
                    "queue: queued turn rejected before admission: {chat_id}/{}: {code}",
                    entry_id(&result.input)
                ));
                callbacks.publish_turn_failed(chat_id, &failure.to_string(), &options)?;
                continue;
            }
            if !result.inserted {
                continue;
            }
            let client_message_id = options.client_message_id.clone();
            let dispatch = self
                .dispatch_dequeued(chat_id, &result.input, options)
                .await;
            if matches!(result.input, DequeuedTurnInput::User { .. }) {
                callbacks.discard_prepared_input(chat_id, client_message_id.as_deref())?;
            }
            if !dispatch? {
                return Ok(());
            }
        }
        Ok(())
    }

    fn admit_dequeue(
        &self,
        chat_id: &str,
        input: &DequeuedTurnInput,
        options: &mut Option<RunAgentTurnOptions>,
        admission: &mut QueueAdmissionState,
    ) -> ExecutionOperationResult<DequeuedTurnAdmission> {
        if self.should_halt(chat_id) {
            return Err(Box::new(QueueDispatchHalted));
        }
        let callbacks = &self.deps.callbacks;
        let turn = options.insert(options_for_turn(
            (self.deps.get_drain_options)(chat_id)?,
            input,
            &*self.new_id,
        ));
        // INFALLIBLE: options_for_turn always assigns a turn identifier.
        callbacks.publish_turn_started(
            chat_id,
            turn.turn_id.as_deref().expect("dequeue assigned a turn id"),
        )?;
        match input {
            DequeuedTurnInput::Control { entry } => {
                if !callbacks
                    .is_control_input_view_current(chat_id, &entry.input.transcript_view_id)?
                {
                    self.logger.debug(&format!(
                        "queue: discarded stale control input: {chat_id}/{}",
                        entry.id
                    ));
                    return Ok(DequeuedTurnAdmission::Discarded);
                }
                callbacks.append_control_receipt(chat_id, entry)?;
                admission.input_inserted = true;
                Ok(DequeuedTurnAdmission::Inserted)
            }
            DequeuedTurnInput::User { entry } => {
                if !entry.images.is_empty() {
                    admission.attachment_entry_id = Some(entry.id.clone());
                    self.deps
                        .attachment_admission
                        .assert_supported(chat_id, &entry.images)?;
                    admission.attachment_entry_id = None;
                }
                match callbacks.register_queued(chat_id, &entry.content, turn) {
                    Ok(inserted) => {
                        admission.input_inserted = inserted;
                        Ok(if inserted {
                            DequeuedTurnAdmission::Inserted
                        } else {
                            DequeuedTurnAdmission::AlreadyCommitted
                        })
                    }
                    Err(error) if is_recoverable_preamble_admission_error(error.as_ref()) => {
                        admission.failure = Some(error);
                        Ok(DequeuedTurnAdmission::Discarded)
                    }
                    Err(error) => Err(error),
                }
            }
        }
    }

    async fn dispatch_dequeued(
        &self,
        chat_id: &str,
        input: &DequeuedTurnInput,
        mut options: RunAgentTurnOptions,
    ) -> ExecutionOperationResult<bool> {
        let deps = &self.deps;
        let user_entry_id = match input {
            DequeuedTurnInput::User { entry } => Some(entry.id.clone()),
            DequeuedTurnInput::Control { .. } => None,
        };
        // INFALLIBLE: options_for_turn assigns nonempty UUIDs to both identifiers.
        let identity =
            execution_turn_identity(&options.identity()).expect("dequeue assigned a turn identity");
        // INFALLIBLE: the turn UUID is part of the identity.
        let run_id = identity
            .turn_id
            .clone()
            .expect("dequeue assigned a turn id");
        let attempt = Rc::new(QueueExecutionAttempt::new(identity, user_entry_id.clone()));
        options.execution_admission = Some(
            deps.ownership
                .install_attempt(chat_id, Rc::clone(&attempt))?,
        );
        let finalization = deps.ownership.begin_finalization(chat_id, &run_id)?;
        if let Some(entry_id) = user_entry_id {
            deps.ownership.set_active_drain_entry(chat_id, &entry_id)?;
        }
        if deps.callbacks.is_shutting_down() {
            finalization.settle(QueuedTurnFinalizationOutcome::NotCommitted);
            deps.callbacks.retire_attempt(chat_id, &attempt)?;
            return Ok(false);
        }
        finalization.settle(QueuedTurnFinalizationOutcome::Committed);
        attempt.mark_launching();
        self.run_entry(chat_id, input, options, &attempt).await
    }

    async fn run_entry(
        &self,
        chat_id: &str,
        input: &DequeuedTurnInput,
        options: RunAgentTurnOptions,
        attempt: &Rc<QueueExecutionAttempt>,
    ) -> ExecutionOperationResult<bool> {
        let result = self
            .run_provider(chat_id, content(input), options.clone(), attempt)
            .await;
        let Err(error) = result else {
            return Ok(true);
        };
        if attempt.is_settled() {
            return Ok(true);
        }
        if attempt.has_terminal_commit() {
            return Ok(false);
        }
        let message = error.to_string();
        self.logger.error(&format!(
            "queue: queued turn failed: {chat_id}/{}: {message}",
            entry_id(input)
        ));
        if let DequeuedTurnInput::User { entry } = input {
            self.deps
                .controls
                .pause_after_failure(
                    chat_id,
                    &FailurePauseCause::QueuedTurnFailed {
                        entry_id: entry.id.clone(),
                    },
                )
                .await?;
        }
        self.deps
            .callbacks
            .publish_turn_failed(chat_id, &message, &options)?;
        // Original QueueDrainer retirement rule; the execution API contract keeps it private.
        if !attempt.is_settled() && !self.deps.turn_runner.is_chat_running(chat_id) {
            self.deps.callbacks.retire_attempt(chat_id, attempt)?;
        }
        Ok(matches!(input, DequeuedTurnInput::Control { .. }))
    }

    async fn run_provider(
        &self,
        chat_id: &str,
        content: &str,
        options: RunAgentTurnOptions,
        attempt: &Rc<QueueExecutionAttempt>,
    ) -> ExecutionOperationResult<()> {
        let runner = Rc::clone(&self.deps.turn_runner);
        let (chat_id, text) = (chat_id.to_owned(), content.to_owned());
        let mut run =
            Box::pin(async move { runner.run_agent_turn(&chat_id, &text, options).await });
        tokio::select! {
            biased;
            result = &mut run => result,
            () = attempt.wait_until_settled() => {
                // The losing Promise.race branch observes completion without publishing it.
                tokio::task::spawn_local(async move { let _ = run.await; });
                Ok(())
            }
        }
    }
}

#[derive(Default)]
struct QueueAdmissionState {
    input_inserted: bool,
    failure: Option<Box<dyn Error>>,
    attachment_entry_id: Option<String>,
}

fn options_for_turn(
    mut options: RunAgentTurnOptions,
    input: &DequeuedTurnInput,
    new_id: &dyn Fn() -> String,
) -> RunAgentTurnOptions {
    let submission = match input {
        DequeuedTurnInput::User { entry } => entry.submission.as_ref(),
        DequeuedTurnInput::Control { .. } => None,
    };
    options.client_request_id = Some(new_id());
    options.client_message_id =
        Some(submission.map_or_else(new_id, |submission| submission.client_message_id.clone()));
    options.turn_id = Some(new_id());
    match input {
        DequeuedTurnInput::Control { entry } => {
            options.transcript_view_id = Some(entry.input.transcript_view_id.clone());
            options.command_type = Some(TurnCommandType::AgentRun);
            options.created_at = Some(entry.input.created_at.clone());
        }
        DequeuedTurnInput::User { entry } => {
            if let Some(submission) = submission {
                options.transcript_view_id = Some(submission.transcript_view_id.clone());
                if let Some(ordinals) = submission
                    .excluded_resend_ordinals
                    .as_ref()
                    .filter(|ordinals| !ordinals.is_empty())
                {
                    options.excluded_resend_ordinals = Some(ordinals.clone());
                }
            }
            if !entry.images.is_empty() {
                options.images = Some(entry.images.clone());
            }
            options.created_at = Some(entry.created_at.clone());
        }
    }
    options
}

fn entry_id(input: &DequeuedTurnInput) -> &str {
    match input {
        DequeuedTurnInput::User { entry } => &entry.id,
        DequeuedTurnInput::Control { entry } => &entry.id,
    }
}

fn content(input: &DequeuedTurnInput) -> &str {
    match input {
        DequeuedTurnInput::User { entry } => &entry.content,
        DequeuedTurnInput::Control { entry } => &entry.input.content,
    }
}
