//! Tracks exclusive execution ownership, not the user-visible processing projection.
//! Only the coordinator may combine this owner state with the provider's running state.

use std::{cell::RefCell, collections::HashSet, error::Error, rc::Rc};

use async_trait::async_trait;
use garcon_interface::{execution::AgentExecutionAdmission, resources::ExecutorResult};
use indexmap::IndexMap;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::execution_attempt::QueueExecutionAttempt;
use crate::turn_finalization_tracker::{
    FinalizationAlreadyExists, QueuedTurnFinalization, QueuedTurnFinalizationHandle,
    QueuedTurnFinalizationTracker,
};
use crate::turn_identity::TurnIdentity;
use crate::types::{
    DirectTurnReservation, DrainSuppressionReason, TranscriptSnapshotReservation,
    execution_turn_identity,
};

#[derive(Default)]
enum ChatOwner {
    #[default]
    Idle,
    Direct {
        reservation_id: String,
    },
    Draining {
        active_entry_id: Option<String>,
    },
    Snapshot {
        reservation_id: String,
    },
}

struct OwnedTurn {
    attempt: Rc<QueueExecutionAttempt>,
    admission: Rc<ExecutionAdmission>,
}

#[derive(Default)]
struct ChatExecutionState {
    owner: ChatOwner,
    turn: Option<OwnedTurn>,
    drain_requested: bool,
    suppressions: HashSet<DrainSuppressionReason>,
    repair_snapshot: Option<TranscriptSnapshotReservation>,
}

impl ChatExecutionState {
    fn owns_execution(&self) -> bool {
        !matches!(self.owner, ChatOwner::Idle)
            || self.turn.is_some()
            || self.repair_snapshot.is_some()
    }

    fn is_turn_reserved(&self) -> bool {
        matches!(
            self.owner,
            ChatOwner::Direct { .. }
                | ChatOwner::Draining {
                    active_entry_id: Some(_)
                }
        )
    }

    fn is_idle(&self) -> bool {
        !self.owns_execution() && !self.drain_requested && self.suppressions.is_empty()
    }

    fn abort_admission(&self, reason: &AdmissionAbortReason) {
        if let Some(turn) = &self.turn {
            turn.admission.abort(reason);
        }
    }

    fn owner_after_reservation(&self) -> ChatOwner {
        self.repair_snapshot
            .as_ref()
            .map_or(ChatOwner::Idle, |repair| ChatOwner::Snapshot {
                reservation_id: repair.reservation_id.clone(),
            })
    }
}

pub type AdmissionAbortReason = Rc<Box<dyn Error>>;

#[derive(Debug, Default)]
pub struct ExecutionAdmission {
    signal: CancellationToken,
    abort_reason: RefCell<Option<AdmissionAbortReason>>,
}

impl ExecutionAdmission {
    fn abort(&self, reason: &AdmissionAbortReason) {
        let mut current = self.abort_reason.borrow_mut();
        if current.is_none() {
            *current = Some(Rc::clone(reason));
            self.signal.cancel();
        }
    }

    pub fn abort_reason(&self) -> Option<AdmissionAbortReason> {
        self.abort_reason.borrow().clone()
    }
}

