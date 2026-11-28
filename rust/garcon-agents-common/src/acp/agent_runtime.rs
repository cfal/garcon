//! Ports `server-agents/common/src/acp/agent-runtime.ts`.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::rc::{Rc, Weak};

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use garcon_contract::chat_modes::PermissionMode;
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::execution::AgentRunningSession;
use garcon_interface::host::AgentLogger;
use garcon_interface::resources::ExecutorResult;
use garcon_interface::services::{AgentSteerRejectionReason as Rejection, AgentSteerResult};
use garcon_js::clock::{Clock, SystemClock};
use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio::task::{JoinHandle, spawn_local};
use tokio_util::sync::CancellationToken;

use crate::execution::admission::check_signal;
use crate::execution::runtime_events::{RuntimeSteerRequest, RuntimeSteerTarget};
use crate::shared::idle_session_purger::{
    DEFAULT_IDLE_SESSION_MAX_AGE_MS, DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS, IdleSessionPurger,
    purge_idle_sessions,
};
use crate::shared::shared_probe::wait_unless_aborted;

use super::client::{
    AcpClient, AcpClientOptions, AcpLoadSessionParams, AcpNewSessionParams, AcpPromptSessionParams,
};
use super::errors::plain_error;
use super::event_converter::{AcpEventConverter, AcpRetireReason};
use super::json_values::member;
use super::policy::{
    AcpAbortStrategy, AcpAgentPolicy, child_environment_for, native_path_for, prompt_for,
};
use super::protocol::garcon_initialize_params;
use super::reconnect_policy::reconnect_acp_session;
use super::runtime_helpers::{humanize_error, unless_settled};
use super::runtime_session::{
    AcpAgentRuntimeSession, AcpRuntimeSessionIdentity, PendingPermissionRequest,
    RuntimeSessionState, SessionRef, TurnRef, TurnSettled, new_runtime_session,
};
use super::runtime_types::{
    AcpExecutionRequest, AcpProjectPathUpdateRequest, AcpResumeRequest, AcpSessionSettingsPatch,
    AcpStartRequest, AcpStartedSession, assert_acp_execution_open,
};
use super::transport::{
    AcpOutputDuringWrite, AcpRequestOptions, AcpSpawnSpec, AcpTransport, AcpTransportOptions,
};

#[cfg(test)]
mod tests;
mod turn;

const DEFAULT_CANCEL_SETTLE_TIMEOUT_MS: f64 = 10_000.0;
const DEFAULT_STEER_DECISION_TIMEOUT_MS: f64 = 15_000.0;

pub struct AcpAgentRuntimeOptions {
    pub converter: Rc<dyn AcpEventConverter>,
    pub create_transport: Option<Rc<dyn Fn() -> AcpTransport>>,
    pub logger: Option<Rc<dyn AgentLogger>>,
    pub cancel_settle_timeout_ms: Option<f64>,
    pub steer_decision_timeout_ms: Option<f64>,
    pub clock: Option<Rc<dyn Clock>>,
    pub new_permission_id: Option<Rc<dyn Fn() -> String>>,
}

struct PendingResume {
    chat_id: String,
    session_id: String,
    release: CancellationToken,
    permission_mode: Cell<PermissionMode>,
}

struct InFlightRestore {
    chat_id: String,
    settled: TurnSettled,
}

#[derive(Default)]
struct RuntimeState {
    sessions: IndexMap<String, SessionRef>,
    restores: IndexMap<String, InFlightRestore>,
    pending_resumes: Vec<Rc<PendingResume>>,
    lifetime: CancellationToken,
    agent_default_models: IndexMap<String, String>,
    pending_permissions: Vec<Rc<PendingPermissionRequest>>,
}

