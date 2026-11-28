//! Ports `server-agents/opencode/src/agents/opencode/endpoint-coordinator.ts`.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use futures::{
    FutureExt,
    future::{LocalBoxFuture, Shared, join_all},
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    host::AgentLogger,
    resources::ExecutorResult,
};
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use tokio::{
    sync::oneshot,
    task::spawn_local,
    time::{Instant, sleep},
};

use super::{
    instance_lifecycle::OpenCodeInstance,
    sdk_client::{OpenCodeClient, OpenCodeRequest},
    sdk_result::{
        OpenCodeRequestScope, OpenCodeSdkResult, create_open_code_request_scope,
        has_open_code_result_error, is_open_code_not_found_result, open_code_result_error_message,
        throw_open_code_result_error, with_open_code_request_scope,
    },
};
use crate::js::{AbortSignal, error, log_fields, prop, timer_delay};

type Settled = Shared<LocalBoxFuture<'static, ()>>;
type EnsureUnlocked = Rc<dyn Fn() -> LocalBoxFuture<'static, ExecutorResult<Rc<OpenCodeInstance>>>>;

pub struct OpenCodeEndpointCoordinatorOptions {
    pub assert_available: Rc<dyn Fn() -> ExecutorResult<()>>,
    pub ensure_unlocked: EnsureUnlocked,
    pub logger: Rc<dyn AgentLogger>,
    pub on_activity: Rc<dyn Fn()>,
}

#[derive(Debug, Clone, Copy, Default)]
pub enum OpenCodeRequestTimeout {
    #[default]
    Default,
    Unbounded,
    After(f64),
}

#[derive(Debug, Clone, Default)]
pub struct OpenCodeRequestControl {
    pub signal: Option<AbortSignal>,
    pub timeout: OpenCodeRequestTimeout,
}

pub struct OpenCodeEndpointRequest {
    pub client: Rc<dyn OpenCodeClient>,
    pub label: &'static str,
    pub operation: OpenCodeRequest,
    pub parameters: Map<String, Value>,
    pub control: OpenCodeRequestControl,
}

#[derive(Debug, Clone, Default)]
pub struct OpenCodeForkOptions {
    pub project_path: Option<String>,
    pub message_id: Option<String>,
    pub signal: Option<AbortSignal>,
}

#[derive(Default)]
struct ProtectedNativeWork {
    next_id: u64,
    pending: IndexMap<u64, Settled>,
}

pub struct OpenCodeEndpointCoordinator {
    options: OpenCodeEndpointCoordinatorOptions,
    request_leases: Cell<usize>,
    turn_admissions: Cell<usize>,
    protected_native_work: Rc<RefCell<ProtectedNativeWork>>,
    transition_tail: RefCell<Option<Settled>>,
}

struct OpenCodeClientLease {
    owner: Rc<OpenCodeEndpointCoordinator>,
    client: Rc<dyn OpenCodeClient>,
}

impl Drop for OpenCodeClientLease {
    fn drop(&mut self) {
        self.owner.request_finished();
    }
}

impl OpenCodeEndpointCoordinator {
    pub fn new(options: OpenCodeEndpointCoordinatorOptions) -> Rc<Self> {
        Rc::new(Self {
            options,
            request_leases: Cell::new(0),
            turn_admissions: Cell::new(0),
            protected_native_work: Rc::default(),
            transition_tail: RefCell::default(),
        })
    }

    pub fn idle(&self) -> bool {
        self.request_leases.get() == 0 && self.turn_admissions.get() == 0
    }

    pub fn run_transition<T, F>(
        &self,
        operation: impl FnOnce() -> F + 'static,
    ) -> LocalBoxFuture<'static, ExecutorResult<T>>
    where
        T: 'static,
        F: Future<Output = ExecutorResult<T>> + 'static,
    {
        let (release, wait) = oneshot::channel();
        let (answer, receive) = oneshot::channel();
        let previous = self.transition_tail.replace(Some(
            async move {
                let _ = wait.await;
            }
            .boxed_local()
            .shared(),
        ));
        spawn_local(async move {
            if let Some(previous) = previous {
                previous.await;
            }
            let result = operation().await;
            let _ = release.send(());
            let _ = answer.send(result);
        });
        async move { receive.await? }.boxed_local()
    }

