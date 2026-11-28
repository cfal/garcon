use std::cell::RefCell;
use std::collections::VecDeque;
use std::net::IpAddr;
use std::rc::Rc;
use std::time::Duration;

use garcon_base::http_body::fetch_header_value;
use garcon_js::clock::{Clock, SystemClock};
use garcon_js::js::{is_safe_integer, trim};
use hashlink::LinkedHashMap;
use http::{HeaderMap, HeaderName};
use tokio::task::AbortHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at};

const SWEEP_INTERVAL: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy)]
pub struct RateLimits {
    window_ms: f64,
    max_requests: u64,
    max_tracked_ips: u64,
}

#[derive(Debug, thiserror::Error)]
#[error(
    "Rate limits require a nonnegative integer threshold, a positive finite window and a positive integer IP capacity"
)]
pub struct InvalidRateLimits;

impl RateLimits {
    pub fn new(
        window_ms: f64,
        max_requests: f64,
        max_tracked_ips: f64,
    ) -> Result<Self, InvalidRateLimits> {
        if !window_ms.is_finite()
            || window_ms <= 0.0
            || !is_safe_integer(max_requests)
            || max_requests < 0.0
            || !is_safe_integer(max_tracked_ips)
            || max_tracked_ips <= 0.0
        {
            return Err(InvalidRateLimits);
        }
        Ok(Self {
            window_ms,
            max_requests: max_requests as u64,
            max_tracked_ips: max_tracked_ips as u64,
        })
    }
}

impl Default for RateLimits {
    fn default() -> Self {
        Self {
            window_ms: 60_000.0,
            max_requests: 10,
            max_tracked_ips: 10_000,
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("Too many requests. Please try again later.")]
pub struct RateLimited;

pub struct RateLimiter<C = SystemClock> {
    limits: RateLimits,
    trust_proxy: bool,
    clock: C,
    // Access order matches the original Map without shifting every active IP
    // on a repeated attempt.
    hits: RefCell<LinkedHashMap<String, VecDeque<i64>>>,
    sweep: RefCell<Option<AbortHandle>>,
}

impl<C: Clock + 'static> RateLimiter<C> {
    /// Starts the limiter and its periodic sweep on the controller's LocalSet.
    pub fn new(limits: RateLimits, trust_proxy: bool, clock: C) -> Rc<Self> {
        let limiter = Rc::new(Self {
            limits,
            trust_proxy,
            clock,
            hits: RefCell::new(LinkedHashMap::new()),
            sweep: RefCell::new(None),
        });
        let weak = Rc::downgrade(&limiter);
        let first_sweep = Instant::now() + SWEEP_INTERVAL;
        let task = tokio::task::spawn_local(async move {
            let mut interval = interval_at(first_sweep, SWEEP_INTERVAL);
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let Some(limiter) = weak.upgrade() else {
                    return;
                };
                purge_expired(
                    &mut limiter.hits.borrow_mut(),
                    limiter.clock.now_ms() as f64 - limiter.limits.window_ms,
                );
            }
        });
        *limiter.sweep.borrow_mut() = Some(task.abort_handle());
        limiter
    }

    pub fn check(&self, headers: &HeaderMap, peer: Option<IpAddr>) -> Result<(), RateLimited> {
        let socket_ip = peer.map(|address| address.to_string());
        let forwarded = self
            .trust_proxy
            .then(|| forwarded_client_ip(headers))
            .flatten();
        let ip = forwarded
            .as_deref()
            .or(socket_ip.as_deref())
            .unwrap_or("unknown");
        let now = self.clock.now_ms();
        let cutoff = now as f64 - self.limits.window_ms;
        let mut hits = self.hits.borrow_mut();
        if self.limits.max_requests == 0 {
            return Err(RateLimited);
        }
        if !hits.contains_key(ip) && hits.len() as u64 >= self.limits.max_tracked_ips {
            purge_expired(&mut hits, cutoff);
            if hits.len() as u64 >= self.limits.max_tracked_ips {
                return Err(RateLimited);
            }
        }
        let mut timestamps = hits.remove(ip).unwrap_or_default();
        // Wall time can move backward, so keep the original per-entry filter.
        timestamps.retain(|timestamp| *timestamp as f64 > cutoff);
        let exhausted = timestamps.len() as u64 >= self.limits.max_requests;
        if exhausted {
            timestamps.pop_front();
        }
        timestamps.push_back(now);
        hits.insert(ip.to_owned(), timestamps);
        if exhausted { Err(RateLimited) } else { Ok(()) }
    }

    pub fn dispose(&self) {
        if let Some(sweep) = self.sweep.borrow_mut().take() {
            sweep.abort();
        }
        self.hits.borrow_mut().clear();
    }
}

impl<C> Drop for RateLimiter<C> {
    fn drop(&mut self) {
        if let Some(sweep) = self.sweep.get_mut().take() {
            sweep.abort();
        }
    }
}

fn forwarded_client_ip(headers: &HeaderMap) -> Option<String> {
    const FORWARDED_FOR: HeaderName = HeaderName::from_static("x-forwarded-for");
    const REAL_IP: HeaderName = HeaderName::from_static("x-real-ip");
    fetch_header_value(headers, &FORWARDED_FOR)
        .and_then(|addresses| {
            addresses
                .split(',')
                .next()
                .map(trim)
                .filter(|ip| !ip.is_empty())
                .map(str::to_owned)
        })
        .or_else(|| fetch_header_value(headers, &REAL_IP).filter(|ip| !ip.is_empty()))
}

