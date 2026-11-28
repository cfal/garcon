//! Ports the controller's stateless TaskWorker supervisor. Owned inputs and
//! outputs move through typed channels; there is no structured clone to batch
//! and no dynamically typed event or task ID to validate at receipt.
//!
//! A Rust thread cannot be terminated like a Bun Worker. Cancellation retires
//! the result and signals the handler immediately. Handlers must check the
//! token during long operations. The successor waits for the former handler's
//! slot, even if it ignores cancellation, so retired threads cannot pile up.

use std::{
    any::Any,
    cell::RefCell,
    error::Error,
    future::pending,
    io,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{Arc, mpsc},
    thread,
};

use garcon_contract::error_codes::ErrorCode;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};
use tokio_util::sync::CancellationToken;

use crate::{
    domain_error::DomainError,
    errors::{NamedError, error_metadata},
    keyed_lock::LockAborted,
};

const MAX_QUEUED_TASKS: usize = 8;

/// A task error crosses the thread boundary as its original message and code.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct TaskFailure {
    pub message: String,
    pub code: Option<String>,
}

impl TaskFailure {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    pub fn from_error(error: &(dyn Error + 'static)) -> Self {
        Self {
            message: error.to_string(),
            code: error_metadata(error).code.map(str::to_owned),
        }
    }

    fn into_error(self) -> Box<dyn Error> {
        NamedError {
            name: "Error".into(),
            message: self.message,
            code: self.code,
        }
        .into()
    }
}

pub type TaskWorkerResult<T> = Result<T, Box<dyn Error>>;
type Handler<T, I, O> =
    dyn Fn(T, Vec<I>, &CancellationToken) -> Result<O, TaskFailure> + Send + Sync;
type WorkerSlot<T, I, O> = RefCell<Option<mpsc::Sender<Job<T, I, O>>>>;

/// Runs one task at a time on a lazily started, reusable thread.
pub struct TaskWorker<T, I, O> {
    thread_name: String,
    label: String,
    handler: Arc<Handler<T, I, O>>,
    thread: WorkerSlot<T, I, O>,
    admitted: Arc<Semaphore>,
    running: Arc<Semaphore>,
    closed: CancellationToken,
}

impl<T: Send + 'static, I: Send + 'static, O: Send + 'static> TaskWorker<T, I, O> {
    pub fn new(
        thread_name: impl Into<String>,
        label: impl Into<String>,
        handler: impl Fn(T, Vec<I>, &CancellationToken) -> Result<O, TaskFailure>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        Self {
            thread_name: thread_name.into(),
            label: label.into(),
            handler: Arc::new(handler),
            thread: RefCell::default(),
            admitted: Arc::new(Semaphore::new(MAX_QUEUED_TASKS + 1)),
            running: Arc::new(Semaphore::new(1)),
            closed: CancellationToken::new(),
        }
    }

    pub async fn run(
        &self,
        task: T,
        items: Vec<I>,
        signal: Option<&CancellationToken>,
    ) -> TaskWorkerResult<O> {
        self.run_with_abort_reason(task, items, signal, || LockAborted.into())
            .await
    }

