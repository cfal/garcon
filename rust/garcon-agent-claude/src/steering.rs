use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    time::Duration,
};

use garcon_agents_common::execution::runtime_events::{RuntimeSteerRequest, RuntimeSteerTarget};
use garcon_interface::{
    host::AgentLogger,
    resources::ExecutorResult,
    services::{AgentSteerFailureOutcome, AgentSteerRejectionReason, AgentSteerResult},
};
use garcon_js::json::Opaque;
use indexmap::{IndexMap, IndexSet};
use serde_json::{Value, json};
use tokio::{task::AbortHandle, time::Instant};

use crate::{
    active_turn::ClaudeActiveTurn,
    cli_process_transport::ClaudeWriteLineOptions,
    cli_protocol::{ClaudeTurnStartSource, ClaudeTurnTerminalState},
    runtime_state::{ClaudeRunningSession, ClaudeSessionProcess},
    user_input::{
        ClaudeUserInputFrameOptions, ClaudeUserInputPriority, build_claude_steering_user_content,
        build_claude_user_input_frame,
    },
};

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

type SessionLookup = dyn Fn(&str) -> Option<Rc<ClaudeRunningSession>>;
type FlushDeferredIdle = dyn Fn(&Rc<ClaudeRunningSession>, &Rc<ClaudeActiveTurn>);

pub struct ClaudeSteeringControllerOptions {
    pub session: Rc<SessionLookup>,
    pub is_shutting_down: Rc<dyn Fn() -> bool>,
    pub logger: Rc<dyn AgentLogger>,
    pub write_timeout: Duration,
    pub flush_deferred_idle: Rc<FlushDeferredIdle>,
}

pub struct ClaudeSteeringController {
    options: ClaudeSteeringControllerOptions,
    identity: Rc<()>,
}

struct CapturedTarget {
    session: Rc<ClaudeRunningSession>,
    active_turn: Rc<ClaudeActiveTurn>,
    process: ClaudeSessionProcess,
}

struct SteeringTarget {
    owner: Weak<()>,
    captured: RefCell<Option<CapturedTarget>>,
}

struct SteeringDelivery<'a> {
    reservation: Option<ClaudeSteeringReservation>,
    target: &'a CapturedTarget,
    flush: &'a FlushDeferredIdle,
}

impl Drop for SteeringDelivery<'_> {
    fn drop(&mut self) {
        drop(self.reservation.take());
        (self.flush)(&self.target.session, &self.target.active_turn);
    }
}

impl ClaudeSteeringController {
    pub fn new(options: ClaudeSteeringControllerOptions) -> Self {
        Self {
            options,
            identity: Rc::new(()),
        }
    }

    pub fn capture_target(&self, agent_session_id: &str) -> Option<RuntimeSteerTarget> {
        if (self.options.is_shutting_down)() {
            return None;
        }
        let session = (self.options.session)(agent_session_id)?;
        let turn = session.active_turn.borrow().clone()?;
        if !can_steer(&turn) {
            return None;
        }
        let process = session.process.borrow().clone()?;
        Some(Rc::new(SteeringTarget {
            owner: Rc::downgrade(&self.identity),
            captured: RefCell::new(Some(CapturedTarget {
                session,
                active_turn: turn,
                process,
            })),
        }))
    }

    pub async fn steer(&self, request: RuntimeSteerRequest) -> ExecutorResult<AgentSteerResult> {
        let target = request
            .target
            .as_deref()
            .and_then(|target| target.downcast_ref::<SteeringTarget>())
            .filter(|target| target.owner.ptr_eq(&Rc::downgrade(&self.identity)))
            .and_then(|target| target.captured.take());
        let Some(target) = target else {
            return Ok(no_active_turn());
        };
        if let Some(rejection) = self.validate_target(&request, &target) {
            return Ok(rejection);
        }
        let _delivery = SteeringDelivery {
            reservation: Some(target.active_turn.steering.reserve_delivery()),
            target: &target,
            flush: self.options.flush_deferred_idle.as_ref(),
        };
        let native_input_id = uuid::Uuid::new_v4().to_string();
        let frame = build_claude_user_input_frame(ClaudeUserInputFrameOptions {
            content: &build_claude_steering_user_content(&request.input),
            session_id: &target.session.id,
            uuid: &native_input_id,
            priority: Some(ClaudeUserInputPriority::Next),
        })?;
        (request.prepare_delivery)().await?;
        if let Some(rejection) = self.validate_target(&request, &target) {
            return Ok(rejection);
        }

        let attempted = Rc::new(Cell::new(false));
        let write_started_at = Instant::now();
        let options = ClaudeWriteLineOptions {
            before_write: Some(Box::new({
                let attempted = attempted.clone();
                let turn = target.active_turn.clone();
                let input_id = native_input_id.clone();
                move || {
                    attempted.set(true);
                    turn.steering.mark_submitted(input_id);
                    Ok(())
                }
            })),
            attempt_timeout: Some(self.options.write_timeout),
            kill_process_after_attempt_failure: true,
        };
        if target
            .process
            .transport
            .write_line(frame, options)
            .await
            .is_err()
        {
            target
                .active_turn
                .steering
                .remove_submitted(&native_input_id);
            return Ok(if attempted.get() {
                AgentSteerResult::Failed {
                    outcome: AgentSteerFailureOutcome::Unknown,
                    message: "Claude steering delivery could not be confirmed".into(),
                }
            } else {
                AgentSteerResult::Failed {
                    outcome: AgentSteerFailureOutcome::NotSent,
                    message: "Claude steering input was not sent".into(),
                }
            });
        }
        self.options.logger.debug(
            "Claude steering input accepted for native delivery",
            Some(&steering_fields(
                &target.session,
                &target.active_turn,
                &native_input_id,
                [
                    ("writeMs", json!(write_started_at.elapsed().as_millis())),
                    (
                        "submittedSteers",
                        json!(target.active_turn.steering.submitted_count()),
                    ),
                ],
            )),
        );
        Ok(AgentSteerResult::Accepted)
    }

