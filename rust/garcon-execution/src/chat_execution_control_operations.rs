//! Applies queue transitions under the controller's shared per-chat lock.

use std::{collections::HashSet, future::Future, rc::Rc};

use garcon_base::{
    domain_error::DomainError,
    keyed_lock::KeyedLock,
    log::{Logger, ScopedLogger, create_logger},
};
use garcon_contract::{error_codes::ErrorCode, queue_state::AutomaticQueuePauseKind};
use garcon_js::clock::{Clock, to_iso_string};
use serde::Serialize;

use crate::{
    chat_execution_control_repository::ChatExecutionControlRepository,
    chat_execution_control_transitions::{
        ControlTransition, DeleteQueueEntryInput, DequeuedTurnInput, FailurePauseCause,
        MoveQueueEntryInput, ObservedQueueEntry, QueueCommandIdentity, QueueEntryInput,
        QueueMutationValue, QueuedSteerInput, ReplaceQueueEntryInput, RequeueAndPauseInput,
        ReservedQueueSteer, TransitionContext, TransitionOutcome, clear_queue, consume_queue_steer,
        create_queue_entry, create_queued_steer, delete_queue_entry, dequeue_next_turn,
        discard_pending_input, enqueue_control_input, mark_queue_entry_steer, move_queue_entry,
        pause_after_failure, pause_queue, release_queue_steer, replace_queue_entry,
        requeue_and_pause, reserve_pending_steer, reserve_queue_steer, resume_queue,
    },
    control_state::{
        StoredChatExecutionControlState, StoredControlInput, StoredControlInputEntry,
        StoredQueueEntry, StoredQueueEntryStatus, StoredQueueSubmissionIdentity,
        clone_stored_chat_execution_control,
    },
    types::{
        ExecutionOperationResult, ProjectAdmissionPort, QueueCommandMutationResult,
        QueuedAttachmentAdmissionPort, transition_error,
    },
};

pub trait ChatExecutionControlOperationsHost {
    fn chat_exists(&self, chat_id: &str) -> bool;
    fn unsettled_queue_receipt_keys(&self, chat_id: &str) -> HashSet<String>;
    fn publish(
        &self,
        chat_id: &str,
        control: &StoredChatExecutionControlState,
    ) -> ExecutionOperationResult<()>;
    fn input_accepted(&self, chat_id: &str) -> ExecutionOperationResult<()>;
}

#[derive(Debug, Serialize)]
pub struct ControlChangeResult {
    pub control: StoredChatExecutionControlState,
    pub changed: bool,
}