struct RuntimeInner {
    policy: AcpAgentPolicy,
    converter: Rc<dyn AcpEventConverter>,
    create_transport: Rc<dyn Fn() -> AcpTransport>,
    logger: Option<Rc<dyn AgentLogger>>,
    cancel_settle_timeout_ms: f64,
    steer_decision_timeout_ms: f64,
    clock: Rc<dyn Clock>,
    new_permission_id: Rc<dyn Fn() -> String>,
    state: RefCell<RuntimeState>,
    idle_purger: IdleSessionPurger,
}

#[derive(Clone)]
pub struct AcpAgentRuntime(Rc<RuntimeInner>);

impl AcpAgentRuntime {
    pub fn new(policy: AcpAgentPolicy, options: AcpAgentRuntimeOptions) -> Self {
        Self(Rc::new(RuntimeInner {
            policy,
            converter: options.converter,
            create_transport: options
                .create_transport
                .unwrap_or_else(|| Rc::new(|| AcpTransport::new(AcpTransportOptions::default()))),
            logger: options.logger,
            cancel_settle_timeout_ms: options
                .cancel_settle_timeout_ms
                .unwrap_or(DEFAULT_CANCEL_SETTLE_TIMEOUT_MS),
            steer_decision_timeout_ms: options
                .steer_decision_timeout_ms
                .unwrap_or(DEFAULT_STEER_DECISION_TIMEOUT_MS),
            clock: options.clock.unwrap_or_else(|| Rc::new(SystemClock)),
            new_permission_id: options
                .new_permission_id
                .unwrap_or_else(|| Rc::new(|| uuid::Uuid::new_v4().to_string())),
            state: RefCell::default(),
            idle_purger: IdleSessionPurger::default(),
        }))
    }

    pub async fn start_session(
        &self,
        request: AcpStartRequest,
    ) -> ExecutorResult<AcpStartedSession> {
        let AcpStartRequest {
            execution,
            on_session_activated,
        } = request;
        assert_acp_execution_open(&execution)?;
        let prompt = prompt_for(&self.0.policy, &execution)?;
        let signal = self.admission_signal(&execution, None)?;
        let session = self.open_session(&execution, None, &signal).await?;
        let id = session.borrow().id.clone();
        let result = Rc::new(AcpStartedSession {
            native_path: native_path_for(&self.0.policy, &id),
            agent_session_id: id.clone(),
        });
        let (start, started) = oneshot::channel::<ExecutorResult<()>>();
        let start = Rc::new(Cell::new(Some(start)));
        let wait = async {
            signal.check()?;
            if session.borrow().retired {
                return Err(plain_error(format!(
                    "ACP session {id} retired before activation"
                )));
            }
            let activated = Rc::new({
                let session = Rc::clone(&session);
                let runtime = self.clone();
                let signal = signal.reasons.clone();
                let result = Rc::clone(&result);
                let start = Rc::clone(&start);
                move || {
                    if let Some(activated) = &on_session_activated {
                        activated(&result)?;
                    }
                    signal.check()?;
                    runtime.retire_superseded_chat_sessions(&session);
                    if let Some(start) = start.take() {
                        let _ = start.send(Ok(()));
                    }
                    Ok(())
                }
            });
            let turn = self.run_prompt(Rc::clone(&session), execution, prompt, Some(activated))?;
            spawn_local(async move {
                let outcome = turn.await;
                if let Some(start) = start.take() {
                    let _ = start.send(outcome.and_then(|()| {
                        Err(plain_error("ACP session ended before execution started"))
                    }));
                }
            });
            tokio::select! {
                biased;
                started = started => started?,
                () = signal.token.cancelled() => signal.check(),
            }
        };
        if let Err(error) = wait.await {
            self.retire_session(&session, AcpRetireReason::Cancelled, false);
            return Err(error);
        }
        Ok(AcpStartedSession {
            agent_session_id: result.agent_session_id.clone(),
            native_path: result.native_path.clone(),
        })
    }

