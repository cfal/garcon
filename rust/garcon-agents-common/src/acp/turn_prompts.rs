//! Ports `server-agents/common/src/acp/turn-prompts.ts`.

use std::cell::{Cell, RefCell};
use std::error::Error;
use std::future::Future;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use garcon_interface::resources::ExecutorResult;
use garcon_interface::services::{
    AgentSteerFailureOutcome, AgentSteerRejectionReason, AgentSteerResult,
};
use indexmap::IndexSet;
use tokio::sync::oneshot;
use tokio::task::{JoinHandle, spawn_local};

use super::errors::{as_rpc_error, boxed, plain_error, shared_error};
use super::json_values::is_truthy;
use super::policy::AcpSteeringProtocol;
use super::protocol::AcpSessionPromptResult;
use super::runtime_helpers::humanize_error;
use super::timers::delay;
use super::transport::{AcpReply, ReplyCallback, SentCallback};

const UNCONFIRMED: &str = "The prompt ended without confirming the steering input";

type DrainResult = Result<(), Rc<dyn Error>>;
type Drained = Shared<LocalBoxFuture<'static, DrainResult>>;
type SteerSlot = Shared<LocalBoxFuture<'static, ()>>;
type BoundaryCallback = Rc<dyn Fn(Option<&str>) -> ExecutorResult<()>>;

pub struct AcpTurnPromptEvents {
    pub steering: Option<Rc<dyn AcpSteeringProtocol>>,
    pub take_failure: Rc<dyn Fn() -> ExecutorResult<Option<String>>>,
    pub on_boundary: BoundaryCallback,
    pub on_steerable: Rc<dyn Fn()>,
}

struct Decision {
    settle: RefCell<Option<oneshot::Sender<AgentSteerResult>>>,
    timer: Cell<Option<JoinHandle<()>>>,
}

impl Decision {
    fn resolve(&self, result: AgentSteerResult) {
        if let Some(settle) = self.settle.borrow_mut().take() {
            let _ = settle.send(result);
        }
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }

    fn resolved(&self) -> bool {
        self.settle.borrow().is_none()
    }
}

struct Overlap {
    predecessor: u64,
    written: Rc<Cell<bool>>,
    decision: Rc<Decision>,
    acknowledged: Cell<bool>,
    awaiting_late_reply: Cell<bool>,
}

impl Overlap {
    fn acknowledge(&self) {
        self.acknowledged.set(true);
        if self.written.get() {
            self.decision.resolve(AgentSteerResult::Accepted);
        }
    }
}

#[derive(Default)]
struct TurnState {
    next_id: u64,
    open: IndexSet<u64>,
    closed: bool,
    failure: Option<String>,
    slot: Option<Rc<SteerSlot>>,
    overlap: Option<Rc<Overlap>>,
}

struct Inner {
    events: AcpTurnPromptEvents,
    state: RefCell<TurnState>,
    drain: Cell<Option<oneshot::Sender<DrainResult>>>,
    drained: Drained,
}

/// Tracks the native prompts of one Garcon turn. Only one overlap can await attribution.
#[derive(Clone)]
pub struct AcpTurnPrompts(Rc<Inner>);

