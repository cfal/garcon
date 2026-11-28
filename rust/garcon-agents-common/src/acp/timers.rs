//! JavaScript timers the ACP modules set.
//!
//! `setTimeout(callback, ms)` delays by whole milliseconds; anything that is
//! not a positive number fires on the next turn of the event loop.

use std::time::Duration;

/// The delay of a `setTimeout` timer.
pub(super) fn delay(ms: f64) -> Duration {
    if ms.is_finite() && ms > 0.0 {
        Duration::from_millis(ms.trunc() as u64)
    } else {
        Duration::ZERO
    }
}
