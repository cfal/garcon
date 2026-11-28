use std::{
    cell::RefCell,
    rc::{Rc, Weak},
    time::Duration,
};

use indexmap::{IndexMap, IndexSet};
use serde_json::Value;
use tokio::{task::AbortHandle, time::Instant};

use crate::cli_protocol::{ClaudeTurnStartSource, ClaudeTurnTerminalState};

pub const CLAUDE_STEER_WRITE_TIMEOUT: Duration = Duration::from_secs(15);
pub const CLAUDE_STEER_IDLE_FENCE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, PartialEq, Eq)]
pub enum ClaudeSteeringInputObservation {
    Queued {
        uuid: String,
    },
    Started {
        uuid: String,
        source: ClaudeTurnStartSource,
        wait: Duration,
    },
    DuplicateReplay {
        uuid: String,
    },
    Terminal {
        uuid: String,
        phase: ClaudeSteeringTerminalPhase,
        state: ClaudeTurnTerminalState,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum ClaudeSteeringTerminalPhase {
    BeforeStart,
    AfterStart,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InputPhase {
    Submitted,
    Queued,
    Active,
}

struct NativeInput {
    submitted_at: Instant,
    phase: InputPhase,
}

#[derive(Default)]
struct SteeringState {
    reservations: IndexSet<u64>,
    next_reservation: u64,
    inputs: IndexMap<String, NativeInput>,
    idle_deferred: bool,
    idle_timer: Option<AbortHandle>,
    settlement_failure: Option<String>,
}

impl SteeringState {
    fn drop_native_input(&mut self, uuid: &str) {
        self.inputs.shift_remove(uuid);
        if self.inputs.is_empty()
            && let Some(timer) = self.idle_timer.take()
        {
            timer.abort();
        }
    }

    fn clear_deferred_idle(&mut self) {
        self.idle_deferred = false;
        if let Some(timer) = self.idle_timer.take() {
            timer.abort();
        }
    }
}

impl Drop for SteeringState {
    fn drop(&mut self) {
        self.clear_deferred_idle();
    }
}

#[derive(Default)]
pub struct ClaudeTurnSteeringState(Rc<RefCell<SteeringState>>);

pub struct ClaudeSteeringReservation {
    state: Weak<RefCell<SteeringState>>,
    id: u64,
}

impl Drop for ClaudeSteeringReservation {
    fn drop(&mut self) {
        if let Some(state) = self.state.upgrade() {
            state.borrow_mut().reservations.shift_remove(&self.id);
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ClaudeSteeringInterruptReceipt {
    pub cancelled_count: usize,
    pub still_queued_count: usize,
}

impl ClaudeTurnSteeringState {
    pub fn reserve_delivery(&self) -> ClaudeSteeringReservation {
        let mut state = self.0.borrow_mut();
        let id = state.next_reservation;
        state.next_reservation += 1;
        state.reservations.insert(id);
        ClaudeSteeringReservation {
            state: Rc::downgrade(&self.0),
            id,
        }
    }

    pub fn mark_submitted(&self, uuid: String) {
        self.0.borrow_mut().inputs.insert(
            uuid,
            NativeInput {
                submitted_at: Instant::now(),
                phase: InputPhase::Submitted,
            },
        );
    }

    pub fn remove_submitted(&self, uuid: &str) {
        self.0.borrow_mut().drop_native_input(uuid);
    }

    pub fn observe(&self, message: &Value) -> Option<ClaudeSteeringInputObservation> {
        use ClaudeSteeringInputObservation as Observation;
        let replay = message["type"] == "user" && message["isReplay"] == true;
        let uuid = if message["type"] == "command_lifecycle" {
            message["command_uuid"].as_str()
        } else if replay {
            message["uuid"].as_str()
        } else {
            None
        }
        .filter(|uuid| !uuid.is_empty())?;
        let mut state = self.0.borrow_mut();
        let input = state.inputs.get_mut(uuid)?;
        let event = if replay {
            "replay"
        } else {
            message["state"].as_str()?
        };
        match event {
            "queued" if input.phase == InputPhase::Submitted => {
                input.phase = InputPhase::Queued;
                Some(Observation::Queued { uuid: uuid.into() })
            }
            "replay" if !replay => None,
            "started" | "replay" if input.phase != InputPhase::Active => {
                let source = if replay {
                    if input.phase != InputPhase::Queued {
                        state.drop_native_input(uuid);
                        return Some(Observation::DuplicateReplay { uuid: uuid.into() });
                    }
                    ClaudeTurnStartSource::Replay
                } else {
                    ClaudeTurnStartSource::Lifecycle
                };
                input.phase = InputPhase::Active;
                Some(Observation::Started {
                    uuid: uuid.into(),
                    source,
                    wait: input.submitted_at.elapsed(),
                })
            }
            "completed" | "cancelled" | "discarded" => {
                let terminal = match event {
                    "completed" => ClaudeTurnTerminalState::Completed,
                    "cancelled" => ClaudeTurnTerminalState::Cancelled,
                    _ => ClaudeTurnTerminalState::Discarded,
                };
                let phase = if input.phase == InputPhase::Active {
                    ClaudeSteeringTerminalPhase::AfterStart
                } else {
                    ClaudeSteeringTerminalPhase::BeforeStart
                };
                state.drop_native_input(uuid);
                Some(Observation::Terminal {
                    uuid: uuid.into(),
                    phase,
                    state: terminal,
                })
            }
            _ => None,
        }
    }

    pub fn blocks_idle_settlement(&self) -> bool {
        let state = self.0.borrow();
        !state.reservations.is_empty() || !state.inputs.is_empty()
    }

    pub fn has_deferred_idle(&self) -> bool {
        self.0.borrow().idle_deferred
    }

    pub fn submitted_count(&self) -> usize {
        self.0
            .borrow()
            .inputs
            .values()
            .filter(|input| input.phase != InputPhase::Active)
            .count()
    }

    pub fn active_count(&self) -> usize {
        self.0
            .borrow()
            .inputs
            .values()
            .filter(|input| input.phase == InputPhase::Active)
            .count()
    }

    pub fn reservation_count(&self) -> usize {
        self.0.borrow().reservations.len()
    }

    pub fn remember_provider_idle(&self) {
        self.0.borrow_mut().idle_deferred = true;
    }

    pub fn defer_idle(&self, on_timeout: impl FnOnce() + 'static, timeout: Duration) {
        let mut state = self.0.borrow_mut();
        state.idle_deferred = true;
        if state.inputs.is_empty() || state.idle_timer.is_some() {
            return;
        }
        let weak = Rc::downgrade(&self.0);
        let deadline = Instant::now() + timeout;
        state.idle_timer = Some(
            tokio::task::spawn_local(async move {
                tokio::time::sleep_until(deadline).await;
                let Some(state) = weak.upgrade() else {
                    return;
                };
                let should_fire = {
                    let mut state = state.borrow_mut();
                    state.idle_timer = None;
                    state.idle_deferred && !state.inputs.is_empty()
                };
                if should_fire {
                    on_timeout();
                }
            })
            .abort_handle(),
        );
    }

    pub fn clear_deferred_idle(&self) {
        self.0.borrow_mut().clear_deferred_idle();
    }

    pub fn record_protocol_failure(&self, message: String) {
        self.0.borrow_mut().settlement_failure = Some(message);
    }

    pub fn settlement_failure_message(&self) -> Option<String> {
        self.0.borrow().settlement_failure.clone()
    }

    pub fn observe_interrupt_receipt(
        &self,
        cancelled: &[&str],
        still_queued: &[&str],
    ) -> ClaudeSteeringInterruptReceipt {
        let mut state = self.0.borrow_mut();
        let mut receipt = ClaudeSteeringInterruptReceipt::default();
        let mut dropped = Vec::new();
        for uuid in state.inputs.keys() {
            if still_queued.contains(&uuid.as_str()) {
                receipt.still_queued_count += 1;
            } else if cancelled.contains(&uuid.as_str()) {
                dropped.push(uuid.clone());
                receipt.cancelled_count += 1;
            }
        }
        for uuid in dropped {
            state.drop_native_input(&uuid);
        }
        receipt
    }

    pub fn clear(&self) {
        let mut state = self.0.borrow_mut();
        state.clear_deferred_idle();
        state.inputs.clear();
        state.reservations.clear();
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use serde_json::json;
    use tokio::task::LocalSet;

    use super::*;

    fn lifecycle(uuid: &str, state: &str) -> Value {
        json!({"type":"command_lifecycle", "command_uuid": uuid, "state": state})
    }

    #[test]
    fn distinguishes_queued_replay_from_duplicate_replay_and_tracks_terminal_phase() {
        let state = ClaudeTurnSteeringState::default();
        state.mark_submitted("a".into());
        let replay = json!({"type":"user", "isReplay":true, "uuid":"a"});
        assert_eq!(
            state.observe(&replay),
            Some(ClaudeSteeringInputObservation::DuplicateReplay { uuid: "a".into() })
        );
        assert!(!state.blocks_idle_settlement());

        state.mark_submitted("a".into());
        assert_eq!(
            state.observe(&lifecycle("a", "queued")),
            Some(ClaudeSteeringInputObservation::Queued { uuid: "a".into() })
        );
        assert!(matches!(
            state.observe(&replay),
            Some(ClaudeSteeringInputObservation::Started {
                source: ClaudeTurnStartSource::Replay,
                ..
            })
        ));
        assert_eq!(state.submitted_count(), 0);
        assert_eq!(state.active_count(), 1);
        assert!(state.observe(&lifecycle("a", "started")).is_none());
        assert_eq!(
            state.observe(&lifecycle("a", "completed")),
            Some(ClaudeSteeringInputObservation::Terminal {
                uuid: "a".into(),
                phase: ClaudeSteeringTerminalPhase::AfterStart,
                state: ClaudeTurnTerminalState::Completed,
            })
        );
        state.mark_submitted("a".into());
        assert_eq!(
            state.observe(&lifecycle("a", "discarded")),
            Some(ClaudeSteeringInputObservation::Terminal {
                uuid: "a".into(),
                phase: ClaudeSteeringTerminalPhase::BeforeStart,
                state: ClaudeTurnTerminalState::Discarded,
            })
        );
        assert!(!state.blocks_idle_settlement());
    }

    #[tokio::test(start_paused = true)]
    async fn idle_timeout_is_owned_by_native_inputs_not_reservations() {
        LocalSet::new()
            .run_until(async {
                let state = ClaudeTurnSteeringState::default();
                let count = Rc::new(Cell::new(0));
                let arm = || {
                    let count = count.clone();
                    state.defer_idle(
                        move || count.set(count.get() + 1),
                        CLAUDE_STEER_IDLE_FENCE_TIMEOUT,
                    );
                };
                let stale = state.reserve_delivery();
                arm();
                tokio::time::advance(CLAUDE_STEER_IDLE_FENCE_TIMEOUT).await;
                assert_eq!(count.get(), 0);
                assert!(state.has_deferred_idle());
                assert!(state.blocks_idle_settlement());

                state.mark_submitted("a".into());
                arm();
                assert_eq!(
                    state
                        .observe_interrupt_receipt(&["a"], &["a"])
                        .still_queued_count,
                    1
                );
                assert_eq!(
                    state.observe_interrupt_receipt(&["a"], &[]).cancelled_count,
                    1
                );
                tokio::time::advance(CLAUDE_STEER_IDLE_FENCE_TIMEOUT).await;
                assert_eq!(count.get(), 0);

                state.clear();
                let current = state.reserve_delivery();
                drop(stale);
                assert_eq!(state.reservation_count(), 1);
                drop(current);
                state.mark_submitted("b".into());
                let (fired, settled) = tokio::sync::oneshot::channel();
                state.defer_idle(
                    move || {
                        fired.send(()).unwrap();
                    },
                    CLAUDE_STEER_IDLE_FENCE_TIMEOUT,
                );
                arm();
                tokio::time::advance(CLAUDE_STEER_IDLE_FENCE_TIMEOUT).await;
                settled.await.unwrap();
                assert_eq!(count.get(), 0);
            })
            .await;
    }
}
