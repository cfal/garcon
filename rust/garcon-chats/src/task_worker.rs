//! Controller-side supervisor for `server/controller/lib/task-worker.ts`.
//! Owned inputs (including stored rows) move across the channel without a
//! structured clone or a serialization pass on the controller.

use std::{
    cell::RefCell,
    collections::VecDeque,
    rc::Rc,
    sync::{Arc, mpsc},
    thread,
};

use garcon_base::{domain_error::DomainError, keyed_lock::LockAborted};
use garcon_contract::error_codes::ErrorCode;
use tokio::{sync::oneshot, task};
use tokio_util::sync::CancellationToken;

const MAX_QUEUED_TASKS: usize = 8;

#[derive(Debug, thiserror::Error)]
pub enum TaskWorkerError<E> {
    #[error("{0} is closed")]
    Closed(&'static str),
    #[error(transparent)]
    Busy(DomainError),
    #[error(transparent)]
    Aborted(#[from] LockAborted),
    #[error("{label} worker failed: {cause}")]
    Spawn {
        label: &'static str,
        #[source]
        cause: std::io::Error,
    },
    #[error("{0} worker exited")]
    Exited(&'static str),
    #[error("{0} worker message failed")]
    Send(&'static str),
    #[error(transparent)]
    Task(E),
}

impl<E> TaskWorkerError<E> {
    pub fn domain_error(&self) -> Option<&DomainError> {
        match self {
            Self::Busy(error) => Some(error),
            _ => None,
        }
    }
}

type ResultFor<O, E> = Result<O, TaskWorkerError<E>>;
type Handler<I, O, E> = dyn Fn(I, &CancellationToken) -> Result<O, E> + Send + Sync;

struct Reply<O, E> {
    sender: oneshot::Sender<ResultFor<O, E>>,
    done: CancellationToken,
}

impl<O: Send + 'static, E> Reply<O, E> {
    fn finish(self, result: ResultFor<O, E>) {
        self.done.cancel();
        if let Err(Ok(abandoned)) = self.sender.send(result) {
            task::spawn_blocking(move || drop(abandoned));
        }
    }
}

struct Queued<I, O, E> {
    id: u64,
    input: I,
    reply: Reply<O, E>,
    signal: Option<CancellationToken>,
}

struct Active<O, E> {
    id: u64,
    reply: Reply<O, E>,
    stop: CancellationToken,
    signal: Option<CancellationToken>,
}

struct Command<I, O, E> {
    input: I,
    result: oneshot::Sender<Result<O, E>>,
    stop: CancellationToken,
}

struct Worker<I, O, E> {
    commands: mpsc::SyncSender<Command<I, O, E>>,
    thread: thread::JoinHandle<()>,
}

struct State<I, O, E> {
    next_id: u64,
    queue: VecDeque<Queued<I, O, E>>,
    active: Option<Active<O, E>>,
    worker: Option<Worker<I, O, E>>,
    retiring: bool,
    closed: bool,
}

struct Supervisor<I, O, E> {
    name: &'static str,
    label: &'static str,
    handler: Arc<Handler<I, O, E>>,
    state: RefCell<State<I, O, E>>,
}

pub struct TaskWorker<I, O, E>(Rc<Supervisor<I, O, E>>);

impl<I, O, E> Clone for TaskWorker<I, O, E> {
    fn clone(&self) -> Self {
        Self(Rc::clone(&self.0))
    }
}

impl<I: Send + 'static, O: Send + 'static, E: Send + 'static> TaskWorker<I, O, E> {
    pub fn new(
        name: &'static str,
        label: &'static str,
        handler: impl Fn(I, &CancellationToken) -> Result<O, E> + Send + Sync + 'static,
    ) -> Self {
        Self(Rc::new(Supervisor {
            name,
            label,
            handler: Arc::new(handler),
            state: RefCell::new(State {
                next_id: 0,
                queue: VecDeque::new(),
                active: None,
                worker: None,
                retiring: false,
                closed: false,
            }),
        }))
    }

    pub fn run(
        &self,
        input: I,
        signal: Option<&CancellationToken>,
    ) -> impl Future<Output = ResultFor<O, E>> + use<I, O, E> {
        let admission = self.enqueue(input, signal);
        let label = self.0.label;
        async move {
            admission?
                .await
                .unwrap_or(Err(TaskWorkerError::Closed(label)))
        }
    }

    fn enqueue(
        &self,
        input: I,
        signal: Option<&CancellationToken>,
    ) -> Result<oneshot::Receiver<ResultFor<O, E>>, TaskWorkerError<E>> {
        let mut state = self.0.state.borrow_mut();
        let mut index = 0;
        while let Some(queued) = state.queue.get(index) {
            if queued
                .signal
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
                && let Some(queued) = state.queue.remove(index)
            {
                queued
                    .reply
                    .finish(Err(TaskWorkerError::Aborted(LockAborted)));
                task::spawn_blocking(move || drop(queued.input));
            } else {
                index += 1;
            }
        }
        let failure = if state.closed {
            Some(TaskWorkerError::Closed(self.0.label))
        } else if signal.is_some_and(CancellationToken::is_cancelled) {
            Some(TaskWorkerError::Aborted(LockAborted))
        } else if state.queue.len() >= MAX_QUEUED_TASKS {
            Some(TaskWorkerError::Busy(DomainError::new(
                ErrorCode::TRANSCRIPT_WORK_BUSY,
                format!("{} capacity is full. Try again later.", self.0.label),
                503,
                true,
            )))
        } else {
            None
        };
        if let Some(failure) = failure {
            task::spawn_blocking(move || drop(input));
            return Err(failure);
        }

        let (sender, result) = oneshot::channel();
        let done = CancellationToken::new();
        state.next_id = state.next_id.wrapping_add(1);
        let id = state.next_id;
        state.queue.push_back(Queued {
            id,
            input,
            reply: Reply {
                sender,
                done: done.clone(),
            },
            signal: signal.cloned(),
        });
        drop(state);
        if let Some(signal) = signal.cloned() {
            let this = self.clone();
            task::spawn_local(async move {
                tokio::select! {
                    biased;
                    () = done.cancelled() => (),
                    () = signal.cancelled() => this.abort(id),
                }
            });
        }
        self.pump();
        Ok(result)
    }

    pub fn close(&self) {
        let mut state = self.0.state.borrow_mut();
        if state.closed {
            return;
        }
        state.closed = true;
        if let Some(active) = state.active.take() {
            active.stop.cancel();
            active
                .reply
                .finish(Err(TaskWorkerError::Closed(self.0.label)));
        }
        let discarded: Vec<I> = state
            .queue
            .drain(..)
            .map(|queued| {
                queued
                    .reply
                    .finish(Err(TaskWorkerError::Closed(self.0.label)));
                queued.input
            })
            .collect();
        task::spawn_blocking(move || drop(discarded));
        drop(state);
        self.retire();
    }

    fn abort(&self, id: u64) {
        let mut state = self.0.state.borrow_mut();
        if let Some(index) = state.queue.iter().position(|queued| queued.id == id)
            && let Some(queued) = state.queue.remove(index)
        {
            queued
                .reply
                .finish(Err(TaskWorkerError::Aborted(LockAborted)));
            task::spawn_blocking(move || drop(queued.input));
        } else if state.active.as_ref().is_some_and(|active| active.id == id)
            && let Some(active) = state.active.take()
        {
            active.stop.cancel();
            active
                .reply
                .finish(Err(TaskWorkerError::Aborted(LockAborted)));
            drop(state);
            self.retire();
        }
    }

    fn pump(&self) {
        loop {
            let mut state = self.0.state.borrow_mut();
            if state.closed || state.retiring || state.active.is_some() {
                return;
            }
            let Some(queued) = state.queue.pop_front() else {
                return;
            };
            if queued
                .signal
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
            {
                queued
                    .reply
                    .finish(Err(TaskWorkerError::Aborted(LockAborted)));
                task::spawn_blocking(move || drop(queued.input));
                continue;
            }
            let worker = match &state.worker {
                Some(worker) => worker,
                None => match self.spawn() {
                    Ok(worker) => state.worker.insert(worker),
                    Err(cause) => {
                        queued.reply.finish(Err(TaskWorkerError::Spawn {
                            label: self.0.label,
                            cause,
                        }));
                        task::spawn_blocking(move || drop(queued.input));
                        continue;
                    }
                },
            };
            let stop = CancellationToken::new();
            let (sender, result) = oneshot::channel();
            let id = queued.id;
            let command = Command {
                input: queued.input,
                result: sender,
                stop: stop.clone(),
            };
            if let Err(send) = worker.commands.try_send(command) {
                queued
                    .reply
                    .finish(Err(TaskWorkerError::Send(self.0.label)));
                task::spawn_blocking(move || drop(send));
                drop(state);
                self.retire();
                return;
            }
            state.active = Some(Active {
                id,
                reply: queued.reply,
                stop,
                signal: queued.signal,
            });
            let this = self.clone();
            task::spawn_local(async move {
                this.receive(id, result.await);
            });
            return;
        }
    }

    fn spawn(&self) -> std::io::Result<Worker<I, O, E>> {
        let (commands, receiver) = mpsc::sync_channel::<Command<I, O, E>>(1);
        let handler = Arc::clone(&self.0.handler);
        let thread = thread::Builder::new()
            .name(format!("garcon-{}", self.0.name))
            .spawn(move || {
                while let Ok(command) = receiver.recv() {
                    if !command.stop.is_cancelled() {
                        let result = handler(command.input, &command.stop);
                        let _ = command.result.send(result);
                    }
                }
            })?;
        Ok(Worker { commands, thread })
    }

    fn receive(&self, id: u64, result: Result<Result<O, E>, oneshot::error::RecvError>) {
        let mut state = self.0.state.borrow_mut();
        if state.active.as_ref().is_none_or(|active| active.id != id) {
            task::spawn_blocking(move || drop(result));
            return;
        }
        let Some(active) = state.active.take() else {
            return;
        };
        drop(state);
        if active
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            active.stop.cancel();
            active
                .reply
                .finish(Err(TaskWorkerError::Aborted(LockAborted)));
            task::spawn_blocking(move || drop(result));
            self.retire();
            return;
        }
        match result {
            Ok(result) => {
                active.reply.finish(result.map_err(TaskWorkerError::Task));
                self.pump();
            }
            Err(_) => {
                active
                    .reply
                    .finish(Err(TaskWorkerError::Exited(self.0.label)));
                self.retire();
            }
        }
    }

    fn retire(&self) {
        let mut state = self.0.state.borrow_mut();
        let Some(worker) = state.worker.take() else {
            return;
        };
        state.retiring = true;
        drop(state);
        drop(worker.commands);
        let this = self.clone();
        task::spawn_local(async move {
            // A Rust thread cannot be killed. Retire its delivery immediately
            // and let its pure transform settle before starting another one.
            let _ = task::spawn_blocking(move || worker.thread.join().is_ok()).await;
            this.0.state.borrow_mut().retiring = false;
            this.pump();
        });
    }
}
