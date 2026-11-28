//! Ports the pure controller queue transitions.

use std::collections::HashSet;

use garcon_contract::chat_command_contracts::QueueEntryPlacement;
use garcon_contract::queue_state::{
    AutomaticQueuePauseKind, QueueEntryKind, QueuePause, QueuePauseKind,
    RecentlyDispatchedQueueEntry,
};
use garcon_contract::ws_requests::AgentCommandImage;
use garcon_js::trim;
use serde::{Deserialize, Serialize};

use crate::control_projection::ClientQueueEntry;
use crate::control_state::{
    MAX_CONTROL_INPUT_ENTRIES, MAX_QUEUED_ATTACHMENT_BYTES, MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES,
    MAX_STORED_APPLIED_QUEUE_COMMANDS, StoredAppliedQueueCommand, StoredChatExecutionControlState,
    StoredControlInput, StoredControlInputEntry, StoredQueueCommandOperation, StoredQueueEntry,
    StoredQueueEntryStatus, StoredQueueSubmissionIdentity, clone_stored_chat_execution_control,
    has_pending_turn_input, queued_attachment_bytes, to_client_queue_entry,
};

pub struct TransitionContext<'a> {
    pub now: &'a str,
    pub new_id: &'a dyn Fn() -> String,
    pub unsettled_queue_receipt_keys: &'a dyn Fn() -> HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCommandIdentity {
    pub key: String,
    pub entry_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum TransitionRejection {
    ValidationFailed,
    IdempotencyConflict {
        client_message_id: String,
    },
    QueueEntryNotFound {
        entry_id: String,
    },
    QueueEntryAlreadySent {
        entry_id: String,
    },
    QueueEntryInFlight {
        entry_id: String,
    },
    QueueEntryRevisionConflict {
        entry_id: String,
        actual_revision: u64,
    },
    QueueEntryReorderConflict,
    QueuePauseChanged,
    ControlInputQueueFull,
    QueueAttachmentsFull,
}

pub trait TransitionValue: Serialize {
    fn is_undefined(&self) -> bool {
        false
    }
}

