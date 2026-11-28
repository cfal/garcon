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

#[cfg(test)]
mod tests {
    use std::{cell::Cell, rc::Rc};

    use tokio::{
        task::{LocalSet, yield_now},
        time::advance,
    };

    use super::*;

    #[test]
    fn skips_running_and_recent_sessions_and_purges_at_the_age_limit() {
        let sessions = [
            ("running", (true, 0)),
            ("recent", (false, 91)),
            ("boundary", (false, 90)),
            ("old", (false, 0)),
        ];
        let mut removed = Vec::new();
        let count = purge_idle_sessions(
            sessions,
            |session| session.0,
            |session| session.1,
            |id, _| removed.push(id),
            100,
            10,
        );
        assert_eq!(count, 2);
        assert_eq!(removed, ["boundary", "old"]);
    }

    #[tokio::test(start_paused = true)]
    async fn starts_one_interval_and_stops_and_restarts_it() {
        LocalSet::new()
            .run_until(async {
                let purger = IdleSessionPurger::default();
                let count = Rc::new(Cell::new(0u32));
                let start = || {
                    purger.start(10, {
                        let count = count.clone();
                        move || count.set(count.get() + 1)
                    })
                };
                start();
                purger.start(1, || panic!("a second purge timer started"));
                advance(Duration::from_millis(9)).await;
                yield_now().await;
                assert_eq!(count.get(), 0);
                advance(Duration::from_millis(1)).await;
                yield_now().await;
                assert_eq!(count.get(), 1);
                purger.stop();
                advance(Duration::from_millis(10)).await;
                yield_now().await;
                assert_eq!(count.get(), 1);
                start();
                advance(Duration::from_millis(10)).await;
                yield_now().await;
                assert_eq!(count.get(), 2);
            })
            .await;
    }
}
