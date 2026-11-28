//! Ports `server-agents/opencode/src/agents/opencode/opencode.ts`.

use std::{
    cell::{Cell, RefCell},
    error::Error,
    ffi::OsStr,
    rc::{Rc, Weak},
};

use futures::{
    FutureExt,
    future::{LocalBoxFuture, Shared},
};
use garcon_agents_common::{
    execution::runtime_events::{AgentRuntimeEvent, AgentRuntimeOperation, ProviderRunOutcome},
    which::which,
};
use garcon_interface::{
    host::AgentLogger,
    producer::{AgentFinalResponse, AgentRunFailureDetail},
    resources::ExecutorResult,
};
use garcon_js::{json::Opaque, number_to_string};
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use tokio::{sync::oneshot, task::spawn_local};

use super::{
    endpoint_coordinator::{
        OpenCodeEndpointCoordinator, OpenCodeEndpointCoordinatorOptions, OpenCodeEndpointRequest,
        OpenCodeRequestControl, OpenCodeRequestTimeout,
    },
    global_event_listener::{OpenCodeGlobalEventListener, OpenCodeGlobalEventListenerOptions},
    idle_lifecycle::{OpenCodeIdleLifecycle, OpenCodeIdleLifecycleOptions},
    instance_lifecycle::{
        OpenCodeInstance, OpenCodeInstanceCreationTracker, OpenCodeServerTermination,
        close_open_code_instance,
    },
    model_catalog::OpenCodeModelOption,
    model_discovery::{OpenCodeModelDiscovery, OpenCodeModelDiscoveryOptions},
    opencode_auth::OpenCodeAuthRuntime,
    operation_routes::OpenCodeOperationRoutes,
    permissions::{OpenCodeDecisionController, OpenCodeDecisionControllerOptions},
    request_control::{OpenCodeTimeoutError, with_abortable_timeout},
    runtime_options::{
        NormalizedOpenCodeRuntimeOptions, OpenCodeRuntimeOptions,
        normalize_open_code_runtime_options,
    },
    sdk_client::{OpenCodeClient, OpenCodeRequest},
    sdk_result::{OpenCodeRequestScope, OpenCodeSdkResult, with_open_code_request_scope},
    steering::{OpenCodeSteeringController, OpenCodeSteeringOptions},
    turn_events::{OpenCodeSession, SessionStatus},
};
use crate::{
    config::OpenCodeConfig,
    js::{AbortSignal, SharedError, error, error_of, log_fields, shared_error},
};

mod events;
mod sessions;
mod single_query;
#[cfg(test)]
mod tests;
mod turns;

struct SilentLogger;

impl AgentLogger for SilentLogger {
    fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn warn(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
}

type Startup = Shared<LocalBoxFuture<'static, Result<Rc<OpenCodeInstance>, SharedError>>>;
type Shutdown = Shared<LocalBoxFuture<'static, ()>>;
type AbortWork = Shared<LocalBoxFuture<'static, bool>>;
type TurnResult = Result<(), SharedError>;

pub struct OpenCodeRuntime {
    config: OpenCodeConfig,
    logger: Rc<dyn AgentLogger>,
    options: NormalizedOpenCodeRuntimeOptions,
    new_id: Rc<dyn Fn() -> String>,
    instance: RefCell<Option<Rc<OpenCodeInstance>>>,
    generation: Cell<u64>,
    deliberately_closed: RefCell<Vec<Weak<OpenCodeInstance>>>,
    pending_session_deletions: RefCell<IndexMap<String, OpenCodeRequestScope>>,
    startup: RefCell<Option<Startup>>,
    startup_signal: RefCell<Option<AbortSignal>>,
    shutdown: RefCell<Option<Shutdown>>,
    shutting_down: Cell<bool>,
    sessions: RefCell<IndexMap<String, OpenCodeSession>>,
    pending_session_aborts: RefCell<IndexMap<OpenCodeSession, AbortWork>>,
    turn_waiters: RefCell<IndexMap<String, oneshot::Sender<TurnResult>>>,
    decisions: Rc<OpenCodeDecisionController>,
    pub steering: Rc<OpenCodeSteeringController>,
    endpoint: Rc<OpenCodeEndpointCoordinator>,
    listener: Rc<OpenCodeGlobalEventListener>,
    routes: OpenCodeOperationRoutes,
    models: Rc<OpenCodeModelDiscovery>,
    idle: Rc<OpenCodeIdleLifecycle>,
    creations: Rc<OpenCodeInstanceCreationTracker>,
    unavailable_until: Cell<f64>,
    unavailable_reason: RefCell<String>,
    available: Cell<Option<bool>>,
}

fn weak_read<T: Default + 'static>(
    weak: &Weak<OpenCodeRuntime>,
    read: impl Fn(&OpenCodeRuntime) -> T + 'static,
) -> Rc<dyn Fn() -> T> {
    let weak = weak.clone();
    Rc::new(move || weak.upgrade().as_deref().map_or_else(T::default, &read))
}

