use std::collections::HashMap;

use garcon_js::performance_now_ms;

const SESSION_REFRESH_INTERVAL_MS: f64 = 30_000.0;
const GLOBAL_REFRESH_INTERVAL_MS: f64 = 1_000.0;

pub struct NativePathDiscoveryRefreshLimiter {
    session_interval_ms: f64,
    global_interval_ms: f64,
    sessions: HashMap<String, f64>,
    last_refresh_at: f64,
}

impl Default for NativePathDiscoveryRefreshLimiter {
    fn default() -> Self {
        Self::new(SESSION_REFRESH_INTERVAL_MS, GLOBAL_REFRESH_INTERVAL_MS)
    }
}

impl NativePathDiscoveryRefreshLimiter {
    pub fn new(session_interval_ms: f64, global_interval_ms: f64) -> Self {
        Self {
            session_interval_ms,
            global_interval_ms,
            sessions: HashMap::new(),
            last_refresh_at: f64::NEG_INFINITY,
        }
    }

    pub fn accept(&mut self, agent_session_id: &str) -> bool {
        self.accept_at(agent_session_id, performance_now_ms())
    }

    fn accept_at(&mut self, agent_session_id: &str, now: f64) -> bool {
        self.sessions.retain(|_, refreshed_at| {
            let elapsed = now - *refreshed_at;
            !(elapsed < 0.0 || elapsed >= self.session_interval_ms)
        });
        if self.sessions.contains_key(agent_session_id) {
            return false;
        }
        let global_elapsed = now - self.last_refresh_at;
        if global_elapsed >= 0.0 && global_elapsed < self.global_interval_ms {
            return false;
        }
        self.last_refresh_at = now;
        self.sessions.insert(agent_session_id.to_owned(), now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_repeated_native_path_discovery_refresh_requests() {
        let mut limiter = NativePathDiscoveryRefreshLimiter::default();
        assert!(limiter.accept_at("first", 0.0));
        assert!(!limiter.accept_at("first", 29_999.0));
        assert!(limiter.accept_at("first", 30_000.0));
    }

    #[test]
    fn lets_another_session_request_a_refresh_after_the_global_minimum_interval() {
        let mut limiter = NativePathDiscoveryRefreshLimiter::default();
        assert!(limiter.accept_at("first", 0.0));
        assert!(!limiter.accept_at("second", 999.0));
        assert!(limiter.accept_at("second", 1_000.0));
        assert!(!limiter.accept_at("first", 1_001.0));
    }

    #[test]
    fn discards_refresh_times_ahead_of_the_current_clock() {
        let mut limiter = NativePathDiscoveryRefreshLimiter::default();
        assert!(limiter.accept_at("first", 1_000.0));
        assert!(limiter.accept_at("first", 999.0));
    }
}
