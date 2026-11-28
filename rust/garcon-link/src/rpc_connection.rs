//! Ports `server/remote/transport/rpc-connection.ts`.

use std::cell::RefCell;
use std::convert::Infallible;
use std::rc::Rc;

use garcon_base::event_loop_stalls::ActivityTracker;
use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome};
use serde::Serialize;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::bulk_connection::{
    BulkAttemptFailure, BulkConnection, BulkConnectionOptions, BulkConnectionStatus,
    BulkConnectionTiming, BulkPhase,
};
use crate::limits::BULK_ACQUIRE_TIMEOUT_MS;
use crate::message_session::SessionError;
use crate::rpc::{ExecutorRpc, ExecutorRpcContinuity, ParkedRpcCalls};
use crate::rpc_admission::{RpcAdmissionBudgets, RpcAdmissionBudgetsSnapshot, RpcAdmissionLease};
use crate::rpc_journal::RpcReplyJournal;
use crate::rpc_lane::RpcLane;
use crate::session_transport::{Listeners, SessionTransport};
use crate::websocket_link::WebSocketLink;

pub struct ParkedRpcLanes {
    pub primary: Rc<ParkedRpcCalls>,
    pub bulk: Rc<ParkedRpcCalls>,
}

type BulkFailed = Rc<dyn Fn(BulkFailureWithCalls)>;
type Endpoint = dyn Fn(Rc<ExecutorRpc>) -> Result<(), SessionError>;
type Changed = dyn Fn(&BulkConnectionStatus);