fn closed() -> Box<dyn Error> {
    error("Error", "OpenCode runtime is shutting down")
}

impl OpenCodeRuntime {
    pub fn new(options: OpenCodeRuntimeOptions) -> Rc<Self> {
        let config = options.config.clone().unwrap_or_default();
        let logger: Rc<dyn AgentLogger> = options
            .logger
            .clone()
            .unwrap_or_else(|| Rc::new(SilentLogger));
        let new_id = options
            .new_id
            .clone()
            .unwrap_or_else(|| Rc::new(|| uuid::Uuid::new_v4().to_string()));
        let normalized = normalize_open_code_runtime_options(&options);
        Rc::new_cyclic(|weak: &Weak<Self>| {
            let endpoint = OpenCodeEndpointCoordinator::new(OpenCodeEndpointCoordinatorOptions {
                assert_available: Rc::new({
                    let weak = weak.clone();
                    move || weak.upgrade().ok_or_else(closed)?.assert_available()
                }),
                ensure_unlocked: Rc::new({
                    let weak = weak.clone();
                    move || {
                        let runtime = weak.upgrade();
                        async move { runtime.ok_or_else(closed)?.ensure_unlocked().await }
                            .boxed_local()
                    }
                }),
                logger: logger.clone(),
                on_activity: weak_read(weak, |runtime| runtime.idle.record_activity()),
            });
            let get_client = Rc::new({
                let weak = weak.clone();
                move || {
                    let runtime = weak.upgrade();
                    async move { runtime.ok_or_else(closed)?.get_client().await }.boxed_local()
                }
            });
            let request = Rc::new({
                let weak = weak.clone();
                move |request| {
                    let runtime = weak.upgrade();
                    async move { runtime.ok_or_else(closed)?.run_request(request).await }
                        .boxed_local()
                }
            });
            let session = Rc::new({
                let weak = weak.clone();
                move |id: &str| weak.upgrade()?.session(id)
            });
            let mark_unavailable = Rc::new({
                let weak = weak.clone();
                move |reason, generation| {
                    weak.upgrade().is_some_and(|runtime| {
                        runtime.mark_temporarily_unavailable(reason, generation)
                    })
                }
            });
            let decisions = OpenCodeDecisionController::new(OpenCodeDecisionControllerOptions {
                logger: logger.clone(),
                publish: Rc::new({
                    let weak = weak.clone();
                    move |session_id, operation, event| {
                        if let Some(runtime) = weak.upgrade() {
                            runtime.publish(session_id, operation, event);
                        }
                    }
                }),
                get_client: get_client.clone(),
                run_scoped_request: request.clone(),
                get_session: session.clone(),
                fail_turn: Rc::new({
                    let weak = weak.clone();
                    move |id, session, failure| {
                        if let Some(runtime) = weak.upgrade() {
                            runtime.fail_turn_for_provider_error(id, &session, &failure, None);
                        }
                    }
                }),
                clock: normalized.clock.clone(),
                new_id: new_id.clone(),
            });
            let steering = OpenCodeSteeringController::new(OpenCodeSteeringOptions {
                request_timeout_ms: normalized.request_timeout_ms,
                get_client: get_client.clone(),
                get_session: session,
                run_scoped_request: request,
                release_deferred_terminal: Rc::new({
                    let weak = weak.clone();
                    move |id, session| {
                        if let Some(runtime) = weak.upgrade() {
                            runtime.release_deferred_terminal(id, session);
                        }
                    }
                }),
                bind_operation_part: Rc::new({
                    let weak = weak.clone();
                    move |turn, part| {
                        weak.upgrade()
                            .is_some_and(|runtime| runtime.routes.bind_part(turn, part))
                    }
                }),
                unbind_operation_part: Rc::new({
                    let weak = weak.clone();
                    move |turn, part| {
                        if let Some(runtime) = weak.upgrade() {
                            runtime.routes.unbind_part(turn, part);
                        }
                    }
                }),
                new_id: new_id.clone(),
            });
            let models = OpenCodeModelDiscovery::new(OpenCodeModelDiscoveryOptions {
                cache_ttl_ms: Some(normalized.model_cache_ttl_ms),
                discovery_timeout_ms: Some(normalized.model_discovery_timeout_ms),
                logger: logger.clone(),
                endpoint: endpoint.clone(),
                clock: normalized.clock.clone(),
                is_available: weak_read(weak, Self::is_available),
                is_temporarily_unavailable: weak_read(weak, Self::is_temporarily_unavailable),
                instance_generation: weak_read(weak, |runtime| runtime.generation.get()),
                mark_available: Rc::new({
                    let weak = weak.clone();
                    move |generation| {
                        if let Some(runtime) = weak.upgrade() {
                            runtime.mark_available(Some(generation));
                        }
                    }
                }),
                mark_temporarily_unavailable: Rc::new({
                    let mark = mark_unavailable.clone();
                    move |reason, generation| mark(reason, Some(generation))
                }),
            });
            let idle = OpenCodeIdleLifecycle::new(OpenCodeIdleLifecycleOptions {
                logger: logger.clone(),
                endpoint: endpoint.clone(),
                clock: normalized.clock.clone(),
                sessions: weak_read(weak, Self::session_snapshot),
                purge_session: Rc::new({
                    let weak = weak.clone();
                    move |id| {
                        if let Some(runtime) = weak.upgrade() {
                            runtime.sessions.borrow_mut().shift_remove(&id);
                        }
                    }
                }),
                has_instance: weak_read(weak, |runtime| runtime.instance.borrow().is_some()),
                has_startup: weak_read(weak, |runtime| runtime.startup.borrow().is_some()),
                routes_idle: weak_read(weak, |runtime| runtime.routes.idle()),
                decisions_idle: weak_read(weak, |runtime| runtime.decisions.idle()),
                has_pending_turn_waiters: weak_read(weak, |runtime| {
                    !runtime.turn_waiters.borrow().is_empty()
                }),
                is_shutting_down: weak_read(weak, |runtime| runtime.shutting_down.get()),
                invalidate_models: weak_read(weak, |runtime| runtime.models.invalidate()),
                close_instance: weak_read(weak, Self::close_instance),
                retirement_delay_ms: options.idle_retirement_delay_ms,
                retirement_check_interval_ms: options.idle_retirement_check_interval_ms,
            });
            let requires_executable = normalized.requires_executable;
            let listener = OpenCodeGlobalEventListener::new(OpenCodeGlobalEventListenerOptions {
                request_timeout_ms: normalized.request_timeout_ms,
                heartbeat_timeout_ms: normalized.sse_heartbeat_timeout_ms,
                retry_delay_ms: normalized.sse_retry_delay_ms,
                logger: logger.clone(),
                get_client,
                is_shutting_down: weak_read(weak, |runtime| runtime.shutting_down.get()),
                is_temporarily_unavailable: weak_read(weak, Self::is_temporarily_unavailable),
                unavailable_retry_after_ms: weak_read(weak, Self::unavailable_remaining_ms),
                instance_generation: Some(weak_read(weak, |runtime| runtime.generation.get())),
                mark_temporarily_unavailable: mark_unavailable,
                fail_running_turns: Rc::new({
                    let weak = weak.clone();
                    move |failure| {
                        if let Some(runtime) = weak.upgrade() {
                            runtime.fail_running_turns(failure, RetiredSource::EventStream);
                        }
                    }
                }),
                close_unavailable_instance_if_idle: weak_read(weak, |runtime| {
                    runtime.idle.close_instance_if_idle()
                }),
                confirm_event_delivery: Rc::new({
                    let weak = weak.clone();
                    move |input| {
                        if !requires_executable {
                            return async { Ok(()) }.boxed_local();
                        }
                        weak.upgrade().map_or_else(
                            || async { Err(closed()) }.boxed_local(),
                            |runtime| runtime.confirm_event_delivery(input),
                        )
                    }
                }),
                handle_event: Rc::new({
                    let weak = weak.clone();
                    move |client, event| {
                        weak.upgrade()
                            .map_or(Ok(()), |runtime| runtime.handle_global_event(client, event))
                    }
                }),
            });
            Self {
                config,
                new_id,
                options: normalized,
                routes: OpenCodeOperationRoutes::new(logger.clone()),
                logger,
                instance: RefCell::default(),
                generation: Cell::new(0),
                deliberately_closed: RefCell::default(),
                pending_session_deletions: RefCell::default(),
                startup: RefCell::default(),
                startup_signal: RefCell::default(),
                shutdown: RefCell::default(),
                shutting_down: Cell::new(false),
                sessions: RefCell::default(),
                pending_session_aborts: RefCell::default(),
                turn_waiters: RefCell::default(),
                decisions,
                steering,
                endpoint,
                listener,
                models,
                idle,
                creations: Rc::new(OpenCodeInstanceCreationTracker::new(weak_read(
                    weak,
                    |runtime| runtime.shutting_down.get(),
                ))),
                unavailable_until: Cell::new(0.0),
                unavailable_reason: RefCell::default(),
                available: Cell::new(None),
            }
        })
    }

