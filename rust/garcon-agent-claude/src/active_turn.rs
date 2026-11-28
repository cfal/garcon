use std::cell::{Cell, RefCell};

use garcon_agents_common::execution::runtime_events::AgentRuntimeOperation;
use tokio::{task::AbortHandle, time::Instant};
use tokio_util::sync::CancellationToken;

use crate::{
    cli_protocol::ClaudeTurnState, compaction::CompactionInfo, steering::ClaudeTurnSteeringState,
};

pub struct ClaudeActiveTurn {
    pub protocol: RefCell<ClaudeTurnState>,
    pub steering: ClaudeTurnSteeringState,
    pub started_at: Instant,
    pub operation: AgentRuntimeOperation,
    pub abort_timer: Cell<Option<AbortHandle>>,
    pub pending_compaction: Cell<Option<CompactionInfo>>,
    completion: CancellationToken,
    pre_start_abort_confirmation: CancellationToken,
    interrupt_request_failed: Cell<bool>,
}

impl ClaudeActiveTurn {
    pub fn new(background_task_count: usize, operation: AgentRuntimeOperation) -> Self {
        Self {
            protocol: RefCell::new(ClaudeTurnState::new(
                uuid::Uuid::new_v4().to_string(),
                background_task_count,
            )),
            steering: ClaudeTurnSteeringState::default(),
            started_at: Instant::now(),
            operation,
            abort_timer: Cell::new(None),
            pending_compaction: Cell::new(None),
            completion: CancellationToken::new(),
            pre_start_abort_confirmation: CancellationToken::new(),
            interrupt_request_failed: Cell::new(false),
        }
    }

    pub async fn completion(&self) {
        self.completion.cancelled().await;
    }

    pub async fn pre_start_abort_confirmation(&self) {
        self.pre_start_abort_confirmation.cancelled().await;
    }

    pub fn finish(&self) {
        self.steering.clear();
        self.completion.cancel();
    }

    pub fn confirm_pre_start_abort(&self) {
        self.pre_start_abort_confirmation.cancel();
    }

    pub fn mark_interrupt_request_failed(&self) {
        if self.protocol.borrow().abort_requested() {
            self.interrupt_request_failed.set(true);
        }
    }

    pub fn interrupt_request_failed(&self) -> bool {
        self.interrupt_request_failed.get()
    }

    pub fn clear_abort_timer(&self) {
        if let Some(timer) = self.abort_timer.take() {
            timer.abort();
        }
    }
}

impl Drop for ClaudeActiveTurn {
    fn drop(&mut self) {
        self.clear_abort_timer();
    }
}

#[cfg(test)]
mod tests {
    use std::rc::Rc;

    use futures::FutureExt;
    use garcon_agents_common::execution::runtime_events::runtime_operation;

    use super::*;

    #[tokio::test]
    async fn pre_start_abort_confirmation_does_not_settle_the_turn() {
        let turn = ClaudeActiveTurn::new(2, runtime_operation("run-1".into(), Rc::new(|_| {})));
        let reservation = turn.steering.reserve_delivery();
        assert!(turn.protocol.borrow().background_continuation_pending());
        assert!(turn.completion().now_or_never().is_none());
        assert!(turn.pre_start_abort_confirmation().now_or_never().is_none());
        turn.mark_interrupt_request_failed();
        assert!(!turn.interrupt_request_failed());
        turn.protocol.borrow_mut().mark_abort_requested();
        turn.mark_interrupt_request_failed();
        assert!(turn.interrupt_request_failed());
        turn.confirm_pre_start_abort();
        assert!(turn.pre_start_abort_confirmation().now_or_never().is_some());
        assert!(turn.completion().now_or_never().is_none());
        turn.finish();
        assert!(!turn.steering.blocks_idle_settlement());
        assert!(turn.completion().now_or_never().is_some());
        drop(reservation);
    }
}
