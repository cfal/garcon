//! Holds calls while the original executor reconnects. Transport replay and
//! journal reconciliation belong to garcon-link, not this layer.

use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::{Future, pending},
    rc::Rc,
    time::Duration,
};

use garcon_base::executor_disconnect::{ExecutorSessionLostError, reconnect_timed_out};
use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome},
    execution_runtime::{ExecutorAvailability, ExecutorInfo},
    resources::{AgentResourceScope, ExecutorCallOptions, ExecutorResult},
};
use garcon_js::{json::Opaque, performance_now_ms};
use garcon_link::{
    limits::BULK_ACQUIRE_TIMEOUT_MS,
    rpc::{DEFAULT_RPC_TIMEOUT_MS, ExecutorRpc, RpcCallOptions, RpcTimeout},
    rpc_admission::{RpcAdmissionBudgets, RpcAdmissionLease},
    rpc_lane::RpcLane,
    rpc_routing::rpc_lane,
};
use tokio::{
    sync::oneshot,
    time::{Instant, sleep},
};
use tokio_util::sync::CancellationToken;

use super::wire::own_rpc_error;

const HELD_CALL_BUDGET_MS: f64 = 1_000.0;

pub(super) struct RemoteSessionBacking {
    pub rpc: Rc<ExecutorRpc>,
    pub info: Rc<ExecutorInfo>,
}

impl RemoteSessionBacking {
    pub fn scope(&self, integration_id: &str) -> AgentResourceScope {
        AgentResourceScope {
            executor_id: self.info.executor_id.clone(),
            instance_id: self.info.instance_id.clone(),
            integration_id: integration_id.to_owned(),
        }
    }
}

#[derive(Clone)]
pub(super) struct HeldCallOptions {
    pub signal: Option<CancellationToken>,
    /// None means there is no RPC timeout, not the default timeout.
    pub timeout_ms: Option<f64>,
    pub dispatch_deadline: Option<f64>,
    pub instance_id: Option<String>,
}

impl Default for HeldCallOptions {
    fn default() -> Self {
        Self {
            signal: None,
            timeout_ms: Some(DEFAULT_RPC_TIMEOUT_MS as f64),
            dispatch_deadline: None,
            instance_id: None,
        }
    }
}

impl From<Option<ExecutorCallOptions>> for HeldCallOptions {
    fn from(options: Option<ExecutorCallOptions>) -> Self {
        let options = options.unwrap_or_default();
        Self {
            signal: options.signal,
            timeout_ms: options.timeout_ms.or(Some(DEFAULT_RPC_TIMEOUT_MS as f64)),
            dispatch_deadline: options.dispatch_deadline,
            instance_id: None,
        }
    }
}

pub(super) struct HeldSession {
    pub backing: Rc<RemoteSessionBacking>,
    pub timeout_ms: Option<f64>,
}

impl HeldSession {
    pub fn rpc_options(&self, options: &HeldCallOptions) -> RpcCallOptions {
        RpcCallOptions {
            signal: options.signal.clone(),
            timeout: self.timeout_ms.map_or(RpcTimeout::None, |ms| {
                let value = if ms.fract() == 0.0 && (1.0..=f64::from(i32::MAX)).contains(&ms) {
                    ms as u64
                } else {
                    // The RPC layer rejects this as an invalid deadline.
                    0
                };
                RpcTimeout::Milliseconds(value)
            }),
            dispatch_deadline: options.dispatch_deadline.and_then(as_instant),
            ..Default::default()
        }
    }
}

type SessionResult = ExecutorResult<Rc<RemoteSessionBacking>>;

struct Waiter {
    lane: RpcLane,
    ready: oneshot::Sender<SessionResult>,
}

pub(super) struct RemoteSessions {
    availability: Cell<ExecutorAvailability>,
    latest: RefCell<Option<Rc<RemoteSessionBacking>>>,
    primary: RefCell<Option<Rc<RemoteSessionBacking>>>,
    bulk: RefCell<Option<Rc<RemoteSessionBacking>>>,
    waiters: RefCell<BTreeMap<u64, Waiter>>,
    next_waiter: Cell<u64>,
    pub admission: Rc<RpcAdmissionBudgets>,
}