    pub async fn with_client_lease<T, F>(
        self: &Rc<Self>,
        operation: impl FnOnce(Rc<dyn OpenCodeClient>) -> F,
        admission_signal: Option<AbortSignal>,
    ) -> ExecutorResult<T>
    where
        F: Future<Output = ExecutorResult<T>>,
    {
        let pending_lease = self.run_transition({
            let owner = self.clone();
            let admission_signal = admission_signal.clone();
            move || async move {
                check_admission(admission_signal.as_ref())?;
                (owner.options.assert_available)()?;
                let client = (owner.options.ensure_unlocked)().await?.client.clone();
                check_admission(admission_signal.as_ref())?;
                owner.request_started();
                Ok(OpenCodeClientLease { owner, client })
            }
        });
        let lease = if let Some(signal) = &admission_signal {
            tokio::select! {
                biased;
                lease = pending_lease => lease?,
                () = signal.token().cancelled() => return Err(signal.abort_reason().into()),
            }
        } else {
            pending_lease.await?
        };
        check_admission(admission_signal.as_ref())?;
        operation(lease.client.clone()).await
    }

    pub fn request_started(&self) {
        self.request_leases.set(self.request_leases.get() + 1);
        (self.options.on_activity)();
    }

    pub fn request_finished(&self) {
        self.request_leases.set(self.request_leases.get() - 1);
        (self.options.on_activity)();
    }

    pub fn turn_admission_started(&self) {
        self.turn_admissions.set(self.turn_admissions.get() + 1);
        (self.options.on_activity)();
    }

    pub fn turn_admission_finished(&self) {
        self.turn_admissions.set(self.turn_admissions.get() - 1);
        (self.options.on_activity)();
    }

    pub fn run_protected_native_fork<T, F>(
        &self,
        operation: impl FnOnce() -> F,
    ) -> LocalBoxFuture<'static, ExecutorResult<T>>
    where
        T: 'static,
        F: Future<Output = ExecutorResult<T>> + 'static,
    {
        self.track_protected_native_work(operation())
    }

    pub fn run_protected_native_cleanup<T, F>(
        &self,
        operation: impl FnOnce() -> F,
    ) -> LocalBoxFuture<'static, ExecutorResult<T>>
    where
        T: 'static,
        F: Future<Output = ExecutorResult<T>> + 'static,
    {
        self.track_protected_native_work(operation())
    }

    fn track_protected_native_work<T, F>(
        &self,
        operation: F,
    ) -> LocalBoxFuture<'static, ExecutorResult<T>>
    where
        T: 'static,
        F: Future<Output = ExecutorResult<T>> + 'static,
    {
        let (settled, wait) = oneshot::channel();
        let (answer, receive) = oneshot::channel();
        let id = {
            let mut work = self.protected_native_work.borrow_mut();
            let id = work.next_id;
            work.next_id = id.wrapping_add(1);
            work.pending.insert(
                id,
                async move {
                    let _ = wait.await;
                }
                .boxed_local()
                .shared(),
            );
            id
        };
        let work = self.protected_native_work.clone();
        spawn_local(async move {
            let result = operation.await;
            let _ = answer.send(result);
            work.borrow_mut().pending.shift_remove(&id);
            let _ = settled.send(());
        });
        async move { receive.await? }.boxed_local()
    }

    pub async fn wait_for_protected_native_work(
        &self,
        timeout_ms: f64,
        retained_deletion_count: impl Fn() -> usize,
    ) {
        let deadline = Instant::now() + timer_delay(timeout_ms);
        let mut pending_operations = 0;
        loop {
            let pending: Vec<_> = self
                .protected_native_work
                .borrow()
                .pending
                .values()
                .cloned()
                .collect();
            if pending.is_empty() {
                break;
            }
            let timer = sleep(
                deadline
                    .saturating_duration_since(Instant::now())
                    .max(timer_delay(0.0)),
            );
            let completed = tokio::select! {
                biased;
                _ = join_all(pending) => true,
                () = timer => false,
            };
            if !completed {
                pending_operations = self.protected_native_work.borrow().pending.len();
                break;
            }
        }
        let retained = retained_deletion_count();
        if pending_operations > 0 || retained > 0 {
            self.options.logger.warn(
                "OpenCode shutdown abandoned native session cleanup",
                Some(&log_fields([
                    ("pendingOperations", json!(pending_operations)),
                    ("retainedDeletions", json!(retained)),
                    ("timeoutMs", json!(timeout_ms)),
                ])),
            );
        }
    }

