//! Shared reconnect deadlines and the grace for an admitted read.

use garcon_interface::resources::ExecutorCallOptions;
use garcon_js::performance_now_ms;
use tokio_util::sync::CancellationToken;

pub const INTERACTIVE_EXECUTOR_WAIT_MS: f64 = 20_000.0;
pub const SENT_READ_GRACE_MS: f64 = 5_000.0;

pub fn interactive_deadline() -> f64 {
    interactive_deadline_at(performance_now_ms())
}

pub fn interactive_deadline_at(now_ms: f64) -> f64 {
    now_ms + INTERACTIVE_EXECUTOR_WAIT_MS
}

pub fn read_before(
    deadline: Option<f64>,
    signal: Option<CancellationToken>,
) -> ExecutorCallOptions {
    read_before_at(deadline, signal, performance_now_ms())
}

pub fn read_before_at(
    deadline: Option<f64>,
    signal: Option<CancellationToken>,
    now_ms: f64,
) -> ExecutorCallOptions {
    let timeout_ms = deadline.map(|deadline| {
        let remaining = (deadline + SENT_READ_GRACE_MS - now_ms).ceil();
        if remaining.is_nan() {
            remaining
        } else {
            remaining.max(1.0)
        }
    });
    ExecutorCallOptions {
        signal,
        dispatch_deadline: deadline,
        timeout_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_share_the_same_deadline_and_once_sent_use_its_remaining_grace() {
        let signal = CancellationToken::new();
        let deadline = interactive_deadline_at(1_000.0);
        assert_eq!(deadline, 21_000.0);
        for (now, desired) in [(1_000.0, 25_000.0), (23_000.0, 3_000.0), (26_001.0, 1.0)] {
            let read = read_before_at(Some(deadline), Some(signal.clone()), now);
            assert_eq!(read.dispatch_deadline, Some(deadline));
            assert_eq!(read.timeout_ms, Some(desired));
            assert!(read.signal.is_some());
        }
        let unbounded = read_before_at(None, Some(signal), 23_000.0);
        assert_eq!(unbounded.dispatch_deadline, None);
        assert_eq!(unbounded.timeout_ms, None);
        assert!(unbounded.signal.is_some());
    }
}