#[derive(Default)]
pub struct RpcConnectionOptions {
    pub admission: Rc<RpcAdmissionBudgets>,
    pub parked: Option<ParkedRpcLanes>,
    pub journal: Option<Rc<RpcReplyJournal>>,
    pub bulk_timing: BulkConnectionTiming,
    pub bulk_failed: Option<BulkFailed>,
    pub activity: Option<Rc<ActivityTracker>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BulkFailureWithCalls {
    #[serde(flatten)]
    pub failure: BulkAttemptFailure,
    pub calls: RpcAdmissionBudgetsSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcConnectionDiagnostics {
    pub bulk_phase: BulkPhase,
    pub bulk_retries: usize,
    pub calls: RpcAdmissionBudgetsSnapshot,
}

struct Events {
    endpoints: Rc<Listeners<Endpoint>>,
    changes: Rc<Listeners<Changed>>,
    latest_bulk: RefCell<Option<Rc<ExecutorRpc>>>,
    status: RefCell<BulkConnectionStatus>,
}

pub struct ExecutorRpcConnection {
    pub primary: Rc<ExecutorRpc>,
    pub bulk: Rc<BulkConnection>,
    events: Rc<Events>,
    admission: Rc<RpcAdmissionBudgets>,
}

impl ExecutorRpcConnection {
    pub fn new(
        link: Rc<WebSocketLink>,
        transport: Rc<SessionTransport>,
        options: RpcConnectionOptions,
    ) -> Result<Rc<Self>, SessionError> {
        let events = Rc::new(Events {
            endpoints: Listeners::new(),
            changes: Listeners::new(),
            latest_bulk: RefCell::default(),
            status: RefCell::default(),
        });
        let admission = Rc::clone(&options.admission);
        let options = Rc::new(options);
        let primary = ExecutorRpc::new(
            Rc::clone(&transport),
            continuity(&options, RpcLane::Primary),
        );
        let bulk = BulkConnection::new(
            link,
            Rc::clone(&primary),
            BulkConnectionOptions {
                timing: options.bulk_timing.clone(),
                failed: options.bulk_failed.as_ref().map(|failed| {
                    let failed = Rc::clone(failed);
                    let admission = Rc::clone(&admission);
                    Rc::new(move |failure| {
                        failed(BulkFailureWithCalls {
                            failure,
                            calls: admission.snapshot(),
                        })
                    }) as Rc<dyn Fn(BulkAttemptFailure)>
                }),
                install: Rc::new({
                    let events = Rc::clone(&events);
                    let options = Rc::clone(&options);
                    move |session| {
                        let rpc = ExecutorRpc::new(
                            Rc::clone(&session),
                            continuity(&options, RpcLane::Bulk),
                        );
                        *events.latest_bulk.borrow_mut() = Some(Rc::clone(&rpc));
                        let (events_weak, rpc_weak) = (Rc::downgrade(&events), Rc::downgrade(&rpc));
                        let _unsubscribe = session.on_failure(Rc::new(move |_| {
                            if let Some((events, rpc)) =
                                events_weak.upgrade().zip(rpc_weak.upgrade())
                            {
                                let mut latest = events.latest_bulk.borrow_mut();
                                if latest
                                    .as_ref()
                                    .is_some_and(|latest| Rc::ptr_eq(latest, &rpc))
                                {
                                    *latest = None;
                                }
                            }
                        }));
                        events
                            .endpoints
                            .notify(|listener| listener(Rc::clone(&rpc)))?;
                        Ok(rpc)
                    }
                }),
                changed: Rc::new({
                    let events = Rc::clone(&events);
                    move |status| {
                        *events.status.borrow_mut() = status.clone();
                        let _: Result<_, Infallible> = events.changes.notify(|listener| {
                            listener(&status);
                            Ok(())
                        });
                    }
                }),
            },
        )?;
        let weak = Rc::downgrade(&events);
        let _unsubscribe = transport.on_failure(Rc::new(move |_| {
            if let Some(events) = weak.upgrade() {
                events.endpoints.clear();
                events.changes.clear();
            }
        }));
        Ok(Rc::new(Self {
            primary,
            bulk,
            events,
            admission,
        }))
    }

    pub fn status(&self) -> BulkConnectionStatus {
        self.events.status.borrow().clone()
    }

    pub fn diagnostics(&self) -> RpcConnectionDiagnostics {
        let status = self.events.status.borrow();
        RpcConnectionDiagnostics {
            bulk_phase: status.phase,
            bulk_retries: status.retries,
            calls: self.admission.snapshot(),
        }
    }

    pub async fn acquire(
        &self,
        lane: RpcLane,
        signal: CancellationToken,
        timeout_ms: Option<u64>,
    ) -> Result<(Rc<ExecutorRpc>, Option<u64>), SessionError> {
        if signal.is_cancelled() || !self.primary.active() {
            return Err(Rc::new(AgentCallError::new(
                AgentDeliveryOutcome::NotDispatched,
                "The captured executor connection is unavailable",
            )));
        }
        let rpc = match lane {
            RpcLane::Primary => Some(Rc::clone(&self.primary)),
            RpcLane::Bulk => self.bulk.current(),
        };
        if let Some(rpc) = rpc.filter(|rpc| rpc.active()) {
            return Ok((rpc, timeout_ms));
        }
        let started = Instant::now();
        let reserve = timeout_ms.map_or(0, |timeout| 1000.min(timeout / 2));
        let wait_ms = timeout_ms.map_or(BULK_ACQUIRE_TIMEOUT_MS, |timeout| {
            BULK_ACQUIRE_TIMEOUT_MS.min(timeout - reserve)
        });
        let _admission = Admission(
            self.admission
                .outgoing
                .acquire(lane)
                .map_err(|error| Rc::new(*error) as SessionError)?,
        );
        let endpoint = self.bulk.wait(Some(signal), Some(wait_ms)).await?;
        let remaining = timeout_ms.map(|timeout| {
            timeout
                .saturating_sub(started.elapsed().as_millis() as u64)
                .max(reserve)
        });
        Ok((endpoint, remaining))
    }

    pub fn owns(&self, rpc: &Rc<ExecutorRpc>) -> bool {
        self.primary.transport.connected()
            && rpc.transport.connected()
            && (Rc::ptr_eq(&self.primary, rpc)
                || self
                    .events
                    .latest_bulk
                    .borrow()
                    .as_ref()
                    .is_some_and(|latest| Rc::ptr_eq(latest, rpc)))
    }

    pub fn on_endpoint(&self, listener: Rc<Endpoint>) -> Result<impl Fn() + use<>, SessionError> {
        let unsubscribe = self.events.endpoints.subscribe(Rc::clone(&listener));
        listener(Rc::clone(&self.primary))?;
        let bulk = self.events.latest_bulk.borrow().clone();
        if let Some(bulk) = bulk {
            listener(bulk)?;
        }
        Ok(unsubscribe)
    }

    pub fn on_bulk_changed(&self, listener: Rc<Changed>) -> impl Fn() + use<> {
        self.events.changes.subscribe(listener)
    }

    pub fn activate(&self) -> Result<(), SessionError> {
        self.primary.activate();
        self.bulk.start()
    }
}

fn continuity(options: &RpcConnectionOptions, lane: RpcLane) -> ExecutorRpcContinuity {
    ExecutorRpcContinuity {
        admission: Some(Rc::clone(&options.admission)),
        journal: options.journal.clone(),
        parked: options.parked.as_ref().map(|parked| match lane {
            RpcLane::Primary => Rc::clone(&parked.primary),
            RpcLane::Bulk => Rc::clone(&parked.bulk),
        }),
        recovering: lane == RpcLane::Bulk,
        activity: options.activity.clone(),
        new_id: None,
    }
}

struct Admission(RpcAdmissionLease);

impl Drop for Admission {
    fn drop(&mut self) {
        self.0.release();
    }
}
