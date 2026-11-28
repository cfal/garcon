//! Ports `server/remote/transport/message-session.ts`.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::error::Error;
use std::rc::Rc;
use std::time::Duration;

use garcon_js::is_safe_integer;
use tokio::task::{JoinHandle, spawn_local};
use tokio::time::{Instant, sleep_until};

use crate::limits::{BULK_CONTROL_BYTES, RPC_QUEUE_BYTES, RPC_QUEUE_MESSAGES};
use crate::message_queue_budget::{
    MessageQueueBudget, MessageQueueReservation, MessageQueueSnapshot,
};
use crate::rpc_lane::{BulkConnectionControl, RpcLane};

pub type SessionError = Rc<dyn Error>;
pub type DeliverMessage = Rc<dyn Fn(String) -> Result<(), SessionError>>;
pub type SessionFailed = Rc<dyn Fn(SessionError)>;
pub type AvailabilityChanged = Rc<dyn Fn(bool)>;

pub trait SessionSocket {
    fn send(&self, encoded: String) -> Result<(), SessionError>;
    fn close(&self);
    fn can_send(&self, _bytes: usize) -> bool {
        true
    }
}

pub struct MessageSessionOptions {
    pub deliver: DeliverMessage,
    pub failed: SessionFailed,
    pub availability_changed: Option<AvailabilityChanged>,
    pub max_queued_bytes: Option<usize>,
    pub max_queued_frames: Option<usize>,
    pub max_frame_bytes: Option<usize>,
    pub budget: Option<Rc<MessageQueueBudget>>,
    pub lane: RpcLane,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct MessageContinuityError(pub &'static str);

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Session limits must be positive safe integers")]
pub struct InvalidSessionLimits;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Message session already attached")]
struct AlreadyAttached;

struct Limits {
    bytes: usize,
    count: usize,
    frame: usize,
}

struct QueuedMessage {
    body: String,
    reservation: Option<MessageQueueReservation>,
}

impl QueuedMessage {
    fn release(&self) {
        if let Some(reservation) = &self.reservation {
            reservation.release();
        }
    }
}

#[derive(Default)]
struct State {
    pending: VecDeque<QueuedMessage>,
    bytes: usize,
    socket: Option<Rc<dyn SessionSocket>>,
    failure: Option<SessionError>,
    flushing: bool,
    retry: Option<JoinHandle<()>>,
    closed_queues: Option<MessageQueueSnapshot>,
}

pub struct MessageSession {
    options: MessageSessionOptions,
    limits: Limits,
    state: RefCell<State>,
}

impl MessageSession {
    pub fn new(options: MessageSessionOptions) -> Result<Rc<Self>, InvalidSessionLimits> {
        let limits = Limits {
            bytes: options.max_queued_bytes.unwrap_or(RPC_QUEUE_BYTES),
            count: options.max_queued_frames.unwrap_or(RPC_QUEUE_MESSAGES),
            frame: options.max_frame_bytes.unwrap_or(1024 * 1024),
        };
        if [limits.bytes, limits.count, limits.frame]
            .into_iter()
            .any(|limit| limit == 0 || !is_safe_integer(limit as f64))
        {
            return Err(InvalidSessionLimits);
        }
        Ok(Rc::new(Self {
            options,
            limits,
            state: RefCell::default(),
        }))
    }

    pub fn connected(&self) -> bool {
        self.state.borrow().socket.is_some()
    }

    pub fn failure(&self) -> Option<SessionError> {
        self.state.borrow().failure.clone()
    }

    pub fn queued_bytes(&self) -> usize {
        self.state.borrow().bytes
    }

    pub fn queued_frames(&self) -> usize {
        self.state.borrow().pending.len()
    }

    pub fn queue_snapshot(&self) -> Option<MessageQueueSnapshot> {
        let closed = self.state.borrow().closed_queues;
        closed.or_else(|| self.options.budget.as_ref().map(|budget| budget.snapshot()))
    }

    pub fn fits_frame(&self, body: &str) -> bool {
        body.len() <= self.limits.frame
    }

    pub fn can_admit(&self, body: &str) -> bool {
        let bytes = body.len();
        let state = self.state.borrow();
        state.socket.is_some()
            && self.fits_frame(body)
            && state.bytes + bytes <= self.limits.bytes
            && state.pending.len() < self.limits.count
            && self
                .options
                .budget
                .as_ref()
                .is_none_or(|budget| budget.can_admit(self.options.lane, bytes))
    }

    pub fn offer_bulk_control(self: &Rc<Self>, frame: &BulkConnectionControl) -> bool {
        let Ok(body) = serde_json::to_string(frame) else {
            return false;
        };
        let bytes = body.len();
        let Some(budget) = &self.options.budget else {
            return false;
        };
        if self.options.lane == RpcLane::Bulk
            || !self.connected()
            || self.failure().is_some()
            || bytes > BULK_CONTROL_BYTES
            || !self.fits_frame(&body)
            || self.queued_bytes() + bytes > self.limits.bytes
            || self.queued_frames() >= self.limits.count
        {
            return false;
        }
        let Ok(reservation) = budget.reserve_control(bytes) else {
            return false;
        };
        self.enqueue(body, Some(reservation));
        self.connected()
    }

    pub fn on_capacity(&self, listener: Rc<dyn Fn()>) -> impl Fn() + use<> {
        let unsubscribe = self
            .options
            .budget
            .as_ref()
            .map(|budget| budget.on_capacity(listener));
        move || {
            if let Some(unsubscribe) = &unsubscribe {
                unsubscribe();
            }
        }
    }

    pub fn offer(self: &Rc<Self>, body: String) -> bool {
        if !self.can_admit(&body) {
            return false;
        }
        let exceeds_share = self.queued_bytes() + body.len()
            > (self.limits.bytes / 4).min(4 * 1024 * 1024)
            || self.queued_frames() >= self.limits.count.div_ceil(4).min(512);
        if self.queued_frames() > 0 && exceeds_share {
            return false;
        }
        self.send(body).is_ok() && self.connected()
    }

    pub fn try_send(self: &Rc<Self>, body: String) -> bool {
        let bytes = body.len();
        if !self.can_admit(&body)
            || self.queued_bytes() + bytes > (self.limits.bytes / 2).min(2 * 1024 * 1024)
            || self.queued_frames() >= self.limits.count.div_ceil(2).min(256)
        {
            return false;
        }
        let socket = self.state.borrow().socket.clone();
        if socket.is_some_and(|socket| !socket.can_send(bytes)) {
            return false;
        }
        self.send(body).is_ok() && self.connected()
    }

    pub fn send(self: &Rc<Self>, body: String) -> Result<(), SessionError> {
        if let Some(error) = self.failure() {
            return Err(error);
        }
        if !self.can_admit(&body) {
            let error: SessionError = Rc::new(MessageContinuityError(
                "Message queue unavailable or budget exhausted",
            ));
            self.close(Some(Rc::clone(&error)));
            return Err(error);
        }
        let reservation = self
            .options
            .budget
            .as_ref()
            .map(|budget| budget.reserve(self.options.lane, body.len()))
            .transpose()
            .map_err(|error| Rc::new(error) as SessionError)?;
        self.enqueue(body, reservation);
        match self.failure() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn enqueue(self: &Rc<Self>, body: String, reservation: Option<MessageQueueReservation>) {
        {
            let mut state = self.state.borrow_mut();
            state.bytes += body.len();
            state.pending.push_back(QueuedMessage { body, reservation });
        }
        self.flush();
    }

    pub fn attach(
        self: &Rc<Self>,
        socket: Rc<dyn SessionSocket>,
    ) -> Result<MessageSessionAttachment, SessionError> {
        {
            let mut state = self.state.borrow_mut();
            if let Some(error) = &state.failure {
                return Err(Rc::clone(error));
            }
            if state.socket.is_some() {
                return Err(Rc::new(AlreadyAttached));
            }
            state.socket = Some(Rc::clone(&socket));
        }
        if let Some(changed) = &self.options.availability_changed {
            changed(true);
        }
        Ok(MessageSessionAttachment {
            session: Rc::clone(self),
            socket,
        })
    }

    pub fn close(&self, error: Option<SessionError>) {
        let (socket, pending, error) = {
            let mut state = self.state.borrow_mut();
            if state.failure.is_some() {
                return;
            }
            let error =
                error.unwrap_or_else(|| Rc::new(MessageContinuityError("Message session closed")));
            state.closed_queues = self.options.budget.as_ref().map(|budget| budget.snapshot());
            state.failure = Some(Rc::clone(&error));
            if let Some(retry) = state.retry.take() {
                retry.abort();
            }
            state.bytes = 0;
            (
                state.socket.take(),
                std::mem::take(&mut state.pending),
                error,
            )
        };
        for message in pending {
            message.release();
        }
        if let Some(socket) = socket {
            socket.close();
        }
        if let Some(changed) = &self.options.availability_changed {
            changed(false);
        }
        (self.options.failed)(error);
    }

    fn flush(self: &Rc<Self>) {
        {
            let mut state = self.state.borrow_mut();
            if state.flushing {
                return;
            }
            state.flushing = true;
        }
        if let Err(error) = self.flush_pending() {
            self.close(Some(error));
        }
        self.state.borrow_mut().flushing = false;
    }

    fn flush_pending(self: &Rc<Self>) -> Result<(), SessionError> {
        loop {
            let next = {
                let state = self.state.borrow();
                state
                    .socket
                    .clone()
                    .zip(state.pending.front().map(|message| message.body.len()))
            };
            let Some((socket, bytes)) = next else {
                return Ok(());
            };
            if !socket.can_send(bytes) {
                self.schedule_retry();
                return Ok(());
            }
            let message = {
                let mut state = self.state.borrow_mut();
                let Some(message) = state.pending.pop_front() else {
                    return Ok(());
                };
                state.bytes -= message.body.len();
                message
            };
            message.release();
            socket.send(message.body)?;
        }
    }

    fn schedule_retry(self: &Rc<Self>) {
        let mut state = self.state.borrow_mut();
        if state.retry.is_none() && state.failure.is_none() {
            let session = Rc::clone(self);
            let deadline = Instant::now() + Duration::from_millis(10);
            state.retry = Some(spawn_local(async move {
                sleep_until(deadline).await;
                session.state.borrow_mut().retry = None;
                session.flush();
            }));
        }
    }
}

pub struct MessageSessionAttachment {
    session: Rc<MessageSession>,
    socket: Rc<dyn SessionSocket>,
}

impl MessageSessionAttachment {
    pub fn receive(&self, body: String) {
        let session = &self.session;
        if !session
            .state
            .borrow()
            .socket
            .as_ref()
            .is_some_and(|socket| Rc::ptr_eq(socket, &self.socket))
        {
            return;
        }
        if !session.fits_frame(&body) {
            session.close(Some(Rc::new(MessageContinuityError(
                "Message exceeds frame budget",
            ))));
        } else if let Err(error) = (session.options.deliver)(body) {
            session.close(Some(error));
        }
    }

    pub fn disconnected(&self) {
        self.session.close(Some(Rc::new(MessageContinuityError(
            "Executor connection lost",
        ))));
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use crate::message_queue_budget::{LaneQueueSnapshot, MessageQueueLimits};
    use crate::rpc_lane::BulkControlType;

    use super::*;

    struct TestSocket {
        writable: Cell<bool>,
        sent: RefCell<Vec<String>>,
    }

    impl SessionSocket for TestSocket {
        fn send(&self, body: String) -> Result<(), SessionError> {
            self.sent.borrow_mut().push(body);
            Ok(())
        }

        fn close(&self) {}

        fn can_send(&self, _bytes: usize) -> bool {
            self.writable.get()
        }
    }

    fn session(
        budget: &Rc<MessageQueueBudget>,
        lane: RpcLane,
        writable: bool,
    ) -> (Rc<MessageSession>, Rc<TestSocket>) {
        let session = MessageSession::new(MessageSessionOptions {
            deliver: Rc::new(|_| Ok(())),
            failed: Rc::new(|_| {}),
            availability_changed: None,
            max_queued_bytes: None,
            max_queued_frames: None,
            max_frame_bytes: None,
            budget: Some(Rc::clone(budget)),
            lane,
        })
        .unwrap();
        let socket = Rc::new(TestSocket {
            writable: Cell::new(writable),
            sent: RefCell::default(),
        });
        assert!(session.attach(socket.clone()).is_ok());
        (session, socket)
    }

    #[tokio::test]
    async fn queue_diagnostics_retain_pre_close_pressure_and_ages_without_retaining_payloads() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let now = Rc::new(Cell::new(100.0));
                let budget = Rc::new(MessageQueueBudget::with_clock(
                    MessageQueueLimits::default(),
                    {
                        let now = Rc::clone(&now);
                        move || now.get()
                    },
                ));
                let (primary, _) = session(&budget, RpcLane::Primary, false);
                let (bulk, _) = session(&budget, RpcLane::Bulk, false);
                assert!(primary.send("synthetic-primary".to_owned()).is_ok());
                now.set(120.0);
                assert!(bulk.send("synthetic-bulk".to_owned()).is_ok());
                now.set(150.0);
                let snapshot = MessageQueueSnapshot {
                    total: LaneQueueSnapshot {
                        bytes: 31,
                        messages: 2,
                        oldest_age_ms: 50,
                    },
                    primary: LaneQueueSnapshot {
                        bytes: 17,
                        messages: 1,
                        oldest_age_ms: 50,
                    },
                    bulk: LaneQueueSnapshot {
                        bytes: 14,
                        messages: 1,
                        oldest_age_ms: 30,
                    },
                };
                assert_eq!(primary.queue_snapshot(), Some(snapshot));
                primary.close(None);
                now.set(200.0);
                assert_eq!(primary.queue_snapshot(), Some(snapshot));
                assert_eq!(
                    bulk.queue_snapshot().unwrap().total,
                    LaneQueueSnapshot {
                        bytes: 14,
                        messages: 1,
                        oldest_age_ms: 80
                    }
                );
                bulk.close(None);
                assert_eq!(budget.snapshot(), MessageQueueSnapshot::default());
                assert!(
                    !serde_json::to_string(&primary.queue_snapshot())
                        .unwrap()
                        .contains("synthetic")
                );
            })
            .await;
    }

    #[tokio::test]
    async fn full_ordinary_queues_cannot_retire_primary_through_bulk_controls() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let budget = Rc::new(MessageQueueBudget::new(MessageQueueLimits {
                    bytes: 1000,
                    messages: 8,
                    bulk_bytes: 600,
                    bulk_messages: 4,
                    control_bytes: 200,
                    control_messages: 2,
                }));
                let (primary, _) = session(&budget, RpcLane::Primary, false);
                let (bulk, _) = session(&budget, RpcLane::Bulk, false);
                assert!(bulk.send("b".repeat(600)).is_ok());
                assert!(!bulk.can_admit("b"));
                assert!(primary.send("p".repeat(200)).is_ok());
                assert!(!primary.can_admit("p"));
                let frame = BulkConnectionControl::new(
                    BulkControlType::Prepare,
                    "22222222-2222-4222-8222-222222222222".to_owned(),
                );
                assert!(primary.offer_bulk_control(&frame));
                assert!(primary.offer_bulk_control(&frame));
                assert!(!primary.offer_bulk_control(&frame));
                assert!(primary.connected());
                assert_eq!(budget.queued_messages(), 4);
                let notifications = Rc::new(Cell::new(0));
                let unsubscribe = primary.on_capacity(Rc::new({
                    let notifications = Rc::clone(&notifications);
                    move || notifications.set(notifications.get() + 1)
                }));
                bulk.close(None);
                tokio::task::yield_now().await;
                assert_eq!(notifications.get(), 1);
                assert!(primary.connected());
                assert!(primary.can_admit("p"));
                unsubscribe();
                primary.close(None);
                assert_eq!(budget.queued_bytes(), 0);
                assert_eq!(budget.queued_messages(), 0);
            })
            .await;
    }

    #[tokio::test]
    async fn terminal_offers_refuse_aggregate_pressure_without_retiring_primary() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let budget = Rc::new(MessageQueueBudget::new(MessageQueueLimits {
                    bytes: 1000,
                    messages: 8,
                    bulk_bytes: 800,
                    bulk_messages: 4,
                    control_bytes: 200,
                    control_messages: 2,
                }));
                let (primary, socket) = session(&budget, RpcLane::Primary, true);
                let hold = budget.reserve(RpcLane::Bulk, 800).unwrap();
                assert!(!primary.try_send("terminal output".to_owned()));
                assert!(primary.connected());
                hold.release();
                assert!(primary.try_send("terminal output".to_owned()));
                assert_eq!(*socket.sent.borrow(), ["terminal output"]);
                primary.close(None);
            })
            .await;
    }
}
