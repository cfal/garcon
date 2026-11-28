//! Ports `server-agents/pi/src/agents/pi/lazy-runtime.ts`.

use std::{
    cell::{Cell, RefCell},
    future::Future,
    rc::Rc,
};

use async_trait::async_trait;
use futures::{FutureExt, future::LocalBoxFuture};
use garcon_agents_common::{
    execution::runtime_events::{RuntimeSteerRequest, RuntimeSteerTarget},
    shared::shared_probe::{InFlightProbes, SharedProbe, shared_probe},
};
use garcon_base::errors::NamedError;
use garcon_interface::{
    execution::AgentRunningSession, resources::ExecutorResult, services::AgentSteerResult,
};

use crate::runtime_types::{PiResumeRequest, PiStartRequest, PiStartedSession};

#[async_trait(?Send)]
pub trait PiRuntime {
    async fn start_session(&self, request: PiStartRequest) -> ExecutorResult<PiStartedSession>;
    async fn run_turn(&self, request: PiResumeRequest) -> ExecutorResult<()>;
    async fn abort(&self, agent_session_id: &str) -> ExecutorResult<bool>;
    fn is_running(&self, agent_session_id: &str) -> bool;
    fn running_sessions(&self) -> Vec<AgentRunningSession>;
    fn capture_steer_target(&self, agent_session_id: &str) -> Option<RuntimeSteerTarget>;
    async fn steer(&self, request: RuntimeSteerRequest) -> ExecutorResult<AgentSteerResult>;
    async fn release_session(&self, chat_id: &str, agent_session_id: &str) -> ExecutorResult<()>;
    fn start_purge_timer(&self);
    async fn shutdown(&self) -> ExecutorResult<()>;
}

type PiRuntimeLoader = dyn Fn() -> LocalBoxFuture<'static, ExecutorResult<Rc<dyn PiRuntime>>>;
const RUNTIME: &str = "runtime";
const SHUTDOWN: &str = "shutdown";

struct PendingOperation {
    chat_id: String,
    agent_session_id: Option<String>,
    cancelled: Cell<bool>,
}

#[derive(Default)]
struct State {
    runtime: RefCell<Option<Rc<dyn PiRuntime>>>,
    loading: InFlightProbes<Rc<dyn PiRuntime>>,
    pending: RefCell<Vec<Rc<PendingOperation>>>,
    purge_requested: Cell<bool>,
    shutdown_requested: Cell<bool>,
    shutdown_loading: InFlightProbes<()>,
    shutdown: RefCell<Option<SharedProbe<()>>>,
}

pub struct LazyPiRuntime {
    load_runtime: Rc<PiRuntimeLoader>,
    state: Rc<State>,
}

impl LazyPiRuntime {
    pub fn new(load_runtime: Rc<PiRuntimeLoader>) -> Self {
        Self {
            load_runtime,
            state: Rc::default(),
        }
    }

    pub async fn start_session(&self, request: PiStartRequest) -> ExecutorResult<PiStartedSession> {
        self.run_after_load(
            request.execution.chat_id.clone(),
            None,
            |runtime| async move { runtime.start_session(request).await },
        )
        .await
    }

    pub async fn run_turn(&self, request: PiResumeRequest) -> ExecutorResult<()> {
        self.run_after_load(
            request.execution.chat_id.clone(),
            Some(request.agent_session_id.clone()),
            |runtime| async move { runtime.run_turn(request).await },
        )
        .await
    }

    pub async fn abort(&self, agent_session_id: &str) -> ExecutorResult<bool> {
        let pending = self.cancel_pending(Some(agent_session_id), None);
        let runtime = self.state.runtime.borrow().clone();
        if let Some(runtime) = runtime {
            return Ok(runtime.abort(agent_session_id).await? || pending);
        }
        Ok(pending)
    }

    pub fn is_running(&self, agent_session_id: &str) -> bool {
        self.state
            .runtime
            .borrow()
            .as_ref()
            .is_some_and(|runtime| runtime.is_running(agent_session_id))
    }

    pub fn running_sessions(&self) -> Vec<AgentRunningSession> {
        self.state
            .runtime
            .borrow()
            .as_ref()
            .map_or_else(Vec::new, |runtime| runtime.running_sessions())
    }

    pub fn capture_steer_target(&self, agent_session_id: &str) -> Option<RuntimeSteerTarget> {
        self.state
            .runtime
            .borrow()
            .as_ref()?
            .capture_steer_target(agent_session_id)
    }