    pub async fn run_with_abort_reason(
        &self,
        task: T,
        items: Vec<I>,
        signal: Option<&CancellationToken>,
        abort_reason: impl FnOnce() -> Box<dyn Error>,
    ) -> TaskWorkerResult<O> {
        if self.closed.is_cancelled() {
            return Err(self.closed_error());
        }
        if signal.is_some_and(CancellationToken::is_cancelled) {
            return Err(abort_reason());
        }
        let admitted = self.admitted.clone().try_acquire_owned().map_err(|_| {
            DomainError::new(
                ErrorCode::TRANSCRIPT_WORK_BUSY,
                format!("{} capacity is full. Try again later.", self.label),
                503,
                true,
            )
        })?;
        let cancelled = async {
            match signal {
                Some(signal) => signal.cancelled().await,
                None => pending().await,
            }
        };
        tokio::pin!(cancelled);
        let running = tokio::select! {
            biased;
            () = self.closed.cancelled() => return Err(self.closed_error()),
            () = &mut cancelled => return Err(abort_reason()),
            permit = self.running.clone().acquire_owned() => permit?,
        };
        let (reply, result) = oneshot::channel();
        let token = self.closed.child_token();
        let job = Job {
            task,
            items,
            token: token.clone(),
            reply,
            slots: (admitted, running),
        };
        self.dispatch(job)?;
        let mut active = ActiveJob {
            token,
            thread: &self.thread,
            keep_thread: false,
        };
        let completion = tokio::select! {
            biased;
            () = self.closed.cancelled() => return Err(self.closed_error()),
            () = &mut cancelled => return Err(abort_reason()),
            result = result => result.map_err(|_| self.worker_error("worker exited"))?,
        };
        match completion.result {
            Ok(result) => {
                active.keep_thread = true;
                result.map_err(TaskFailure::into_error)
            }
            Err(panic) => Err(self.worker_error(&format!("worker failed: {panic}"))),
        }
    }

    /// Rejects active and queued waiters and signals the thread to stop.
    pub fn close(&self) {
        self.closed.cancel();
        self.thread.borrow_mut().take();
    }

    fn closed_error(&self) -> Box<dyn Error> {
        self.worker_error("is closed")
    }

    fn worker_error(&self, message: &str) -> Box<dyn Error> {
        format!("{} {message}", self.label).into()
    }

    fn dispatch(&self, job: Job<T, I, O>) -> TaskWorkerResult<()> {
        let mut thread = self.thread.borrow_mut();
        if thread.is_none() {
            *thread = Some(
                spawn_worker(self.thread_name.clone(), self.handler.clone())
                    .map_err(|error| self.worker_error(&format!("worker failed: {error}")))?,
            );
        }
        if thread
            .as_ref()
            .is_some_and(|thread| thread.send(job).is_ok())
        {
            Ok(())
        } else {
            thread.take();
            Err(self.worker_error("worker exited"))
        }
    }
}

impl<T, I, O> Drop for TaskWorker<T, I, O> {
    fn drop(&mut self) {
        self.closed.cancel();
    }
}

struct ActiveJob<'a, T, I, O> {
    token: CancellationToken,
    thread: &'a WorkerSlot<T, I, O>,
    keep_thread: bool,
}

impl<T, I, O> Drop for ActiveJob<'_, T, I, O> {
    fn drop(&mut self) {
        if !self.keep_thread {
            self.token.cancel();
            self.thread.borrow_mut().take();
        }
    }
}

type Slots = (OwnedSemaphorePermit, OwnedSemaphorePermit);

struct Job<T, I, O> {
    task: T,
    items: Vec<I>,
    token: CancellationToken,
    reply: oneshot::Sender<Completion<O>>,
    slots: Slots,
}

struct Completion<O> {
    result: Result<Result<O, TaskFailure>, String>,
    _slots: Slots,
}

fn spawn_worker<T: Send + 'static, I: Send + 'static, O: Send + 'static>(
    name: String,
    handler: Arc<Handler<T, I, O>>,
) -> io::Result<mpsc::Sender<Job<T, I, O>>> {
    let (send, jobs) = mpsc::channel::<Job<T, I, O>>();
    thread::Builder::new().name(name).spawn(move || {
        for Job {
            task,
            items,
            token,
            reply,
            slots,
        } in jobs
        {
            if token.is_cancelled() {
                break;
            }
            let result = catch_unwind(AssertUnwindSafe(|| handler(task, items, &token)))
                .map_err(|panic| panic_message(panic.as_ref()).to_owned());
            // The controller retains the permits until it processes the outcome.
            let retire = result.is_err() || token.is_cancelled();
            let sent = reply
                .send(Completion {
                    result,
                    _slots: slots,
                })
                .is_ok();
            if retire || !sent {
                break;
            }
        }
    })?;
    Ok(send)
}

fn panic_message(value: &(dyn Any + Send)) -> &str {
    value
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| value.downcast_ref::<&'static str>().copied())
        .unwrap_or("worker panicked")
}

#[cfg(test)]
mod tests;
