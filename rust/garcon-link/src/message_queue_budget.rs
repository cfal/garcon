//! Ports `server/remote/transport/message-queue-budget.ts`.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::ops::Bound::{Excluded, Unbounded};
use std::rc::Rc;

use garcon_js::{math_round, performance_now_ms};
use serde::Serialize;
use tokio::task::spawn_local;

use crate::limits::{
    BULK_CONTROL_RESERVE_BYTES, BULK_CONTROL_RESERVE_MESSAGES, BULK_QUEUE_BYTES,
    BULK_QUEUE_MESSAGES, RPC_QUEUE_BYTES, RPC_QUEUE_MESSAGES,
};
use crate::rpc_lane::RpcLane;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MessageQueueLimits {
    pub bytes: usize,
    pub messages: usize,
    pub bulk_bytes: usize,
    pub bulk_messages: usize,
    pub control_bytes: usize,
    pub control_messages: usize,
}

impl Default for MessageQueueLimits {
    fn default() -> Self {
        Self {
            bytes: RPC_QUEUE_BYTES,
            messages: RPC_QUEUE_MESSAGES,
            bulk_bytes: BULK_QUEUE_BYTES,
            bulk_messages: BULK_QUEUE_MESSAGES,
            control_bytes: BULK_CONTROL_RESERVE_BYTES,
            control_messages: BULK_CONTROL_RESERVE_MESSAGES,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneQueueSnapshot {
    pub bytes: usize,
    pub messages: usize,
    pub oldest_age_ms: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct MessageQueueSnapshot {
    pub total: LaneQueueSnapshot,
    pub primary: LaneQueueSnapshot,
    pub bulk: LaneQueueSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum QueueBudgetExhausted {
    #[error("Message queue budget exhausted")]
    Message,
    #[error("Control queue budget exhausted")]
    Control,
}

#[derive(Default)]
struct Queued {
    bytes: usize,
    entries: BTreeMap<u64, f64>,
}

impl Queued {
    fn snapshot(&self, now: f64) -> LaneQueueSnapshot {
        LaneQueueSnapshot {
            bytes: self.bytes,
            messages: self.entries.len(),
            oldest_age_ms: self
                .entries
                .first_key_value()
                .map_or(0, |(_, at)| math_round(now - at).max(0.0) as u64),
        }
    }
}

type CapacityListener = Rc<dyn Fn()>;

#[derive(Default)]
struct State {
    primary: Queued,
    bulk: Queued,
    control_bytes: usize,
    control_messages: usize,
    notifying: bool,
    next_id: u64,
    listeners: BTreeMap<u64, CapacityListener>,
}

impl State {
    fn lane(&mut self, lane: RpcLane) -> &mut Queued {
        match lane {
            RpcLane::Primary => &mut self.primary,
            RpcLane::Bulk => &mut self.bulk,
        }
    }

    fn queued_bytes(&self) -> usize {
        self.primary.bytes + self.bulk.bytes
    }

    fn queued_messages(&self) -> usize {
        self.primary.entries.len() + self.bulk.entries.len()
    }

    fn allocate_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }
}

pub struct MessageQueueBudget {
    limits: MessageQueueLimits,
    state: Rc<RefCell<State>>,
    now: Rc<dyn Fn() -> f64>,
}

impl Default for MessageQueueBudget {
    fn default() -> Self {
        Self::new(MessageQueueLimits::default())
    }
}

impl MessageQueueBudget {
    pub fn new(limits: MessageQueueLimits) -> Self {
        Self::with_clock(limits, performance_now_ms)
    }

    pub fn with_clock(limits: MessageQueueLimits, now: impl Fn() -> f64 + 'static) -> Self {
        Self {
            limits,
            state: Rc::default(),
            now: Rc::new(now),
        }
    }

    pub fn queued_bytes(&self) -> usize {
        self.state.borrow().queued_bytes()
    }

    pub fn queued_messages(&self) -> usize {
        self.state.borrow().queued_messages()
    }

    pub fn snapshot(&self) -> MessageQueueSnapshot {
        let now = (self.now)();
        let state = self.state.borrow();
        let primary = state.primary.snapshot(now);
        let bulk = state.bulk.snapshot(now);
        MessageQueueSnapshot {
            total: LaneQueueSnapshot {
                bytes: state.queued_bytes(),
                messages: state.queued_messages(),
                oldest_age_ms: primary.oldest_age_ms.max(bulk.oldest_age_ms),
            },
            primary,
            bulk,
        }
    }

    pub fn can_admit(&self, lane: RpcLane, bytes: usize) -> bool {
        let state = self.state.borrow();
        self.limits
            .bytes
            .checked_sub(self.limits.control_bytes)
            .is_some_and(|limit| state.queued_bytes().saturating_add(bytes) <= limit)
            && state.queued_messages()
                < self
                    .limits
                    .messages
                    .saturating_sub(self.limits.control_messages)
            && (lane == RpcLane::Primary
                || state.bulk.bytes.saturating_add(bytes) <= self.limits.bulk_bytes
                    && state.bulk.entries.len() < self.limits.bulk_messages)
    }

    pub fn can_admit_control(&self, bytes: usize) -> bool {
        let state = self.state.borrow();
        state.queued_bytes().saturating_add(bytes) <= self.limits.bytes
            && state.queued_messages() < self.limits.messages
            && state.control_bytes.saturating_add(bytes) <= self.limits.control_bytes
            && state.control_messages < self.limits.control_messages
    }

    pub fn reserve(
        &self,
        lane: RpcLane,
        bytes: usize,
    ) -> Result<MessageQueueReservation, QueueBudgetExhausted> {
        if !self.can_admit(lane, bytes) {
            return Err(QueueBudgetExhausted::Message);
        }
        Ok(self.reserve_queued(lane, bytes, false))
    }

    pub fn reserve_control(
        &self,
        bytes: usize,
    ) -> Result<MessageQueueReservation, QueueBudgetExhausted> {
        if !self.can_admit_control(bytes) {
            return Err(QueueBudgetExhausted::Control);
        }
        Ok(self.reserve_queued(RpcLane::Primary, bytes, true))
    }

    pub fn on_capacity(&self, listener: CapacityListener) -> impl Fn() + use<> {
        let mut state = self.state.borrow_mut();
        let id = state
            .listeners
            .iter()
            .find_map(|(id, registered)| Rc::ptr_eq(&listener, registered).then_some(*id))
            .unwrap_or_else(|| {
                let id = state.allocate_id();
                state.listeners.insert(id, listener);
                id
            });
        let state = Rc::clone(&self.state);
        move || {
            state.borrow_mut().listeners.remove(&id);
        }
    }

    fn reserve_queued(
        &self,
        lane: RpcLane,
        bytes: usize,
        control: bool,
    ) -> MessageQueueReservation {
        let at = (self.now)();
        let mut state = self.state.borrow_mut();
        let id = state.allocate_id();
        let queued = state.lane(lane);
        queued.entries.insert(id, at);
        queued.bytes += bytes;
        if control {
            state.control_bytes += bytes;
            state.control_messages += 1;
        }
        MessageQueueReservation {
            state: Rc::clone(&self.state),
            released: Cell::new(false),
            id,
            lane,
            bytes,
            control,
        }
    }
}

pub struct MessageQueueReservation {
    state: Rc<RefCell<State>>,
    released: Cell<bool>,
    id: u64,
    lane: RpcLane,
    bytes: usize,
    control: bool,
}

impl MessageQueueReservation {
    pub fn release(&self) {
        if self.released.replace(true) {
            return;
        }
        let mut state = self.state.borrow_mut();
        let queued = state.lane(self.lane);
        queued.entries.remove(&self.id);
        queued.bytes -= self.bytes;
        if self.control {
            state.control_bytes -= self.bytes;
            state.control_messages -= 1;
        }
        if !state.notifying {
            state.notifying = true;
            let state = Rc::clone(&self.state);
            spawn_local(async move { notify_capacity(&state) });
        }
    }
}

fn notify_capacity(state: &RefCell<State>) {
    state.borrow_mut().notifying = false;
    let mut last = 0;
    loop {
        // Like Set iteration, sees registrations and removals made by a listener.
        let next = state
            .borrow()
            .listeners
            .range((Excluded(last), Unbounded))
            .next()
            .map(|(id, listener)| (*id, Rc::clone(listener)));
        let Some((id, listener)) = next else {
            break;
        };
        last = id;
        listener();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ordinary_capacity_leaves_room_for_controls_and_notifies_once_per_turn() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let budget = MessageQueueBudget::new(MessageQueueLimits {
                    bytes: 1000,
                    messages: 8,
                    bulk_bytes: 600,
                    bulk_messages: 4,
                    control_bytes: 200,
                    control_messages: 2,
                });
                let bulk = budget.reserve(RpcLane::Bulk, 600).unwrap();
                let primary = budget.reserve(RpcLane::Primary, 200).unwrap();
                assert!(!budget.can_admit(RpcLane::Bulk, 1));
                assert!(!budget.can_admit(RpcLane::Primary, 1));
                let controls = [
                    budget.reserve_control(100).unwrap(),
                    budget.reserve_control(100).unwrap(),
                ];
                assert!(!budget.can_admit_control(0));
                assert_eq!(budget.queued_messages(), 4);
                let notified = Rc::new(Cell::new(0));
                let unsubscribe = budget.on_capacity(Rc::new({
                    let notified = Rc::clone(&notified);
                    move || notified.set(notified.get() + 1)
                }));
                bulk.release();
                bulk.release();
                primary.release();
                assert_eq!(notified.get(), 0);
                tokio::task::yield_now().await;
                assert_eq!(notified.get(), 1);
                assert!(budget.can_admit(RpcLane::Primary, 1));
                unsubscribe();
                for control in controls {
                    control.release();
                }
                assert_eq!(budget.snapshot(), MessageQueueSnapshot::default());
            })
            .await;
    }

    #[tokio::test]
    async fn queue_snapshot_ages_the_oldest_reservation_per_lane() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let now = Rc::new(Cell::new(100.0));
                let budget = MessageQueueBudget::with_clock(MessageQueueLimits::default(), {
                    let now = Rc::clone(&now);
                    move || now.get()
                });
                let first = budget.reserve(RpcLane::Primary, 17).unwrap();
                now.set(120.0);
                let second = budget.reserve(RpcLane::Bulk, 14).unwrap();
                now.set(150.0);
                let snapshot = budget.snapshot();
                assert_eq!(
                    snapshot.total,
                    LaneQueueSnapshot {
                        bytes: 31,
                        messages: 2,
                        oldest_age_ms: 50
                    }
                );
                assert_eq!(snapshot.primary.oldest_age_ms, 50);
                assert_eq!(snapshot.bulk.oldest_age_ms, 30);
                first.release();
                now.set(200.0);
                assert_eq!(
                    budget.snapshot().total,
                    LaneQueueSnapshot {
                        bytes: 14,
                        messages: 1,
                        oldest_age_ms: 80
                    }
                );
                second.release();
                assert_eq!(budget.snapshot(), MessageQueueSnapshot::default());
            })
            .await;
    }
}
