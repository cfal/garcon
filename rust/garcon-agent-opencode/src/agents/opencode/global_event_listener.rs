//! Ports `server-agents/opencode/src/agents/opencode/global-event-listener.ts`.

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

use futures::{
    FutureExt, StreamExt,
    future::{LocalBoxFuture, Shared, pending},
};
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use indexmap::IndexMap;
use serde_json::json;
use tokio::{
    sync::oneshot,
    task::{JoinHandle, spawn_local},
    time::sleep,
};

use super::{
    request_control::OpenCodeTimeoutError,
    sdk_client::OpenCodeClient,
    sse_events::{SseEvent, stream_global_events},
};
use crate::js::{AbortSignal, SharedError, error, error_of, log_fields, shared_error, timer_delay};

type ReadyResult = Result<(), SharedError>;
type Ready = Shared<LocalBoxFuture<'static, ReadyResult>>;
type EventMatcher = Rc<dyn Fn(&SseEvent) -> bool>;
type WaitForEvent = Rc<
    dyn Fn(EventMatcher, Option<AbortSignal>) -> LocalBoxFuture<'static, ExecutorResult<SseEvent>>,
>;
type GetClient = Rc<dyn Fn() -> LocalBoxFuture<'static, ExecutorResult<Rc<dyn OpenCodeClient>>>>;
type ConfirmEventDelivery =
    Rc<dyn Fn(ConfirmEventDeliveryInput) -> LocalBoxFuture<'static, ExecutorResult<()>>>;
type HandleEvent = Rc<dyn Fn(Rc<dyn OpenCodeClient>, SseEvent) -> ExecutorResult<()>>;

pub struct ConfirmEventDeliveryInput {
    pub client: Rc<dyn OpenCodeClient>,
    pub directory: Option<String>,
    pub signal: AbortSignal,
    pub wait_for_event: WaitForEvent,
}

pub struct OpenCodeGlobalEventListenerOptions {
    pub request_timeout_ms: f64,
    pub heartbeat_timeout_ms: f64,
    pub retry_delay_ms: f64,
    pub logger: Rc<dyn AgentLogger>,
    pub get_client: GetClient,
    pub is_shutting_down: Rc<dyn Fn() -> bool>,
    pub is_temporarily_unavailable: Rc<dyn Fn() -> bool>,
    pub unavailable_retry_after_ms: Rc<dyn Fn() -> f64>,
    pub instance_generation: Option<Rc<dyn Fn() -> u64>>,
    pub mark_temporarily_unavailable: Rc<dyn Fn(String, Option<u64>) -> bool>,
    pub fail_running_turns: Rc<dyn Fn(SharedError)>,
    pub close_unavailable_instance_if_idle: Rc<dyn Fn() -> bool>,
    pub confirm_event_delivery: ConfirmEventDelivery,
    pub handle_event: HandleEvent,
}

struct EventWaiter {
    generation: u64,
    matches: EventMatcher,
    send: oneshot::Sender<Result<SseEvent, SharedError>>,
}

struct RemoveWaiter {
    listener: Weak<OpenCodeGlobalEventListener>,
    id: u64,
}

impl Drop for RemoveWaiter {
    fn drop(&mut self) {
        if let Some(listener) = self.listener.upgrade() {
            listener.state.borrow_mut().waiters.shift_remove(&self.id);
        }
    }
}

struct Attempt {
    generation: u64,
    signal: AbortSignal,
    ready: Ready,
    resolve_ready: RefCell<Option<oneshot::Sender<ReadyResult>>>,
    ready_observed: Cell<bool>,
    ready_timer: RefCell<Option<JoinHandle<()>>>,
    heartbeat_timer: RefCell<Option<JoinHandle<()>>>,
}

impl Attempt {
    fn new(generation: u64) -> Rc<Self> {
        let (resolve, ready) = oneshot::channel();
        Rc::new(Self {
            generation,
            signal: AbortSignal::new(),
            ready: async move {
                ready
                    .await
                    .unwrap_or_else(|_| Err(listener_closed_before_ready()))
            }
            .boxed_local()
            .shared(),
            resolve_ready: RefCell::new(Some(resolve)),
            ready_observed: Cell::new(false),
            ready_timer: RefCell::default(),
            heartbeat_timer: RefCell::default(),
        })
    }

