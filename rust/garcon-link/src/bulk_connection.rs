//! Ports `server/remote/transport/bulk-connection.ts`.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::future::pending;
use std::rc::Rc;
use std::time::Duration;

use futures::channel::oneshot;
use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome};
use indexmap::IndexMap;
use serde::Serialize;
use tokio::task::{JoinHandle, spawn_local};
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;

use crate::failure_reason::{Failure, failure_reason};
use crate::limits::{BULK_ACQUIRE_TIMEOUT_MS, BULK_SETUP_TIMEOUT_MS};
use crate::link_handshake::LinkRole;
use crate::message_queue_budget::MessageQueueSnapshot;
use crate::message_session::SessionError;
use crate::rpc::{DEFAULT_RPC_TIMEOUT_MS, ExecutorRpc};
use crate::rpc_lane::{BulkConnectionControl, BulkControlType, RpcLane};
use crate::session_transport::SessionTransport;
use crate::websocket_link::{REDIAL_DELAYS_MS, WebSocketLink};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BulkPhase {
    Offline,
    Preparing,
    Connecting,
    Reconciling,
    Activating,
    Ready,
    Reconnecting,
}

impl BulkPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Offline => "offline",
            Self::Preparing => "preparing",
            Self::Connecting => "connecting",
            Self::Reconciling => "reconciling",
            Self::Activating => "activating",
            Self::Ready => "ready",
            Self::Reconnecting => "reconnecting",
        }
    }
}

#[derive(Debug, Clone)]
pub struct BulkConnectionStatus {
    pub phase: BulkPhase,
    pub session_id: Option<String>,
    pub error: Option<SessionError>,
    pub retries: usize,
}