fn purge_expired(hits: &mut LinkedHashMap<String, VecDeque<i64>>, cutoff: f64) {
    while hits
        .front()
        .is_some_and(|(_, times)| times.back().is_none_or(|value| *value as f64 <= cutoff))
    {
        hits.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_js::clock::ManualClock;
    use http::header::HeaderValue;
    use tokio::task::LocalSet;

    #[test]
    fn rejects_unbounded_or_fractional_settings_and_permits_an_explicit_zero_threshold() {
        for invalid in [-1.0, 0.5, f64::NAN, f64::INFINITY, (1_u64 << 53) as f64] {
            assert!(RateLimits::new(60_000.0, invalid, 10.0).is_err());
            assert!(RateLimits::new(60_000.0, 10.0, invalid).is_err());
        }
        for invalid in [-1.0, 0.0, f64::NAN, f64::INFINITY] {
            assert!(RateLimits::new(invalid, 10.0, 10.0).is_err());
        }
        assert!(RateLimits::new(0.5, 0.0, 10.0).is_ok());
    }

    fn request(ip: &str, name: &'static str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(name, HeaderValue::from_str(ip).unwrap());
        headers
    }

    #[tokio::test]
    async fn fails_closed_for_new_keys_at_capacity_without_resetting_existing_quotas() {
        LocalSet::new()
            .run_until(async {
                let limits = RateLimits::new(1_000.0, 2.0, 2.0).unwrap();
                let limiter = RateLimiter::new(limits, true, ManualClock::new(0));
                let check = |ip: &str| limiter.check(&request(ip, "x-forwarded-for"), None);
                assert_eq!(check("first"), Ok(()));
                assert_eq!(check("second"), Ok(()));
                for index in 0..100 {
                    assert_eq!(check(&format!("unseen-{index}")), Err(RateLimited));
                }
                assert_eq!(check("first"), Ok(()));
                assert_eq!(check("first"), Err(RateLimited));
                limiter.clock.set(900);
                assert_eq!(check("second"), Ok(()));
                assert_eq!(check("new"), Err(RateLimited));
                limiter.clock.set(1_000);
                assert_eq!(check("new"), Ok(()));
                assert_eq!(check("first"), Err(RateLimited));
                assert_eq!(check("second"), Ok(()));
                assert_eq!(check("second"), Err(RateLimited));
                limiter.clock.set(2_000);
                assert_eq!(check("first"), Ok(()));
            })
            .await;
    }

    #[tokio::test]
    async fn retains_only_the_threshold_of_recent_attempts_under_a_sustained_rejected_burst() {
        LocalSet::new()
            .run_until(async {
                let clock = ManualClock::new(1_000);
                let limiter = RateLimiter::new(RateLimits::default(), false, clock);
                for index in 0..2_000 {
                    assert_eq!(limiter.check(&HeaderMap::new(), None).is_err(), index >= 10);
                }
                assert_eq!(limiter.hits.borrow()["unknown"].len(), 10);
            })
            .await;
    }

    #[tokio::test]
    async fn preserves_rejected_attempt_cooldown_and_expires_hits_at_the_exact_window_boundary() {
        LocalSet::new()
            .run_until(async {
                let limits = RateLimits::new(1_000.0, 2.0, 10.0).unwrap();
                let limiter = RateLimiter::new(limits, false, ManualClock::new(0));
                let check = || limiter.check(&HeaderMap::new(), None);
                assert_eq!(check(), Ok(()));
                assert_eq!(check(), Ok(()));
                for (at, expected) in [
                    (900, Err(RateLimited)),
                    (1_000, Ok(())),
                    (1_899, Err(RateLimited)),
                    (2_000, Ok(())),
                ] {
                    limiter.clock.set(at);
                    assert_eq!(check(), expected);
                }
            })
            .await;
    }

    #[tokio::test]
    async fn uses_forwarded_headers_only_when_proxy_trust_is_enabled() {
        LocalSet::new()
            .run_until(async {
                let limits = RateLimits::new(60_000.0, 1.0, 10.0).unwrap();
                let peer = Some("127.0.0.1".parse().unwrap());
                for trust in [false, true] {
                    let limiter = RateLimiter::new(limits, trust, ManualClock::new(0));
                    assert_eq!(
                        limiter.check(&request("10.0.0.1, proxy", "x-forwarded-for"), peer),
                        Ok(())
                    );
                    assert_eq!(
                        limiter
                            .check(&request("10.0.0.2", "x-real-ip"), peer)
                            .is_ok(),
                        trust
                    );
                }
                let trust = RateLimiter::new(limits, true, ManualClock::new(0));
                assert_eq!(trust.check(&HeaderMap::new(), peer), Ok(()));
                assert_eq!(trust.check(&HeaderMap::new(), peer), Err(RateLimited));
                let disabled = RateLimiter::new(
                    RateLimits::new(60_000.0, 0.0, 10.0).unwrap(),
                    false,
                    SystemClock,
                );
                assert_eq!(disabled.check(&HeaderMap::new(), peer), Err(RateLimited));
                assert!(disabled.hits.borrow().is_empty());
            })
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn sweeps_expired_addresses_and_stops_the_sweep_when_disposed() {
        LocalSet::new()
            .run_until(async {
                let limiter = RateLimiter::new(RateLimits::default(), false, ManualClock::new(0));
                limiter.check(&HeaderMap::new(), None).unwrap();
                limiter.clock.set(120_000);
                tokio::time::sleep(SWEEP_INTERVAL + Duration::from_secs(1)).await;
                assert!(limiter.hits.borrow().is_empty());
                let sweep = limiter.sweep.borrow().clone().unwrap();
                limiter.dispose();
                tokio::task::yield_now().await;
                assert!(sweep.is_finished());
            })
            .await;
    }
}