    fn settle(&self, result: ReadyResult) {
        if let Some(resolve) = self.resolve_ready.take() {
            self.ready_observed.set(result.is_ok());
            abort_timer(self.ready_timer.take());
            let _ = resolve.send(result);
        }
    }

    fn clear_timers(&self) {
        abort_timer(self.ready_timer.take());
        abort_timer(self.heartbeat_timer.take());
    }
}

fn listener_closed_before_ready() -> SharedError {
    shared_error(
        "Error",
        "OpenCode event listener closed before it was ready",
    )
}

fn abort_timer(timer: Option<JoinHandle<()>>) {
    if let Some(timer) = timer {
        timer.abort();
    }
}

#[derive(Default)]
struct ListenerState {
    started: bool,
    generation: u64,
    attempt: Option<Rc<Attempt>>,
    retry_timer: Option<JoinHandle<()>>,
    readiness_directory: Option<String>,
    next_waiter: u64,
    waiters: IndexMap<u64, EventWaiter>,
}

pub struct OpenCodeGlobalEventListener {
    options: OpenCodeGlobalEventListenerOptions,
    state: RefCell<ListenerState>,
}

impl OpenCodeGlobalEventListener {
    pub fn new(options: OpenCodeGlobalEventListenerOptions) -> Rc<Self> {
        Rc::new(Self {
            options,
            state: RefCell::default(),
        })
    }

    pub fn close(&self) {
        let (attempt, retry, waiters) = {
            let mut state = self.state.borrow_mut();
            state.started = false;
            state.generation = state.generation.wrapping_add(1);
            (
                state.attempt.take(),
                state.retry_timer.take(),
                std::mem::take(&mut state.waiters),
            )
        };
        let failure = shared_error("Error", "OpenCode event listener closed");
        if let Some(attempt) = attempt {
            attempt.settle(Err(listener_closed_before_ready()));
            attempt.signal.abort(failure.clone());
            attempt.clear_timers();
        }
        abort_timer(retry);
        for (_, waiter) in waiters {
            let _ = waiter.send.send(Err(failure.clone()));
        }
    }

