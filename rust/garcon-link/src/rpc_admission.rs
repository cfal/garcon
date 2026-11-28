//! Ports `server/remote/transport/rpc-admission.ts`.

use std::cell::Cell;
use std::rc::Rc;

use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome, AgentIntegrationErrorCode};
use serde::Serialize;

use crate::limits::{BULK_RPC_CALL_LIMIT, RPC_CALL_LIMIT};
use crate::rpc_lane::RpcLane;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct RpcAdmissionSnapshot {
    pub total: usize,
    pub primary: usize,
    pub bulk: usize,
}

#[derive(Clone)]
pub struct RpcAdmission {
    counts: Rc<Cell<RpcAdmissionSnapshot>>,
    total_limit: usize,
    bulk_limit: usize,
}

impl Default for RpcAdmission {
    fn default() -> Self {
        Self::new(RPC_CALL_LIMIT, BULK_RPC_CALL_LIMIT)
    }
}

impl RpcAdmission {
    pub fn new(total_limit: usize, bulk_limit: usize) -> Self {
        Self {
            counts: Rc::default(),
            total_limit,
            bulk_limit,
        }
    }

    pub fn size(&self) -> usize {
        self.snapshot().total
    }

    pub fn snapshot(&self) -> RpcAdmissionSnapshot {
        self.counts.get()
    }

    pub fn acquire(&self, lane: RpcLane) -> Result<RpcAdmissionLease, Box<AgentCallError>> {
        let mut counts = self.snapshot();
        if counts.total >= self.total_limit
            || lane == RpcLane::Bulk && counts.bulk >= self.bulk_limit
        {
            return Err(Box::new(AgentCallError::with_code(
                AgentDeliveryOutcome::NotDispatched,
                "The executor is handling too many requests. Try again shortly.",
                AgentIntegrationErrorCode::EXECUTOR_BUSY,
            )));
        }
        counts.total += 1;
        match lane {
            RpcLane::Primary => counts.primary += 1,
            RpcLane::Bulk => counts.bulk += 1,
        }
        self.counts.set(counts);
        Ok(RpcAdmissionLease {
            counts: Rc::clone(&self.counts),
            lane: Cell::new(Some(lane)),
        })
    }
}

pub struct RpcAdmissionLease {
    counts: Rc<Cell<RpcAdmissionSnapshot>>,
    lane: Cell<Option<RpcLane>>,
}

impl RpcAdmissionLease {
    pub fn release(&self) {
        let Some(lane) = self.lane.take() else {
            return;
        };
        let mut counts = self.counts.get();
        counts.total -= 1;
        match lane {
            RpcLane::Primary => counts.primary -= 1,
            RpcLane::Bulk => counts.bulk -= 1,
        }
        self.counts.set(counts);
    }
}

#[derive(Default)]
pub struct RpcAdmissionBudgets {
    pub incoming: RpcAdmission,
    pub outgoing: RpcAdmission,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RpcAdmissionBudgetsSnapshot {
    pub incoming: RpcAdmissionSnapshot,
    pub outgoing: RpcAdmissionSnapshot,
}

impl RpcAdmissionBudgets {
    pub fn snapshot(&self) -> RpcAdmissionBudgetsSnapshot {
        RpcAdmissionBudgetsSnapshot {
            incoming: self.incoming.snapshot(),
            outgoing: self.outgoing.snapshot(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_admission_reserves_primary_capacity_and_releases_exactly_once() {
        let admission = RpcAdmission::new(4, 3);
        let bulk: Vec<_> = (0..3)
            .map(|_| admission.acquire(RpcLane::Bulk).unwrap())
            .collect();
        let Err(error) = admission.acquire(RpcLane::Bulk) else {
            panic!("admitted an extra bulk request");
        };
        assert_eq!(error.code, AgentIntegrationErrorCode::EXECUTOR_BUSY);
        assert_eq!(error.outcome, AgentDeliveryOutcome::NotDispatched);
        let primary = admission.acquire(RpcLane::Primary).unwrap();
        assert_eq!(
            admission.snapshot(),
            RpcAdmissionSnapshot {
                total: 4,
                primary: 1,
                bulk: 3
            }
        );
        assert!(admission.acquire(RpcLane::Primary).is_err());
        bulk[0].release();
        bulk[0].release();
        assert_eq!(admission.size(), 3);
        primary.release();
        for lease in bulk {
            lease.release();
        }
        assert_eq!(admission.snapshot(), RpcAdmissionSnapshot::default());
    }
}
