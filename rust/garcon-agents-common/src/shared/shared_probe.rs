//! Ports `server-agents/common/src/shared/shared-probe.ts`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::error::Error;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll};

use futures::{
    FutureExt,
    future::{LocalBoxFuture, Shared},
};
use garcon_base::errors::{SharedDiagnosticError, error_metadata};
use garcon_base::executor_disconnect::ExecutorSessionLostError;
use garcon_interface::errors::{AgentCallError, AgentIntegrationError};
use garcon_interface::resources::ExecutorResult;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::execution::admission::check_signal;

type SharedResult<T> = Result<T, Rc<dyn Error>>;

/// An operation that concurrent callers share. Every clone settles with the
/// same outcome, and a caller that stops waiting leaves it running.
pub struct SharedProbe<T>(Shared<LocalBoxFuture<'static, SharedResult<T>>>);

impl<T> Clone for SharedProbe<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T: Clone> Future for SharedProbe<T> {
    type Output = ExecutorResult<T>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0)
            .poll(cx)
            .map(|result| result.map_err(box_shared_error))
    }
}

/// The operations running, one for each key.
pub type InFlightProbes<T> = Rc<RefCell<HashMap<String, SharedProbe<T>>>>;

/// Lets concurrent callers that would run an identical probe share one
/// operation; the entry clears once it settles.
pub fn shared_probe<T, F>(in_flight: &InFlightProbes<T>, key: &str, start: F) -> SharedProbe<T>
where
    T: Clone + 'static,
    F: FnOnce() -> LocalBoxFuture<'static, ExecutorResult<T>>,
{
    if let Some(running) = in_flight.borrow().get(key) {
        return running.clone();
    }
    let operation = start();
    let (sender, receiver) = oneshot::channel::<SharedResult<T>>();
    let probe = SharedProbe(
        async move { receiver.await.unwrap_or_else(|error| Err(Rc::new(error))) }
            .boxed_local()
            .shared(),
    );
    let in_flight = Rc::clone(in_flight);
    let key = key.to_owned();
    in_flight.borrow_mut().insert(key.clone(), probe.clone());
    tokio::task::spawn_local(async move {
        let result = operation.await.map_err(Rc::from);
        in_flight.borrow_mut().remove(&key);
        let _ = sender.send(result);
    });
    probe
}

fn box_shared_error(error: Rc<dyn Error>) -> Box<dyn Error> {
    if let Some(error) = error.downcast_ref::<ExecutorSessionLostError>() {
        return Box::new(error.clone());
    }
    if let Some(error) = error.downcast_ref::<AgentCallError>() {
        return Box::new(error.clone());
    }
    if let Some(error) = error.downcast_ref::<AgentIntegrationError>() {
        return Box::new(error.clone());
    }
    let metadata = error_metadata(error.as_ref());
    Box::new(SharedDiagnosticError::new(error.clone(), metadata))
}

