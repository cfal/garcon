//! Ports `server-agents/common/src/shared/idle-session-purger.ts`.

use std::cell::RefCell;
use std::time::Duration;

use tokio::task::{JoinHandle, spawn_local};
use tokio::time::{Instant, MissedTickBehavior, interval_at};

pub const DEFAULT_IDLE_SESSION_MAX_AGE_MS: i64 = 30 * 60 * 1_000;
pub const DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS: u64 = 5 * 60 * 1_000;

pub fn purge_idle_sessions<K, T>(
    sessions: impl IntoIterator<Item = (K, T)>,
    is_running: impl Fn(&T) -> bool,
    last_activity_at: impl Fn(&T) -> i64,
    mut purge: impl FnMut(K, T),
    now: i64,
    max_idle_ms: i64,
) -> usize {
    let mut purged = 0;
    for (id, session) in sessions {
        if !is_running(&session) && now.saturating_sub(last_activity_at(&session)) >= max_idle_ms {
            purge(id, session);
            purged += 1;
        }
    }
    purged
}

#[derive(Default)]
pub struct IdleSessionPurger {
    timer: RefCell<Option<JoinHandle<()>>>,
}

impl IdleSessionPurger {
    pub fn start(&self, interval_ms: u64, mut purge: impl FnMut() + 'static) {
        if self.timer.borrow().is_some() {
            return;
        }
        let period = Duration::from_millis(interval_ms.max(1));
        let mut timer = interval_at(Instant::now() + period, period);
        timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
        self.timer.replace(Some(spawn_local(async move {
            loop {
                timer.tick().await;
                purge();
            }
        })));
    }

    pub fn stop(&self) {
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }
}

impl Drop for IdleSessionPurger {
    fn drop(&mut self) {
        self.stop();
    }
}