    pub fn wait_for_event(
        self: &Rc<Self>,
        matches: EventMatcher,
        signal: Option<AbortSignal>,
    ) -> LocalBoxFuture<'static, ExecutorResult<SseEvent>> {
        let generation = self.state.borrow().generation;
        self.wait_for_generation(generation, matches, signal)
    }

    fn wait_for_generation(
        self: &Rc<Self>,
        generation: u64,
        matches: EventMatcher,
        signal: Option<AbortSignal>,
    ) -> LocalBoxFuture<'static, ExecutorResult<SseEvent>> {
        let mut state = self.state.borrow_mut();
        if !state.started
            || state.generation != generation
            || state
                .attempt
                .as_ref()
                .is_some_and(|attempt| attempt.signal.aborted())
        {
            return async { Err(error("Error", "OpenCode event listener is not running")) }
                .boxed_local();
        }
        if let Some(reason) = signal.as_ref().and_then(AbortSignal::reason) {
            return async move { Err(reason.into()) }.boxed_local();
        }
        let id = state.next_waiter;
        state.next_waiter = id.wrapping_add(1);
        let (send, receive) = oneshot::channel();
        state.waiters.insert(
            id,
            EventWaiter {
                generation,
                matches,
                send,
            },
        );
        let remove = RemoveWaiter {
            listener: Rc::downgrade(self),
            id,
        };
        async move {
            let _remove = remove;
            let aborted = async {
                match signal.as_ref() {
                    Some(signal) => {
                        signal.token().cancelled().await;
                        signal.abort_reason()
                    }
                    None => pending().await,
                }
            };
            tokio::select! {
                biased;
                result = receive => result?.map_err(Into::into),
                reason = aborted => Err(reason.into()),
            }
        }
        .boxed_local()
    }

    pub fn start(
        self: &Rc<Self>,
        directory: Option<String>,
    ) -> LocalBoxFuture<'static, ExecutorResult<()>> {
        let mut state = self.state.borrow_mut();
        if let Some(directory) = directory.filter(|directory| !directory.is_empty()) {
            state.readiness_directory = Some(directory);
        }
        abort_timer(state.retry_timer.take());
        if state.started {
            return await_ready(state.attempt.as_ref().map(|attempt| attempt.ready.clone()));
        }
        state.started = true;
        state.generation = state.generation.wrapping_add(1);
        let attempt = Attempt::new(state.generation);
        let ready = attempt.ready.clone();
        let directory = state.readiness_directory.clone();
        state.attempt = Some(attempt.clone());
        drop(state);

        let timeout_ms = self.options.request_timeout_ms;
        let waiting = sleep(timer_delay(timeout_ms));
        let weak_attempt = Rc::downgrade(&attempt);
        attempt.ready_timer.replace(Some(spawn_local(async move {
            waiting.await;
            if let Some(attempt) = weak_attempt.upgrade() {
                let failure = SharedError::new(OpenCodeTimeoutError::new(
                    "OpenCode event stream readiness",
                    timeout_ms,
                ));
                attempt.signal.abort(failure.clone());
                attempt.settle(Err(failure));
            }
        })));
        spawn_local({
            let listener = self.clone();
            async move {
                listener.run(attempt, directory).await;
            }
        });
        await_ready(Some(ready))
    }

    async fn run(self: Rc<Self>, attempt: Rc<Attempt>, directory: Option<String>) {
        let mut instance_generation = None;
        if let Err(failure) = self
            .read_events(&attempt, directory, &mut instance_generation)
            .await
        {
            self.stream_failed(&attempt, failure.into(), instance_generation);
        }
        self.reject_generation(
            attempt.generation,
            shared_error(
                "Error",
                "OpenCode event stream ended before event delivery confirmation",
            ),
        );
        attempt.clear_timers();
        if self.is_current(attempt.generation) {
            self.state.borrow_mut().attempt = None;
        }
    }

    async fn read_events(
        self: &Rc<Self>,
        attempt: &Rc<Attempt>,
        directory: Option<String>,
        instance_generation: &mut Option<u64>,
    ) -> ExecutorResult<()> {
        let client = (self.options.get_client)().await?;
        if !self.is_current(attempt.generation) {
            return Err(error(
                "Error",
                "OpenCode event listener was superseded during startup",
            ));
        }
        *instance_generation = self
            .options
            .instance_generation
            .as_ref()
            .map(|capture| capture());
        let mut confirmation_started = false;
        let mut events = stream_global_events(client.as_ref(), &attempt.signal, {
            let listener = self.clone();
            let attempt = attempt.clone();
            let client = client.clone();
            move || {
                if !std::mem::replace(&mut confirmation_started, true) {
                    listener.arm_heartbeat(&attempt);
                    listener.confirm_delivery(attempt.clone(), client.clone(), directory.clone());
                }
            }
        })
        .await?;
        while let Some(event) = events.next().await {
            let event = event?;
            if !self.is_current(attempt.generation) {
                return Ok(());
            }
            self.arm_heartbeat(attempt);
            self.resolve_event_waiters(attempt.generation, &event);
            (self.options.handle_event)(client.clone(), event)?;
            tokio::task::yield_now().await;
        }
        Ok(())
    }

    fn confirm_delivery(
        self: &Rc<Self>,
        attempt: Rc<Attempt>,
        client: Rc<dyn OpenCodeClient>,
        directory: Option<String>,
    ) {
        let wait_for_event = {
            let listener = self.clone();
            let generation = attempt.generation;
            Rc::new(move |matches, signal| {
                listener.wait_for_generation(generation, matches, signal)
            })
        };
        let confirmation = (self.options.confirm_event_delivery)(ConfirmEventDeliveryInput {
            client,
            directory,
            signal: attempt.signal.clone(),
            wait_for_event,
        });
        let listener = self.clone();
        spawn_local(async move {
            match confirmation.await {
                Ok(()) if listener.is_current(attempt.generation) => attempt.settle(Ok(())),
                Err(failure) => {
                    let failure = SharedError::from(failure);
                    attempt.settle(Err(failure.clone()));
                    attempt.signal.abort(failure);
                }
                Ok(()) => {}
            }
        });
    }

    fn arm_heartbeat(self: &Rc<Self>, attempt: &Attempt) {
        abort_timer(attempt.heartbeat_timer.take());
        let listener = Rc::downgrade(self);
        let generation = attempt.generation;
        let signal = attempt.signal.clone();
        let timeout_ms = self.options.heartbeat_timeout_ms;
        let watchdog = sleep(timer_delay(timeout_ms));
        attempt
            .heartbeat_timer
            .replace(Some(spawn_local(async move {
                watchdog.await;
                let Some(listener) = listener.upgrade() else {
                    return;
                };
                if listener.is_current(generation) && !(listener.options.is_shutting_down)() {
                    signal.abort(SharedError::new(OpenCodeTimeoutError::new(
                        "OpenCode event stream heartbeat",
                        timeout_ms,
                    )));
                }
            })));
    }

    fn stream_failed(
        self: &Rc<Self>,
        attempt: &Attempt,
        failure: SharedError,
        instance_generation: Option<u64>,
    ) {
        attempt.settle(Err(failure.clone()));
        if !attempt.signal.aborted() {
            attempt.signal.abort(failure.clone());
        }
        if !self.is_current(attempt.generation) {
            return;
        }
        if !attempt.ready_observed.get() || error_of::<OpenCodeTimeoutError>(&*failure).is_some() {
            let reason = failure.to_string();
            if (self.options.mark_temporarily_unavailable)(reason.clone(), instance_generation) {
                self.options.logger.warn(
                    "OpenCode event stream marked the runtime unavailable",
                    Some(&log_fields([("reason", json!(reason))])),
                );
            }
        }
        if !self.is_current(attempt.generation) {
            return;
        }
        (self.options.fail_running_turns)(failure.clone());
        if (self.options.is_temporarily_unavailable)()
            && (self.options.close_unavailable_instance_if_idle)()
        {
            return;
        }
        let delay_ms = if (self.options.is_temporarily_unavailable)() {
            self.options
                .retry_delay_ms
                .max((self.options.unavailable_retry_after_ms)().min(30_000.0))
        } else {
            self.options.retry_delay_ms
        };
        self.options.logger.error(
            "OpenCode SSE listener failed and will reconnect",
            Some(&log_fields([
                (
                    "retrySeconds",
                    json!(garcon_js::math_round(delay_ms / 1000.0)),
                ),
                ("error", json!(failure.to_string())),
            ])),
        );
        let mut state = self.state.borrow_mut();
        state.started = false;
        if state
            .attempt
            .as_ref()
            .is_some_and(|current| current.generation == attempt.generation)
        {
            state.attempt = None;
        }
        let listener = Rc::downgrade(self);
        let delay = sleep(timer_delay(delay_ms));
        state.retry_timer = Some(spawn_local(async move {
            delay.await;
            let Some(listener) = listener.upgrade() else {
                return;
            };
            listener.state.borrow_mut().retry_timer = None;
            if let Err(error) = listener.start(None).await {
                listener.options.logger.error(
                    "OpenCode SSE listener restart failed",
                    Some(&log_fields([("error", json!(error.to_string()))])),
                );
            }
        }));
    }

    fn is_current(&self, generation: u64) -> bool {
        self.state.borrow().generation == generation
    }

    fn resolve_event_waiters(&self, generation: u64, event: &SseEvent) {
        let candidates: Vec<_> = self
            .state
            .borrow()
            .waiters
            .iter()
            .filter(|(_, waiter)| waiter.generation == generation)
            .map(|(&id, waiter)| (id, waiter.matches.clone()))
            .collect();
        for (id, matches) in candidates {
            if matches(event)
                && let Some(waiter) = self.state.borrow_mut().waiters.shift_remove(&id)
            {
                let _ = waiter.send.send(Ok(event.clone()));
            }
        }
    }

    fn reject_generation(&self, generation: u64, failure: SharedError) {
        let mut state = self.state.borrow_mut();
        let ids: Vec<_> = state
            .waiters
            .iter()
            .filter(|(_, waiter)| waiter.generation == generation)
            .map(|(&id, _)| id)
            .collect();
        for id in ids {
            if let Some(waiter) = state.waiters.shift_remove(&id) {
                let _ = waiter.send.send(Err(failure.clone()));
            }
        }
    }
}

fn await_ready(ready: Option<Ready>) -> LocalBoxFuture<'static, ExecutorResult<()>> {
    async move {
        match ready {
            Some(ready) => ready.await.map_err(Into::into),
            None => Ok(()),
        }
    }
    .boxed_local()
}

#[cfg(test)]
mod tests;
