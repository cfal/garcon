//! Cancellation ends the wait, never the admitted work.

use std::future::Future;

use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::keyed_lock::LockAborted;

#[derive(Debug, thiserror::Error)]
pub enum AbortableWaitError<E, A = LockAborted> {
    #[error(transparent)]
    Aborted(A),
    #[error(transparent)]
    Work(E),
    #[error(transparent)]
    Join(#[from] JoinError),
}

pub fn wait_abortably<'a, T: 'a, E: 'a>(
    work: JoinHandle<Result<T, E>>,
    signal: &'a CancellationToken,
) -> Result<impl Future<Output = Result<T, AbortableWaitError<E>>> + 'a, AbortableWaitError<E>> {
    wait_abortably_with_reason(work, signal, || LockAborted)
}

pub fn wait_abortably_with_reason<'a, T: 'a, E: 'a, A: 'a>(
    mut work: JoinHandle<Result<T, E>>,
    signal: &'a CancellationToken,
    reason: impl FnOnce() -> A + 'a,
) -> Result<impl Future<Output = Result<T, AbortableWaitError<E, A>>> + 'a, AbortableWaitError<E, A>>
{
    if signal.is_cancelled() {
        return Err(AbortableWaitError::Aborted(reason()));
    }
    Ok(async move {
        tokio::select! {
            biased;
            () = signal.cancelled() => Err(AbortableWaitError::Aborted(reason())),
            result = &mut work => result?.map_err(AbortableWaitError::Work),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::rc::Rc;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn throws_an_already_aborted_reason_before_polling_the_wait() {
        let signal = CancellationToken::new();
        signal.cancel();
        let reason = Rc::new("synthetic abort");
        let work = tokio::spawn(async { Ok::<_, std::io::Error>(()) });
        let result = wait_abortably_with_reason(work, &signal, || Rc::clone(&reason));
        assert!(
            matches!(result, Err(AbortableWaitError::Aborted(actual)) if Rc::ptr_eq(&actual, &reason))
        );
    }

    #[tokio::test]
    async fn aborting_only_the_wait_leaves_the_job_running() {
        let (ready, release) = oneshot::channel();
        let (done, finished) = oneshot::channel();
        let work = tokio::spawn(async {
            release.await.unwrap();
            done.send(()).unwrap();
            Err::<(), _>(std::io::Error::other("synthetic late failure"))
        });
        let signal = CancellationToken::new();
        let waiting = wait_abortably(work, &signal).unwrap();
        signal.cancel();
        assert!(matches!(
            waiting.await,
            Err(AbortableWaitError::Aborted(LockAborted))
        ));
        ready.send(()).unwrap();
        finished.await.unwrap();
    }
}
