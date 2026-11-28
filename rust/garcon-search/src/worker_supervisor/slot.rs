use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
    time::Duration,
};

use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use super::{Response, SearchWorker, WorkerError, cancelled};

#[derive(Debug, thiserror::Error)]
pub enum WorkerSlotError {
    #[error(transparent)]
    Worker(#[from] WorkerError),
    #[error("Could not start transcript search worker: {0}")]
    Spawn(#[from] std::io::Error),
}

/// Owns a connection's worker generation even after that generation stops delivering replies.
pub struct WorkerSlot<R, E> {
    spawn: fn(u64) -> std::io::Result<SearchWorker<R, E>>,
    open: fn(PathBuf) -> R,
    close: fn() -> R,
    opened: fn(&E) -> bool,
    closed: fn(&E) -> bool,
    epoch: Cell<u64>,
    current: RefCell<Option<SearchWorker<R, E>>>,
    changing: Cell<bool>,
    admitted: Cell<bool>,
}

struct Changing<'a>(&'a Cell<bool>);

impl Drop for Changing<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

struct RetireOnDrop<'a, R: Send + 'static, E: Send + 'static>(Option<&'a SearchWorker<R, E>>);

impl<R: Send + 'static, E: Send + 'static> Drop for RetireOnDrop<'_, R, E> {
    fn drop(&mut self) {
        if let Some(worker) = self.0 {
            worker.retire();
        }
    }
}

impl<R: Send + 'static, E: Send + 'static> WorkerSlot<R, E> {
    pub(crate) fn new(
        spawn: fn(u64) -> std::io::Result<SearchWorker<R, E>>,
        open: fn(PathBuf) -> R,
        close: fn() -> R,
        opened: fn(&E) -> bool,
        closed: fn(&E) -> bool,
    ) -> Self {
        Self {
            spawn,
            open,
            close,
            opened,
            closed,
            epoch: Cell::new(0),
            current: RefCell::new(None),
            changing: Cell::new(false),
            admitted: Cell::new(false),
        }
    }

    pub fn worker(&self) -> Option<SearchWorker<R, E>> {
        if !self.admitted.get() {
            return None;
        }
        self.current
            .borrow()
            .as_ref()
            .filter(|worker| worker.available())
            .cloned()
    }

    pub fn retire(&self) {
        self.admitted.set(false);
        if let Some(worker) = self.current.borrow().as_ref() {
            worker.retire();
        }
    }

    fn begin_change(&self) -> Result<Changing<'_>, WorkerError> {
        if self.changing.replace(true) {
            return Err(WorkerError::Active);
        }
        Ok(Changing(&self.changing))
    }

    pub async fn start(
        &self,
        path: PathBuf,
        signal: Option<&CancellationToken>,
        deadline: Duration,
    ) -> Result<E, WorkerSlotError> {
        if signal.is_some_and(CancellationToken::is_cancelled) {
            return Err(WorkerError::Aborted.into());
        }
        let _change = self.begin_change()?;
        if self.worker().is_some() {
            return Err(WorkerError::Active.into());
        }
        let previous = self.current.borrow().clone();
        if let Some(previous) = previous {
            tokio::select! { biased;
                () = cancelled(signal) => return Err(WorkerError::Aborted.into()),
                _ = previous.wait_closed() => {},
            }
        }
        self.admitted.set(false);
        let epoch = self
            .epoch
            .get()
            .checked_add(1)
            .ok_or(WorkerError::Unavailable)?;
        self.epoch.set(epoch);
        let worker = (self.spawn)(epoch)?;
        self.current.replace(Some(worker.clone()));
        let mut retire = RetireOnDrop(Some(&worker));
        let opened = worker
            .request([(self.open)(path)], signal, deadline, |event| {
                if (self.opened)(event) {
                    Response::Complete
                } else {
                    Response::Mismatch
                }
            })
            .await?;
        self.admitted.set(true);
        retire.0 = None;
        Ok(opened)
    }

    pub async fn stop(&self, deadline: Duration) -> Result<(), WorkerError> {
        let _change = self.begin_change()?;
        self.admitted.set(false);
        let Some(worker) = self.current.borrow().clone() else {
            return Ok(());
        };
        let mut retire = RetireOnDrop(Some(&worker));
        if worker.available() {
            let close = worker.request([(self.close)()], None, deadline, |event| {
                if (self.closed)(event) {
                    Response::Complete
                } else {
                    Response::Mismatch
                }
            });
            if close.await.is_err() {
                worker.retire();
            }
        }
        let ended = match timeout(deadline, worker.wait_closed()).await {
            Ok(ended) => ended,
            Err(_) => {
                worker.retire();
                worker.wait_closed().await
            }
        };
        self.current.take();
        retire.0 = None;
        ended
    }
}