/// Stops waiting on an operation when the caller aborts, without ending the
/// operation for the other callers that share it.
pub async fn wait_unless_aborted<T, E>(
    operation: impl Future<Output = Result<T, E>>,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<T>
where
    E: Into<Box<dyn Error>>,
{
    let Some(signal) = signal else {
        return operation.await.map_err(Into::into);
    };
    check_signal(Some(signal))?;
    // A caller that stops waiting leaves the operation running.
    tokio::select! {
        biased;
        _ = signal.cancelled() => {
            // INFALLIBLE: the signal is cancelled here, so the check fails.
            Err(check_signal(Some(signal)).unwrap_err())
        }
        result = operation => result.map_err(Into::into),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use garcon_base::errors::NamedError;
    use garcon_interface::errors::AgentIntegrationErrorCode;
    use tokio::sync::watch;
    use tokio::task::LocalSet;

    use super::*;

    const KEY: &str = "key";

    fn aborted(error: &(dyn Error + 'static)) -> bool {
        error
            .downcast_ref::<NamedError>()
            .is_some_and(|error| error.name == "AbortError")
    }

    // A probe that starts on `start`, answers what `gate` sends, and counts its starts.
    struct Gated {
        starts: Rc<Cell<usize>>,
        gate: watch::Sender<Option<Result<i32, String>>>,
    }

    impl Gated {
        fn new() -> Rc<Self> {
            Rc::new(Self {
                starts: Rc::default(),
                gate: watch::channel(None).0,
            })
        }

        fn probe(self: &Rc<Self>, in_flight: &InFlightProbes<i32>) -> SharedProbe<i32> {
            let gated = Rc::clone(self);
            shared_probe(in_flight, KEY, move || {
                gated.starts.set(gated.starts.get() + 1);
                let mut answer = gated.gate.subscribe();
                Box::pin(async move {
                    answer
                        .wait_for(|answer| answer.is_some())
                        .await
                        .ok()
                        .and_then(|answer| answer.clone())
                        .unwrap_or(Err("the gate closed".to_owned()))
                        .map_err(Into::into)
                })
            })
        }
    }

    #[tokio::test]
    async fn shares_one_operation_between_concurrent_callers_and_clears_it_once_settled() {
        LocalSet::new()
            .run_until(async {
                let in_flight: InFlightProbes<i32> = Rc::default();
                let gated = Gated::new();

                let first = gated.probe(&in_flight);
                let second = gated.probe(&in_flight);
                assert_eq!(in_flight.borrow().len(), 1);
                gated.gate.send_replace(Some(Ok(7)));

                assert_eq!(first.await.ok(), Some(7));
                assert_eq!(second.await.ok(), Some(7));
                assert_eq!(gated.starts.get(), 1);
                assert!(in_flight.borrow().is_empty());
            })
            .await;
    }

    #[tokio::test]
    async fn every_waiter_of_a_failed_probe_sees_the_same_failure() {
        LocalSet::new()
            .run_until(async {
                let in_flight: InFlightProbes<i32> = Rc::default();
                let gated = Gated::new();
                let first = gated.probe(&in_flight);
                let second = gated.probe(&in_flight);
                gated
                    .gate
                    .send_replace(Some(Err("probe failed".to_owned())));

                let failure = first.await.unwrap_err();
                assert_eq!(failure.to_string(), "probe failed");
                assert_eq!(second.await.unwrap_err().to_string(), "probe failed");
                assert_eq!(error_metadata(failure.as_ref()).name, "Error");
                assert!(in_flight.borrow().is_empty());
            })
            .await;
    }

    #[tokio::test]
    async fn preserves_the_provider_error_for_each_waiter() {
        LocalSet::new()
            .run_until(async {
                let in_flight: InFlightProbes<i32> = Rc::default();
                let probe = shared_probe(&in_flight, KEY, || {
                    Box::pin(async {
                        Err(AgentIntegrationError::new(
                            AgentIntegrationErrorCode::AUTH_REQUIRED,
                            "Sign in first",
                            false,
                            None,
                        )
                        .into())
                    })
                });
                for wait in [probe.clone(), probe] {
                    let error = wait.await.unwrap_err();
                    let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
                    assert_eq!(error.code, AgentIntegrationErrorCode::AUTH_REQUIRED);
                }
            })
            .await;
    }

    #[tokio::test]
    async fn an_aborted_caller_leaves_no_failure_behind() {
        LocalSet::new()
            .run_until(async {
                let in_flight: InFlightProbes<i32> = Rc::default();
                let gated = Gated::new();
                let controller = CancellationToken::new();
                controller.cancel();
                let probe = gated.probe(&in_flight);

                let error = wait_unless_aborted(probe.clone(), Some(&controller))
                    .await
                    .unwrap_err();
                assert!(aborted(error.as_ref()));

                // The probe fails with nobody waiting on it, which is not an error anywhere.
                gated
                    .gate
                    .send_replace(Some(Err("probe failed".to_owned())));
                assert_eq!(probe.await.unwrap_err().to_string(), "probe failed");
                assert!(in_flight.borrow().is_empty());
            })
            .await;
    }

    #[tokio::test]
    async fn rejects_with_the_abort_reason_while_the_shared_operation_keeps_running() {
        LocalSet::new()
            .run_until(async {
                let in_flight: InFlightProbes<i32> = Rc::default();
                let gated = Gated::new();
                let controller = CancellationToken::new();
                let probe = gated.probe(&in_flight);
                let waiting = wait_unless_aborted(probe.clone(), Some(&controller));
                tokio::pin!(waiting);
                assert!(futures::poll!(waiting.as_mut()).is_pending());

                controller.cancel();

                assert!(aborted(waiting.await.unwrap_err().as_ref()));
                assert_eq!(in_flight.borrow().len(), 1);
                gated.gate.send_replace(Some(Ok(9)));
                assert_eq!(probe.await.ok(), Some(9));
            })
            .await;
    }

    #[tokio::test]
    async fn without_a_signal_the_operation_is_awaited_whatever_it_does() {
        LocalSet::new()
            .run_until(async {
                let in_flight: InFlightProbes<i32> = Rc::default();
                let gated = Gated::new();
                let probe = gated.probe(&in_flight);
                let waiting = wait_unless_aborted(probe, None);
                tokio::pin!(waiting);
                assert!(futures::poll!(waiting.as_mut()).is_pending());

                gated.gate.send_replace(Some(Ok(4)));

                assert_eq!(waiting.await.ok(), Some(4));
                let error = wait_unless_aborted(async { Err::<i32, _>("plain failure") }, None)
                    .await
                    .unwrap_err();
                assert_eq!(error.to_string(), "plain failure");
            })
            .await;
    }
}