impl Default for RemoteSessions {
    fn default() -> Self {
        Self {
            availability: Cell::new(ExecutorAvailability::Offline),
            latest: RefCell::default(),
            primary: RefCell::default(),
            bulk: RefCell::default(),
            waiters: RefCell::default(),
            next_waiter: Cell::default(),
            admission: Rc::default(),
        }
    }
}

impl RemoteSessions {
    pub fn availability(&self) -> ExecutorAvailability {
        self.availability.get()
    }

    pub fn set_availability(&self, availability: ExecutorAvailability) -> bool {
        if self.availability.replace(availability) == availability {
            return false;
        }
        if !self.holds_calls() {
            for (_, waiter) in self.waiters.take() {
                let _ = waiter.ready.send(Err(self.unavailable().into()));
            }
        }
        true
    }

    pub fn set_backing(&self, lane: RpcLane, backing: Option<Rc<RemoteSessionBacking>>) {
        self.current(lane).replace(backing.clone());
        if let Some(backing) = backing {
            if lane == RpcLane::Primary {
                self.latest.replace(Some(backing.clone()));
            }
            self.waiters
                .borrow_mut()
                .extract_if(.., |_, waiter| waiter.lane == lane)
                .for_each(|(_, waiter)| {
                    let _ = waiter.ready.send(Ok(backing.clone()));
                });
        }
    }

    pub fn current(&self, lane: RpcLane) -> &RefCell<Option<Rc<RemoteSessionBacking>>> {
        match lane {
            RpcLane::Primary => &self.primary,
            RpcLane::Bulk => &self.bulk,
        }
    }

    pub fn latest(&self) -> ExecutorResult<Rc<RemoteSessionBacking>> {
        self.latest
            .borrow()
            .as_ref()
            .filter(|_| self.holds_calls())
            .cloned()
            .ok_or_else(|| self.unavailable().into())
    }

    pub fn scope(&self, integration_id: &str) -> ExecutorResult<AgentResourceScope> {
        Ok(self.latest()?.scope(integration_id))
    }

    pub async fn acquire(
        &self,
        lane: RpcLane,
        options: &HeldCallOptions,
    ) -> ExecutorResult<HeldSession> {
        let session = self.hold_session(lane, options).await?;
        if options
            .instance_id
            .as_ref()
            .is_some_and(|id| id != &session.backing.info.instance_id)
        {
            return Err(
                not_dispatched("The executor restarted before the request was sent.").into(),
            );
        }
        Ok(session)
    }

    pub async fn send<T, F: Future<Output = ExecutorResult<T>>>(
        &self,
        lane: RpcLane,
        mut options: HeldCallOptions,
        mut send: impl FnMut(HeldSession) -> F,
    ) -> ExecutorResult<T> {
        let started = performance_now_ms();
        let timeout_ms = options.timeout_ms;
        if lane == RpcLane::Bulk {
            let cap = started + BULK_ACQUIRE_TIMEOUT_MS as f64;
            options.dispatch_deadline = Some(
                options
                    .dispatch_deadline
                    .map_or(cap, |deadline| deadline.min(cap)),
            );
        }
        let mut previous = None;
        loop {
            let session = self.acquire(lane, &options).await?;
            let backing = session.backing.clone();
            let error = match send(session).await {
                Ok(value) => return Ok(value),
                Err(error) => error,
            };
            let remaining = timeout_ms.map(|ms| (ms - (performance_now_ms() - started)).ceil());
            if !error
                .downcast_ref::<ExecutorSessionLostError>()
                .is_some_and(|error| error.outcome == AgentDeliveryOutcome::NotDispatched)
                || previous
                    .as_ref()
                    .is_some_and(|previous| Rc::ptr_eq(previous, &backing))
                || remaining.is_some_and(|ms| ms < 1.0)
            {
                return Err(error);
            }
            options.timeout_ms = remaining;
            options.instance_id = Some(backing.info.instance_id.clone());
            previous = Some(backing);
        }
    }

    pub async fn call(
        &self,
        integration_id: &str,
        method: &str,
        request: Opaque,
        options: HeldCallOptions,
    ) -> ExecutorResult<Option<Opaque>> {
        let lane = rpc_lane(method, &request, RpcLane::Primary)?;
        self.send(lane, options.clone(), |session| {
            let rpc_options = session.rpc_options(&options);
            let reply =
                session
                    .backing
                    .rpc
                    .call(integration_id, method, request.clone(), rpc_options);
            async { reply.await.map_err(own_rpc_error) }
        })
        .await
    }