    pub async fn run_turn(&self, request: AcpResumeRequest) -> ExecutorResult<()> {
        assert_acp_execution_open(&request.execution)?;
        let prompt = prompt_for(&self.0.policy, &request.execution)?;
        let pending = Rc::new(PendingResume {
            chat_id: request.execution.chat_id.clone(),
            session_id: request.agent_session_id.clone(),
            release: CancellationToken::new(),
            permission_mode: Cell::new(request.execution.permission_mode),
        });
        let signal = self.admission_signal(&request.execution, Some(&pending))?;
        self.0
            .state
            .borrow_mut()
            .pending_resumes
            .push(Rc::clone(&pending));
        let reservation = ResumeReservation {
            runtime: self.clone(),
            pending: Rc::clone(&pending),
        };
        let mut session = self.session_for_turn(&request, &signal).await?;
        signal.check()?;
        let cancelled = active_or_pending(&session).and_then(|turn| {
            let turn = turn.borrow();
            turn.aborted.then(|| turn.settled.clone())
        });
        if let Some(cancelled) = cancelled {
            signal.wait(cancelled).await?;
            signal.check()?;
        }
        if session.borrow().retired {
            session = self.session_for_turn(&request, &signal).await?;
            signal.check()?;
            if session.borrow().retired {
                return Err(plain_error(format!(
                    "ACP session {} retired before activation",
                    request.agent_session_id
                )));
            }
        }
        if is_busy(&session.borrow()) {
            return Err(plain_error(format!(
                "Session {} is already running",
                request.agent_session_id
            )));
        }
        let mut execution = request.execution;
        execution.permission_mode = pending.permission_mode.get();
        let turn = self.run_prompt(session, execution, prompt, None)?;
        drop(reservation);
        turn.await
    }

    pub async fn prepare_project_path_update(
        &self,
        request: AcpProjectPathUpdateRequest,
    ) -> ExecutorResult<()> {
        let Some(id) = request.agent_session_id.filter(|id| !id.is_empty()) else {
            return Ok(());
        };
        let busy = |message: String| {
            AgentIntegrationError::new(
                AgentIntegrationErrorCode::SESSION_BUSY,
                message,
                false,
                None,
            )
        };
        if self.0.state.borrow().restores.contains_key(&id) {
            return Err(busy(format!("Session {id} is being restored")).into());
        }
        let Some(session) = self.session(&id) else {
            return Ok(());
        };
        {
            let session = session.borrow();
            if session.chat_id != request.chat_id {
                return Err(busy("Chat ID mismatch".to_owned()).into());
            }
            if is_busy(&session) {
                return Err(busy(format!("Session {id} is already running")).into());
            }
            if session
                .source_turn
                .as_ref()
                .is_some_and(|turn| !turn.borrow().pending_permissions.is_empty())
            {
                return Err(busy(format!("Session {id} is waiting for permission")).into());
            }
        }
        self.retire_session(&session, AcpRetireReason::SessionComplete, false);
        Ok(())
    }

    pub fn release_session(&self, chat_id: &str, agent_session_id: Option<&str>) {
        let Some(id) = agent_session_id.filter(|id| !id.is_empty()) else {
            return;
        };
        for pending in &self.0.state.borrow().pending_resumes {
            if pending.chat_id == chat_id && pending.session_id == id {
                pending.release.cancel();
            }
        }
        if let Some(session) = self
            .session(id)
            .filter(|session| session.borrow().chat_id == chat_id)
        {
            self.retire_session(&session, AcpRetireReason::Cancelled, false);
        }
    }