#[derive(Debug, Serialize)]
pub struct QueueEntryMutationResult {
    #[serde(flatten)]
    pub value: QueueMutationValue,
    pub control: StoredChatExecutionControlState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMoveResult {
    pub entry_id: String,
    pub duplicate: bool,
    pub rebased: Option<bool>,
    pub control: StoredChatExecutionControlState,
}

#[derive(Debug, Serialize)]
pub struct EnqueuedControl {
    pub entry: StoredControlInputEntry,
    pub control: StoredChatExecutionControlState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DequeuedTurnAdmission {
    Inserted,
    AlreadyCommitted,
    Discarded,
}

#[derive(Debug, Serialize)]
pub struct DequeuedTurn {
    pub input: DequeuedTurnInput,
    pub control: StoredChatExecutionControlState,
    pub inserted: bool,
}

#[derive(Debug, Serialize)]
pub struct ReservedSteer {
    pub entry: StoredQueueEntry,
    pub control: StoredChatExecutionControlState,
}

struct Committed<T> {
    value: T,
    control: StoredChatExecutionControlState,
    changed: bool,
}

type Control = StoredChatExecutionControlState;
type EntryTransition = fn(&Control, &str, &TransitionContext<'_>) -> ControlTransition<()>;
type ReserveTransition = fn(
    &Control,
    &ObservedQueueEntry,
    &TransitionContext<'_>,
) -> ControlTransition<ReservedQueueSteer>;

pub struct ChatExecutionControlOperations {
    repository: Rc<dyn ChatExecutionControlRepository>,
    lock: Rc<KeyedLock>,
    host: Rc<dyn ChatExecutionControlOperationsHost>,
    project_admission: Rc<dyn ProjectAdmissionPort>,
    attachment_admission: Rc<dyn QueuedAttachmentAdmissionPort>,
    clock: Rc<dyn Clock>,
    new_id: Box<dyn Fn() -> String>,
    logger: ScopedLogger,
}

impl ChatExecutionControlOperations {
    pub fn new(
        repository: Rc<dyn ChatExecutionControlRepository>,
        lock: Rc<KeyedLock>,
        host: Rc<dyn ChatExecutionControlOperationsHost>,
        project_admission: Rc<dyn ProjectAdmissionPort>,
        attachment_admission: Rc<dyn QueuedAttachmentAdmissionPort>,
        clock: Rc<dyn Clock>,
        new_id: impl Fn() -> String + 'static,
    ) -> Self {
        Self {
            repository,
            lock,
            host,
            project_admission,
            attachment_admission,
            clock,
            new_id: Box::new(new_id),
            logger: create_logger("chat-execution-control"),
        }
    }

    async fn exclusive<T, F, Fut>(&self, chat_id: &str, work: F) -> ExecutionOperationResult<T>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = ExecutionOperationResult<T>>,
    {
        self.lock
            .run_exclusive(&format!("chat:{chat_id}"), work, None)
            .await?
    }

    async fn load(&self, chat_id: &str) -> Control {
        let current = self.repository.load(chat_id);
        // The original awaits its synchronous load while still holding the lock.
        tokio::task::yield_now().await;
        current
    }

    fn transition<T>(
        &self,
        receipt_chat: Option<&str>,
        run: impl FnOnce(&TransitionContext<'_>) -> ControlTransition<T>,
    ) -> ExecutionOperationResult<ControlTransition<T>> {
        let now = to_iso_string(self.clock.now_ms())?;
        let receipts = || {
            receipt_chat.map_or_else(HashSet::new, |chat| {
                self.host.unsettled_queue_receipt_keys(chat)
            })
        };
        Ok(run(&TransitionContext {
            now: &now,
            new_id: &*self.new_id,
            unsettled_queue_receipt_keys: &receipts,
        }))
    }

    fn assert_chat_exists(&self, chat_id: &str) -> ExecutionOperationResult<()> {
        if self.host.chat_exists(chat_id) {
            Ok(())
        } else {
            Err(Box::new(DomainError::new(
                ErrorCode::SESSION_NOT_FOUND,
                "Chat queue owner no longer exists",
                404,
                false,
            )))
        }
    }

    fn commit_now(
        &self,
        chat_id: &str,
        control: &Control,
        publish: bool,
    ) -> ExecutionOperationResult<Control> {
        self.assert_chat_exists(chat_id)?;
        let result = self.repository.save(chat_id, control)?;
        if publish && let Err(error) = self.host.publish(chat_id, &result) {
            self.logger.warn(&format!(
                "execution-control publication failed after commit for {chat_id}: {error}"
            ));
        }
        Ok(result)
    }

    async fn commit_transition<T>(
        &self,
        chat_id: &str,
        current: &Control,
        transition: ControlTransition<T>,
    ) -> ExecutionOperationResult<Committed<T>> {
        let result: ExecutionOperationResult<_> = match transition.outcome {
            TransitionOutcome::Rejected { rejection } => {
                Err(Box::new(transition_error(&rejection, current)))
            }
            TransitionOutcome::Ok { value } if transition.changed => self
                .commit_now(chat_id, &transition.next, transition.public_changed)
                .map(|control| Committed {
                    value,
                    control,
                    changed: true,
                }),
            TransitionOutcome::Ok { value } => Ok(Committed {
                value,
                control: clone_stored_chat_execution_control(current),
                changed: false,
            }),
        };
        // Every original caller awaits commitTransition before post-commit notifications.
        tokio::task::yield_now().await;
        result
    }

    pub async fn read(&self, chat_id: &str) -> ExecutionOperationResult<Control> {
        self.exclusive(chat_id, || async {
            Ok(clone_stored_chat_execution_control(
                &self.load(chat_id).await,
            ))
        })
        .await
    }

    pub async fn with_control<T, F, Fut>(
        &self,
        chat_id: &str,
        operation: F,
    ) -> ExecutionOperationResult<T>
    where
        F: FnOnce(Control) -> Fut,
        Fut: Future<Output = ExecutionOperationResult<T>>,
    {
        self.exclusive(chat_id, || {
            operation(clone_stored_chat_execution_control(
                &self.repository.load(chat_id),
            ))
        })
        .await
    }

    pub async fn create(
        &self,
        chat_id: &str,
        input: &QueueEntryInput,
        admission_deadline: Option<f64>,
    ) -> ExecutionOperationResult<QueueEntryMutationResult> {
        self.exclusive(chat_id, || async {
            let current = self.load(chat_id).await;
            let transition = self.transition(Some(chat_id), |context| {
                create_queue_entry(&current, input, context)
            })?;
            if matches!(&transition.outcome, TransitionOutcome::Ok { value } if !value.duplicate) {
                self.project_admission
                    .assert_available(chat_id, admission_deadline)
                    .await?;
                if !input.images.is_empty() {
                    self.attachment_admission
                        .assert_supported(chat_id, &input.images)?;
                }
            }
            let Committed { value, control, .. } = self
                .commit_transition(chat_id, &current, transition)
                .await?;
            if !value.duplicate {
                self.host.input_accepted(chat_id)?;
                self.log_mutation(
                    "create",
                    chat_id,
                    &value.entry_id,
                    &control,
                    value.entry.as_ref().map(|entry| entry.0.revision),
                    None,
                );
            }
            Ok(QueueEntryMutationResult { value, control })
        })
        .await
    }

    pub async fn create_steer(
        &self,
        chat_id: &str,
        content: &str,
        command: &QueueCommandIdentity,
        submission: &StoredQueueSubmissionIdentity,
    ) -> ExecutionOperationResult<QueueCommandMutationResult> {
        self.exclusive(chat_id, || async {
            let current = self.load(chat_id).await;
            let input = QueuedSteerInput {
                content: content.to_owned(),
                command: Some(command.clone()),
                submission: Some(submission.clone()),
            };
            let transition = self.transition(Some(chat_id), |context| {
                create_queued_steer(&current, &input, context)
            })?;
            let Committed { value, control, .. } = self
                .commit_transition(chat_id, &current, transition)
                .await?;
            if !value.duplicate {
                self.host.input_accepted(chat_id)?;
                self.log_mutation(
                    "create-steer",
                    chat_id,
                    &value.entry_id,
                    &control,
                    None,
                    None,
                );
            }
            Ok(QueueCommandMutationResult {
                entry_id: value.entry_id,
                control,
                duplicate: value.duplicate,
            })
        })
        .await
    }

    pub async fn mark_steer(
        &self,
        chat_id: &str,
        input: &ObservedQueueEntry,
    ) -> ExecutionOperationResult<Control> {
        self.exclusive(chat_id, || async {
            self.assert_chat_exists(chat_id)?;
            let current = self.load(chat_id).await;
            let transition = self.transition(None, |context| {
                mark_queue_entry_steer(&current, input, context)
            })?;
            let committed = self
                .commit_transition(chat_id, &current, transition)
                .await?;
            if committed.changed {
                self.log_mutation(
                    "mark-steer",
                    chat_id,
                    &input.entry_id,
                    &committed.control,
                    None,
                    None,
                );
            }
            Ok(committed.control)
        })
        .await
    }

    pub async fn replace(
        &self,
        chat_id: &str,
        input: &ReplaceQueueEntryInput,
    ) -> ExecutionOperationResult<QueueEntryMutationResult> {
        self.exclusive(chat_id, || async {
            let current = self.load(chat_id).await;
            let transition = self.transition(Some(chat_id), |context| {
                replace_queue_entry(&current, input, context)
            })?;
            if let TransitionOutcome::Rejected { rejection } = &transition.outcome {
                let error = transition_error(rejection, &current);
                self.log_mutation(
                    "replace",
                    chat_id,
                    &input.entry_id,
                    &current,
                    revision(&current, &input.entry_id),
                    Some(error.domain_error().code),
                );
            }
            let Committed { value, control, .. } = self
                .commit_transition(chat_id, &current, transition)
                .await?;
            if !value.duplicate {
                self.host.input_accepted(chat_id)?;
                self.log_mutation(
                    "replace",
                    chat_id,
                    &input.entry_id,
                    &control,
                    value.entry.as_ref().map(|entry| entry.0.revision),
                    None,
                );
            }
            Ok(QueueEntryMutationResult { value, control })
        })
        .await
    }

    pub async fn delete(
        &self,
        chat_id: &str,
        input: &DeleteQueueEntryInput,
    ) -> ExecutionOperationResult<QueueCommandMutationResult> {
        self.exclusive(chat_id, || async {
            let current = self.load(chat_id).await;
            let transition = self.transition(Some(chat_id), |context| {
                delete_queue_entry(&current, input, context)
            })?;
            if let TransitionOutcome::Rejected { rejection } = &transition.outcome {
                let error = transition_error(rejection, &current);
                self.log_mutation(
                    "delete",
                    chat_id,
                    &input.entry_id,
                    &current,
                    revision(&current, &input.entry_id),
                    Some(error.domain_error().code),
                );
            }
            let Committed { value, control, .. } = self
                .commit_transition(chat_id, &current, transition)
                .await?;
            if !value.duplicate {
                self.log_mutation("delete", chat_id, &input.entry_id, &control, None, None);
            }
            Ok(QueueCommandMutationResult {
                entry_id: value.entry_id,
                control,
                duplicate: value.duplicate,
            })
        })
        .await
    }

    pub async fn move_entry(
        &self,
        chat_id: &str,
        input: &MoveQueueEntryInput,
    ) -> ExecutionOperationResult<QueueMoveResult> {
        self.exclusive(chat_id, || async {
            let current = self.load(chat_id).await;
            let transition = self.transition(Some(chat_id), |context| {
                move_queue_entry(&current, input, context)
            })?;
            if let TransitionOutcome::Rejected { rejection } = &transition.outcome {
                let error = transition_error(rejection, &current);
                self.log_move(
                    chat_id,
                    input,
                    &current,
                    None,
                    Some(error.domain_error().code),
                );
            }
            let Committed { value, control, .. } = self
                .commit_transition(chat_id, &current, transition)
                .await?;
            if !value.value.duplicate {
                self.log_move(chat_id, input, &control, value.rebased, None);
            }
            Ok(QueueMoveResult {
                entry_id: value.value.entry_id,
                duplicate: value.value.duplicate,
                rebased: value.rebased,
                control,
            })
        })
        .await
    }

    pub async fn clear(&self, chat_id: &str) -> ExecutionOperationResult<Control> {
        self.change_pending(chat_id, clear_queue).await
    }

    pub async fn discard_pending_input(&self, chat_id: &str) -> ExecutionOperationResult<Control> {
        self.change_pending(chat_id, discard_pending_input).await
    }

    async fn change_pending(
        &self,
        chat_id: &str,
        change: fn(&Control, &TransitionContext<'_>) -> ControlTransition<()>,
    ) -> ExecutionOperationResult<Control> {
        self.exclusive(chat_id, || async {
            let current = self.load(chat_id).await;
            let transition = self.transition(None, |context| change(&current, context))?;
            Ok(self
                .commit_transition(chat_id, &current, transition)
                .await?
                .control)
        })
        .await
    }

    pub async fn enqueue_control(
        &self,
        chat_id: &str,
        input: &StoredControlInput,
    ) -> ExecutionOperationResult<EnqueuedControl> {
        self.exclusive(chat_id, || async {
            self.assert_chat_exists(chat_id)?;
            let current = self.load(chat_id).await;
            let transition = self.transition(None, |context| {
                enqueue_control_input(&current, input, context)
            })?;
            let Committed { value, control, .. } = self
                .commit_transition(chat_id, &current, transition)
                .await?;
            self.log_control_mutation("enqueue", chat_id, &value, &control);
            self.host.input_accepted(chat_id)?;
            Ok(EnqueuedControl {
                entry: value,
                control,
            })
        })
        .await
    }

    pub async fn pause(&self, chat_id: &str) -> ExecutionOperationResult<ControlChangeResult> {
        self.pause_if(chat_id, |_| true).await
    }

    pub async fn pause_for_unavailable_project(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<ControlChangeResult> {
        self.pause_if(chat_id, |current| {
            !current.entries.is_empty()
                && current
                    .entries
                    .iter()
                    .all(|entry| entry.status == StoredQueueEntryStatus::Queued)
        })
        .await
    }

    async fn pause_if(
        &self,
        chat_id: &str,
        eligible: impl FnOnce(&Control) -> bool,
    ) -> ExecutionOperationResult<ControlChangeResult> {
        self.exclusive(chat_id, || async {
            let current = self.load(chat_id).await;
            if !eligible(&current) {
                return Ok(ControlChangeResult {
                    control: clone_stored_chat_execution_control(&current),
                    changed: false,
                });
            }
            let transition = self.transition(None, |context| pause_queue(&current, context))?;
            let committed = self
                .commit_transition(chat_id, &current, transition)
                .await?;
            if committed.changed {
                self.log_pause_mutation("pause", chat_id, &committed.control, None);
            }
            Ok(ControlChangeResult {
                control: committed.control,
                changed: committed.changed,
            })
        })
        .await
    }

    pub async fn resume(
        &self,
        chat_id: &str,
        pause_id: &str,
    ) -> ExecutionOperationResult<ControlChangeResult> {
        self.exclusive(chat_id, || async {
            let current = self.load(chat_id).await;
            let transition =
                self.transition(None, |context| resume_queue(&current, pause_id, context))?;
            let committed = self
                .commit_transition(chat_id, &current, transition)
                .await?;
            if committed.changed {
                self.log_pause_mutation("resume", chat_id, &committed.control, None);
            }
            Ok(ControlChangeResult {
                control: committed.control,
                changed: committed.changed,
            })
        })
        .await
    }

    pub async fn dequeue_next_turn(
        &self,
        chat_id: &str,
        admit: impl FnOnce(&DequeuedTurnInput) -> ExecutionOperationResult<DequeuedTurnAdmission>,
    ) -> ExecutionOperationResult<Option<DequeuedTurn>> {
        self.exclusive(chat_id, || async {
            let current = self.repository.load(chat_id);
            let mut transition =
                self.transition(None, |context| dequeue_next_turn(&current, context))?;
            let input = match transition.outcome {
                TransitionOutcome::Rejected { rejection } => {
                    return Err(Box::new(transition_error(&rejection, &current))
                        as Box<dyn std::error::Error>);
                }
                TransitionOutcome::Ok { value: None } => return Ok(None),
                TransitionOutcome::Ok { value: Some(input) } => input,
            };
            let admission = admit(&input)?;
            if admission == DequeuedTurnAdmission::Discarded {
                transition.next.recently_dispatched = current.recently_dispatched;
            }
            let control = self.commit_now(chat_id, &transition.next, transition.public_changed)?;
            match &input {
                DequeuedTurnInput::Control { entry } => {
                    self.log_control_mutation("dequeue", chat_id, entry, &control)
                }
                DequeuedTurnInput::User { entry } => self.log_mutation(
                    "pop",
                    chat_id,
                    &entry.id,
                    &control,
                    Some(entry.revision),
                    None,
                ),
            }
            Ok(Some(DequeuedTurn {
                input,
                control,
                inserted: admission == DequeuedTurnAdmission::Inserted,
            }))
        })
        .await
    }

    pub async fn reserve_steer(
        &self,
        chat_id: &str,
        input: &ObservedQueueEntry,
    ) -> ExecutionOperationResult<ReservedSteer> {
        self.reserve(chat_id, input, reserve_queue_steer).await
    }

    pub async fn reserve_pending_steer(
        &self,
        chat_id: &str,
        input: &ObservedQueueEntry,
    ) -> ExecutionOperationResult<ReservedSteer> {
        self.reserve(chat_id, input, reserve_pending_steer).await
    }

    async fn reserve(
        &self,
        chat_id: &str,
        input: &ObservedQueueEntry,
        reserve: ReserveTransition,
    ) -> ExecutionOperationResult<ReservedSteer> {
        self.exclusive(chat_id, || async {
            self.assert_chat_exists(chat_id)?;
            let current = self.load(chat_id).await;
            let transition = self.transition(None, |context| reserve(&current, input, context))?;
            let control = self
                .commit_transition(chat_id, &current, transition)
                .await?
                .control;
            // INFALLIBLE: a successful reservation keeps the entry and the repository saves its copy.
            let entry = control
                .entries
                .iter()
                .find(|entry| entry.id == input.entry_id)
                .expect("reservation retains the entry")
                .clone();
            self.log_mutation(
                "steer-reserve",
                chat_id,
                &entry.id,
                &control,
                Some(entry.revision),
                None,
            );
            Ok(ReservedSteer { entry, control })
        })
        .await
    }

    pub async fn release_steer(
        &self,
        chat_id: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<Control> {
        self.settle_steer(chat_id, entry_id, release_queue_steer, "steer-release")
            .await
    }

    pub async fn consume_steer(
        &self,
        chat_id: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<Control> {
        self.settle_steer(chat_id, entry_id, consume_queue_steer, "steer-consume")
            .await
    }

    async fn settle_steer(
        &self,
        chat_id: &str,
        entry_id: &str,
        settle: EntryTransition,
        operation: &str,
    ) -> ExecutionOperationResult<Control> {
        self.exclusive(chat_id, || async {
            self.assert_chat_exists(chat_id)?;
            let current = self.load(chat_id).await;
            let transition =
                self.transition(None, |context| settle(&current, entry_id, context))?;
            let committed = self
                .commit_transition(chat_id, &current, transition)
                .await?;
            if committed.changed {
                self.log_mutation(operation, chat_id, entry_id, &committed.control, None, None);
            }
            Ok(committed.control)
        })
        .await
    }

    pub async fn requeue_and_pause(
        &self,
        chat_id: &str,
        entry_id: &str,
        kind: AutomaticQueuePauseKind,
    ) -> ExecutionOperationResult<Control> {
        self.exclusive(chat_id, || async {
            let current = self.load(chat_id).await;
            let prior_revision = revision(&current, entry_id);
            let transition = self.transition(None, |context| {
                requeue_and_pause(
                    &current,
                    &RequeueAndPauseInput {
                        entry_id: entry_id.to_owned(),
                        kind,
                    },
                    context,
                )
            })?;
            let control = self
                .commit_transition(chat_id, &current, transition)
                .await?
                .control;
            if prior_revision.is_some() {
                self.log_mutation("requeue", chat_id, entry_id, &control, prior_revision, None);
            }
            self.log_pause_mutation("pause", chat_id, &control, Some(entry_id));
            Ok(control)
        })
        .await
    }

    pub async fn pause_after_failure(
        &self,
        chat_id: &str,
        cause: &FailurePauseCause,
    ) -> ExecutionOperationResult<()> {
        self.exclusive(chat_id, || async {
            let current = self.load(chat_id).await;
            let transition = self.transition(None, |context| {
                pause_after_failure(&current, cause, context)
            })?;
            let committed = self
                .commit_transition(chat_id, &current, transition)
                .await?;
            if committed.changed {
                let entry_id = match cause {
                    FailurePauseCause::QueuedTurnFailed { entry_id } => Some(entry_id.as_str()),
                    FailurePauseCause::TurnFailed { .. } => None,
                };
                self.log_pause_mutation("pause", chat_id, &committed.control, entry_id);
            }
            Ok(())
        })
        .await
    }

    pub fn delete_stored(&self, chat_id: &str) {
        self.repository.delete(chat_id);
    }

    fn log_mutation(
        &self,
        operation: &str,
        chat_id: &str,
        entry_id: &str,
        control: &Control,
        revision: Option<u64>,
        error_code: Option<ErrorCode>,
    ) {
        self.logger.debug(&format!(
            "queue mutation chatId={chat_id} operation={operation} entryId={entry_id} revision={revision:?} queueVersion={} queuedCount={} errorCode={error_code:?}",
            control.version, control.entries.len(),
        ));
    }

    fn log_move(
        &self,
        chat_id: &str,
        input: &MoveQueueEntryInput,
        control: &Control,
        rebased: Option<bool>,
        error_code: Option<ErrorCode>,
    ) {
        self.logger.debug(&format!(
            "queue mutation chatId={chat_id} operation=move entryId={} targetEntryId={} placement={:?} expectedReorderRevision={} reorderRevision={} queueVersion={} queuedCount={} rebased={rebased:?} errorCode={error_code:?}",
            input.entry_id, input.target_entry_id, input.placement, input.expected_reorder_revision, control.reorder_revision, control.version, control.entries.len(),
        ));
    }

    fn log_pause_mutation(
        &self,
        operation: &str,
        chat_id: &str,
        control: &Control,
        entry_id: Option<&str>,
    ) {
        self.logger.debug(&format!(
            "queue pause mutation chatId={chat_id} operation={operation} entryId={entry_id:?} pauseId={:?} pauseKind={:?} queueVersion={} queuedCount={}",
            control.pause.as_ref().map(|pause| &pause.id), control.pause.as_ref().map(|pause| &pause.kind), control.version, control.entries.len(),
        ));
    }

    fn log_control_mutation(
        &self,
        operation: &str,
        chat_id: &str,
        entry: &StoredControlInputEntry,
        control: &Control,
    ) {
        self.logger.debug(&format!(
            "control input lane mutation chatId={chat_id} operation={operation} entryId={} laneDepth={}",
            entry.id, control.control_entries.len(),
        ));
    }
}

fn revision(control: &Control, entry_id: &str) -> Option<u64> {
    control
        .entries
        .iter()
        .find(|entry| entry.id == entry_id)
        .map(|entry| entry.revision)
}
