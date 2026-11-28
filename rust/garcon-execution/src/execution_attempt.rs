//! Ports the identity and lifecycle gates of a single queue-managed turn.

use std::cell::{Cell, RefCell};

use tokio::sync::watch;

use crate::turn_identity::{TurnIdentity, matches_turn_identity};

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Cannot replace the identity of a launched turn")]
pub struct ReservedTurnAlreadyLaunched;

#[derive(Debug)]
pub struct QueueExecutionAttempt {
    pub entry_id: Option<String>,
    turn: RefCell<TurnIdentity>,
    launched: Cell<bool>,
    settled: watch::Sender<bool>,
    terminal_committed: Cell<bool>,
}

impl QueueExecutionAttempt {
    pub fn new(turn: TurnIdentity, entry_id: Option<String>) -> Self {
        Self {
            entry_id,
            turn: RefCell::new(turn),
            launched: Cell::new(false),
            settled: watch::Sender::new(false),
            terminal_committed: Cell::new(false),
        }
    }

    pub fn is_settled(&self) -> bool {
        *self.settled.borrow()
    }
    pub fn has_terminal_commit(&self) -> bool {
        self.terminal_committed.get()
    }
    pub fn mark_terminal_committed(&self) {
        self.terminal_committed.set(true);
    }

    pub fn identity(&self) -> TurnIdentity {
        self.turn.borrow().clone()
    }

    pub fn matches(&self, turn: Option<&TurnIdentity>) -> bool {
        matches_turn_identity(Some(&self.turn.borrow()), turn)
    }

    pub async fn wait_until_settled(&self) {
        // INFALLIBLE: self holds the sender for the duration of the wait.
        self.settled
            .subscribe()
            .wait_for(|settled| *settled)
            .await
            .expect("attempt owns its sender");
    }

    pub fn replace_reserved_turn(
        &self,
        turn: TurnIdentity,
    ) -> Result<(), ReservedTurnAlreadyLaunched> {
        if self.launched.get() || self.is_settled() {
            return Err(ReservedTurnAlreadyLaunched);
        }
        self.turn.replace(turn);
        Ok(())
    }

    pub fn mark_launching(&self) {
        if !self.is_settled() {
            self.launched.set(true);
        }
    }

    pub fn mark_settled(&self) {
        self.settled.send_if_modified(|settled| {
            if *settled {
                false
            } else {
                *settled = true;
                true
            }
        });
    }
}