    pub fn abort(&self, id: &str) -> bool {
        let Some(session) = self.session(id) else {
            return false;
        };
        let Some(turn) = active_or_pending(&session) else {
            return false;
        };
        turn.borrow_mut().aborted = true;
        let (active, client) = {
            let mut session = session.borrow_mut();
            session.state = RuntimeSessionState::Aborted;
            (
                same_turn(&session.active_turn, &turn),
                Rc::clone(&session.client),
            )
        };
        if self.0.policy.abort_strategy == AcpAbortStrategy::ProcessRestart {
            if active {
                self.complete_turn(&session, &turn);
            }
            self.retire_session(&session, AcpRetireReason::Aborted, false);
            return true;
        }
        if active {
            self.cancel_permissions_for_turn(&session, &turn, AcpRetireReason::Aborted);
            if let Err(error) = client.cancel_session(id) {
                self.warn(
                    "ACP cancel could not be delivered.",
                    id,
                    Some(("error", humanize_error(error.as_ref()))),
                );
            }
        }
        let mut current = turn.borrow_mut();
        if current.cancel_timer.is_none() {
            let settled = current.settled.clone();
            let turn = Rc::downgrade(&turn);
            let session = Rc::downgrade(&session);
            let runtime = Rc::downgrade(&self.0);
            current.cancel_timer = Some(unless_settled(
                settled,
                self.0.cancel_settle_timeout_ms,
                move || {
                    if let (Some(runtime), Some(session), Some(turn)) =
                        (runtime.upgrade(), session.upgrade(), turn.upgrade())
                    {
                        let completed = turn.borrow().completed;
                        if !completed {
                            AcpAgentRuntime(runtime).retire_session(
                                &session,
                                AcpRetireReason::Aborted,
                                false,
                            );
                        }
                    }
                },
            ));
        }
        true
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.session(id)
            .is_some_and(|session| is_busy(&session.borrow()))
    }

    pub fn get_running_sessions(&self) -> Vec<AgentRunningSession> {
        self.0
            .state
            .borrow()
            .sessions
            .values()
            .filter_map(|session| {
                let session = session.borrow();
                is_busy(&session).then(|| AgentRunningSession {
                    agent_session_id: session.id.clone(),
                    status: Some(session.state.as_str().to_owned()),
                    started_at: Some(session.started_at.clone()),
                })
            })
            .collect()
    }

    pub fn capture_steer_target(&self, id: &str) -> Option<RuntimeSteerTarget> {
        let session = self.session(id)?;
        let turn = session.borrow().active_turn.clone()?;
        self.steer_rejection(&session, &turn).is_none().then(|| {
            Rc::new(AcpSteerTarget {
                owner: Rc::downgrade(&self.0),
                turn: Cell::new(Some(Rc::downgrade(&turn))),
            }) as RuntimeSteerTarget
        })
    }

    pub async fn steer(&self, request: RuntimeSteerRequest) -> ExecutorResult<AgentSteerResult> {
        let target = request
            .target
            .as_ref()
            .and_then(|target| target.downcast_ref::<AcpSteerTarget>());
        let turn = target
            .filter(|target| target.owner.ptr_eq(&Rc::downgrade(&self.0)))
            .and_then(|target| target.turn.take())
            .and_then(|turn| turn.upgrade());
        let Some(turn) = turn else {
            return Ok(rejected_steer(Rejection::NoActiveTurn, "No active turn"));
        };
        let session = turn.borrow().session.upgrade();
        let Some(session) = session else {
            return Ok(rejected_steer(
                Rejection::TurnChanged,
                "The active turn changed",
            ));
        };
        {
            let owner = session.borrow();
            if owner.id != request.agent_session_id || owner.chat_id != request.chat_id {
                return Ok(rejected_steer(
                    Rejection::TurnChanged,
                    "The steering target belongs to another session",
                ));
            }
        }
        let prompts = turn.borrow().prompts.clone();
        let runtime = self.clone();
        prompts
            .clone()
            .with_steer_slot(move || async move {
                if let Some(rejection) = runtime.steer_rejection(&session, &turn) {
                    return Ok(rejection);
                }
                (request.prepare_delivery)().await?;
                if let Some(rejection) = runtime.steer_rejection(&session, &turn) {
                    return Ok(rejection);
                }
                let (id, client) = {
                    let session = session.borrow();
                    (session.id.clone(), Rc::clone(&session.client))
                };
                let prompt = [json!({"type": "text", "text": request.input})];
                let decision = prompts.steer(
                    |on_sent, on_reply| {
                        client.prompt_session(
                            AcpPromptSessionParams {
                                session_id: &id,
                                prompt: &prompt,
                                config: None,
                            },
                            AcpRequestOptions {
                                on_sent: Some(on_sent),
                                on_reply: Some(on_reply),
                                output_during_write: Some(AcpOutputDuringWrite::Stream),
                                ..Default::default()
                            },
                        )
                    },
                    runtime.0.steer_decision_timeout_ms,
                );
                Ok(decision.await)
            })
            .await
    }

