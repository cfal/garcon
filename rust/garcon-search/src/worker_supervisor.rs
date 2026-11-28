//! Request delivery is retired before a connection-owning thread is joined.

use std::{
    cell::{Cell, RefCell},
    collections::HashSet,
    future::pending,
    rc::Rc,
    thread::{self, JoinHandle},
    time::Duration,
};

use tokio::{
    sync::mpsc,
    time::{Instant, sleep, sleep_until},
};
use tokio_util::sync::CancellationToken;

use crate::{
    schema::MAX_SAFE_ORDINAL,
    worker_protocol::{WorkerFailure, WorkerIdentity},
};

pub(crate) const CHANNEL_CAPACITY: usize = 8;

mod slot;
pub use slot::{WorkerSlot, WorkerSlotError};

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WorkerError {
    #[error("Transcript search worker is unavailable")]
    Unavailable,
    #[error("Transcript search worker request is active")]
    Active,
    #[error("Transcript search worker request queue is full")]
    Busy,
    #[error("Transcript search response identity mismatch")]
    IdentityMismatch,
    #[error("Transcript search worker sent an invalid message")]
    InvalidMessage,
    #[error("Transcript search worker closed")]
    Closed,
    #[error("Transcript search worker panicked")]
    Panicked,
    #[error("{0}")]
    Timeout(&'static str),
    #[error("Aborted")]
    Aborted,
    #[error(transparent)]
    Failure(#[from] WorkerFailure),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Response {
    Complete,
    Progress,
    Continue,
    Mismatch,
}

pub(crate) struct Command<R, E> {
    pub identity: WorkerIdentity,
    pub request: R,
    pub reply: Reply<E>,
}

pub(crate) struct Reply<E> {
    pub identity: WorkerIdentity,
    pub send: mpsc::Sender<(WorkerIdentity, Result<E, WorkerError>)>,
}

impl<E> Clone for Reply<E> {
    fn clone(&self) -> Self {
        Self {
            identity: self.identity,
            send: self.send.clone(),
        }
    }
}

struct Shared<R, E> {
    epoch: u64,
    timeout_code: &'static str,
    next_request: Cell<u64>,
    pending: RefCell<HashSet<u64>>,
    sender: RefCell<Option<mpsc::Sender<Command<R, E>>>>,
    retired: CancellationToken,
    exited: CancellationToken,
    thread: RefCell<Option<JoinHandle<()>>>,
}

impl<R, E> Drop for Shared<R, E> {
    fn drop(&mut self) {
        self.retired.cancel();
    }
}

pub struct SearchWorker<R, E>(Rc<Shared<R, E>>);

impl<R, E> Clone for SearchWorker<R, E> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

pub struct WorkerSession<R, E> {
    request_id: u64,
    worker: SearchWorker<R, E>,
}

struct Pending<'a> {
    id: u64,
    ids: &'a RefCell<HashSet<u64>>,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.ids.borrow_mut().remove(&self.id);
    }
}