    fn validate_target(
        &self,
        request: &RuntimeSteerRequest,
        captured: &CapturedTarget,
    ) -> Option<AgentSteerResult> {
        let Some(current) = (self.options.session)(&request.agent_session_id) else {
            return Some(no_active_turn());
        };
        if current.active_turn.borrow().is_none() || (self.options.is_shutting_down)() {
            return Some(no_active_turn());
        }
        if !Rc::ptr_eq(&current, &captured.session)
            || current.chat_id != request.chat_id
            || !current.is_current_turn(&captured.active_turn)
            || !current.is_current_process(&captured.process.identity)
            || !can_steer(&captured.active_turn)
        {
            return Some(AgentSteerResult::Rejected {
                reason: AgentSteerRejectionReason::TurnChanged,
                message: "The active Claude turn changed".into(),
            });
        }
        None
    }

    pub fn handle_observation(
        &self,
        session: &Rc<ClaudeRunningSession>,
        turn: &Rc<ClaudeActiveTurn>,
        observation: ClaudeSteeringInputObservation,
    ) {
        if !session.is_current_turn(turn) {
            return;
        }
        match observation {
            ClaudeSteeringInputObservation::Queued { .. } => return,
            ClaudeSteeringInputObservation::Started { uuid, source, wait } => {
                self.options.logger.debug(
                    "Claude steering input started",
                    Some(&steering_fields(
                        session,
                        turn,
                        &uuid,
                        [
                            ("source", json!(source)),
                            ("submitToStartMs", json!(wait.as_millis())),
                            ("remainingSubmitted", json!(turn.steering.submitted_count())),
                        ],
                    )),
                );
                return;
            }
            ClaudeSteeringInputObservation::DuplicateReplay { .. } => {
                turn.steering.record_protocol_failure(
                    "Claude CLI replayed steering input without accepting it into the command queue.".into(),
                );
            }
            ClaudeSteeringInputObservation::Terminal { uuid, phase, state } => {
                if !(phase == ClaudeSteeringTerminalPhase::AfterStart
                    && state == ClaudeTurnTerminalState::Completed)
                {
                    let abort_requested = turn.protocol.borrow().abort_requested();
                    let state = match state {
                        ClaudeTurnTerminalState::Completed => "completed",
                        ClaudeTurnTerminalState::Cancelled => "cancelled",
                        ClaudeTurnTerminalState::Discarded => "discarded",
                    };
                    if !abort_requested {
                        let message = match phase {
                            ClaudeSteeringTerminalPhase::BeforeStart => format!(
                                "Claude CLI {state} accepted steering input before it started."
                            ),
                            ClaudeSteeringTerminalPhase::AfterStart => {
                                format!("Claude CLI {state} steering input before it completed.")
                            }
                        };
                        turn.steering.record_protocol_failure(message);
                    }
                    let phase = match phase {
                        ClaudeSteeringTerminalPhase::BeforeStart => "before-start",
                        ClaudeSteeringTerminalPhase::AfterStart => "after-start",
                    };
                    self.options.logger.warn(
                        "Claude steering input ended without normal completion",
                        Some(&steering_fields(
                            session,
                            turn,
                            &uuid,
                            [
                                ("phase", json!(phase)),
                                ("state", json!(state)),
                                ("abortRequested", json!(abort_requested)),
                            ],
                        )),
                    );
                }
            }
        }
        (self.options.flush_deferred_idle)(session, turn);
    }
}

fn can_steer(turn: &ClaudeActiveTurn) -> bool {
    let protocol = turn.protocol.borrow();
    protocol.input_started() && !protocol.abort_requested()
}

fn no_active_turn() -> AgentSteerResult {
    AgentSteerResult::Rejected {
        reason: AgentSteerRejectionReason::NoActiveTurn,
        message: "No active Claude turn".into(),
    }
}

fn steering_fields<const N: usize>(
    session: &ClaudeRunningSession,
    turn: &ClaudeActiveTurn,
    uuid: &str,
    fields: [(&str, Value); N],
) -> IndexMap<String, Opaque> {
    let prefix =
        |value: &str| String::from_utf16_lossy(&value.encode_utf16().take(8).collect::<Vec<_>>());
    [
        ("chatId", json!(session.chat_id)),
        ("runId", json!(turn.operation.run_id)),
        ("sessionId", json!(prefix(&session.id))),
        ("inputId", json!(prefix(uuid))),
    ]
    .into_iter()
    .chain(fields)
    .map(|(key, value)| (key.to_owned(), value.into()))
    .collect()
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