    fn steer_rejection(&self, session: &SessionRef, turn: &TurnRef) -> Option<AgentSteerResult> {
        if self.0.policy.steering.is_none() {
            return Some(rejected_steer(
                Rejection::TurnNotSteerable,
                format!("{} does not take steering input", self.0.policy.agent_id),
            ));
        }
        let session = session.borrow();
        let active = same_turn(&session.active_turn, turn);
        let turn = turn.borrow();
        if turn.completed
            || turn.prompts.closed()
            || turn.aborted
            || turn.source_retired
            || session.retired
            || !active
            || !session.client.is_connected()
        {
            return Some(rejected_steer(
                Rejection::TurnChanged,
                "The active turn changed",
            ));
        }
        if !turn.pending_permissions.is_empty() {
            return Some(rejected_steer(
                Rejection::TurnNotSteerable,
                "The active turn is waiting for a permission answer",
            ));
        }
        if turn.prompts.awaiting_late_reply() {
            return Some(rejected_steer(
                Rejection::TurnNotSteerable,
                "The agent has not settled the previous prompts",
            ));
        }
        None
    }

    pub fn update_session_settings(&self, id: &str, patch: AcpSessionSettingsPatch) {
        let Some(mode) = patch.permission_mode else {
            return;
        };
        for pending in &self.0.state.borrow().pending_resumes {
            if pending.session_id == id {
                pending.permission_mode.set(mode);
            }
        }
        if let Some(session) = self.session(id) {
            let session = session.borrow();
            for turn in [&session.source_turn, &session.pending_turn]
                .into_iter()
                .flatten()
            {
                turn.borrow_mut().permission_mode = mode;
            }
        }
    }

    pub fn shutdown(&self) {
        self.0.state.borrow().lifetime.cancel();
        self.0.idle_purger.stop();
        for session in self.sessions() {
            self.retire_session(&session, AcpRetireReason::SessionComplete, false);
        }
        let mut state = self.0.state.borrow_mut();
        state.sessions.clear();
        state.pending_permissions.clear();
    }

    pub fn start_purge_timer(&self) {
        if self.0.state.borrow().lifetime.is_cancelled() {
            self.0.state.borrow_mut().lifetime = CancellationToken::new();
        }
        let runtime = Rc::downgrade(&self.0);
        self.0
            .idle_purger
            .start(DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS, move || {
                let Some(runtime) = runtime.upgrade() else {
                    return;
                };
                let runtime = AcpAgentRuntime(runtime);
                let sessions = runtime.sessions().into_iter().map(|session| ((), session));
                purge_idle_sessions(
                    sessions,
                    |session| is_busy(&session.borrow()),
                    |session| session.borrow().last_activity_at,
                    |(), session| {
                        runtime.retire_session(&session, AcpRetireReason::SessionComplete, false)
                    },
                    runtime.0.clock.now_ms(),
                    DEFAULT_IDLE_SESSION_MAX_AGE_MS,
                );
            });
    }

