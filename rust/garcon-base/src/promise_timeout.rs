//! A deadline around independently running work.

use std::future::Future;

use garcon_js::number_to_string;
use tokio::task::{JoinError, JoinHandle};

use crate::event_loop_stalls::timer_interval;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PromiseTimeoutError {
    message: String,
}

impl PromiseTimeoutError {
    pub fn new(label: &str, timeout_ms: f64) -> Self {
        let timeout_ms = number_to_string(timeout_ms);
        Self {
            message: format!("{label} timed out after {timeout_ms}ms"),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TimedWorkError<E> {
    #[error(transparent)]
    Timeout(#[from] PromiseTimeoutError),
    #[error(transparent)]
    Work(E),
    #[error(transparent)]
    Join(#[from] JoinError),
}

pub fn with_promise_timeout<T, E>(
    mut work: JoinHandle<Result<T, E>>,
    timeout_ms: f64,
    label: impl Into<String>,
) -> impl Future<Output = Result<T, TimedWorkError<E>>> {
    let label = label.into();
    let timer = tokio::time::sleep(timer_interval(timeout_ms));
    async move {
        tokio::select! {
            biased;
            result = &mut work => result?.map_err(TimedWorkError::Work),
            () = timer => Err(PromiseTimeoutError::new(&label, timeout_ms).into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[tokio::test(start_paused = true)]
    async fn timeout_does_not_cancel_work_that_finishes_later() {
        let (ready, release) = oneshot::channel();
        let (done, finished) = oneshot::channel();
        let work = tokio::spawn(async {
            release.await.unwrap();
            done.send(()).unwrap();
            Ok::<_, std::io::Error>(())
        });
        let error = with_promise_timeout(work, 123.0, "synthetic work")
            .await
            .unwrap_err();
        assert!(matches!(error, TimedWorkError::Timeout(_)));
        assert_eq!(error.to_string(), "synthetic work timed out after 123ms");
        ready.send(()).unwrap();
        finished.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_a_work_result_or_error_when_the_work_finishes_first() {
        let success = tokio::spawn(async { Ok::<_, std::io::Error>("synthetic result") });
        assert_eq!(
            with_promise_timeout(success, 123.0, "fixture")
                .await
                .unwrap(),
            "synthetic result"
        );
        let failure =
            tokio::spawn(async { Err::<(), _>(std::io::Error::other("synthetic failure")) });
        let error = with_promise_timeout(failure, 123.0, "fixture")
            .await
            .unwrap_err();
        assert!(matches!(error, TimedWorkError::Work(_)));
        assert_eq!(error.to_string(), "synthetic failure");
    }
}