    pub async fn fork_session<F, D>(
        self: &Rc<Self>,
        source_session_id: &str,
        options: OpenCodeForkOptions,
        run_scoped_request: impl FnOnce(OpenCodeEndpointRequest) -> F,
        discard_cancelled_fork: impl FnOnce(Rc<dyn OpenCodeClient>, String, OpenCodeRequestScope) -> D,
    ) -> ExecutorResult<String>
    where
        F: Future<Output = ExecutorResult<OpenCodeSdkResult>>,
        D: Future<Output = ExecutorResult<()>>,
    {
        let session_id = garcon_js::trim(source_session_id);
        if session_id.is_empty() {
            return Err(error(
                "Error",
                "Cannot fork OpenCode session: missing source session id",
            ));
        }
        let scope = create_open_code_request_scope(options.project_path.as_deref());
        let mut parameters = Map::from_iter([("sessionID".to_owned(), Value::from(session_id))]);
        if let Some(message_id) = options.message_id.filter(|id| !id.is_empty()) {
            parameters.insert("messageID".to_owned(), Value::String(message_id));
        }
        let signal = options.signal.clone();
        let forked_id = self
            .with_client_lease(
                |client| async move {
                    check_admission(signal.as_ref())?;
                    let result = run_scoped_request(OpenCodeEndpointRequest {
                        client: client.clone(),
                        label: "OpenCode session fork",
                        operation: OpenCodeRequest::SessionFork,
                        parameters: with_open_code_request_scope(parameters, &scope),
                        control: OpenCodeRequestControl {
                            signal: None,
                            timeout: OpenCodeRequestTimeout::Unbounded,
                        },
                    })
                    .await;
                    let result = match result {
                        Ok(result) => result,
                        Err(failure) => {
                            check_admission(signal.as_ref())?;
                            return Err(failure);
                        }
                    };
                    let forked_id = prop(prop(&*result, "data"), "id")
                        .as_str()
                        .map(garcon_js::trim)
                        .unwrap_or_default();
                    if let Some(signal) = signal.as_ref().filter(|signal| signal.aborted()) {
                        if !forked_id.is_empty() {
                            discard_cancelled_fork(client, forked_id.to_owned(), scope).await?;
                        }
                        signal.throw_if_aborted()?;
                    }
                    if is_open_code_not_found_result(&result) {
                        return Err(AgentIntegrationError::new(
                            Code::TRANSCRIPT_UNAVAILABLE,
                            "The OpenCode source session is unavailable",
                            true,
                            Some(Map::from_iter([(
                                "nativeForkReason".to_owned(),
                                Value::from("source-missing"),
                            )])),
                        )
                        .into());
                    }
                    if has_open_code_result_error(&result) {
                        return Err(AgentIntegrationError::new(
                            Code::TRANSCRIPT_UNAVAILABLE,
                            open_code_result_error_message(&result, "OpenCode session fork failed"),
                            true,
                            None,
                        )
                        .into());
                    }
                    if forked_id.is_empty() {
                        return Err(error(
                            "Error",
                            "OpenCode session fork did not return a session id",
                        ));
                    }
                    Ok(forked_id.to_owned())
                },
                options.signal,
            )
            .await?;
        self.options.logger.info(
            "OpenCode session forked",
            Some(&log_fields([
                ("sourceSessionId", json!(session_id)),
                ("forkedSessionId", json!(forked_id)),
            ])),
        );
        Ok(forked_id)
    }

    pub async fn move_session<F>(
        self: &Rc<Self>,
        agent_session_id: &str,
        directory: &str,
        signal: AbortSignal,
        run_request: impl FnOnce(OpenCodeEndpointRequest) -> F,
    ) -> ExecutorResult<()>
    where
        F: Future<Output = ExecutorResult<OpenCodeSdkResult>>,
    {
        let session_id = garcon_js::trim(agent_session_id);
        let destination = garcon_js::trim(directory);
        if session_id.is_empty() {
            return Err(error(
                "Error",
                "Cannot move OpenCode session: missing session id",
            ));
        }
        if destination.is_empty() {
            return Err(error(
                "Error",
                "Cannot move OpenCode session: missing destination directory",
            ));
        }
        signal.throw_if_aborted()?;
        self.with_client_lease(
            |client| async move {
                if !client.supports_move_session() {
                    return Err(AgentIntegrationError::new(
                        Code::OPERATION_UNSUPPORTED,
                        "This OpenCode version does not support project path updates",
                        false,
                        None,
                    )
                    .into());
                }
                let result = run_request(OpenCodeEndpointRequest {
                    client,
                    label: "OpenCode session move",
                    operation: OpenCodeRequest::MoveSession,
                    parameters: Map::from_iter([
                        ("sessionID".to_owned(), Value::from(session_id)),
                        ("destination".to_owned(), json!({"directory": destination})),
                    ]),
                    control: OpenCodeRequestControl {
                        signal: Some(signal),
                        timeout: OpenCodeRequestTimeout::Default,
                    },
                })
                .await?;
                throw_open_code_result_error(&result, "OpenCode session move failed")?;
                Ok(())
            },
            None,
        )
        .await
    }
}

fn check_admission(signal: Option<&AbortSignal>) -> ExecutorResult<()> {
    signal.map_or(Ok(()), AbortSignal::throw_if_aborted)
}

#[cfg(test)]
mod tests;