    fn admission_signal(
        &self,
        request: &AcpExecutionRequest,
        pending: Option<&Rc<PendingResume>>,
    ) -> ExecutorResult<RuntimeSignal> {
        let lifetime = self.0.state.borrow().lifetime.clone();
        if lifetime.is_cancelled() {
            return Err(plain_error(format!(
                "The {} runtime is shutting down.",
                self.0.policy.agent_id
            )));
        }
        Ok(RuntimeSignal::new(SignalReasons {
            lifetime,
            admission: request
                .execution_admission
                .as_ref()
                .map(|admission| admission.signal().clone()),
            pending: pending.cloned(),
            agent_id: self.0.policy.agent_id.clone(),
        }))
    }

    async fn open_session(
        &self,
        request: &AcpExecutionRequest,
        native_id: Option<&str>,
        signal: &RuntimeSignal,
    ) -> ExecutorResult<SessionRef> {
        signal.check()?;
        let command = (self.0.policy.command)()?;
        let transport = (self.0.create_transport)();
        let policy = &self.0.policy;
        let initialize = garcon_initialize_params(Some(&json!({
            "clientCapabilities": policy.client_capabilities,
            "mcpServers": policy.mcp_servers.as_deref().unwrap_or_default(),
        })))?;
        let authenticate_method_id = policy
            .authenticate_method_id
            .as_ref()
            .map(|resolve| resolve())
            .transpose()?;
        let client = Rc::new(AcpClient::new(
            transport,
            AcpClientOptions {
                initialize,
                authenticate_method_id,
            },
        ));
        let mut opening = OpeningClient(Some(Rc::clone(&client)));
        let open = async {
            let spec = AcpSpawnSpec {
                command,
                args: policy
                    .args
                    .clone()
                    .unwrap_or_else(|| vec!["acp".to_owned()]),
                cwd: request.project_path.clone(),
                env: child_environment_for(policy, request)?,
            };
            client.connect(&spec).await?;
            signal.check()?;
            let mcp_servers = policy.mcp_servers.as_deref();
            if let Some(id) = native_id {
                reconnect_acp_session(
                    &client,
                    &AcpLoadSessionParams {
                        cwd: &request.project_path,
                        mcp_servers,
                        session_id: id,
                    },
                )
                .await
            } else {
                client
                    .new_session(AcpNewSessionParams {
                        cwd: &request.project_path,
                        mcp_servers,
                        model: None,
                        config: None,
                        modes: None,
                    })
                    .await
            }
        };
        let opened = tokio::select! {
            biased;
            () = signal.token.cancelled() => {
                signal.check()?;
                return Err(plain_error("ACP session opening cancelled"));
            }
            result = open => result,
        };
        signal.check()?;
        let opened = opened?;
        let id = member(&opened, "sessionId", "opened.sessionId")?
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AgentIntegrationError::new(
                    AgentIntegrationErrorCode::PROVIDER_FAILURE,
                    "ACP session response did not include a string sessionId",
                    false,
                    None,
                )
            })?
            .to_owned();
        let owner = {
            let state = self.0.state.borrow();
            state
                .sessions
                .get(&id)
                .map(|session| session.borrow().chat_id.clone())
                .or_else(|| {
                    native_id
                        .is_none()
                        .then(|| {
                            state
                                .restores
                                .get(&id)
                                .map(|restore| restore.chat_id.clone())
                        })
                        .flatten()
                })
        };
        if let Some(owner) = owner {
            return Err(plain_error(if owner != request.chat_id {
                format!("ACP session {id} is already bound to another chat")
            } else {
                format!("ACP session {id} is already active")
            }));
        }
        let models = opened.get("models").cloned();
        if native_id.is_none()
            && let Some(model) = models
                .as_ref()
                .and_then(|models| models.get("currentModelId"))
                .and_then(Value::as_str)
                .filter(|model| !model.is_empty())
        {
            self.0
                .state
                .borrow_mut()
                .agent_default_models
                .insert(request.project_path.clone(), model.to_owned());
        }
        let session = Rc::new(RefCell::new(new_runtime_session(
            AcpRuntimeSessionIdentity {
                id,
                chat_id: request.chat_id.clone(),
                project_path: request.project_path.clone(),
                client,
                config_options: opened.get("configOptions").cloned(),
                models,
            },
            self.0.clock.as_ref(),
        )?));
        self.register_session(&session);
        opening.0.take();
        Ok(session)
    }

    async fn session_for_turn(
        &self,
        request: &AcpResumeRequest,
        signal: &RuntimeSignal,
    ) -> ExecutorResult<SessionRef> {
        let id = &request.agent_session_id;
        let chat_id = &request.execution.chat_id;
        loop {
            let restoring = self
                .0
                .state
                .borrow()
                .restores
                .get(id)
                .map(|restore| (restore.chat_id.clone(), restore.settled.clone()));
            let Some((owner, settled)) = restoring else {
                break;
            };
            if owner != *chat_id {
                return Err(plain_error(format!(
                    "ACP session {id} is already bound to another chat"
                )));
            }
            signal.wait(settled).await?;
            signal.check()?;
        }
        if let Some(existing) = self.session(id) {
            {
                let session = existing.borrow();
                if session.chat_id != *chat_id {
                    return Err(plain_error(format!(
                        "ACP session {id} is already bound to another chat"
                    )));
                }
                if session.client.is_connected() || is_busy(&session) {
                    return Ok(Rc::clone(&existing));
                }
            }
            self.retire_session(&existing, AcpRetireReason::Cancelled, true);
        }
        let (resolve, settled) = settlement();
        self.0.state.borrow_mut().restores.insert(
            id.clone(),
            InFlightRestore {
                chat_id: chat_id.clone(),
                settled,
            },
        );
        let _restore = RestoreReservation {
            runtime: self.clone(),
            id: id.clone(),
            resolve: Some(resolve),
        };
        self.open_session(&request.execution, Some(id), signal)
            .await
    }

    fn register_session(&self, session: &SessionRef) {
        let client = {
            let session_fields = session.borrow();
            self.0
                .state
                .borrow_mut()
                .sessions
                .insert(session_fields.id.clone(), Rc::clone(session));
            Rc::clone(&session_fields.client)
        };
        let runtime = Rc::downgrade(&self.0);
        let session = Rc::downgrade(session);
        let _ = client.on_exit(move |_| {
            if let (Some(runtime), Some(session)) = (runtime.upgrade(), session.upgrade()) {
                let inactive = session.borrow().active_turn.is_none();
                if inactive {
                    AcpAgentRuntime(runtime).retire_session(
                        &session,
                        AcpRetireReason::Cancelled,
                        true,
                    );
                }
            }
        });
    }

    fn session(&self, id: &str) -> Option<SessionRef> {
        self.0.state.borrow().sessions.get(id).cloned()
    }

    fn sessions(&self) -> Vec<SessionRef> {
        self.0.state.borrow().sessions.values().cloned().collect()
    }

    fn warn(&self, message: &str, session_id: &str, extra: Option<(&str, String)>) {
        if let Some(logger) = &self.0.logger {
            let mut fields = IndexMap::from([
                (
                    "agentId".to_owned(),
                    Value::String(self.0.policy.agent_id.clone()).into(),
                ),
                (
                    "sessionId".to_owned(),
                    Value::String(session_id.to_owned()).into(),
                ),
            ]);
            if let Some((key, value)) = extra {
                fields.insert(key.to_owned(), Value::String(value).into());
            }
            logger.warn(message, Some(&fields));
        }
    }
}

