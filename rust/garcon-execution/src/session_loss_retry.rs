//! Retries replay-safe setup work on a replacement executor session.

use std::{error::Error, future::Future};

use garcon_base::executor_disconnect::ExecutorSessionLostError;
use tokio_util::sync::CancellationToken;

use crate::types::ExecutionOperationResult;

const SESSION_LOSS_ATTEMPTS: usize = 3;

#[derive(Clone, Copy)]
pub struct SessionLossRetrySignal<'a> {
    pub token: &'a CancellationToken,
    pub reason: &'a dyn Fn() -> Box<dyn Error>,
}

pub async fn retry_after_session_loss<T, F, Fut>(
    mut step: F,
    signal: Option<SessionLossRetrySignal<'_>>,
) -> ExecutionOperationResult<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = ExecutionOperationResult<T>>,
{
    let mut attempt = 1;
    loop {
        match step().await {
            Err(error)
                if attempt < SESSION_LOSS_ATTEMPTS && error.is::<ExecutorSessionLostError>() =>
            {
                if let Some(signal) = signal
                    && signal.token.is_cancelled()
                {
                    return Err((signal.reason)());
                }
                attempt += 1;
            }
            outcome => return outcome,
        }
    }
}