    fn holds_calls(&self) -> bool {
        matches!(
            self.availability(),
            ExecutorAvailability::Ready | ExecutorAvailability::Reconnecting
        )
    }

    fn unavailable(&self) -> AgentCallError {
        let status = match self.availability() {
            ExecutorAvailability::Ready => "ready",
            ExecutorAvailability::Reconnecting => "reconnecting",
            ExecutorAvailability::Offline => "offline",
            ExecutorAvailability::Disposed => "disposed",
        };
        not_dispatched(format!("Executor is {status}"))
    }

    async fn hold_session(
        &self,
        lane: RpcLane,
        options: &HeldCallOptions,
    ) -> ExecutorResult<HeldSession> {
        if options
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(held_call_cancelled().into());
        }
        let existing = self
            .current(lane)
            .borrow()
            .as_ref()
            .filter(|session| session.rpc.active())
            .cloned();
        if let Some(backing) = existing {
            return Ok(HeldSession {
                backing,
                timeout_ms: options.timeout_ms,
            });
        }
        self.latest()?;
        let started = performance_now_ms();
        let dispatch_wait_ms = options
            .dispatch_deadline
            .map_or(f64::INFINITY, |deadline| deadline - started);
        if dispatch_wait_ms <= 0.0 {
            return Err(reconnect_timed_out().into());
        }
        let reserved = options
            .timeout_ms
            .map_or(0.0, |ms| HELD_CALL_BUDGET_MS.min((ms / 2.0).floor()));
        let wait_ms = options
            .timeout_ms
            .map_or(f64::INFINITY, |ms| ms - reserved)
            .min(dispatch_wait_ms)
            .min(match lane {
                RpcLane::Primary => f64::INFINITY,
                RpcLane::Bulk => BULK_ACQUIRE_TIMEOUT_MS as f64,
            });
        let admission = self
            .admission
            .outgoing
            .acquire(lane)
            .map_err(|error| *error)?;
        let backing = self
            .next_session(lane, options.signal.as_ref(), wait_ms, admission)
            .await?;
        let timeout_ms = options
            .timeout_ms
            .map(|ms| reserved.max((ms - (performance_now_ms() - started)).ceil()));
        Ok(HeldSession {
            backing,
            timeout_ms,
        })
    }

    async fn next_session(
        &self,
        lane: RpcLane,
        signal: Option<&CancellationToken>,
        wait_ms: f64,
        admission: RpcAdmissionLease,
    ) -> SessionResult {
        let id = self.next_waiter.get();
        self.next_waiter.set(id.wrapping_add(1));
        let (ready, received) = oneshot::channel();
        self.waiters.borrow_mut().insert(id, Waiter { lane, ready });
        let _pending = PendingWait {
            waiters: &self.waiters,
            id,
            admission,
        };
        tokio::select! {
            biased;
            result = received => result.unwrap_or_else(|_| Err(self.unavailable().into())),
            () = async {
                if let Some(signal) = signal { signal.cancelled().await; } else { pending::<()>().await; }
            } => Err(held_call_cancelled().into()),
            () = async {
                if wait_ms.is_finite() { sleep(timer_delay(wait_ms)).await; } else { pending::<()>().await; }
            } => Err(reconnect_timed_out().into()),
        }
    }
}

struct PendingWait<'a> {
    waiters: &'a RefCell<BTreeMap<u64, Waiter>>,
    id: u64,
    admission: RpcAdmissionLease,
}

impl Drop for PendingWait<'_> {
    fn drop(&mut self) {
        self.waiters.borrow_mut().remove(&self.id);
        self.admission.release();
    }
}

fn held_call_cancelled() -> AgentCallError {
    not_dispatched("The request was cancelled while the executor reconnected.")
}

pub(super) fn not_dispatched(message: impl Into<String>) -> AgentCallError {
    AgentCallError::new(AgentDeliveryOutcome::NotDispatched, message)
}

fn as_instant(deadline: f64) -> Option<Instant> {
    let delay =
        Duration::try_from_secs_f64(((deadline - performance_now_ms()) / 1_000.0).max(0.0)).ok()?;
    Instant::now().checked_add(delay)
}

fn timer_delay(ms: f64) -> Duration {
    let ms = if (1.0..=f64::from(i32::MAX)).contains(&ms) {
        ms as u64
    } else {
        1
    };
    Duration::from_millis(ms)
}