struct AcpSteerTarget {
    owner: Weak<RuntimeInner>,
    turn: Cell<Option<Weak<RefCell<super::runtime_session::AcpTurnContext>>>>,
}

fn rejected_steer(reason: Rejection, message: impl Into<String>) -> AgentSteerResult {
    AgentSteerResult::Rejected {
        reason,
        message: message.into(),
    }
}

fn is_busy(session: &AcpAgentRuntimeSession) -> bool {
    session.active_turn.is_some() || session.pending_turn.is_some()
}

fn same_turn(current: &Option<TurnRef>, turn: &TurnRef) -> bool {
    current
        .as_ref()
        .is_some_and(|current| Rc::ptr_eq(current, turn))
}

fn active_or_pending(session: &SessionRef) -> Option<TurnRef> {
    let session = session.borrow();
    session
        .active_turn
        .as_ref()
        .or(session.pending_turn.as_ref())
        .cloned()
}

fn settlement() -> (oneshot::Sender<()>, TurnSettled) {
    let (resolve, settled) = oneshot::channel();
    let settled: LocalBoxFuture<'static, ()> = Box::pin(async move {
        let _ = settled.await;
    });
    (resolve, settled.shared())
}

struct OpeningClient(Option<Rc<AcpClient>>);

impl Drop for OpeningClient {
    fn drop(&mut self) {
        if let Some(client) = &self.0 {
            client.close();
        }
    }
}

