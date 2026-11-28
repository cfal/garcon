//! Ports `server-agents/opencode/src/agents/opencode/request-control.ts`.

use std::error::Error;
use std::future::Future;
use std::pin::Pin;
use std::task::Poll;

use futures::future::pending;
use garcon_js::number_to_string;
use tokio::task::JoinError;

use crate::js::{AbortSignal, SharedError, error, timer_delay};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct OpenCodeTimeoutError {
    message: String,
}

impl OpenCodeTimeoutError {
    pub fn new(label: &str, timeout_ms: f64) -> Self {
        Self {
            message: format!("{label} timed out after {}ms", number_to_string(timeout_ms)),
        }
    }
}

type Operation<T, E> = Pin<Box<dyn Future<Output = Result<Result<T, E>, JoinError>>>>;

/// Runs `operation` under a signal that aborts with the timeout error once
/// `timeout_ms` have passed and with the caller's reason when `caller_signal`
/// aborts. Neither stops the operation: it keeps running after this has
/// returned, as its promise does in the original, so cleanup that follows its
/// own awaits still happens.
pub async fn with_abortable_timeout<T, E, Fut>(
    operation: impl FnOnce(AbortSignal) -> Fut,
    timeout_ms: Option<f64>,
    label: &str,
    caller_signal: Option<&AbortSignal>,
) -> Result<T, Box<dyn Error>>
where
    Fut: Future<Output = Result<T, E>> + 'static,
    E: Into<Box<dyn Error>> + 'static,
    T: 'static,
{
    let controller = AbortSignal::new();
    if let Some(caller) = caller_signal.filter(|caller| caller.aborted()) {
        controller.abort(caller.abort_reason());
    }
    // The operation is entered before anything else runs, as the body of a
    // promise is; an already aborted signal keeps it from being entered.
    let mut work: Operation<T, E> = match (!controller.aborted()).then(|| {
        let signal = controller.clone();
        Box::pin(operation(signal))
    }) {
        Some(mut work) => match futures::poll!(&mut work) {
            Poll::Ready(result) => Box::pin(async move { Ok(result) }),
            Poll::Pending => Box::pin(tokio::task::spawn_local(work)),
        },
        None => Box::pin(pending()),
    };
    let mut timer: Pin<Box<dyn Future<Output = f64>>> = match timeout_ms {
        Some(ms) => Box::pin(async move {
            tokio::time::sleep(timer_delay(ms)).await;
            ms
        }),
        None => Box::pin(pending()),
    };
    let mut caller: Pin<Box<dyn Future<Output = ()> + '_>> = match caller_signal {
        Some(signal) => Box::pin(signal.token().cancelled()),
        None => Box::pin(pending()),
    };
    tokio::select! {
        biased;
        result = &mut work => result
            .map_err(|joined| error("Error", joined.to_string()))?
            .map_err(Into::into),
        ms = &mut timer => {
            let failure = SharedError::new(OpenCodeTimeoutError::new(label, ms));
            controller.abort(failure.clone());
            Err(failure.into())
        }
        () = &mut caller => {
            // The caller's reason is what the operation's signal is aborted with.
            if let Some(caller) = caller_signal {
                controller.abort(caller.abort_reason());
            }
            Err(controller.abort_reason().into())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::rc::Rc;
    use std::time::Duration;

    use tokio::task::LocalSet;

    use super::*;
    use crate::js::shared_error;

    #[test]
    fn a_timeout_names_its_label_and_its_delay_as_javascript_writes_them() {
        assert_eq!(
            OpenCodeTimeoutError::new("OpenCode startup", 15_000.0).to_string(),
            "OpenCode startup timed out after 15000ms"
        );
        assert_eq!(
            OpenCodeTimeoutError::new("probe", 2.5).to_string(),
            "probe timed out after 2.5ms"
        );
        assert_eq!(
            OpenCodeTimeoutError::new("probe", 1e21).to_string(),
            "probe timed out after 1e+21ms"
        );
    }

    async fn settle(value: &'static str) -> Result<&'static str, Box<dyn Error>> {
        Ok(value)
    }

    // An operation that waits for its signal, as a request does, and then
    // reports the reason it was aborted with.
    async fn waiting(
        signal: AbortSignal,
        observed: Rc<Cell<Option<String>>>,
    ) -> Result<(), Box<dyn Error>> {
        signal.token().cancelled().await;
        observed.set(signal.reason().map(|reason| reason.to_string()));
        Err(error("Error", "request aborted"))
    }

    #[tokio::test]
    async fn returns_what_the_operation_returns_with_or_without_a_timeout() {
        LocalSet::new()
            .run_until(async {
                for timeout_ms in [Some(1_000.0), None] {
                    let value = with_abortable_timeout(
                        |_| Box::pin(settle("done")),
                        timeout_ms,
                        "probe",
                        None,
                    )
                    .await;
                    assert_eq!(value.expect("the operation succeeds"), "done");
                }
            })
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_timeout_ends_the_wait_and_aborts_the_operation_with_the_timeout_error() {
        LocalSet::new()
            .run_until(async {
                let observed = Rc::new(Cell::new(None));
                let result = with_abortable_timeout(
                    |signal| waiting(signal, Rc::clone(&observed)),
                    Some(50.0),
                    "OpenCode probe",
                    None,
                )
                .await;
                assert_eq!(
                    result.unwrap_err().to_string(),
                    "OpenCode probe timed out after 50ms"
                );
                tokio::task::yield_now().await;
                assert_eq!(
                    observed.take(),
                    Some("OpenCode probe timed out after 50ms".to_owned())
                );
            })
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_callers_abort_ends_the_wait_with_the_callers_reason() {
        LocalSet::new()
            .run_until(async {
                let caller = AbortSignal::new();
                tokio::task::spawn_local({
                    let caller = caller.clone();
                    async move {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        caller.abort(shared_error("Error", "route retired"));
                    }
                });
                let observed = Rc::new(Cell::new(None));
                let result = with_abortable_timeout(
                    |signal| waiting(signal, Rc::clone(&observed)),
                    Some(60_000.0),
                    "probe",
                    Some(&caller),
                )
                .await;
                assert_eq!(result.unwrap_err().to_string(), "route retired");
                tokio::task::yield_now().await;
                assert_eq!(observed.take(), Some("route retired".to_owned()));
            })
            .await;
    }

    #[tokio::test]
    async fn an_already_aborted_caller_keeps_the_operation_from_being_entered() {
        LocalSet::new()
            .run_until(async {
                let caller = AbortSignal::new();
                caller.abort(shared_error("Error", "already stopped"));
                let entered = Rc::new(Cell::new(false));
                let result = with_abortable_timeout(
                    {
                        let entered = Rc::clone(&entered);
                        move |_| {
                            entered.set(true);
                            Box::pin(settle("late"))
                        }
                    },
                    None,
                    "probe",
                    Some(&caller),
                )
                .await;
                assert_eq!(result.unwrap_err().to_string(), "already stopped");
                assert!(!entered.get());
            })
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_operation_keeps_running_after_a_timeout() {
        LocalSet::new()
            .run_until(async {
                let (release, released) = tokio::sync::oneshot::channel::<()>();
                let cleaned_up = Rc::new(Cell::new(false));
                let result = with_abortable_timeout(
                    {
                        let cleaned_up = Rc::clone(&cleaned_up);
                        move |_| {
                            Box::pin(async move {
                                let _ = released.await;
                                cleaned_up.set(true);
                                Ok::<(), Box<dyn Error>>(())
                            })
                        }
                    },
                    Some(10.0),
                    "probe",
                    None,
                )
                .await;
                assert!(result.is_err());
                assert!(!cleaned_up.get());
                release.send(()).expect("the operation still waits");
                tokio::task::yield_now().await;
                assert!(cleaned_up.get());
            })
            .await;
    }
}
