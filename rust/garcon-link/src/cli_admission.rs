//! Ports `server/remote/transport/cli-admission.ts`.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use garcon_base::domain_error::DomainError;
use garcon_contract::error_codes::ErrorCode;

use crate::cli_protocol::CliPool;
use crate::rpc_lane::RpcLane;

#[derive(Clone, Copy, Default)]
struct Counts {
    short: usize,
    long: usize,
    bulk_short: usize,
}

impl Counts {
    fn pool(&mut self, pool: CliPool) -> &mut usize {
        match pool {
            CliPool::Short => &mut self.short,
            CliPool::Long => &mut self.long,
        }
    }
}

#[derive(Default)]
struct State {
    executors: HashMap<String, Counts>,
    total: Counts,
}

#[derive(Default)]
pub struct CliAdmission {
    state: Rc<RefCell<State>>,
}

impl CliAdmission {
    pub fn acquire(
        &self,
        executor_id: &str,
        pool: CliPool,
        lane: RpcLane,
    ) -> Result<CliAdmissionLease, DomainError> {
        let mut state = self.state.borrow_mut();
        let mut counts = state
            .executors
            .get(executor_id)
            .copied()
            .unwrap_or_default();
        let bulk_short = pool == CliPool::Short && lane == RpcLane::Bulk;
        let (executor_limit, global_limit) = match pool {
            CliPool::Short => (6, 32),
            CliPool::Long => (2, 8),
        };
        if *counts.pool(pool) >= executor_limit
            || *state.total.pool(pool) >= global_limit
            || bulk_short && (counts.bulk_short >= 4 || state.total.bulk_short >= 24)
        {
            return Err(DomainError::new(
                ErrorCode::CLI_SERVICE_BUSY,
                "CLI service is busy; try again after current requests finish",
                503,
                true,
            ));
        }
        *counts.pool(pool) += 1;
        *state.total.pool(pool) += 1;
        if bulk_short {
            counts.bulk_short += 1;
            state.total.bulk_short += 1;
        }
        state.executors.insert(executor_id.to_owned(), counts);
        Ok(CliAdmissionLease {
            state: Rc::clone(&self.state),
            executor_id: executor_id.to_owned(),
            pool,
            bulk_short,
            released: Cell::new(false),
        })
    }
}

pub struct CliAdmissionLease {
    state: Rc<RefCell<State>>,
    executor_id: String,
    pool: CliPool,
    bulk_short: bool,
    released: Cell<bool>,
}

impl CliAdmissionLease {
    pub fn release(&self) {
        if self.released.replace(true) {
            return;
        }
        let mut state = self.state.borrow_mut();
        let State { executors, total } = &mut *state;
        // INFALLIBLE: counts are retained until the last acquired lease releases.
        let counts = executors
            .get_mut(&self.executor_id)
            .expect("the executor still has a lease");
        *counts.pool(self.pool) -= 1;
        *total.pool(self.pool) -= 1;
        if self.bulk_short {
            counts.bulk_short -= 1;
            total.bulk_short -= 1;
        }
        if counts.short == 0 && counts.long == 0 {
            executors.remove(&self.executor_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bulk_short_work_preserves_primary_capacity_and_long_has_its_own_pool() {
        let admission = CliAdmission::default();
        let bulk: Vec<_> = (0..4)
            .map(|_| {
                admission
                    .acquire("synthetic", CliPool::Short, RpcLane::Bulk)
                    .unwrap()
            })
            .collect();
        let Err(error) = admission.acquire("synthetic", CliPool::Short, RpcLane::Bulk) else {
            panic!("accepted an extra bulk short call");
        };
        assert_eq!(
            (error.code, error.status, error.retryable),
            (ErrorCode::CLI_SERVICE_BUSY, 503, true)
        );
        let primary: Vec<_> = (0..2)
            .map(|_| {
                admission
                    .acquire("synthetic", CliPool::Short, RpcLane::Primary)
                    .unwrap()
            })
            .collect();
        assert!(
            admission
                .acquire("synthetic", CliPool::Short, RpcLane::Primary)
                .is_err()
        );
        let long: Vec<_> = (0..2)
            .map(|_| {
                admission
                    .acquire("synthetic", CliPool::Long, RpcLane::Bulk)
                    .unwrap()
            })
            .collect();
        assert!(
            admission
                .acquire("synthetic", CliPool::Long, RpcLane::Bulk)
                .is_err()
        );
        bulk[0].release();
        bulk[0].release();
        let replacement = admission
            .acquire("synthetic", CliPool::Short, RpcLane::Bulk)
            .unwrap();
        assert!(
            admission
                .acquire("synthetic", CliPool::Short, RpcLane::Bulk)
                .is_err()
        );
        for lease in bulk
            .into_iter()
            .chain(primary)
            .chain(long)
            .chain([replacement])
        {
            lease.release();
        }
        assert!(admission.state.borrow().executors.is_empty());
    }
}