struct ResumeReservation {
    runtime: AcpAgentRuntime,
    pending: Rc<PendingResume>,
}

impl Drop for ResumeReservation {
    fn drop(&mut self) {
        self.runtime
            .0
            .state
            .borrow_mut()
            .pending_resumes
            .retain(|pending| !Rc::ptr_eq(pending, &self.pending));
    }
}

struct RestoreReservation {
    runtime: AcpAgentRuntime,
    id: String,
    resolve: Option<oneshot::Sender<()>>,
}

impl Drop for RestoreReservation {
    fn drop(&mut self) {
        self.runtime
            .0
            .state
            .borrow_mut()
            .restores
            .shift_remove(&self.id);
        if let Some(resolve) = self.resolve.take() {
            let _ = resolve.send(());
        }
    }
}

#[derive(Clone)]
struct SignalReasons {
    lifetime: CancellationToken,
    admission: Option<CancellationToken>,
    pending: Option<Rc<PendingResume>>,
    agent_id: String,
}

impl SignalReasons {
    fn check(&self) -> ExecutorResult<()> {
        if self.lifetime.is_cancelled() {
            return Err(plain_error(format!(
                "The {} runtime stopped while the session was starting.",
                self.agent_id
            )));
        }
        check_signal(self.admission.as_ref())?;
        if let Some(pending) = &self.pending
            && pending.release.is_cancelled()
        {
            return Err(plain_error(format!(
                "The {} session {} was released while it was being restored.",
                self.agent_id, pending.session_id
            )));
        }
        Ok(())
    }
}

struct RuntimeSignal {
    reasons: SignalReasons,
    token: CancellationToken,
    forward: JoinHandle<()>,
}

impl RuntimeSignal {
    fn new(reasons: SignalReasons) -> Self {
        let token = reasons.lifetime.child_token();
        let forward = spawn_local({
            let token = token.clone();
            let admission = reasons.admission.clone();
            let release = reasons
                .pending
                .as_ref()
                .map(|pending| pending.release.clone());
            async move {
                tokio::select! {
                    () = wait_cancel(admission) => token.cancel(),
                    () = wait_cancel(release) => token.cancel(),
                }
            }
        });
        Self {
            reasons,
            token,
            forward,
        }
    }

    fn check(&self) -> ExecutorResult<()> {
        self.reasons.check()
    }

    async fn wait(&self, work: impl Future<Output = ()>) -> ExecutorResult<()> {
        self.check()?;
        let result = wait_unless_aborted(
            async {
                work.await;
                Ok::<(), Box<dyn std::error::Error>>(())
            },
            Some(&self.token),
        )
        .await;
        self.check()?;
        result
    }
}

impl Drop for RuntimeSignal {
    fn drop(&mut self) {
        self.forward.abort();
    }
}

async fn wait_cancel(token: Option<CancellationToken>) {
    match token {
        Some(token) => token.cancelled().await,
        None => std::future::pending().await,
    }
}