    pub async fn steer(&self, request: RuntimeSteerRequest) -> ExecutorResult<AgentSteerResult> {
        self.run_after_load(
            request.chat_id.clone(),
            Some(request.agent_session_id.clone()),
            |runtime| async move { runtime.steer(request).await },
        )
        .await
    }

    pub async fn release_session(
        &self,
        chat_id: &str,
        agent_session_id: Option<&str>,
    ) -> ExecutorResult<()> {
        let Some(agent_session_id) = agent_session_id.filter(|id| !id.is_empty()) else {
            return Ok(());
        };
        self.cancel_pending(Some(agent_session_id), Some(chat_id));
        let runtime = self.state.runtime.borrow().clone();
        if let Some(runtime) = runtime {
            runtime.release_session(chat_id, agent_session_id).await?;
        }
        Ok(())
    }

    pub fn start_purge_timer(&self) {
        self.state.purge_requested.set(true);
        if let Some(runtime) = &*self.state.runtime.borrow() {
            runtime.start_purge_timer();
        }
    }

    pub async fn shutdown(&self) -> ExecutorResult<()> {
        let shutdown = self.state.shutdown.borrow().clone();
        if let Some(shutdown) = shutdown {
            return shutdown.await;
        }
        self.state.shutdown_requested.set(true);
        self.cancel_pending(None, None);
        let state = self.state.clone();
        let shutdown = shared_probe(&self.state.shutdown_loading, SHUTDOWN, || {
            async move {
                let runtime = state.runtime.borrow().clone();
                let runtime = match runtime {
                    Some(runtime) => Some(runtime),
                    None => {
                        let loading = state.loading.borrow().get(RUNTIME).cloned();
                        match loading {
                            Some(loading) => loading.await.ok(),
                            None => None,
                        }
                    }
                };
                if let Some(runtime) = runtime {
                    runtime.shutdown().await?;
                }
                Ok(())
            }
            .boxed_local()
        });
        self.state.shutdown.replace(Some(shutdown.clone()));
        shutdown.await
    }

    async fn run_after_load<T, F, Fut>(
        &self,
        chat_id: String,
        agent_session_id: Option<String>,
        operation: F,
    ) -> ExecutorResult<T>
    where
        F: FnOnce(Rc<dyn PiRuntime>) -> Fut,
        Fut: Future<Output = ExecutorResult<T>>,
    {
        if self.state.shutdown_requested.get() {
            return Err(cancelled_error().into());
        }
        let pending = Rc::new(PendingOperation {
            chat_id,
            agent_session_id,
            cancelled: Cell::new(false),
        });
        self.state.pending.borrow_mut().push(pending.clone());
        let guard = PendingGuard {
            state: &self.state,
            pending: &pending,
        };
        let runtime = self.get_runtime().await?;
        if pending.cancelled.get() || self.state.shutdown_requested.get() {
            return Err(cancelled_error().into());
        }
        drop(guard);
        operation(runtime).await
    }

    fn cancel_pending(&self, agent_session_id: Option<&str>, chat_id: Option<&str>) -> bool {
        let mut cancelled = false;
        for pending in &*self.state.pending.borrow() {
            if agent_session_id.is_some_and(|id| pending.agent_session_id.as_deref() != Some(id))
                || chat_id.is_some_and(|id| pending.chat_id != id)
            {
                continue;
            }
            pending.cancelled.set(true);
            cancelled = true;
        }
        cancelled
    }

    async fn get_runtime(&self) -> ExecutorResult<Rc<dyn PiRuntime>> {
        let runtime = self.state.runtime.borrow().clone();
        if let Some(runtime) = runtime {
            return Ok(runtime);
        }
        let state = self.state.clone();
        let load = self.load_runtime.clone();
        shared_probe(&self.state.loading, RUNTIME, || {
            async move {
                let runtime = load().await?;
                state.runtime.replace(Some(runtime.clone()));
                if state.purge_requested.get() {
                    runtime.start_purge_timer();
                }
                Ok(runtime)
            }
            .boxed_local()
        })
        .await
    }
}

struct PendingGuard<'a> {
    state: &'a State,
    pending: &'a Rc<PendingOperation>,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.state
            .pending
            .borrow_mut()
            .retain(|item| !Rc::ptr_eq(item, self.pending));
    }
}

fn cancelled_error() -> NamedError {
    NamedError {
        name: "AbortError".to_owned(),
        message: "Pi runtime operation cancelled before initialization".to_owned(),
        code: None,
    }
}