#[async_trait(?Send)]
impl AgentExecutionAdmission for ExecutionAdmission {
    fn signal(&self) -> &CancellationToken {
        &self.signal
    }
    async fn mark_started(&self) -> ExecutorResult<()> {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ExecutionOwnershipError {
    #[error("Another chat operation already owns execution")]
    TranscriptSnapshotAlreadyOwned,
    #[error("Transcript snapshot reservation is no longer active")]
    StaleTranscriptSnapshot,
    #[error("Cannot reserve a direct turn while another operation owns execution")]
    DirectAlreadyOwned,
    #[error("Cannot drain a chat holding an execution reservation")]
    DrainWhileReserved,
    #[error("Cannot set the active drain entry for a chat that is not draining")]
    NotDraining,
    #[error("Another chat turn already owns execution")]
    AttemptAlreadyOwned,
}

pub struct ExecutionOwnership {
    chats: RefCell<IndexMap<String, ChatExecutionState>>,
    owners_changed: watch::Sender<u64>,
    turn_finalizations: QueuedTurnFinalizationTracker,
    new_id: Box<dyn Fn() -> String>,
}

impl ExecutionOwnership {
    pub fn new(new_id: impl Fn() -> String + 'static) -> Self {
        Self {
            chats: RefCell::new(IndexMap::new()),
            owners_changed: watch::Sender::new(0),
            turn_finalizations: QueuedTurnFinalizationTracker::new(),
            new_id: Box::new(new_id),
        }
    }

    fn gc(&self, chat_id: &str) {
        let mut chats = self.chats.borrow_mut();
        if chats.get(chat_id).is_some_and(ChatExecutionState::is_idle) {
            chats.shift_remove(chat_id);
        }
    }

    pub fn begin_shutdown(&self, reason: &AdmissionAbortReason) -> Vec<String> {
        let mut owners = Vec::new();
        for (chat_id, state) in self.chats.borrow().iter() {
            state.abort_admission(reason);
            if state.owns_execution() {
                owners.push(chat_id.clone());
            }
        }
        owners
    }

    pub fn abort_admission(&self, chat_id: &str, reason: &AdmissionAbortReason) {
        if let Some(state) = self.chats.borrow().get(chat_id) {
            state.abort_admission(reason);
        }
    }

    pub fn has_any_owner(&self) -> bool {
        self.chats
            .borrow()
            .values()
            .any(ChatExecutionState::owns_execution)
    }

    pub async fn wait_for_owners(&self) {
        let mut changes = self.owners_changed.subscribe();
        while self.has_any_owner() {
            // INFALLIBLE: self owns the sender for the duration of the wait.
            changes
                .changed()
                .await
                .expect("ownership holds its change sender");
        }
    }

    pub fn notify_owners_changed(&self) {
        self.owners_changed
            .send_modify(|generation| *generation = generation.wrapping_add(1));
    }

    pub fn has_owner(&self, chat_id: &str) -> bool {
        self.chats
            .borrow()
            .get(chat_id)
            .is_some_and(ChatExecutionState::owns_execution)
    }

    pub fn is_turn_reserved(&self, chat_id: &str) -> bool {
        self.chats
            .borrow()
            .get(chat_id)
            .is_some_and(ChatExecutionState::is_turn_reserved)
    }

    pub fn turn_reserved_chat_ids(&self) -> Vec<String> {
        self.chats
            .borrow()
            .iter()
            .filter(|(_, state)| state.is_turn_reserved())
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn reserve_transcript_snapshot(
        &self,
        chat_id: &str,
    ) -> Result<TranscriptSnapshotReservation, ExecutionOwnershipError> {
        if self.has_owner(chat_id) {
            return Err(ExecutionOwnershipError::TranscriptSnapshotAlreadyOwned);
        }
        let reservation = TranscriptSnapshotReservation {
            chat_id: chat_id.to_owned(),
            reservation_id: (self.new_id)(),
        };
        self.chats
            .borrow_mut()
            .entry(chat_id.to_owned())
            .or_default()
            .owner = ChatOwner::Snapshot {
            reservation_id: reservation.reservation_id.clone(),
        };
        Ok(reservation)
    }

    pub fn has_transcript_snapshot(&self, chat_id: &str) -> bool {
        self.chats.borrow().get(chat_id).is_some_and(|state| {
            matches!(state.owner, ChatOwner::Snapshot { .. }) || state.repair_snapshot.is_some()
        })
    }

    pub fn release_transcript_snapshot(
        &self,
        reservation: &TranscriptSnapshotReservation,
    ) -> Result<(), ExecutionOwnershipError> {
        {
            let mut chats = self.chats.borrow_mut();
            let Some(state) = chats.get_mut(&reservation.chat_id) else {
                return Ok(());
            };
            if state
                .repair_snapshot
                .as_ref()
                .is_some_and(|repair| repair.reservation_id == reservation.reservation_id)
            {
                state.repair_snapshot = None;
                if matches!(&state.owner, ChatOwner::Snapshot { reservation_id } if reservation_id == &reservation.reservation_id)
                {
                    state.owner = ChatOwner::Idle;
                }
            } else {
                let ChatOwner::Snapshot { reservation_id } = &state.owner else {
                    return Ok(());
                };
                if reservation_id != &reservation.reservation_id {
                    return Err(ExecutionOwnershipError::StaleTranscriptSnapshot);
                }
                state.owner = ChatOwner::Idle;
            }
        }
        self.gc(&reservation.chat_id);
        Ok(())
    }

    pub fn replace_turn_with_transcript_snapshot(
        &self,
        chat_id: &str,
        turn: &TurnIdentity,
    ) -> Option<TranscriptSnapshotReservation> {
        let mut chats = self.chats.borrow_mut();
        let state = chats.get_mut(chat_id)?;
        if !state.turn.as_ref()?.attempt.matches(Some(turn)) {
            return None;
        }
        if let Some(repair) = &state.repair_snapshot {
            return Some(repair.clone());
        }
        let reservation = TranscriptSnapshotReservation {
            chat_id: chat_id.to_owned(),
            reservation_id: (self.new_id)(),
        };
        state.repair_snapshot = Some(reservation.clone());
        Some(reservation)
    }

    pub fn reserve_direct(
        &self,
        chat_id: &str,
        turn: &TurnIdentity,
    ) -> Result<DirectTurnReservation, ExecutionOwnershipError> {
        let mut chats = self.chats.borrow_mut();
        let state = chats.entry(chat_id.to_owned()).or_default();
        if state.owns_execution() {
            return Err(ExecutionOwnershipError::DirectAlreadyOwned);
        }
        let admission = Rc::new(ExecutionAdmission::default());
        let reservation = DirectTurnReservation {
            chat_id: chat_id.to_owned(),
            reservation_id: (self.new_id)(),
            execution_admission: Rc::clone(&admission),
        };
        let identity = execution_turn_identity(turn).unwrap_or_else(|| TurnIdentity {
            turn_id: Some((self.new_id)()),
            client_request_id: None,
        });
        state.owner = ChatOwner::Direct {
            reservation_id: reservation.reservation_id.clone(),
        };
        state.turn = Some(OwnedTurn {
            attempt: Rc::new(QueueExecutionAttempt::new(identity, None)),
            admission,
        });
        Ok(reservation)
    }

    pub fn has_direct(&self, chat_id: &str) -> bool {
        self.chats
            .borrow()
            .get(chat_id)
            .is_some_and(|state| matches!(state.owner, ChatOwner::Direct { .. }))
    }

    pub fn is_direct_current(&self, reservation: &DirectTurnReservation) -> bool {
        self.chats.borrow().get(&reservation.chat_id).is_some_and(|state| {
            matches!(&state.owner, ChatOwner::Direct { reservation_id } if reservation_id == &reservation.reservation_id)
        })
    }

    pub fn release_direct(&self, reservation: &DirectTurnReservation) {
        if let Some(state) = self.chats.borrow_mut().get_mut(&reservation.chat_id)
            && matches!(state.owner, ChatOwner::Direct { .. })
        {
            state.owner = state.owner_after_reservation();
        }
        self.gc(&reservation.chat_id);
    }

    pub fn is_draining(&self, chat_id: &str) -> bool {
        self.chats
            .borrow()
            .get(chat_id)
            .is_some_and(|state| matches!(state.owner, ChatOwner::Draining { .. }))
    }

    pub fn begin_drain(&self, chat_id: &str) -> Result<(), ExecutionOwnershipError> {
        let mut chats = self.chats.borrow_mut();
        let state = chats.entry(chat_id.to_owned()).or_default();
        match state.owner {
            ChatOwner::Direct { .. } | ChatOwner::Snapshot { .. } => {
                Err(ExecutionOwnershipError::DrainWhileReserved)
            }
            ChatOwner::Draining { .. } => Ok(()),
            ChatOwner::Idle => {
                state.owner = ChatOwner::Draining {
                    active_entry_id: None,
                };
                Ok(())
            }
        }
    }

    pub fn end_drain(&self, chat_id: &str) {
        if let Some(state) = self.chats.borrow_mut().get_mut(chat_id)
            && matches!(state.owner, ChatOwner::Draining { .. })
        {
            state.owner = state.owner_after_reservation();
        }
        self.gc(chat_id);
    }

    pub fn set_active_drain_entry(
        &self,
        chat_id: &str,
        entry_id: &str,
    ) -> Result<(), ExecutionOwnershipError> {
        let mut chats = self.chats.borrow_mut();
        match chats.get_mut(chat_id).map(|state| &mut state.owner) {
            Some(ChatOwner::Draining { active_entry_id }) => {
                *active_entry_id = Some(entry_id.to_owned());
                Ok(())
            }
            _ => Err(ExecutionOwnershipError::NotDraining),
        }
    }

    pub fn attempt(&self, chat_id: &str) -> Option<Rc<QueueExecutionAttempt>> {
        self.chats
            .borrow()
            .get(chat_id)?
            .turn
            .as_ref()
            .map(|turn| Rc::clone(&turn.attempt))
    }

    pub fn mark_run_terminal_committed(&self, chat_id: &str, run_id: &str) {
        if let Some(attempt) = self.attempt(chat_id)
            && attempt.identity().turn_id.as_deref() == Some(run_id)
        {
            attempt.mark_terminal_committed();
        }
    }

    pub fn has_attempt(&self, chat_id: &str) -> bool {
        self.chats
            .borrow()
            .get(chat_id)
            .is_some_and(|state| state.turn.is_some())
    }

    pub fn install_attempt(
        &self,
        chat_id: &str,
        attempt: Rc<QueueExecutionAttempt>,
    ) -> Result<Rc<ExecutionAdmission>, ExecutionOwnershipError> {
        let mut chats = self.chats.borrow_mut();
        let state = chats.entry(chat_id.to_owned()).or_default();
        if state.turn.is_some() {
            return Err(ExecutionOwnershipError::AttemptAlreadyOwned);
        }
        let admission = Rc::new(ExecutionAdmission::default());
        state.turn = Some(OwnedTurn {
            attempt,
            admission: Rc::clone(&admission),
        });
        Ok(admission)
    }

    pub fn is_current_attempt(&self, chat_id: &str, attempt: &Rc<QueueExecutionAttempt>) -> bool {
        self.attempt(chat_id)
            .is_some_and(|current| Rc::ptr_eq(&current, attempt))
    }

    pub fn remove_attempt(&self, chat_id: &str, attempt: &Rc<QueueExecutionAttempt>) -> bool {
        {
            let mut chats = self.chats.borrow_mut();
            let Some(state) = chats.get_mut(chat_id) else {
                return false;
            };
            if state
                .turn
                .as_ref()
                .is_none_or(|turn| !Rc::ptr_eq(&turn.attempt, attempt))
            {
                return false;
            }
            state.turn = None;
            if matches!(state.owner, ChatOwner::Idle) && state.repair_snapshot.is_some() {
                state.owner = state.owner_after_reservation();
            }
        }
        self.gc(chat_id);
        true
    }

    pub fn retire_attempt(
        &self,
        chat_id: &str,
        attempt: &Rc<QueueExecutionAttempt>,
        reason: Option<&AdmissionAbortReason>,
    ) -> bool {
        {
            let mut chats = self.chats.borrow_mut();
            let Some(state) = chats.get_mut(chat_id) else {
                return false;
            };
            let Some(turn) = &state.turn else {
                return false;
            };
            if !Rc::ptr_eq(&turn.attempt, attempt) {
                return false;
            }
            if let Some(reason) = reason {
                turn.admission.abort(reason);
            }
            attempt.mark_settled();
            state.turn = None;
            match &mut state.owner {
                ChatOwner::Direct { .. } => state.owner = state.owner_after_reservation(),
                ChatOwner::Draining { active_entry_id } => *active_entry_id = None,
                _ => {}
            }
        }
        self.gc(chat_id);
        true
    }

    pub fn request_drain(&self, chat_id: &str) {
        self.chats
            .borrow_mut()
            .entry(chat_id.to_owned())
            .or_default()
            .drain_requested = true;
    }

    pub fn consume_drain_request(&self, chat_id: &str) {
        if let Some(state) = self.chats.borrow_mut().get_mut(chat_id) {
            state.drain_requested = false;
        }
        self.gc(chat_id);
    }

    pub fn has_drain_request(&self, chat_id: &str) -> bool {
        self.chats
            .borrow()
            .get(chat_id)
            .is_some_and(|state| state.drain_requested)
    }

    pub fn has_suppression(&self, chat_id: &str, reason: DrainSuppressionReason) -> bool {
        self.chats
            .borrow()
            .get(chat_id)
            .is_some_and(|state| state.suppressions.contains(&reason))
    }

    pub fn enter_abort_suppression(&self, chat_id: &str) {
        self.add_suppression(chat_id, DrainSuppressionReason::Abort);
    }

    pub fn clear_abort_suppression(&self, chat_id: &str) {
        self.remove_suppression(chat_id, DrainSuppressionReason::Abort);
    }

    pub fn enter_manual_stop(&self, chat_id: &str) {
        self.add_suppression(chat_id, DrainSuppressionReason::ManualStop);
    }

    pub fn exit_manual_stop(&self, chat_id: &str, drain_still_active: bool) {
        if !drain_still_active {
            self.remove_suppression(chat_id, DrainSuppressionReason::ManualStop);
        }
    }

    pub fn enter_deletion_suppression(&self, chat_id: &str) {
        self.add_suppression(chat_id, DrainSuppressionReason::Deletion);
    }

    pub fn clear_deletion_suppression(&self, chat_id: &str) {
        self.remove_suppression(chat_id, DrainSuppressionReason::Deletion);
    }

    fn add_suppression(&self, chat_id: &str, reason: DrainSuppressionReason) {
        self.chats
            .borrow_mut()
            .entry(chat_id.to_owned())
            .or_default()
            .suppressions
            .insert(reason);
    }

    fn remove_suppression(&self, chat_id: &str, reason: DrainSuppressionReason) {
        if let Some(state) = self.chats.borrow_mut().get_mut(chat_id) {
            state.suppressions.remove(&reason);
        }
        self.gc(chat_id);
    }

    pub fn clear_chat(&self, chat_id: &str, reason: &AdmissionAbortReason) {
        if let Some(state) = self.chats.borrow_mut().get_mut(chat_id) {
            state.suppressions.clear();
            state.drain_requested = false;
            state.abort_admission(reason);
            if let Some(turn) = state.turn.take() {
                turn.attempt.mark_settled();
            }
            state.repair_snapshot = None;
            state.owner = if matches!(state.owner, ChatOwner::Draining { .. }) {
                ChatOwner::Draining {
                    active_entry_id: None,
                }
            } else {
                ChatOwner::Idle
            };
        }
        self.turn_finalizations.clear_chat(chat_id);
        self.gc(chat_id);
        self.notify_owners_changed();
    }

    pub fn begin_finalization(
        &self,
        chat_id: &str,
        turn_id: &str,
    ) -> Result<QueuedTurnFinalizationHandle, FinalizationAlreadyExists> {
        self.turn_finalizations.begin(chat_id, turn_id)
    }

    pub fn finalization(
        &self,
        chat_id: &str,
        turn_id: Option<&str>,
    ) -> Option<QueuedTurnFinalization> {
        self.turn_finalizations.get(chat_id, turn_id)
    }
}