impl TransitionValue for () {
    fn is_undefined(&self) -> bool {
        true
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    bound(serialize = "T: TransitionValue")
)]
pub enum TransitionOutcome<T> {
    Ok {
        #[serde(skip_serializing_if = "TransitionValue::is_undefined")]
        value: T,
    },
    Rejected {
        rejection: TransitionRejection,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", bound(serialize = "T: TransitionValue"))]
pub struct ControlTransition<T> {
    pub next: StoredChatExecutionControlState,
    pub outcome: TransitionOutcome<T>,
    pub changed: bool,
    pub public_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMutationValue {
    pub entry_id: String,
    pub entry: Option<ClientQueueEntry>,
    pub duplicate: bool,
}
impl TransitionValue for QueueMutationValue {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QueueMoveMutationValue {
    #[serde(flatten)]
    pub value: QueueMutationValue,
    pub rebased: Option<bool>,
}
impl TransitionValue for QueueMoveMutationValue {}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DequeuedTurnInput {
    Control { entry: StoredControlInputEntry },
    User { entry: StoredQueueEntry },
}
impl TransitionValue for Option<DequeuedTurnInput> {}
impl TransitionValue for StoredControlInputEntry {}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReservedQueueSteer {
    pub entry: StoredQueueEntry,
}
impl TransitionValue for ReservedQueueSteer {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedQueueEntry {
    pub entry_id: String,
    pub expected_revision: u64,
    pub expected_reorder_revision: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueueEntryInput {
    pub content: String,
    pub images: Vec<AgentCommandImage>,
    pub command: Option<QueueCommandIdentity>,
    pub submission: Option<StoredQueueSubmissionIdentity>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueuedSteerInput {
    pub content: String,
    pub command: Option<QueueCommandIdentity>,
    pub submission: Option<StoredQueueSubmissionIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaceQueueEntryInput {
    pub entry_id: String,
    pub content: String,
    pub expected_revision: u64,
    pub command: Option<QueueCommandIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteQueueEntryInput {
    pub entry_id: String,
    pub command: Option<QueueCommandIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveQueueEntryInput {
    pub entry_id: String,
    pub target_entry_id: String,
    pub placement: QueueEntryPlacement,
    pub expected_reorder_revision: u64,
    pub expected_source_revision: u64,
    pub expected_target_revision: u64,
    pub command: Option<QueueCommandIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequeueAndPauseInput {
    pub entry_id: String,
    pub kind: AutomaticQueuePauseKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum FailurePauseCause {
    QueuedTurnFailed { entry_id: String },
    TurnFailed { turn_id: String },
}

fn accepted<T>(
    next: StoredChatExecutionControlState,
    value: T,
    changed: bool,
) -> ControlTransition<T> {
    ControlTransition {
        next,
        outcome: TransitionOutcome::Ok { value },
        changed,
        public_changed: changed,
    }
}

fn accepted_internal<T>(next: StoredChatExecutionControlState, value: T) -> ControlTransition<T> {
    ControlTransition {
        next,
        outcome: TransitionOutcome::Ok { value },
        changed: true,
        public_changed: false,
    }
}

fn rejected<T>(
    current: &StoredChatExecutionControlState,
    rejection: TransitionRejection,
) -> ControlTransition<T> {
    ControlTransition {
        next: clone_stored_chat_execution_control(current),
        outcome: TransitionOutcome::Rejected { rejection },
        changed: false,
        public_changed: false,
    }
}

fn bump(control: &mut StoredChatExecutionControlState, now: &str) {
    control.version += 1;
    control.updated_at = Some(now.to_owned());
}

fn find_applied_command<'a>(
    control: &'a StoredChatExecutionControlState,
    command: Option<&QueueCommandIdentity>,
) -> Option<&'a StoredAppliedQueueCommand> {
    let command = command?;
    control
        .applied_commands
        .iter()
        .find(|candidate| candidate.key == command.key)
}

fn record_applied_command(
    control: &mut StoredChatExecutionControlState,
    command: &QueueCommandIdentity,
    operation: StoredQueueCommandOperation,
    context: &TransitionContext<'_>,
) {
    let mut protected = (context.unsettled_queue_receipt_keys)();
    protected.insert(command.key.clone());
    let records = &mut control.applied_commands;
    records.retain(|candidate| candidate.key != command.key);
    records.push(StoredAppliedQueueCommand {
        key: command.key.clone(),
        operation,
        entry_id: command.entry_id.clone(),
        applied_at: context.now.to_owned(),
    });
    let protected_count = records
        .iter()
        .filter(|candidate| protected.contains(&candidate.key))
        .count();
    let terminal_limit = MAX_STORED_APPLIED_QUEUE_COMMANDS.saturating_sub(protected_count);
    let retained: HashSet<_> = records
        .iter()
        .rev()
        .filter(|candidate| !protected.contains(&candidate.key))
        .take(terminal_limit)
        .map(|candidate| candidate.key.clone())
        .collect();
    records.retain(|candidate| {
        protected.contains(&candidate.key) || retained.contains(&candidate.key)
    });
}

fn missing_entry_rejection(
    control: &StoredChatExecutionControlState,
    id: &str,
) -> TransitionRejection {
    let entry_id = id.to_owned();
    if control
        .recently_dispatched
        .iter()
        .any(|entry| entry.entry_id == id)
    {
        TransitionRejection::QueueEntryAlreadySent { entry_id }
    } else {
        TransitionRejection::QueueEntryNotFound { entry_id }
    }
}

fn revision_rejection(entry_id: &str, actual_revision: u64) -> TransitionRejection {
    TransitionRejection::QueueEntryRevisionConflict {
        entry_id: entry_id.to_owned(),
        actual_revision,
    }
}

fn in_flight(entry_id: &str) -> TransitionRejection {
    TransitionRejection::QueueEntryInFlight {
        entry_id: entry_id.to_owned(),
    }
}

fn mutation(entry: &StoredQueueEntry, duplicate: bool) -> QueueMutationValue {
    QueueMutationValue {
        entry_id: entry.id.clone(),
        entry: Some(to_client_queue_entry(entry)),
        duplicate,
    }
}

fn duplicate(
    control: &StoredChatExecutionControlState,
    applied: &StoredAppliedQueueCommand,
) -> QueueMutationValue {
    QueueMutationValue {
        entry_id: applied.entry_id.clone(),
        entry: control
            .entries
            .iter()
            .find(|entry| entry.id == applied.entry_id)
            .map(to_client_queue_entry),
        duplicate: true,
    }
}

pub fn create_queue_entry(
    current: &StoredChatExecutionControlState,
    input: &QueueEntryInput,
    context: &TransitionContext<'_>,
) -> ControlTransition<QueueMutationValue> {
    insert_queue_entry(
        current,
        &input.content,
        &input.images,
        input.command.as_ref(),
        input.submission.as_ref(),
        QueueEntryKind::Turn,
        context,
    )
}

pub fn create_queued_steer(
    current: &StoredChatExecutionControlState,
    input: &QueuedSteerInput,
    context: &TransitionContext<'_>,
) -> ControlTransition<QueueMutationValue> {
    insert_queue_entry(
        current,
        &input.content,
        &[],
        input.command.as_ref(),
        input.submission.as_ref(),
        QueueEntryKind::Steer,
        context,
    )
}

fn insert_queue_entry(
    current: &StoredChatExecutionControlState,
    content: &str,
    images: &[AgentCommandImage],
    command: Option<&QueueCommandIdentity>,
    submission: Option<&StoredQueueSubmissionIdentity>,
    kind: QueueEntryKind,
    context: &TransitionContext<'_>,
) -> ControlTransition<QueueMutationValue> {
    let mut next = clone_stored_chat_execution_control(current);
    if let Some(identity) = submission
        && let Some(submitted) = next.entries.iter().find(|entry| {
            entry.submission.as_ref().is_some_and(|submitted| {
                submitted.client_message_id == identity.client_message_id
                    && submitted.transcript_view_id == identity.transcript_view_id
            })
        })
    {
        if submitted.content != content || submitted.images != images {
            return rejected(
                current,
                TransitionRejection::IdempotencyConflict {
                    client_message_id: identity.client_message_id.clone(),
                },
            );
        }
        let value = mutation(submitted, true);
        return accepted(next, value, false);
    }
    if let Some(applied) = find_applied_command(&next, command) {
        let value = duplicate(&next, applied);
        return accepted(next, value, false);
    }
    if !images.is_empty()
        && next
            .entries
            .iter()
            .map(|entry| queued_attachment_bytes(&entry.images))
            .sum::<i64>()
            + queued_attachment_bytes(images)
            > MAX_QUEUED_ATTACHMENT_BYTES as i64
    {
        return rejected(current, TransitionRejection::QueueAttachmentsFull);
    }
    let entry = StoredQueueEntry {
        id: command.map_or_else(context.new_id, |command| command.entry_id.clone()),
        content: content.to_owned(),
        kind,
        images: images.to_vec(),
        revision: 1,
        status: StoredQueueEntryStatus::Queued,
        created_at: context.now.to_owned(),
        updated_at: context.now.to_owned(),
        submission: submission.cloned(),
    };
    let value = mutation(&entry, false);
    if kind == QueueEntryKind::Steer {
        insert_pending_steer(&mut next.entries, entry);
    } else {
        next.entries.push(entry);
    }
    if let Some(command) = command {
        record_applied_command(
            &mut next,
            command,
            StoredQueueCommandOperation::Create,
            context,
        );
    }
    bump(&mut next, context.now);
    accepted(next, value, true)
}

fn insert_pending_steer(entries: &mut Vec<StoredQueueEntry>, entry: StoredQueueEntry) -> usize {
    let index = entries
        .iter()
        .rposition(|entry| entry.kind == QueueEntryKind::Steer)
        .map(|index| index + 1)
        .or_else(|| {
            entries.iter().position(|entry| {
                entry.status == StoredQueueEntryStatus::Queued && entry.kind == QueueEntryKind::Turn
            })
        })
        .unwrap_or(entries.len());
    entries.insert(index, entry);
    index
}

pub fn enqueue_control_input(
    current: &StoredChatExecutionControlState,
    input: &StoredControlInput,
    context: &TransitionContext<'_>,
) -> ControlTransition<StoredControlInputEntry> {
    let mut next = clone_stored_chat_execution_control(current);
    if next.control_entries.len() >= MAX_CONTROL_INPUT_ENTRIES {
        return rejected(current, TransitionRejection::ControlInputQueueFull);
    }
    let entry = StoredControlInputEntry {
        id: (context.new_id)(),
        input: input.clone(),
    };
    next.control_entries.push(entry.clone());
    accepted_internal(next, entry)
}

pub fn replace_queue_entry(
    current: &StoredChatExecutionControlState,
    input: &ReplaceQueueEntryInput,
    context: &TransitionContext<'_>,
) -> ControlTransition<QueueMutationValue> {
    let mut next = clone_stored_chat_execution_control(current);
    if let Some(applied) = find_applied_command(&next, input.command.as_ref()) {
        let value = duplicate(&next, applied);
        return accepted(next, value, false);
    }
    let Some(entry) = next
        .entries
        .iter_mut()
        .find(|entry| entry.id == input.entry_id)
    else {
        return rejected(current, missing_entry_rejection(current, &input.entry_id));
    };
    if entry.status != StoredQueueEntryStatus::Queued {
        return rejected(current, in_flight(&input.entry_id));
    }
    if entry.revision != input.expected_revision {
        return rejected(current, revision_rejection(&input.entry_id, entry.revision));
    }
    if trim(&input.content).is_empty() && entry.images.is_empty() {
        return rejected(current, TransitionRejection::ValidationFailed);
    }
    entry.content.clone_from(&input.content);
    entry.revision += 1;
    entry.updated_at = context.now.to_owned();
    let value = mutation(entry, false);
    if let Some(command) = &input.command {
        record_applied_command(
            &mut next,
            command,
            StoredQueueCommandOperation::Replace,
            context,
        );
    }
    bump(&mut next, context.now);
    accepted(next, value, true)
}

pub fn delete_queue_entry(
    current: &StoredChatExecutionControlState,
    input: &DeleteQueueEntryInput,
    context: &TransitionContext<'_>,
) -> ControlTransition<QueueMutationValue> {
    let mut next = clone_stored_chat_execution_control(current);
    if let Some(applied) = find_applied_command(&next, input.command.as_ref()) {
        let value = QueueMutationValue {
            entry_id: applied.entry_id.clone(),
            entry: None,
            duplicate: true,
        };
        return accepted(next, value, false);
    }
    let Some(index) = next
        .entries
        .iter()
        .position(|entry| entry.id == input.entry_id)
    else {
        return rejected(current, missing_entry_rejection(current, &input.entry_id));
    };
    if next.entries[index].status != StoredQueueEntryStatus::Queued {
        return rejected(current, in_flight(&input.entry_id));
    }
    next.entries.remove(index);
    clear_idle_pause(&mut next);
    if let Some(command) = &input.command {
        record_applied_command(
            &mut next,
            command,
            StoredQueueCommandOperation::Delete,
            context,
        );
    }
    bump(&mut next, context.now);
    accepted(
        next,
        QueueMutationValue {
            entry_id: input.entry_id.clone(),
            entry: None,
            duplicate: false,
        },
        true,
    )
}

pub fn move_queue_entry(
    current: &StoredChatExecutionControlState,
    input: &MoveQueueEntryInput,
    context: &TransitionContext<'_>,
) -> ControlTransition<QueueMoveMutationValue> {
    let mut next = clone_stored_chat_execution_control(current);
    if let Some(applied) = find_applied_command(&next, input.command.as_ref()) {
        let value = QueueMoveMutationValue {
            value: duplicate(&next, applied),
            rebased: None,
        };
        return accepted(next, value, false);
    }
    let Some(source_index) = next
        .entries
        .iter()
        .position(|entry| entry.id == input.entry_id)
    else {
        return rejected(current, missing_entry_rejection(current, &input.entry_id));
    };
    let source = &next.entries[source_index];
    if source.status != StoredQueueEntryStatus::Queued {
        return rejected(current, in_flight(&input.entry_id));
    }
    if source.revision != input.expected_source_revision {
        return rejected(
            current,
            revision_rejection(&input.entry_id, source.revision),
        );
    }
    if next.reorder_revision != input.expected_reorder_revision {
        return rejected(current, TransitionRejection::QueueEntryReorderConflict);
    }

    let target = next
        .entries
        .iter()
        .find(|entry| entry.id == input.target_entry_id);
    let recent = next
        .recently_dispatched
        .iter()
        .find(|entry| entry.entry_id == input.target_entry_id);
    let rebased = target.is_none() && recent.is_some();
    let Some(target_revision) = target
        .map(|entry| entry.revision)
        .or_else(|| recent.map(|entry| entry.revision))
    else {
        return rejected(current, TransitionRejection::QueueEntryReorderConflict);
    };
    if target_revision != input.expected_target_revision {
        return rejected(
            current,
            revision_rejection(&input.target_entry_id, target_revision),
        );
    }

    let original_order: Vec<_> = next.entries.iter().map(|entry| entry.id.clone()).collect();
    let source = next.entries.remove(source_index);
    let value = mutation(&source, false);
    let index = if rebased {
        0
    } else {
        let target = next
            .entries
            .iter()
            .position(|entry| entry.id == input.target_entry_id);
        // Moving relative to itself leaves a -1 target index in the original splice.
        match (target, input.placement) {
            (Some(index), QueueEntryPlacement::Before) => index,
            (Some(index), QueueEntryPlacement::After) => index + 1,
            (None, QueueEntryPlacement::Before) => next.entries.len().saturating_sub(1),
            (None, QueueEntryPlacement::After) => 0,
        }
    };
    next.entries.insert(index, source);
    let order_changed = original_order
        .iter()
        .ne(next.entries.iter().map(|entry| &entry.id));
    if order_changed {
        next.reorder_revision += 1;
    }
    if let Some(command) = &input.command {
        record_applied_command(
            &mut next,
            command,
            StoredQueueCommandOperation::Move,
            context,
        );
    }
    let changed = order_changed || input.command.is_some();
    if changed {
        bump(&mut next, context.now);
    }
    accepted(
        next,
        QueueMoveMutationValue {
            value,
            rebased: Some(rebased),
        },
        changed,
    )
}

fn clear_idle_pause(next: &mut StoredChatExecutionControlState) {
    if !has_pending_turn_input(next) {
        next.pause = None;
        next.resume_pauses = None;
    }
}

pub fn clear_queue(
    current: &StoredChatExecutionControlState,
    context: &TransitionContext<'_>,
) -> ControlTransition<()> {
    if let Some(steering) = current
        .entries
        .iter()
        .find(|entry| entry.status == StoredQueueEntryStatus::Steering)
    {
        return rejected(current, in_flight(&steering.id));
    }
    let mut next = clone_stored_chat_execution_control(current);
    next.entries.clear();
    next.pause = None;
    next.resume_pauses = None;
    bump(&mut next, context.now);
    accepted(next, (), true)
}

pub fn discard_pending_input(
    current: &StoredChatExecutionControlState,
    context: &TransitionContext<'_>,
) -> ControlTransition<()> {
    let mut next = clone_stored_chat_execution_control(current);
    if !has_pending_turn_input(&next) && next.pause.is_none() && next.resume_pauses.is_none() {
        return accepted(next, (), false);
    }
    next.entries.clear();
    next.control_entries.clear();
    next.pause = None;
    next.resume_pauses = None;
    bump(&mut next, context.now);
    accepted(next, (), true)
}

pub fn pause_queue(
    current: &StoredChatExecutionControlState,
    context: &TransitionContext<'_>,
) -> ControlTransition<()> {
    let mut next = clone_stored_chat_execution_control(current);
    if !has_pending_turn_input(&next) || next.pause.is_some() {
        return accepted(next, (), false);
    }
    next.pause = Some(QueuePause {
        id: (context.new_id)(),
        kind: QueuePauseKind::Manual {
            paused_at: context.now.to_owned(),
        },
    });
    bump(&mut next, context.now);
    accepted(next, (), true)
}

pub fn resume_queue(
    current: &StoredChatExecutionControlState,
    pause_id: &str,
    context: &TransitionContext<'_>,
) -> ControlTransition<()> {
    let mut next = clone_stored_chat_execution_control(current);
    let Some(pause) = &next.pause else {
        return accepted(next, (), false);
    };
    if pause.id != pause_id {
        return rejected(current, TransitionRejection::QueuePauseChanged);
    }
    let mut pauses = next.resume_pauses.take().unwrap_or_default().into_iter();
    next.pause = pauses.next();
    let remaining = pauses.collect::<Vec<_>>();
    next.resume_pauses = (!remaining.is_empty()).then_some(remaining);
    bump(&mut next, context.now);
    accepted(next, (), true)
}

fn record_dispatch(
    next: &mut StoredChatExecutionControlState,
    entry: &StoredQueueEntry,
    now: &str,
) {
    next.recently_dispatched
        .retain(|old| old.entry_id != entry.id);
    next.recently_dispatched.push(RecentlyDispatchedQueueEntry {
        entry_id: entry.id.clone(),
        revision: entry.revision,
        dispatched_at: now.to_owned(),
    });
    let excess = next
        .recently_dispatched
        .len()
        .saturating_sub(MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES);
    next.recently_dispatched.drain(..excess);
}

pub fn dequeue_next_turn(
    current: &StoredChatExecutionControlState,
    context: &TransitionContext<'_>,
) -> ControlTransition<Option<DequeuedTurnInput>> {
    let mut next = clone_stored_chat_execution_control(current);
    if next.pause.is_some()
        || next
            .entries
            .iter()
            .any(|entry| entry.status == StoredQueueEntryStatus::Steering)
    {
        return accepted(next, None, false);
    }
    if !next.control_entries.is_empty() {
        let entry = next.control_entries.remove(0);
        return accepted_internal(next, Some(DequeuedTurnInput::Control { entry }));
    }
    if next.entries.is_empty() {
        return accepted(next, None, false);
    }
    let entry = next.entries.remove(0);
    record_dispatch(&mut next, &entry, context.now);
    bump(&mut next, context.now);
    accepted(next, Some(DequeuedTurnInput::User { entry }), true)
}

pub fn reserve_queue_steer(
    current: &StoredChatExecutionControlState,
    input: &ObservedQueueEntry,
    context: &TransitionContext<'_>,
) -> ControlTransition<ReservedQueueSteer> {
    let mut next = clone_stored_chat_execution_control(current);
    let Some(index) = next
        .entries
        .iter()
        .position(|candidate| candidate.id == input.entry_id)
    else {
        return rejected(current, missing_entry_rejection(current, &input.entry_id));
    };
    if next
        .entries
        .iter()
        .any(|entry| entry.status == StoredQueueEntryStatus::Steering)
    {
        return rejected(current, in_flight(&input.entry_id));
    }
    let entry = &mut next.entries[index];
    if entry.revision != input.expected_revision {
        return rejected(current, revision_rejection(&input.entry_id, entry.revision));
    }
    if next.reorder_revision != input.expected_reorder_revision {
        return rejected(current, TransitionRejection::QueueEntryReorderConflict);
    }
    entry.status = StoredQueueEntryStatus::Steering;
    let value = ReservedQueueSteer {
        entry: entry.clone(),
    };
    bump(&mut next, context.now);
    accepted(next, value, true)
}

pub fn reserve_pending_steer(
    current: &StoredChatExecutionControlState,
    input: &ObservedQueueEntry,
    context: &TransitionContext<'_>,
) -> ControlTransition<ReservedQueueSteer> {
    if current.pause.is_some() {
        return rejected(current, TransitionRejection::QueuePauseChanged);
    }
    let head = current
        .entries
        .iter()
        .find(|entry| entry.status == StoredQueueEntryStatus::Queued);
    if head.is_none_or(|entry| entry.id != input.entry_id) {
        return rejected(current, TransitionRejection::QueueEntryReorderConflict);
    }
    reserve_queue_steer(current, input, context)
}

pub fn mark_queue_entry_steer(
    current: &StoredChatExecutionControlState,
    input: &ObservedQueueEntry,
    context: &TransitionContext<'_>,
) -> ControlTransition<()> {
    let mut next = clone_stored_chat_execution_control(current);
    let Some(index) = next
        .entries
        .iter()
        .position(|candidate| candidate.id == input.entry_id)
    else {
        return rejected(current, missing_entry_rejection(current, &input.entry_id));
    };
    let entry = &next.entries[index];
    if entry.status != StoredQueueEntryStatus::Queued {
        return rejected(current, in_flight(&input.entry_id));
    }
    if entry.revision != input.expected_revision {
        return rejected(current, revision_rejection(&input.entry_id, entry.revision));
    }
    if next.reorder_revision != input.expected_reorder_revision {
        return rejected(current, TransitionRejection::QueueEntryReorderConflict);
    }
    if entry.kind == QueueEntryKind::Steer {
        return accepted(next, (), false);
    }
    let mut entry = next.entries.remove(index);
    entry.kind = QueueEntryKind::Steer;
    if insert_pending_steer(&mut next.entries, entry) != index {
        next.reorder_revision += 1;
    }
    bump(&mut next, context.now);
    accepted(next, (), true)
}

pub fn release_queue_steer(
    current: &StoredChatExecutionControlState,
    entry_id: &str,
    context: &TransitionContext<'_>,
) -> ControlTransition<()> {
    let mut next = clone_stored_chat_execution_control(current);
    let Some(entry) = next
        .entries
        .iter_mut()
        .find(|candidate| candidate.id == entry_id)
    else {
        return accepted(next, (), false);
    };
    if entry.status != StoredQueueEntryStatus::Steering {
        return rejected(current, in_flight(entry_id));
    }
    entry.status = StoredQueueEntryStatus::Queued;
    bump(&mut next, context.now);
    accepted(next, (), true)
}

pub fn consume_queue_steer(
    current: &StoredChatExecutionControlState,
    entry_id: &str,
    context: &TransitionContext<'_>,
) -> ControlTransition<()> {
    let mut next = clone_stored_chat_execution_control(current);
    let Some(index) = next.entries.iter().position(|entry| entry.id == entry_id) else {
        return accepted(next, (), false);
    };
    if next.entries[index].status != StoredQueueEntryStatus::Steering {
        return rejected(current, in_flight(entry_id));
    }
    let entry = next.entries.remove(index);
    record_dispatch(&mut next, &entry, context.now);
    clear_idle_pause(&mut next);
    bump(&mut next, context.now);
    accepted(next, (), true)
}

pub fn requeue_and_pause(
    current: &StoredChatExecutionControlState,
    input: &RequeueAndPauseInput,
    context: &TransitionContext<'_>,
) -> ControlTransition<()> {
    let mut next = clone_stored_chat_execution_control(current);
    if let Some(entry) = next
        .entries
        .iter_mut()
        .find(|entry| entry.id == input.entry_id)
    {
        entry.status = StoredQueueEntryStatus::Queued;
        entry.revision += 1;
        entry.updated_at = context.now.to_owned();
        next.recently_dispatched
            .retain(|entry| entry.entry_id != input.entry_id);
    }
    next.pause = has_pending_turn_input(&next).then(|| {
        let id = (context.new_id)();
        let entry_id = input.entry_id.clone();
        let paused_at = context.now.to_owned();
        let kind = match input.kind {
            AutomaticQueuePauseKind::QueuedTurnFailed => QueuePauseKind::QueuedTurnFailed {
                entry_id,
                paused_at,
            },
            AutomaticQueuePauseKind::CompletionUncertain => QueuePauseKind::CompletionUncertain {
                entry_id,
                paused_at,
            },
        };
        QueuePause { id, kind }
    });
    bump(&mut next, context.now);
    accepted(next, (), true)
}

pub fn pause_after_failure(
    current: &StoredChatExecutionControlState,
    cause: &FailurePauseCause,
    context: &TransitionContext<'_>,
) -> ControlTransition<()> {
    let mut next = clone_stored_chat_execution_control(current);
    if !has_pending_turn_input(&next) {
        return accepted(next, (), false);
    }
    let id = (context.new_id)();
    let paused_at = context.now.to_owned();
    let kind = match cause {
        FailurePauseCause::QueuedTurnFailed { entry_id } => QueuePauseKind::QueuedTurnFailed {
            entry_id: entry_id.clone(),
            paused_at,
        },
        FailurePauseCause::TurnFailed { turn_id } => QueuePauseKind::TurnFailed {
            turn_id: turn_id.clone(),
            paused_at,
        },
    };
    next.pause = Some(QueuePause { id, kind });
    bump(&mut next, context.now);
    accepted(next, (), true)
}
