//! Sequential agent event fanout preserves the inline work of synchronous observers.

use std::error::Error;

use crate::types::{ExecutionOperationResult, LocalExecutionFuture};

pub enum ListenerWork<'a> {
    Synchronous(ExecutionOperationResult<()>),
    Pending(LocalExecutionFuture<'a>),
}

pub async fn dispatch_listeners_sequentially<'a, Listener>(
    listeners: impl IntoIterator<Item = Listener>,
    mut invoke: impl FnMut(Listener) -> ListenerWork<'a>,
    mut on_error: impl FnMut(&dyn Error),
) {
    for listener in listeners {
        let result = match invoke(listener) {
            ListenerWork::Synchronous(result) => result,
            ListenerWork::Pending(pending) => pending.await,
        };
        if let Err(error) = result {
            on_error(error.as_ref());
        }
    }
}