    pub fn start_purge_timer(&self) {
        self.idle.start();
    }

    pub fn shutdown(self: &Rc<Self>) -> LocalBoxFuture<'static, ()> {
        if let Some(shutdown) = self.shutdown.borrow().clone() {
            return shutdown.boxed_local();
        }
        self.shutting_down.set(true);
        self.idle.stop();
        self.reject_all_waiters(shared_error("Error", "OpenCode runtime shutting down"));
        self.sessions.borrow_mut().clear();
        self.decisions.clear();
        let startup = self.startup.borrow().clone();
        if let Some(signal) = self.startup_signal.borrow().as_ref() {
            signal.abort(shared_error("Error", "OpenCode runtime shutting down"));
        }
        let (send, receive) = oneshot::channel();
        let shutdown = async move {
            let _ = receive.await;
        }
        .boxed_local()
        .shared();
        self.shutdown.replace(Some(shutdown.clone()));
        let runtime = self.clone();
        spawn_local(async move {
            runtime
                .endpoint
                .wait_for_protected_native_work(
                    runtime.options.shutdown_native_fork_grace_ms,
                    || runtime.pending_session_deletions.borrow().len(),
                )
                .await;
            runtime.close_instance();
            if let Some(startup) = startup {
                let _ = startup.await;
            }
            runtime
                .creations
                .wait_for_cleanup(runtime.options.shutdown_startup_grace_ms)
                .await;
            runtime.close_instance();
            let _ = send.send(());
        });
        shutdown.boxed_local()
    }

    pub fn is_available(&self) -> bool {
        if let Some(available) = self.available.get() {
            return available;
        }
        let available = !self.options.requires_executable
            || (self.config.is_test_environment)()
            || which(OsStr::new("opencode")).is_some();
        self.available.set(Some(available));
        available
    }

    fn now(&self) -> f64 {
        self.options.clock.now_ms() as f64
    }
    fn unavailable_remaining_ms(&self) -> f64 {
        (self.unavailable_until.get() - self.now()).max(0.0)
    }
    pub fn is_temporarily_unavailable(&self) -> bool {
        self.unavailable_remaining_ms() > 0.0
    }

    fn unavailable_reason(&self) -> String {
        if self.is_temporarily_unavailable() {
            self.unavailable_reason.borrow().clone()
        } else {
            String::new()
        }
    }

    fn assert_available(&self) -> ExecutorResult<()> {
        if self.shutting_down.get() {
            return Err(closed());
        }
        if !self.is_available() {
            return Err(error("Error", "opencode is not installed"));
        }
        if self.is_temporarily_unavailable() {
            let reason = self.unavailable_reason();
            let detail = if reason.is_empty() {
                String::new()
            } else {
                format!(": {reason}")
            };
            let seconds = (self.unavailable_remaining_ms() / 1000.0).ceil();
            let retry = if seconds > 0.0 {
                format!(" Retry in {}s.", number_to_string(seconds))
            } else {
                String::new()
            };
            return Err(error(
                "Error",
                format!("OpenCode is temporarily unavailable{detail}.{retry}"),
            ));
        }
        Ok(())
    }

    fn mark_available(&self, generation: Option<u64>) {
        if generation.is_some_and(|generation| generation != self.generation.get()) {
            return;
        }
        self.unavailable_until.set(0.0);
        self.unavailable_reason.borrow_mut().clear();
    }

    fn mark_temporarily_unavailable(&self, reason: String, generation: Option<u64>) -> bool {
        if generation.is_some_and(|generation| generation != self.generation.get()) {
            return false;
        }
        let changed =
            !self.is_temporarily_unavailable() || *self.unavailable_reason.borrow() != reason;
        self.unavailable_reason.replace(reason);
        self.unavailable_until
            .set(self.now() + self.options.unavailable_retry_ms);
        self.idle.close_instance_if_idle();
        changed
    }

    fn bump_generation(&self) {
        self.generation.set(self.generation.get().wrapping_add(1));
    }

    fn close_instance(&self) {
        let instance = self.instance.take();
        self.bump_generation();
        self.listener.close();
        self.routes.clear();
        for session in self.sessions.borrow().values() {
            let mut data = session.borrow_mut();
            if data.status != SessionStatus::Running {
                data.provider_work_requires_quiescence = false;
            }
        }
        if let Some(instance) = instance {
            if instance
                .server
                .as_ref()
                .and_then(|server| server.exit_observed.as_ref())
                .is_some_and(|observed| !observed())
            {
                let mut closed = self.deliberately_closed.borrow_mut();
                closed.retain(|instance| instance.strong_count() > 0);
                closed.push(Rc::downgrade(&instance));
            }
            close_open_code_instance(&instance);
        }
    }

    fn assert_instance_current(&self, instance: &Rc<OpenCodeInstance>) -> ExecutorResult<()> {
        if !self
            .instance
            .borrow()
            .as_ref()
            .is_some_and(|current| Rc::ptr_eq(current, instance))
        {
            return Err(error(
                "Error",
                "OpenCode server process was retired while the request was in flight",
            ));
        }
        Ok(())
    }

    fn watch_server_termination(self: &Rc<Self>, instance: Rc<OpenCodeInstance>) {
        let Some(termination) = instance
            .server
            .as_ref()
            .and_then(|server| server.termination.clone())
        else {
            return;
        };
        let runtime = Rc::downgrade(self);
        spawn_local(async move {
            let outcome = termination.await;
            if let Some(runtime) = runtime.upgrade() {
                let transition = runtime.endpoint.run_transition({
                    let runtime = runtime.clone();
                    move || async move {
                        runtime.handle_server_termination(&instance, outcome);
                        Ok(())
                    }
                });
                if let Err(failure) = transition.await {
                    runtime.logger.error(
                        "OpenCode server termination handling failed",
                        Some(&log_fields([("error", json!(failure.to_string()))])),
                    );
                }
            }
        });
    }

    fn handle_server_termination(
        &self,
        instance: &Rc<OpenCodeInstance>,
        outcome: OpenCodeServerTermination,
    ) {
        if self.shutting_down.get()
            || self
                .deliberately_closed
                .borrow()
                .iter()
                .any(|closed| closed.ptr_eq(&Rc::downgrade(instance)))
        {
            return;
        }
        if self.assert_instance_current(instance).is_err() {
            if self.instance.borrow().is_none() {
                self.mark_available(None);
            }
            return;
        }
        let detail = match outcome {
            OpenCodeServerTermination::Exit { code, signal } => format!(
                "code {}",
                code.map(|code| code.to_string())
                    .or(signal)
                    .unwrap_or_else(|| "unknown".to_owned())
            ),
            OpenCodeServerTermination::Error(failure) => failure.to_string(),
        };
        self.logger.warn(
            "OpenCode server process terminated; retiring the instance",
            Some(&log_fields([("detail", json!(detail))])),
        );
        self.fail_running_turns(
            shared_error(
                "Error",
                format!("OpenCode server process terminated unexpectedly ({detail})"),
            ),
            RetiredSource::Process,
        );
        self.close_instance();
        self.mark_available(None);
    }

    fn fail_running_turns(&self, failure: SharedError, source: RetiredSource) {
        for (id, session) in self.session_snapshot() {
            if session.borrow().status != SessionStatus::Running {
                continue;
            }
            self.steering.stage_pending_cleanup(&session);
            let turn = {
                let mut data = session.borrow_mut();
                data.provider_work_requires_quiescence =
                    matches!(source, RetiredSource::EventStream);
                data.status = SessionStatus::Completed;
                data.last_activity_at = self.now();
                data.turn.clone()
            };
            self.routes.cancel_request(&turn, failure.clone());
            self.decisions.cancel_for_session(&id, "cancelled");
            self.settle_waiter(&id, Err(failure.clone()));
            self.publish_failed(&id, &turn.borrow().operation.clone(), &failure.to_string());
        }
        self.reject_all_waiters(failure);
    }

    async fn ensure(self: &Rc<Self>) -> ExecutorResult<Rc<OpenCodeInstance>> {
        let runtime = self.clone();
        self.endpoint
            .run_transition(move || async move { runtime.ensure_unlocked().await })
            .await
    }

    async fn ensure_unlocked(self: &Rc<Self>) -> ExecutorResult<Rc<OpenCodeInstance>> {
        if let Some(instance) = self.instance.borrow().clone() {
            return Ok(instance);
        }
        let pending = self.startup.borrow().clone();
        if let Some(pending) = pending {
            return pending.await.map_err(Into::into);
        }
        self.assert_available()?;
        let signal = AbortSignal::new();
        self.startup_signal.replace(Some(signal.clone()));
        let (send, receive) = oneshot::channel();
        let startup = async move {
            receive
                .await
                .unwrap_or_else(|_| Err(shared_error("Error", "OpenCode startup aborted")))
        }
        .boxed_local()
        .shared();
        self.startup.replace(Some(startup.clone()));
        let runtime = self.clone();
        spawn_local(async move {
            let result = runtime.start_instance(&signal).await;
            if let Err(failure) = &result {
                let reason = failure.to_string();
                if runtime.mark_temporarily_unavailable(reason.clone(), None) {
                    runtime.logger.warn(
                        "OpenCode marked unavailable after startup failure",
                        Some(&log_fields([("reason", json!(reason))])),
                    );
                }
            }
            runtime.startup.take();
            runtime.startup_signal.take();
            let _ = send.send(result.map_err(SharedError::from));
        });
        startup.await.map_err(Into::into)
    }

    async fn start_instance(
        self: &Rc<Self>,
        signal: &AbortSignal,
    ) -> ExecutorResult<Rc<OpenCodeInstance>> {
        if self.options.requires_executable
            && !(self.config.is_test_environment)()
            && which(OsStr::new("opencode")).is_none()
        {
            return Err(error("Error", "opencode executable not found in $PATH"));
        }
        let factory = self.options.create_instance.clone();
        let tracker = self.creations.clone();
        let instance = with_abortable_timeout(
            move |signal| {
                let provider_signal = signal.clone();
                tracker.track(move || factory(provider_signal), signal)
            },
            Some(self.options.startup_timeout_ms),
            "OpenCode startup",
            Some(signal),
        )
        .await?;
        if self.shutting_down.get() || signal.aborted() {
            close_open_code_instance(&instance);
            return Err(signal.reason().map_or_else(closed, Into::into));
        }
        if !instance.client.supports_permission_reply() {
            close_open_code_instance(&instance);
            return Err(error(
                "Error",
                "OpenCode v2 client missing permission.reply; aborting startup",
            ));
        }
        self.instance.replace(Some(instance.clone()));
        self.bump_generation();
        self.idle.record_activity();
        self.watch_server_termination(instance.clone());
        self.mark_available(None);
        self.drain_pending_session_deletions();
        Ok(instance)
    }

    pub async fn get_client(self: &Rc<Self>) -> ExecutorResult<Rc<dyn OpenCodeClient>> {
        self.assert_available()?;
        Ok(self.ensure().await?.client.clone())
    }

    pub fn get_client_if_initialized(&self) -> Option<Rc<dyn OpenCodeClient>> {
        self.instance
            .borrow()
            .as_ref()
            .map(|instance| instance.client.clone())
    }

    pub async fn with_client_lease<T, F>(
        self: &Rc<Self>,
        operation: impl FnOnce(Rc<dyn OpenCodeClient>) -> F,
        signal: Option<AbortSignal>,
    ) -> ExecutorResult<T>
    where
        F: Future<Output = ExecutorResult<T>>,
    {
        self.endpoint.with_client_lease(operation, signal).await
    }

    pub async fn get_models(&self) -> Vec<OpenCodeModelOption> {
        self.models.get_models().await
    }

    async fn run_request(
        &self,
        request: OpenCodeEndpointRequest,
    ) -> ExecutorResult<OpenCodeSdkResult> {
        let generation = self.generation.get();
        let timeout = match request.control.timeout {
            OpenCodeRequestTimeout::Default => Some(self.options.request_timeout_ms),
            OpenCodeRequestTimeout::After(ms) => Some(ms),
            OpenCodeRequestTimeout::Unbounded => None,
        };
        self.endpoint.request_started();
        let _lease = RequestLease(&self.endpoint);
        let result = with_abortable_timeout(
            move |signal| async move {
                request
                    .client
                    .request(request.operation, request.parameters, &signal)
                    .await
            },
            timeout,
            request.label,
            request.control.signal.as_ref(),
        )
        .await;
        if let Err(failure) = &result
            && error_of::<OpenCodeTimeoutError>(failure.as_ref()).is_some()
        {
            let reason = failure.to_string();
            if self.mark_temporarily_unavailable(reason.clone(), Some(generation)) {
                self.logger.warn(
                    "OpenCode request timed out",
                    Some(&log_fields([("reason", json!(reason))])),
                );
            }
        }
        result
    }

    async fn scoped_request(
        &self,
        label: &'static str,
        client: Rc<dyn OpenCodeClient>,
        operation: OpenCodeRequest,
        parameters: Map<String, Value>,
        scope: &OpenCodeRequestScope,
        control: OpenCodeRequestControl,
    ) -> ExecutorResult<OpenCodeSdkResult> {
        self.run_request(OpenCodeEndpointRequest {
            client,
            label,
            operation,
            parameters: with_open_code_request_scope(parameters, scope),
            control,
        })
        .await
    }

    fn is_current_session(&self, id: &str, session: &OpenCodeSession) -> bool {
        self.session(id).as_ref() == Some(session)
    }

    fn session(&self, id: &str) -> Option<OpenCodeSession> {
        self.sessions.borrow().get(id).cloned()
    }

    fn session_snapshot(&self) -> Vec<(String, OpenCodeSession)> {
        self.sessions
            .borrow()
            .iter()
            .map(|(id, session)| (id.clone(), session.clone()))
            .collect()
    }

    fn create_waiter(&self, id: &str) -> ExecutorResult<oneshot::Receiver<TurnResult>> {
        let mut waiters = self.turn_waiters.borrow_mut();
        if waiters.contains_key(id) {
            return Err(error(
                "Error",
                format!("Turn already in progress for session {id}"),
            ));
        }
        let (send, receive) = oneshot::channel();
        waiters.insert(id.to_owned(), send);
        Ok(receive)
    }

    fn settle_waiter(&self, id: &str, result: TurnResult) {
        if let Some(send) = self.turn_waiters.borrow_mut().shift_remove(id) {
            let _ = send.send(result);
        }
    }

    fn reject_all_waiters(&self, failure: SharedError) {
        for (_, send) in self.turn_waiters.take() {
            let _ = send.send(Err(failure.clone()));
        }
    }

    fn publish(&self, id: &str, operation: &AgentRuntimeOperation, event: AgentRuntimeEvent) {
        let event_type = match &event {
            AgentRuntimeEvent::Rows { .. } => "rows",
            AgentRuntimeEvent::Session { .. } => "session",
            AgentRuntimeEvent::Notice { .. } => "notice",
            AgentRuntimeEvent::Permission { .. } => "permission",
            AgentRuntimeEvent::RunEnded { .. } => "run-ended",
            AgentRuntimeEvent::Steerable => "steerable",
        };
        if let Err(failure) =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (operation.publish)(event)))
        {
            let failure = failure
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| failure.downcast_ref::<String>().map(String::as_str))
                .unwrap_or("Unknown error");
            self.logger.warn(
                "OpenCode publisher rejected an event",
                Some(&log_fields([
                    ("agentSessionId", json!(id)),
                    ("eventType", json!(event_type)),
                    ("error", json!(failure)),
                ])),
            );
        }
    }

    fn publish_finished(
        &self,
        id: &str,
        operation: &AgentRuntimeOperation,
        final_response: Option<AgentFinalResponse>,
    ) {
        self.publish(
            id,
            operation,
            AgentRuntimeEvent::RunEnded {
                run_id: operation.run_id.clone(),
                outcome: ProviderRunOutcome::Finished { final_response },
                working_directory: None,
            },
        );
    }

    fn publish_failed(&self, id: &str, operation: &AgentRuntimeOperation, message: &str) {
        self.publish(
            id,
            operation,
            AgentRuntimeEvent::RunEnded {
                run_id: operation.run_id.clone(),
                working_directory: None,
                outcome: ProviderRunOutcome::Failed {
                    error: Some(AgentRunFailureDetail {
                        code: "PROVIDER_FAILURE".to_owned(),
                        message: Some(message.to_owned()),
                    }),
                },
            },
        );
    }
}

enum RetiredSource {
    Process,
    EventStream,
}

struct RequestLease<'a>(&'a OpenCodeEndpointCoordinator);

impl Drop for RequestLease<'_> {
    fn drop(&mut self) {
        self.0.request_finished();
    }
}

impl OpenCodeAuthRuntime for OpenCodeRuntime {
    fn is_available(&self) -> Option<bool> {
        Some(self.is_available())
    }
    fn is_temporarily_unavailable(&self) -> Option<bool> {
        Some(self.is_temporarily_unavailable())
    }
    fn get_unavailable_reason(&self) -> Option<String> {
        Some(self.unavailable_reason())
    }
    fn get_unavailable_retry_after_ms(&self) -> Option<f64> {
        Some(self.unavailable_remaining_ms())
    }
}