impl AcpTurnPrompts {
    pub fn new(events: AcpTurnPromptEvents) -> Self {
        let (drain, ready) = oneshot::channel();
        let drained: LocalBoxFuture<'static, DrainResult> = Box::pin(async move {
            ready
                .await
                .unwrap_or_else(|_| Err(shared_error("ACP turn prompts closed")))
        });
        Self(Rc::new(Inner {
            events,
            state: RefCell::new(TurnState::default()),
            drain: Cell::new(Some(drain)),
            drained: drained.shared(),
        }))
    }

    pub fn closed(&self) -> bool {
        let state = self.0.state.borrow();
        state.closed || state.failure.is_some()
    }

    pub fn awaiting_late_reply(&self) -> bool {
        self.0
            .state
            .borrow()
            .overlap
            .as_ref()
            .is_some_and(|overlap| overlap.awaiting_late_reply.get())
    }

    pub fn run<S, F>(&self, initial: S) -> impl Future<Output = ExecutorResult<()>> + use<S, F>
    where
        S: FnOnce(ReplyCallback) -> F,
        F: Future<Output = ExecutorResult<AcpSessionPromptResult>> + 'static,
    {
        self.track(initial, None, None);
        let drained = self.0.drained.clone();
        async move { drained.await.map_err(|error| boxed(&error)) }
    }

    pub fn with_steer_slot<D, F>(
        &self,
        deliver: D,
    ) -> impl Future<Output = ExecutorResult<AgentSteerResult>> + use<D, F>
    where
        D: FnOnce() -> F + 'static,
        F: Future<Output = ExecutorResult<AgentSteerResult>> + 'static,
    {
        let (release, released) = oneshot::channel();
        let slot: LocalBoxFuture<'static, ()> = Box::pin(async move {
            let _ = released.await;
        });
        let slot = Rc::new(slot.shared());
        let previous = self.0.state.borrow_mut().slot.replace(Rc::clone(&slot));
        let guard = SteerSlotGuard {
            turn: self.clone(),
            slot,
            release: Some(release),
        };
        let delivered = match previous {
            None => deliver().boxed_local(),
            Some(previous) => async move {
                previous.as_ref().clone().await;
                deliver().await
            }
            .boxed_local(),
        };
        let (complete, completed) = oneshot::channel();
        // Dropping the result does not release the reservation while delivery is pending.
        spawn_local(async move {
            let result = delivered.await;
            drop(guard);
            let _ = complete.send(result);
        });
        async move {
            completed
                .await
                .unwrap_or_else(|_| Err(plain_error("ACP steering delivery closed")))
        }
    }

    pub fn steer<S, F>(
        &self,
        send: S,
        timeout_ms: f64,
    ) -> impl Future<Output = AgentSteerResult> + use<S, F>
    where
        S: FnOnce(SentCallback, ReplyCallback) -> F,
        F: Future<Output = ExecutorResult<AcpSessionPromptResult>> + 'static,
    {
        let (settle, settled) = oneshot::channel();
        let written = Rc::new(Cell::new(false));
        let decision = Rc::new(Decision {
            settle: RefCell::new(Some(settle)),
            timer: Cell::new(None),
        });
        let overlap = {
            let mut state = self.0.state.borrow_mut();
            let overlap = state.open.first().map(|&predecessor| {
                Rc::new(Overlap {
                    predecessor,
                    written: Rc::clone(&written),
                    decision: Rc::clone(&decision),
                    acknowledged: Cell::new(false),
                    awaiting_late_reply: Cell::new(false),
                })
            });
            state.overlap = overlap.clone();
            overlap
        };
        let on_sent: SentCallback = Rc::new({
            let overlap = overlap.clone();
            let decision = Rc::clone(&decision);
            move || {
                written.set(true);
                if overlap
                    .as_ref()
                    .is_none_or(|overlap| overlap.acknowledged.get())
                {
                    decision.resolve(AgentSteerResult::Accepted);
                }
                Ok(())
            }
        });
        self.track(
            |on_reply| send(on_sent, on_reply),
            Some(Rc::clone(&decision)),
            overlap.clone(),
        );
        if !decision.resolved() {
            let deadline = tokio::time::sleep(delay(timeout_ms));
            let timer = spawn_local({
                let decision = Rc::clone(&decision);
                async move {
                    deadline.await;
                    if let Some(overlap) = overlap {
                        overlap.awaiting_late_reply.set(true);
                    }
                    let timeout = garcon_js::number_to_string(timeout_ms);
                    decision.resolve(unconfirmed(format!(
                        "The agent did not confirm the steering input within {timeout}ms"
                    )));
                }
            });
            decision.timer.set(Some(timer));
        }
        async move { settled.await.unwrap_or_else(|_| unconfirmed(UNCONFIRMED)) }
    }

    fn track<F>(
        &self,
        send: impl FnOnce(ReplyCallback) -> F,
        decision: Option<Rc<Decision>>,
        at_send: Option<Rc<Overlap>>,
    ) where
        F: Future<Output = ExecutorResult<AcpSessionPromptResult>> + 'static,
    {
        let id = {
            let mut state = self.0.state.borrow_mut();
            state.next_id += 1;
            let id = state.next_id;
            state.open.insert(id);
            id
        };
        let turn = self.clone();
        let on_reply: ReplyCallback = Rc::new(move |reply| {
            turn.on_reply(id, reply, decision.as_deref(), at_send.as_deref());
            Ok(())
        });
        let pending = send(Rc::clone(&on_reply));
        spawn_local(async move {
            if let Err(error) = pending.await {
                let _ = on_reply(AcpReply::Error(error.as_ref()));
            }
        });
    }

    fn on_reply(
        &self,
        id: u64,
        reply: AcpReply<'_>,
        decide: Option<&Decision>,
        at_send: Option<&Overlap>,
    ) {
        let overlap = {
            let mut state = self.0.state.borrow_mut();
            if !state.open.shift_remove(&id) {
                return;
            }
            state.overlap.clone()
        };
        let successor = overlap
            .as_deref()
            .filter(|overlap| overlap.predecessor == id);
        let outcome = self
            .settle_reply(reply, at_send, successor)
            .unwrap_or_else(|error| {
                let message = humanize_error(error.as_ref());
                self.0
                    .state
                    .borrow_mut()
                    .failure
                    .get_or_insert_with(|| message.clone());
                unconfirmed(message)
            });
        let rejected = matches!(outcome, AgentSteerResult::Rejected { .. });
        if let Some(decide) = decide {
            decide.resolve(outcome);
        }
        {
            let mut state = self.0.state.borrow_mut();
            if let Some(overlap) = overlap
                .as_ref()
                .filter(|overlap| !rejected && state.open.contains(&overlap.predecessor))
            {
                overlap.awaiting_late_reply.set(true);
            } else {
                state.overlap = None;
            }
        }
        self.close_if_drained();
        let became_steerable = {
            let state = self.0.state.borrow();
            !state.open.is_empty()
                && state.overlap.is_none()
                && overlap.is_some_and(|overlap| overlap.awaiting_late_reply.get())
        };
        if became_steerable {
            (self.0.events.on_steerable)();
        }
    }

    fn settle_reply(
        &self,
        reply: AcpReply<'_>,
        at_send: Option<&Overlap>,
        successor: Option<&Overlap>,
    ) -> ExecutorResult<AgentSteerResult> {
        let steering = self.0.events.steering.as_deref();
        if let AcpReply::Error(error) = reply
            && at_send.is_some_and(|overlap| !overlap.acknowledged.get())
            && let Some(rpc) = as_rpc_error(error)
            && steering.is_some_and(|steering| steering.refused(rpc))
        {
            return Ok(AgentSteerResult::Rejected {
                reason: AgentSteerRejectionReason::ProviderRejected,
                message: rpc.to_string(),
            });
        }

        let candidate = (self.0.events.take_failure)()?;
        let error = match reply {
            AcpReply::Error(error) => Some(humanize_error(error)),
            AcpReply::Result(_) => candidate,
        };
        let has_error = error.as_ref().is_some_and(|error| !error.is_empty());
        if let Some(successor) = successor
            && !has_error
            && let AcpReply::Result(result) = reply
            && steering.is_some_and(|steering| steering.likely_superseded(result))
        {
            successor.acknowledge();
        } else {
            let state = self.0.state.borrow();
            let publishes_boundary = successor.is_none() || !state.open.is_empty() || has_error;
            let boundary_error = if state.failure.is_none() {
                error.as_deref()
            } else {
                None
            };
            drop(state);
            if publishes_boundary {
                (self.0.events.on_boundary)(boundary_error)?;
            }
        }
        let mut state = self.0.state.borrow_mut();
        if has_error && state.failure.is_none() {
            state.failure.clone_from(&error);
        }
        if state.failure.is_none()
            && let AcpReply::Result(result) = reply
            && result
                .get("stopReason")
                .is_some_and(|reason| is_truthy(reason) && reason.as_str() != Some("cancelled"))
        {
            return Ok(AgentSteerResult::Accepted);
        }
        Ok(unconfirmed(error.unwrap_or_else(|| UNCONFIRMED.to_owned())))
    }

    fn close_if_drained(&self) {
        let result = {
            let mut state = self.0.state.borrow_mut();
            if state.closed || !state.open.is_empty() || state.slot.is_some() {
                return;
            }
            state.closed = true;
            state
                .failure
                .as_deref()
                .map_or(Ok(()), |reason| Err(shared_error(reason)))
        };
        if let Some(drain) = self.0.drain.take() {
            let _ = drain.send(result);
        }
    }
}

struct SteerSlotGuard {
    turn: AcpTurnPrompts,
    slot: Rc<SteerSlot>,
    release: Option<oneshot::Sender<()>>,
}

impl Drop for SteerSlotGuard {
    fn drop(&mut self) {
        let mut state = self.turn.0.state.borrow_mut();
        if state
            .slot
            .as_ref()
            .is_some_and(|slot| Rc::ptr_eq(slot, &self.slot))
        {
            state.slot = None;
        }
        drop(state);
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
        self.turn.close_if_drained();
    }
}

fn unconfirmed(message: impl Into<String>) -> AgentSteerResult {
    AgentSteerResult::Failed {
        outcome: AgentSteerFailureOutcome::Unknown,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests;