impl<R: Send + 'static, E: Send + 'static> SearchWorker<R, E> {
    pub(crate) fn spawn(
        name: &str,
        epoch: u64,
        timeout_code: &'static str,
        run: impl FnOnce(mpsc::Receiver<Command<R, E>>, CancellationToken) + Send + 'static,
    ) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::channel(CHANNEL_CAPACITY);
        let retired = CancellationToken::new();
        let exited = CancellationToken::new();
        let thread_exit = exited.clone();
        let thread_retire = retired.clone();
        let thread = thread::Builder::new().name(name.into()).spawn(move || {
            let _exit = thread_exit.drop_guard();
            run(receiver, thread_retire);
        })?;
        Ok(Self(Rc::new(Shared {
            epoch,
            timeout_code,
            next_request: Cell::new(0),
            pending: RefCell::new(HashSet::new()),
            sender: RefCell::new(Some(sender)),
            retired,
            exited,
            thread: RefCell::new(Some(thread)),
        })))
    }

    pub fn epoch(&self) -> u64 {
        self.0.epoch
    }

    pub fn available(&self) -> bool {
        !self.0.retired.is_cancelled() && !self.0.exited.is_cancelled()
    }

    pub fn begin_session(&self) -> Result<WorkerSession<R, E>, WorkerError> {
        let next = self.0.next_request.get() + 1;
        if !self.available() || next > MAX_SAFE_ORDINAL {
            return Err(WorkerError::Unavailable);
        }
        self.0.next_request.set(next);
        Ok(WorkerSession {
            request_id: next,
            worker: self.clone(),
        })
    }

    pub fn retire(&self) {
        self.0.retired.cancel();
        self.0.sender.borrow_mut().take();
    }

    pub async fn wait_closed(&self) -> Result<(), WorkerError> {
        self.0.exited.cancelled().await;
        loop {
            if self
                .0
                .thread
                .borrow()
                .as_ref()
                .is_none_or(JoinHandle::is_finished)
            {
                break;
            }
            sleep(Duration::from_millis(1)).await;
        }
        self.0.thread.borrow_mut().take().map_or(Ok(()), |handle| {
            handle.join().map_err(|_| WorkerError::Panicked)
        })
    }

    pub async fn request(
        &self,
        inputs: impl IntoIterator<Item = R>,
        signal: Option<&CancellationToken>,
        timeout: Duration,
        classify: impl Fn(&E) -> Response,
    ) -> Result<E, WorkerError> {
        if signal.is_some_and(CancellationToken::is_cancelled) {
            return Err(WorkerError::Aborted);
        }
        self.begin_session()?
            .request(inputs, signal, timeout, classify)
            .await
    }

    async fn perform(
        &self,
        request_id: u64,
        inputs: impl IntoIterator<Item = R>,
        signal: Option<&CancellationToken>,
        timeout: Duration,
        classify: impl Fn(&E) -> Response,
    ) -> Result<E, WorkerError> {
        if signal.is_some_and(CancellationToken::is_cancelled) {
            return Err(WorkerError::Aborted);
        }
        let sender = self
            .0
            .sender
            .borrow()
            .clone()
            .ok_or(WorkerError::Unavailable)?;
        {
            let mut pending = self.0.pending.borrow_mut();
            if pending.contains(&request_id) {
                return Err(WorkerError::Active);
            }
            if pending.len() >= CHANNEL_CAPACITY {
                return Err(WorkerError::Busy);
            }
            pending.insert(request_id);
        }
        let _pending = Pending {
            id: request_id,
            ids: &self.0.pending,
        };
        let identity = WorkerIdentity {
            epoch: self.0.epoch,
            request_id,
        };
        let (send, mut replies) = mpsc::channel(CHANNEL_CAPACITY);
        let reply = Reply { identity, send };
        let mut deadline = Instant::now() + timeout;
        let mut inputs = std::pin::pin!(async {
            for request in inputs {
                sender
                    .send(Command {
                        identity,
                        request,
                        reply: reply.clone(),
                    })
                    .await
                    .map_err(|_| WorkerError::Closed)?;
            }
            drop(reply);
            Ok::<(), WorkerError>(())
        });
        let mut sent = false;
        loop {
            tokio::select! {
                biased;
                () = self.0.retired.cancelled() => return Err(WorkerError::Unavailable),
                () = cancelled(signal) => return Err(WorkerError::Aborted),
                () = sleep_until(deadline) => {
                    self.retire();
                    return Err(WorkerError::Timeout(self.0.timeout_code));
                }
                result = &mut inputs, if !sent => {
                    result?;
                    sent = true;
                }
                event = replies.recv() => {
                    let (reply_identity, result) = event.ok_or(WorkerError::Closed)?;
                    if identity != reply_identity {
                        continue;
                    }
                    if matches!(result, Err(WorkerError::InvalidMessage)) {
                        self.retire();
                    }
                    let value = result?;
                    match classify(&value) {
                        Response::Complete => return Ok(value),
                        Response::Progress => deadline = Instant::now() + timeout,
                        Response::Continue => {},
                        Response::Mismatch => {
                            self.retire();
                            return Err(WorkerError::IdentityMismatch);
                        }
                    }
                }
            }
        }
    }
}

impl<R: Send + 'static, E: Send + 'static> WorkerSession<R, E> {
    pub fn identity(&self) -> WorkerIdentity {
        WorkerIdentity {
            epoch: self.worker.epoch(),
            request_id: self.request_id,
        }
    }

    pub async fn request(
        &self,
        inputs: impl IntoIterator<Item = R>,
        signal: Option<&CancellationToken>,
        timeout: Duration,
        classify: impl Fn(&E) -> Response,
    ) -> Result<E, WorkerError> {
        self.worker
            .perform(self.request_id, inputs, signal, timeout, classify)
            .await
    }
}

async fn cancelled(signal: Option<&CancellationToken>) {
    if let Some(signal) = signal {
        signal.cancelled().await
    } else {
        pending::<()>().await
    }
}
