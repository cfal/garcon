//! Ports `server/remote/transport/socket-admission.ts`.

use std::cell::Cell;
use std::rc::Rc;

use crate::rpc_lane::RpcLane;

pub const EXECUTOR_SOCKET_LIMIT: usize = 192;
pub const EXECUTOR_PENDING_SOCKET_LIMIT: usize = 64;

#[derive(Clone, Copy, Default)]
struct Counts {
    pending: usize,
    primary: usize,
    bulk: usize,
}

impl Counts {
    fn active(&mut self, lane: RpcLane) -> &mut usize {
        match lane {
            RpcLane::Primary => &mut self.primary,
            RpcLane::Bulk => &mut self.bulk,
        }
    }
}

pub struct ExecutorSocketAdmission {
    counts: Rc<Cell<Counts>>,
    role_limit: usize,
    pending_limit: usize,
}

impl Default for ExecutorSocketAdmission {
    fn default() -> Self {
        Self::new(64, EXECUTOR_PENDING_SOCKET_LIMIT)
    }
}

impl ExecutorSocketAdmission {
    pub fn new(role_limit: usize, pending_limit: usize) -> Self {
        Self {
            counts: Rc::default(),
            role_limit,
            pending_limit,
        }
    }

    pub fn acquire(&self) -> Option<SocketAdmissionLease> {
        let mut counts = self.counts.get();
        if counts.pending >= self.pending_limit {
            return None;
        }
        counts.pending += 1;
        self.counts.set(counts);
        Some(SocketAdmissionLease {
            counts: Rc::clone(&self.counts),
            role_limit: self.role_limit,
            state: Cell::new(LeaseState::Pending),
        })
    }
}

#[derive(Clone, Copy)]
enum LeaseState {
    Pending,
    Active(RpcLane),
    Released,
}

pub struct SocketAdmissionLease {
    counts: Rc<Cell<Counts>>,
    role_limit: usize,
    state: Cell<LeaseState>,
}

impl SocketAdmissionLease {
    pub fn promote(&self, lane: RpcLane) -> bool {
        let mut counts = self.counts.get();
        if !matches!(self.state.get(), LeaseState::Pending)
            || *counts.active(lane) >= self.role_limit
        {
            return false;
        }
        counts.pending -= 1;
        *counts.active(lane) += 1;
        self.counts.set(counts);
        self.state.set(LeaseState::Active(lane));
        true
    }

    pub fn release(&self) {
        let mut counts = self.counts.get();
        match self.state.replace(LeaseState::Released) {
            LeaseState::Pending => counts.pending -= 1,
            LeaseState::Active(lane) => *counts.active(lane) -= 1,
            LeaseState::Released => return,
        }
        self.counts.set(counts);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_and_each_active_lane_have_independent_capacity() {
        let admission = ExecutorSocketAdmission::new(1, 1);
        let primary = admission.acquire().unwrap();
        assert!(admission.acquire().is_none());
        assert!(primary.promote(RpcLane::Primary));
        assert!(!primary.promote(RpcLane::Bulk));
        let bulk = admission.acquire().unwrap();
        assert!(!bulk.promote(RpcLane::Primary));
        assert!(admission.acquire().is_none());
        assert!(bulk.promote(RpcLane::Bulk));
        let pending = admission.acquire().unwrap();
        assert!(!pending.promote(RpcLane::Bulk));
        primary.release();
        primary.release();
        assert!(!primary.promote(RpcLane::Primary));
        assert!(pending.promote(RpcLane::Primary));
        pending.release();
        bulk.release();
    }
}