impl Default for BulkConnectionStatus {
    fn default() -> Self {
        Self {
            phase: BulkPhase::Offline,
            session_id: None,
            error: None,
            retries: 0,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct BulkConnectionTiming {
    pub setup_timeout_ms: Option<u64>,
    pub redial_delays_ms: Option<Vec<u64>>,
    pub stable_session_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkAttemptFailure {
    pub lane: RpcLane,
    pub primary_session_id: String,
    pub session_id: String,
    pub phase: BulkPhase,
    pub reason: String,
    pub retries: usize,
    pub setup_timeout_ms: u64,
    pub queues: Option<MessageQueueSnapshot>,
}

type InstallBulk = Rc<dyn Fn(Rc<SessionTransport>) -> Result<Rc<ExecutorRpc>, SessionError>>;
type Changed = Rc<dyn Fn(BulkConnectionStatus)>;
type Failed = Rc<dyn Fn(BulkAttemptFailure)>;

pub struct BulkConnectionOptions {
    pub timing: BulkConnectionTiming,
    pub install: InstallBulk,
    pub changed: Changed,
    pub failed: Option<Failed>,
}

struct Attempt {
    id: String,
    rpc: RefCell<Option<Rc<ExecutorRpc>>>,
    phase: Cell<BulkPhase>,
    timer: RefCell<Option<JoinHandle<()>>>,
    ready_at: Cell<Option<Instant>>,
    dialed: Cell<bool>,
}

impl Attempt {
    fn new(id: String, phase: BulkPhase) -> Rc<Self> {
        Rc::new(Self {
            id,
            rpc: RefCell::default(),
            phase: Cell::new(phase),
            timer: RefCell::default(),
            ready_at: Cell::new(None),
            dialed: Cell::new(false),
        })
    }
}

#[derive(Clone)]
struct PendingControl {
    frame: BulkConnectionControl,
    sent: Option<Rc<dyn Fn()>>,
}

type BulkReady = Result<Rc<ExecutorRpc>, SessionError>;

#[derive(Default)]
struct State {
    off: Vec<Box<dyn Fn()>>,
    outbox: VecDeque<PendingControl>,
    waiters: IndexMap<u64, oneshot::Sender<BulkReady>>,
    next_waiter: u64,
    attempt: Option<Rc<Attempt>>,
    retry: Option<JoinHandle<()>>,
    retries: usize,
    error: Option<SessionError>,
    flushing: bool,
    disposed: bool,
    started: bool,
}

pub struct BulkConnection {
    link: Rc<WebSocketLink>,
    primary: Rc<ExecutorRpc>,
    options: BulkConnectionOptions,
    state: RefCell<State>,
}

impl BulkConnection {
    pub fn new(
        link: Rc<WebSocketLink>,
        primary: Rc<ExecutorRpc>,
        options: BulkConnectionOptions,
    ) -> Result<Rc<Self>, SessionError> {
        let bulk = Rc::new(Self {
            link,
            primary,
            options,
            state: RefCell::default(),
        });
        let weak = Rc::downgrade(&bulk);
        bulk.primary.on_bulk_control(Rc::new(move |frame| {
            if let Some(bulk) = weak.upgrade() {
                bulk.receive(frame)?;
            }
            Ok(())
        }));
        let weak = Rc::downgrade(&bulk);
        let capacity = bulk.primary.transport.channel.on_capacity(Rc::new(move || {
            if let Some(bulk) = weak.upgrade() {
                bulk.flush();
            }
        }));
        let weak = Rc::downgrade(&bulk);
        let primary = bulk.primary.transport.on_failure(Rc::new(move |_| {
            if let Some(bulk) = weak.upgrade() {
                bulk.dispose();
            }
        }));
        let weak = Rc::downgrade(&bulk);
        let bulk_session = bulk.link.on_bulk_session(Rc::new(move |transport| {
            if let Some(bulk) = weak.upgrade() {
                bulk.install(transport)?;
            }
            Ok(())
        }))?;
        let weak = Rc::downgrade(&bulk);
        let quiesce = bulk.link.on_quiesce(Rc::new(move || {
            if let Some(bulk) = weak.upgrade() {
                bulk.quiesce();
            }
        }));
        bulk.state.borrow_mut().off = vec![
            Box::new(capacity),
            Box::new(primary),
            Box::new(bulk_session),
            Box::new(quiesce),
        ];
        Ok(bulk)
    }

    pub fn current(&self) -> Option<Rc<ExecutorRpc>> {
        let state = self.state.borrow();
        let attempt = state.attempt.as_ref()?;
        if state.disposed || attempt.phase.get() != BulkPhase::Ready {
            return None;
        }
        attempt.rpc.borrow().clone().filter(|rpc| rpc.active())
    }

    pub fn start(self: &Rc<Self>) -> Result<(), SessionError> {
        if !self.live() || self.link.role() != LinkRole::Controller || self.state.borrow().started {
            return Ok(());
        }
        self.state.borrow_mut().started = true;
        self.prepare()
    }

    pub async fn wait(
        &self,
        signal: Option<CancellationToken>,
        timeout_ms: Option<u64>,
    ) -> BulkReady {
        if signal.as_ref().is_some_and(CancellationToken::is_cancelled) {
            return Err(unavailable("Bulk connection wait cancelled"));
        }
        if let Some(rpc) = self.current() {
            return Ok(rpc);
        }
        if !self.live() {
            return Err(unavailable("Executor primary connection is unavailable"));
        }
        let (sender, receiver) = oneshot::channel();
        let id = {
            let mut state = self.state.borrow_mut();
            state.next_waiter += 1;
            let id = state.next_waiter;
            state.waiters.insert(id, sender);
            id
        };
        let _waiter = Waiter {
            state: &self.state,
            id,
        };
        let timeout = timeout_ms
            .unwrap_or(BULK_ACQUIRE_TIMEOUT_MS)
            .min(BULK_ACQUIRE_TIMEOUT_MS);
        let deadline = Instant::now() + Duration::from_millis(timeout);
        tokio::select! {
            biased;
            reply = receiver => reply.unwrap_or_else(|_| Err(unavailable("Executor connection is shutting down"))),
            _ = async { match signal { Some(signal) => signal.cancelled().await, None => pending().await } } => {
                Err(unavailable("Bulk connection wait cancelled"))
            }
            _ = sleep_until(deadline) => Err(unavailable("Executor bulk connection did not become ready in time")),
        }
    }

    pub fn dispose(&self) {
        let off = {
            let mut state = self.state.borrow_mut();
            if state.disposed {
                return;
            }
            state.disposed = true;
            std::mem::take(&mut state.off)
        };
        for off in off {
            off();
        }
        self.quiesce();
        self.clear_attempt();
        self.publish(BulkPhase::Offline);
    }

    fn quiesce(&self) {
        let (waiters, clear) = {
            let mut state = self.state.borrow_mut();
            if let Some(retry) = state.retry.take() {
                retry.abort();
            }
            let clear = state
                .attempt
                .as_ref()
                .is_none_or(|attempt| attempt.phase.get() != BulkPhase::Ready);
            (std::mem::take(&mut state.waiters), clear)
        };
        for waiter in waiters.into_values() {
            let _ = waiter.send(Err(unavailable("Executor connection is shutting down")));
        }
        if clear {
            self.clear_attempt();
        }
    }

    fn parent_is_current(&self) -> bool {
        self.link
            .current()
            .is_some_and(|current| Rc::ptr_eq(&current, &self.primary.transport))
    }

    fn live(&self) -> bool {
        !self.state.borrow().disposed
            && !self.link.quiescing()
            && self.parent_is_current()
            && self.primary.transport.connected()
    }

    fn prepare(self: &Rc<Self>) -> Result<(), SessionError> {
        if !self.live() {
            return Ok(());
        }
        self.clear_attempt();
        let attempt = Attempt::new(uuid::Uuid::new_v4().to_string(), BulkPhase::Preparing);
        self.state.borrow_mut().attempt = Some(Rc::clone(&attempt));
        self.link
            .prepare_bulk(&self.primary.transport, attempt.id.clone())
            .map_err(|error| Rc::new(error) as SessionError)?;
        self.phase(&attempt, BulkPhase::Preparing, None);
        self.send(BulkControlType::Prepare, &attempt.id, None);
        Ok(())
    }

    fn receive(self: &Rc<Self>, frame: BulkConnectionControl) -> Result<(), SessionError> {
        if !self.live() {
            return Ok(());
        }
        let kind = frame.control_type();
        let controller_frame = matches!(
            kind,
            Some(BulkControlType::Prepare | BulkControlType::Connect | BulkControlType::Activate)
        );
        if controller_frame != (self.link.role() == LinkRole::Worker) {
            self.fail_current(error("Invalid bulk control direction"));
            return Ok(());
        }
        let attempt = self.state.borrow().attempt.clone();
        if kind == Some(BulkControlType::Prepare) {
            if attempt
                .as_ref()
                .is_some_and(|attempt| attempt.id == frame.session_id)
            {
                return Ok(());
            }
            self.primary.activate();
            self.clear_attempt();
            let attempt = Attempt::new(frame.session_id, BulkPhase::Connecting);
            self.state.borrow_mut().attempt = Some(Rc::clone(&attempt));
            self.link
                .prepare_bulk(&self.primary.transport, attempt.id.clone())
                .map_err(|error| Rc::new(error) as SessionError)?;
            self.phase(&attempt, BulkPhase::Connecting, None);
            self.send(BulkControlType::Prepared, &attempt.id, None);
            return Ok(());
        }
        let Some(attempt) = attempt.filter(|attempt| attempt.id == frame.session_id) else {
            return Ok(());
        };
        match (kind, attempt.phase.get()) {
            (Some(BulkControlType::Lost), _) => {
                self.fail(&attempt, error("Peer lost the bulk connection"))
            }
            (Some(BulkControlType::Prepared), BulkPhase::Preparing) => {
                self.phase(&attempt, BulkPhase::Connecting, None);
                if self.link.is_dialer() {
                    self.dial(&attempt);
                } else {
                    self.send(BulkControlType::Connect, &attempt.id, None);
                }
            }
            (Some(BulkControlType::Connect), BulkPhase::Connecting) if self.link.is_dialer() => {
                self.dial(&attempt)
            }
            (Some(BulkControlType::Activate), BulkPhase::Activating) => {
                let rpc = attempt.rpc.borrow().clone().filter(|rpc| rpc.reconciled());
                if let Some(rpc) = rpc {
                    rpc.activate_incoming();
                    let weak = Rc::downgrade(self);
                    let activating = Rc::clone(&attempt);
                    self.send(
                        BulkControlType::Active,
                        &attempt.id,
                        Some(Rc::new(move || {
                            if let Some(bulk) = weak.upgrade() {
                                bulk.activate(&activating);
                            }
                        })),
                    );
                }
            }
            (Some(BulkControlType::Active), BulkPhase::Activating) => self.activate(&attempt),
            _ => {}
        }
        Ok(())
    }

    fn dial(self: &Rc<Self>, attempt: &Rc<Attempt>) {
        if !attempt.dialed.replace(true)
            && let Err(error) = self.link.dial_bulk(&self.primary.transport, &attempt.id)
        {
            self.fail(attempt, error);
        }
    }

    fn install(self: &Rc<Self>, transport: Rc<SessionTransport>) -> Result<(), SessionError> {
        if !self.live() {
            return Ok(());
        }
        let attempt = self.state.borrow().attempt.clone().filter(|attempt| {
            transport.id == attempt.id && transport.primary_session_id == self.primary.transport.id
        });
        let Some(attempt) = attempt else {
            return Ok(());
        };
        if attempt.rpc.borrow().is_some() {
            transport.close(Some(error("Duplicate bulk endpoint")));
            return Ok(());
        }
        let rpc = (self.options.install)(Rc::clone(&transport))?;
        *attempt.rpc.borrow_mut() = Some(Rc::clone(&rpc));
        let (bulk, active) = (Rc::downgrade(self), Rc::downgrade(&attempt));
        rpc.on_reconciled(Rc::new(move || {
            if let Some((bulk, attempt)) = bulk.upgrade().zip(active.upgrade())
                && bulk.link.role() == LinkRole::Worker
                && bulk.is_current(&attempt)
            {
                bulk.phase(&attempt, BulkPhase::Activating, None);
            }
        }));
        let (bulk, active) = (Rc::downgrade(self), Rc::downgrade(&attempt));
        let _unsubscribe = transport.on_failure(Rc::new(move |error| {
            if let Some((bulk, attempt)) = bulk.upgrade().zip(active.upgrade()) {
                bulk.fail(&attempt, error);
            }
        }));
        let weak = Rc::downgrade(self);
        spawn_local(async move {
            let ready = transport.ready().await;
            if let Some(bulk) = weak.upgrade() {
                if let Err(error) = ready {
                    bulk.fail(&attempt, error);
                } else {
                    bulk.reconcile(&attempt, &rpc).await;
                }
            }
        });
        Ok(())
    }

    async fn reconcile(self: &Rc<Self>, attempt: &Rc<Attempt>, rpc: &Rc<ExecutorRpc>) {
        if !self.is_current(attempt) {
            return;
        }
        if attempt.phase.get() == BulkPhase::Connecting {
            self.phase(
                attempt,
                BulkPhase::Reconciling,
                Some(DEFAULT_RPC_TIMEOUT_MS),
            );
        }
        if self.link.role() != LinkRole::Controller {
            return;
        }
        if let Err(error) = rpc.reconcile_parked().await {
            self.fail(attempt, error);
        } else if self.is_current(attempt) {
            rpc.activate_incoming();
            self.phase(attempt, BulkPhase::Activating, None);
            self.send(BulkControlType::Activate, &attempt.id, None);
        }
    }

    fn activate(self: &Rc<Self>, attempt: &Rc<Attempt>) {
        let rpc = attempt
            .rpc
            .borrow()
            .clone()
            .filter(|rpc| rpc.transport.connected());
        let Some(rpc) = rpc.filter(|_| self.is_current(attempt)) else {
            return;
        };
        rpc.activate();
        attempt.ready_at.set(Some(Instant::now()));
        self.state.borrow_mut().error = None;
        self.phase(attempt, BulkPhase::Ready, None);
        let waiters = std::mem::take(&mut self.state.borrow_mut().waiters);
        for waiter in waiters.into_values() {
            let _ = waiter.send(Ok(Rc::clone(&rpc)));
        }
    }

    fn is_current(&self, attempt: &Rc<Attempt>) -> bool {
        self.live()
            && self
                .state
                .borrow()
                .attempt
                .as_ref()
                .is_some_and(|current| Rc::ptr_eq(current, attempt))
    }

    fn setup_timeout_ms(&self) -> u64 {
        self.options
            .timing
            .setup_timeout_ms
            .unwrap_or(BULK_SETUP_TIMEOUT_MS)
    }

    fn phase(self: &Rc<Self>, attempt: &Rc<Attempt>, phase: BulkPhase, timeout_ms: Option<u64>) {
        if let Some(timer) = attempt.timer.borrow_mut().take() {
            timer.abort();
        }
        attempt.phase.set(phase);
        if phase != BulkPhase::Ready {
            let (bulk, active) = (Rc::downgrade(self), Rc::downgrade(attempt));
            let deadline = Instant::now()
                + Duration::from_millis(timeout_ms.unwrap_or_else(|| self.setup_timeout_ms()));
            *attempt.timer.borrow_mut() = Some(spawn_local(async move {
                sleep_until(deadline).await;
                if let Some((bulk, attempt)) = bulk.upgrade().zip(active.upgrade()) {
                    bulk.fail(
                        &attempt,
                        error(format!("Bulk {} timed out", phase.as_str())),
                    );
                }
            }));
        }
        self.publish(phase);
    }

    fn fail_current(self: &Rc<Self>, error: SessionError) {
        let attempt = self.state.borrow().attempt.clone();
        if let Some(attempt) = attempt {
            self.fail(&attempt, error);
        }
    }

    fn fail(self: &Rc<Self>, attempt: &Rc<Attempt>, failure: SessionError) {
        if !self.is_current(attempt) {
            return;
        }
        let retries = {
            let mut state = self.state.borrow_mut();
            if attempt.ready_at.get().is_some_and(|at| {
                at.elapsed()
                    >= Duration::from_millis(
                        self.options.timing.stable_session_ms.unwrap_or(10_000),
                    )
            }) {
                state.retries = 0;
            }
            state.error = Some(Rc::clone(&failure));
            state.retries
        };
        if let Some(failed) = &self.options.failed {
            let queues = attempt
                .rpc
                .borrow()
                .as_ref()
                .and_then(|rpc| rpc.transport.channel.queue_snapshot())
                .or_else(|| self.primary.transport.channel.queue_snapshot());
            failed(BulkAttemptFailure {
                lane: RpcLane::Bulk,
                primary_session_id: self.primary.transport.id.clone(),
                session_id: attempt.id.clone(),
                phase: attempt.phase.get(),
                reason: failure_reason(Failure::Error(failure.as_ref())),
                retries,
                setup_timeout_ms: self.setup_timeout_ms(),
                queues,
            });
        }
        self.clear_attempt();
        self.publish(BulkPhase::Reconnecting);
        if self.link.role() == LinkRole::Worker {
            self.send(BulkControlType::Lost, &attempt.id, None);
            self.state.borrow_mut().retries += 1;
        } else {
            self.schedule_retry();
        }
    }

    fn schedule_retry(self: &Rc<Self>) {
        let delays = self
            .options
            .timing
            .redial_delays_ms
            .as_deref()
            .filter(|delays| !delays.is_empty())
            .unwrap_or(REDIAL_DELAYS_MS);
        let mut state = self.state.borrow_mut();
        let delay = delays[state.retries.min(delays.len() - 1)];
        state.retries += 1;
        let weak = Rc::downgrade(self);
        let deadline = Instant::now() + Duration::from_millis(delay);
        state.retry = Some(spawn_local(async move {
            sleep_until(deadline).await;
            if let Some(bulk) = weak.upgrade() {
                bulk.state.borrow_mut().retry = None;
                if let Err(error) = bulk.prepare() {
                    bulk.fail_current(error);
                }
            }
        }));
    }

    fn clear_attempt(&self) {
        let attempt = {
            let mut state = self.state.borrow_mut();
            state.outbox.clear();
            state.attempt.take()
        };
        if let Some(attempt) = attempt
            && let Some(timer) = attempt.timer.borrow_mut().take()
        {
            timer.abort();
        }
        if self.parent_is_current() {
            self.link.fence_bulk();
        }
    }

    fn send(self: &Rc<Self>, kind: BulkControlType, id: &str, sent: Option<Rc<dyn Fn()>>) {
        if !self.live() {
            return;
        }
        {
            let mut state = self.state.borrow_mut();
            if state.outbox.iter().any(|pending| {
                pending.frame.control_type() == Some(kind) && pending.frame.session_id == id
            }) {
                return;
            }
            if state.outbox.len() >= 4 {
                drop(state);
                self.fail_current(error("Bulk control outbox exhausted"));
                return;
            }
            state.outbox.push_back(PendingControl {
                frame: BulkConnectionControl::new(kind, id.to_owned()),
                sent,
            });
        }
        self.flush();
    }

    fn flush(self: &Rc<Self>) {
        if !self.live() || self.state.borrow().flushing {
            return;
        }
        self.state.borrow_mut().flushing = true;
        loop {
            let next = self.state.borrow().outbox.front().cloned();
            let Some(pending) = next else {
                break;
            };
            if !self
                .primary
                .transport
                .channel
                .offer_bulk_control(&pending.frame)
            {
                break;
            }
            self.state.borrow_mut().outbox.pop_front();
            if let Some(sent) = pending.sent {
                sent();
            }
        }
        self.state.borrow_mut().flushing = false;
    }

    fn publish(&self, phase: BulkPhase) {
        let status = {
            let state = self.state.borrow();
            BulkConnectionStatus {
                phase,
                session_id: state.attempt.as_ref().map(|attempt| attempt.id.clone()),
                error: state.error.clone(),
                retries: state.retries,
            }
        };
        (self.options.changed)(status);
    }
}

struct Waiter<'a> {
    state: &'a RefCell<State>,
    id: u64,
}

impl Drop for Waiter<'_> {
    fn drop(&mut self) {
        self.state.borrow_mut().waiters.shift_remove(&self.id);
    }
}

fn unavailable(message: &'static str) -> SessionError {
    Rc::new(AgentCallError::new(
        AgentDeliveryOutcome::NotDispatched,
        message,
    ))
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct BulkError(String);

fn error(message: impl Into<String>) -> SessionError {
    Rc::new(BulkError(message.into()))
}
