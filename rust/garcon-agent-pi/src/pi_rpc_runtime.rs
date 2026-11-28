//! Ports `server-agents/pi/src/agents/pi/pi-rpc-runtime.ts`.

use std::{
    cell::{Cell, RefCell},
    collections::HashSet,
    process::Stdio,
    rc::Rc,
};

use async_trait::async_trait;
use futures::{FutureExt, future::join_all};
use garcon_agents_common::{
    chats::artificial_native_path::ARTIFICIAL_NATIVE_PATH_PREFIX,
    execution::runtime_events::{
        AgentRuntimeEvent, ProviderRunOutcome, RuntimeSteerRequest, RuntimeSteerTarget,
        runtime_rows,
    },
    shared::{
        idle_session_purger::{
            DEFAULT_IDLE_SESSION_MAX_AGE_MS, DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS,
            IdleSessionPurger, purge_idle_sessions,
        },
        shared_probe::{InFlightProbes, SharedProbe, shared_probe},
    },
};
use garcon_base::{
    errors::{ErrorInput, NamedError, js_string},
    executor_disconnect::as_agent_integration_error,
};
use garcon_contract::{
    agents::AgentModelOption,
    chat_types::{ChatMessage, ErrorMessage},
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    execution::AgentRunningSession,
    host::AgentLogger,
    native_message_source::NativeSourced,
    producer::AgentRunFailureDetail,
    resources::ExecutorResult,
    services::{AgentSteerFailureOutcome, AgentSteerRejectionReason as Reason, AgentSteerResult},
};
use garcon_js::{Clock, SystemClock, json::Opaque, path::native, to_iso_string, trim_start, utf16};
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use tokio::{process::Command, sync::oneshot};

use crate::{
    config::PiConfig,
    lazy_runtime::PiRuntime,
    message_converter::{ConvertPiMessageOptions, convert_pi_message, pi_final_response},
    pi_cli::{
        build_pi_cli_env, build_pi_rpc_spawn_command, map_thinking_mode, pipe_pi_stderr,
        require_explicit_pi_model,
    },
    pi_models::PiModelCatalogService,
    pi_process_lifecycle::{PiProcess, terminate_pi_process},
    pi_rpc_client::{
        PiRpcClient, PiRpcClientOptions, PiRpcCommandError, PiRpcResponse, PiRpcTransportError,
    },
    pi_rpc_protocol::{
        PiInputCommand, PiInputDisposition, PreparedPiRpcPrompt, classify_pi_steer_rejection,
        pi_compaction_message, pi_input_disposition, prepare_pi_rpc_prompt, rejected_pi_steer,
        resolve_pi_thinking_level,
    },
    pi_rpc_session_state::{
        CapturedPiSteerTarget, PiActiveTurn, PiPromptDispatch, PiRetireOptions, PiRpcSession,
        PiRpcSessionState as SessionState, PiTurnCompletion as Completion, Session, Turn,
    },
    pi_session_paths::{canonical_existing_pi_session_path, find_pi_session_file_by_session_id},
    runtime_types::{
        PiExecutionRequest, PiResumeRequest, PiStartRequest, PiStartedSession,
        assert_pi_execution_open, mark_pi_execution_started,
    },
};

const READY_TIMEOUT_MS: u64 = 60_000;
const STEER_RESPONSE_TIMEOUT_MS: u64 = 15_000;

#[derive(Clone)]
pub struct PiRpcRuntime(Rc<Runtime>);

struct Runtime {
    config: Rc<PiConfig>,
    logger: Rc<dyn AgentLogger>,
    models: Rc<PiModelCatalogService>,
    clock: Rc<dyn Clock>,
    sessions: RefCell<IndexMap<String, Session>>,
    live: RefCell<Vec<Session>>,
    launching: RefCell<HashSet<String>>,
    retirements: InFlightProbes<()>,
    steer_scope: Rc<()>,
    shutting_down: Cell<bool>,
    idle_purger: IdleSessionPurger,
    idle_interval_ms: u64,
    max_idle_ms: i64,
}

impl PiRpcRuntime {
    pub fn new(
        config: Rc<PiConfig>,
        logger: Rc<dyn AgentLogger>,
        models: Rc<PiModelCatalogService>,
    ) -> Self {
        Self::with_timing(
            config,
            logger,
            models,
            Rc::new(SystemClock),
            DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS,
            DEFAULT_IDLE_SESSION_MAX_AGE_MS,
        )
    }

    pub fn with_timing(
        config: Rc<PiConfig>,
        logger: Rc<dyn AgentLogger>,
        models: Rc<PiModelCatalogService>,
        clock: Rc<dyn Clock>,
        idle_interval_ms: u64,
        max_idle_ms: i64,
    ) -> Self {
        Self(Rc::new(Runtime {
            config,
            logger,
            models,
            clock,
            sessions: RefCell::default(),
            live: RefCell::default(),
            launching: RefCell::default(),
            retirements: Rc::default(),
            steer_scope: Rc::new(()),
            shutting_down: Cell::new(false),
            idle_purger: IdleSessionPurger::default(),
            idle_interval_ms,
            max_idle_ms,
        }))
    }

    pub async fn get_models(&self) -> ExecutorResult<Vec<AgentModelOption>> {
        self.0.models.get_models(None).await
    }
}

#[async_trait(?Send)]
impl PiRuntime for PiRpcRuntime {
    async fn start_session(&self, request: PiStartRequest) -> ExecutorResult<PiStartedSession> {
        assert_pi_execution_open(&request.execution)?;
        self.accepting_operations()?;
        let prompt = prepare_pi_rpc_prompt(
            &request.execution.command,
            request.execution.permission_mode,
            &request.execution.images,
        )?;
        let session = self.spawn_session(&request.execution, None).await?;
        let started = async {
            assert_pi_execution_open(&request.execution)?;
            self.accepting_operations()?;
            let started = {
                let session = session.borrow();
                PiStartedSession {
                    agent_session_id: session.id.clone(),
                    native_path: session.native_path.clone(),
                }
            };
            self.0
                .sessions
                .borrow_mut()
                .insert(started.agent_session_id.clone(), session.clone());
            if let Some(activated) = &request.on_session_activated {
                activated(&started)?;
            }
            // Binds the initial identity before an unbounded prompt preflight can stall.
            self.dispatch_prompt(&session, &request.execution, prompt)
                .await?;
            Ok::<_, Box<dyn std::error::Error>>(started)
        }
        .await;
        if let Err(error) = &started {
            self.retire_after_failure(&session, "initial turn failed", error.as_ref())
                .await;
        }
        started
    }

    async fn run_turn(&self, request: PiResumeRequest) -> ExecutorResult<()> {
        assert_pi_execution_open(&request.execution)?;
        self.accepting_operations()?;
        let prompt = prepare_pi_rpc_prompt(
            &request.execution.command,
            request.execution.permission_mode,
            &request.execution.images,
        )?;
        let id = request.agent_session_id.as_str();
        if !self.0.launching.borrow_mut().insert(id.to_owned()) {
            return Err(format!("Session {id} is already starting a turn").into());
        }
        let mut launch = LaunchGuard {
            launching: &self.0.launching,
            id: Some(id),
        };
        let (session, spawned) = self.resolve_turn_session(&request).await?;
        let outcome = async {
            assert_pi_execution_open(&request.execution)?;
            self.accepting_operations()?;
            if spawned {
                self.0
                    .sessions
                    .borrow_mut()
                    .insert(id.to_owned(), session.clone());
            }
            {
                let mut session = session.borrow_mut();
                session.chat_id.clone_from(&request.execution.chat_id);
                session.last_activity_at = self.now();
            }
            let dispatch = self
                .dispatch_prompt(&session, &request.execution, prompt)
                .await?;
            launch.release();
            dispatch.accepted.await??;
            dispatch.settle.await?;
            Ok::<_, Box<dyn std::error::Error>>(())
        }
        .await;
        if let Err(error) = &outcome
            && (spawned || pending_turn(&session).is_some())
        {
            self.retire_after_failure(&session, "turn launch failed", error.as_ref())
                .await;
        }
        outcome
    }

    async fn abort(&self, agent_session_id: &str) -> ExecutorResult<bool> {
        let Some(session) = self.session(agent_session_id) else {
            return Ok(false);
        };
        let turn = {
            let mut state = session.borrow_mut();
            if state.state == SessionState::Retiring || state.process.is_none() {
                return Ok(false);
            }
            let Some(turn) = state.turn.clone() else {
                return Ok(false);
            };
            turn.borrow_mut().stop_requested = true;
            state.last_activity_at = self.now();
            turn
        };
        // RPC abort can restart queued steering as a new run.
        self.complete_turn(&session, &turn, Completion::Stopped, None);
        self.retire_in_background(&session, "stop requested", PiRetireOptions::default());
        Ok(true)
    }

    fn is_running(&self, agent_session_id: &str) -> bool {
        self.session(agent_session_id)
            .is_some_and(|session| session.borrow().turn.is_some())
    }

    fn running_sessions(&self) -> Vec<AgentRunningSession> {
        self.0
            .sessions
            .borrow()
            .values()
            .filter_map(|session| {
                let session = session.borrow();
                session.turn.as_ref()?;
                Some(AgentRunningSession {
                    agent_session_id: session.id.clone(),
                    status: Some("running".to_owned()),
                    started_at: to_iso_string(session.start_time).ok(),
                })
            })
            .collect()
    }

    fn capture_steer_target(&self, agent_session_id: &str) -> Option<RuntimeSteerTarget> {
        if self.0.shutting_down.get() {
            return None;
        }
        let session = self.session(agent_session_id)?;
        let state = session.borrow();
        let turn = state.turn.as_ref()?;
        let active = turn.borrow();
        if state.state != SessionState::Active
            || active.stop_requested
            || active.settle_observed
            || state.pending_finish
            || state
                .process
                .as_ref()
                .is_none_or(|process| process.killed_flag().get())
            || state.client.is_none()
        {
            return None;
        }
        Some(Rc::new(CapturedPiSteerTarget {
            scope: Rc::downgrade(&self.0.steer_scope),
            session: session.clone(),
            generation: state.generation,
            turn: turn.clone(),
            consumed: Cell::new(false),
        }))
    }

    async fn steer(&self, request: RuntimeSteerRequest) -> ExecutorResult<AgentSteerResult> {
        let runtime = self.clone();
        // The provider owns a dispatched steer until its acknowledgement or failure.
        tokio::task::spawn_local(async move { runtime.steer_owned(request).await }).await?
    }

    async fn release_session(&self, chat_id: &str, agent_session_id: &str) -> ExecutorResult<()> {
        let sessions = self
            .0
            .live
            .borrow()
            .iter()
            .filter(|session| {
                let session = session.borrow();
                session.chat_id == chat_id && session.id == agent_session_id
            })
            .cloned()
            .collect::<Vec<_>>();
        let outcomes = join_all(sessions.iter().map(|session| {
            self.retire(
                session,
                "session released",
                PiRetireOptions {
                    turn_outcome: Some(Completion::Stopped),
                    ..Default::default()
                },
            )
        }))
        .await;
        outcomes.into_iter().collect::<ExecutorResult<Vec<_>>>()?;
        Ok(())
    }

    fn start_purge_timer(&self) {
        let runtime = Rc::downgrade(&self.0);
        self.0.idle_purger.start(self.0.idle_interval_ms, move || {
            let Some(runtime) = runtime.upgrade().map(Self) else {
                return;
            };
            let sessions = runtime.0.sessions.borrow().clone();
            purge_idle_sessions(
                sessions,
                |session| {
                    let session = session.borrow();
                    session.turn.is_some()
                        || matches!(
                            session.state,
                            SessionState::Starting | SessionState::Retiring
                        )
                },
                |session| session.borrow().last_activity_at,
                |_, session| {
                    runtime.retire_in_background(&session, "idle purge", PiRetireOptions::default())
                },
                runtime.now(),
                runtime.0.max_idle_ms,
            );
        });
    }

    async fn shutdown(&self) -> ExecutorResult<()> {
        self.0.shutting_down.set(true);
        self.0.idle_purger.stop();
        let sessions = self.0.live.borrow().clone();
        let results = join_all(sessions.iter().map(|session| {
            let turn = session.borrow().turn.clone();
            if let Some(turn) = turn {
                self.complete_turn(session, &turn, Completion::Shutdown, None);
            }
            self.retire(session, "server shutdown", PiRetireOptions::default())
        }))
        .await;
        self.0.sessions.borrow_mut().clear();
        if results.iter().any(Result::is_err) {
            return Err("One or more Pi processes did not shut down cleanly".into());
        }
        Ok(())
    }
}

impl PiRpcRuntime {
    fn accepting_operations(&self) -> ExecutorResult<()> {
        if self.0.shutting_down.get() {
            return Err(abort_error("Pi runtime is shutting down").into());
        }
        Ok(())
    }

    fn session(&self, id: &str) -> Option<Session> {
        self.0.sessions.borrow().get(id).cloned()
    }
    fn now(&self) -> i64 {
        self.0.clock.now_ms()
    }

    async fn resolve_turn_session(
        &self,
        request: &PiResumeRequest,
    ) -> ExecutorResult<(Session, bool)> {
        let id = request.agent_session_id.as_str();
        if let Some(existing) = self.session(id) {
            let exit = {
                let existing = existing.borrow();
                (existing.state == SessionState::Retiring)
                    .then(|| existing.exit_promise.clone())
                    .flatten()
            };
            if let Some(exit) = exit {
                exit.await?;
            }
        }
        let model = require_explicit_pi_model(&json!(request.execution.model))?.to_owned();
        let thinking = map_thinking_mode(Some(request.execution.thinking_mode));
        if let Some(current) = self.session(id) {
            let path = {
                let current = current.borrow();
                if current.turn.is_some()
                    || matches!(
                        current.state,
                        SessionState::Starting | SessionState::Prompting
                    )
                {
                    return Err(format!("Session {id} is already running").into());
                }
                current.native_path.clone()
            };
            let existing = match path {
                Some(path) => canonical_existing_pi_session_path(&path).await?.is_some(),
                None => false,
            };
            let reusable = {
                let current = current.borrow();
                current.state == SessionState::Idle
                    && current
                        .process
                        .as_ref()
                        .is_some_and(|proc| !proc.killed_flag().get())
                    && current.client.is_some()
                    && !current.native_run_open
                    && current.model == model
                    && current.thinking == thinking
                    && (existing || !current.conversation_observed)
            };
            if reusable {
                return Ok((current, false));
            }
            self.retire(
                &current,
                "model, thinking, or session-file drift",
                PiRetireOptions::default(),
            )
            .await?;
        }
        let path = self.resolve_resume_path(request).await?;
        Ok((
            self.spawn_session(&request.execution, Some((id, &path)))
                .await?,
            true,
        ))
    }

    async fn resolve_resume_path(&self, request: &PiResumeRequest) -> ExecutorResult<String> {
        // A missing path must not become a new session or an interactive confirmation.
        if let Some(path) = &request.native_path
            && !path.starts_with(ARTIFICIAL_NATIVE_PATH_PREFIX)
            && let Some(path) = canonical_existing_pi_session_path(path).await?
        {
            return Ok(path);
        }
        if let Some(found) = find_pi_session_file_by_session_id(
            &request.agent_session_id,
            &request.execution.project_path,
            &self.0.config,
        )
        .await?
            && let Some(path) = canonical_existing_pi_session_path(&found).await?
        {
            return Ok(path);
        }
        Err(provider_failure(format!(
            "Pi session file for {} could not be resolved",
            request.agent_session_id
        ))
        .into())
    }

    async fn spawn_session(
        &self,
        request: &PiExecutionRequest,
        resume: Option<(&str, &str)>,
    ) -> ExecutorResult<Session> {
        self.accepting_operations()?;
        let model = require_explicit_pi_model(&json!(request.model))?.to_owned();
        let thinking = map_thinking_mode(Some(request.thinking_mode));
        let argv = build_pi_rpc_spawn_command(
            &self.0.config,
            &model,
            thinking,
            request.permission_mode,
            resume.map(|(_, path)| path),
        )?;
        let (binary, args) = argv.split_first().ok_or("Pi CLI command is empty")?;
        let mut proc = Command::new(binary)
            .args(args)
            .current_dir(&request.project_path)
            .env_clear()
            .envs(build_pi_cli_env(request.env_overrides.as_ref()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let stdin = proc
            .stdin
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn tokio::io::AsyncWrite + Unpin>);
        let stdout = proc
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn tokio::io::AsyncRead + Unpin>);
        let stderr = proc.stderr.take();
        let process = PiProcess::supervise(proc);
        let now = self.now();
        let id = resume.map_or_else(
            || format!("pending-{}", uuid::Uuid::new_v4()),
            |(id, _)| id.to_owned(),
        );
        let session = Rc::new(RefCell::new(PiRpcSession {
            generation: 0,
            state: SessionState::Starting,
            id: id.clone(),
            chat_id: request.chat_id.clone(),
            native_path: resume.map(|(_, path)| path.to_owned()),
            model,
            thinking,
            process: Some(process.clone()),
            client: None,
            turn: None,
            native_run_open: false,
            conversation_observed: resume.is_some(),
            delivery_reservations: 0,
            pending_finish: false,
            start_time: now,
            last_activity_at: now,
            exit_promise: None,
        }));
        self.0.live.borrow_mut().push(session.clone());
        let generation = session.borrow().generation;
        let client = PiRpcClient::new(
            stdin,
            stdout,
            process.exit_receiver(),
            process.killed_flag(),
            PiRpcClientOptions {
                on_event: Rc::new({
                    let runtime = Rc::downgrade(&self.0);
                    let session = Rc::downgrade(&session);
                    move |event| {
                        if let (Some(runtime), Some(session)) =
                            (runtime.upgrade().map(Self), session.upgrade())
                            && let Err(error) =
                                runtime.route_event(&session, generation, event.as_value())
                        {
                            runtime.0.logger.warn(
                                "Pi RPC event handling failed",
                                Some(&fields([
                                    ("sessionId", json!(session.borrow().id)),
                                    (
                                        "eventType",
                                        json!(event["type"].as_str().unwrap_or("unknown")),
                                    ),
                                    ("error", json!(error.to_string())),
                                ])),
                            );
                        }
                    }
                }),
                on_malformed: Rc::new({
                    let logger = self.0.logger.clone();
                    let session = Rc::downgrade(&session);
                    move |_| {
                        if let Some(session) = session.upgrade() {
                            logger.warn(
                                "Pi emitted malformed RPC JSON",
                                Some(&fields([("sessionId", json!(session.borrow().id))])),
                            );
                        }
                    }
                }),
            },
        );
        session.borrow_mut().client = Some(client.clone());
        if let Some(stderr) = stderr {
            let logger = self.0.logger.clone();
            tokio::task::spawn_local(async move {
                pipe_pi_stderr(logger.as_ref(), &id, stderr).await;
            });
        }
        {
            let client = client.clone();
            let runtime = self.clone();
            let session = session.clone();
            tokio::task::spawn_local(async move {
                if let Some(code) = client.exited().await {
                    runtime.handle_exit(&session, generation, code);
                }
            });
        }
        if let Err(error) = self
            .complete_handshake(&session, &client, request, resume)
            .await
        {
            self.retire_and_log(
                &session,
                "readiness handshake failed",
                PiRetireOptions::default(),
            )
            .await;
            return Err(if as_agent_integration_error(error.as_ref()).is_some() {
                error
            } else {
                provider_failure(error.to_string()).into()
            });
        }
        Ok(session)
    }

    async fn complete_handshake(
        &self,
        session: &Session,
        client: &PiRpcClient,
        request: &PiExecutionRequest,
        resume: Option<(&str, &str)>,
    ) -> ExecutorResult<()> {
        let open = || {
            assert_pi_execution_open(request)?;
            self.accepting_operations()
        };
        open()?;
        client
            .send(
                command("set_steering_mode", [("mode", json!("all"))]),
                READY_TIMEOUT_MS,
                None,
            )
            .await?;
        open()?;
        let state = client
            .send(command("get_state", []), READY_TIMEOUT_MS, None)
            .await?;
        open()?;
        let data = state
            .data
            .as_ref()
            .map(Opaque::as_value)
            .unwrap_or(&Value::Null);
        let session_id = data["sessionId"].as_str().unwrap_or_default();
        let session_file = data["sessionFile"].as_str().unwrap_or_default();
        if session_id.is_empty() || session_file.is_empty() {
            return Err("Pi readiness handshake returned no session identity".into());
        }
        if let Some((resume_id, resume_path)) = resume {
            if session_id != resume_id {
                return Err(
                    format!("Pi resumed session {session_id} instead of {resume_id}").into(),
                );
            }
            let path = canonical_existing_pi_session_path(session_file).await?;
            open()?;
            if path.as_deref() != Some(resume_path) {
                return Err(format!(
                    "Pi resumed session file {session_file} instead of {resume_path}"
                )
                .into());
            }
        } else {
            if !native::is_absolute(session_file) {
                return Err(format!(
                    "Pi readiness handshake returned a relative session file: {session_file}"
                )
                .into());
            }
            let mut session = session.borrow_mut();
            session.id = session_id.to_owned();
            session.native_path = Some(native::normalize(session_file));
        }
        let model = &data["model"];
        let resolved = match (model["provider"].as_str(), model["id"].as_str()) {
            (Some(provider), Some(id)) => format!("{provider}/{id}"),
            _ => "unknown".to_owned(),
        };
        if resolved != session.borrow().model {
            return Err(format!(
                "Pi resolved model {resolved} instead of {}",
                session.borrow().model
            )
            .into());
        }
        if let Some(expected) = map_thinking_mode(Some(request.thinking_mode)) {
            let effective = resolve_pi_thinking_level(model, expected).as_str();
            if data["thinkingLevel"].as_str() != Some(effective) {
                let actual = data
                    .get("thinkingLevel")
                    .map_or(ErrorInput::Undefined, ErrorInput::Json);
                return Err(format!(
                    "Pi thinking level is {} instead of {effective}",
                    js_string(actual)
                )
                .into());
            }
        }
        open()?;
        session.borrow_mut().state = SessionState::Idle;
        Ok(())
    }

    async fn dispatch_prompt(
        &self,
        session: &Session,
        request: &PiExecutionRequest,
        prompt: PreparedPiRpcPrompt<'_>,
    ) -> ExecutorResult<PiPromptDispatch> {
        let client = session
            .borrow()
            .client
            .clone()
            .ok_or("Pi session has no RPC client")?;
        let (settle_tx, settle) = oneshot::channel();
        let turn = Rc::new(RefCell::new(PiActiveTurn {
            operation: request.operation.clone(),
            bound: false,
            stop_requested: false,
            settle_observed: false,
            post_settle_run_observed: false,
            completion: Completion::Pending,
            failure_message: None,
            final_response: None,
            steering_queue: Vec::new(),
            follow_up_queue: Vec::new(),
            settle: Some(settle_tx),
        }));
        let mut prompt_frame = command("prompt", [("message", json!(prompt.message))]);
        if !prompt.images.is_empty() {
            prompt_frame.insert("images".to_owned(), serde_json::to_value(prompt.images)?);
        }
        assert_pi_execution_open(request)?;
        mark_pi_execution_started(request).await?;
        let generation = {
            let mut session = session.borrow_mut();
            session.turn = Some(turn.clone());
            session.state = SessionState::Prompting;
            session.start_time = self.now();
            session.last_activity_at = session.start_time;
            session.generation
        };
        let response = client.send_unbounded(
            prompt_frame,
            Some(Box::new({
                let runtime = self.clone();
                let session = session.clone();
                let turn = turn.clone();
                move |response| {
                    if session.borrow().generation != generation
                        || turn.borrow().completion != Completion::Pending
                    {
                        return Ok(());
                    }
                    runtime.accept_prompt(&session, &turn, response)
                }
            })),
        );
        let (accepted_tx, accepted) = oneshot::channel();
        let runtime = self.clone();
        let session = session.clone();
        tokio::task::spawn_local(async move {
            let result = runtime
                .await_prompt_acceptance(&session, &turn, generation, response.await)
                .await;
            let _ = accepted_tx.send(result);
        });
        Ok(PiPromptDispatch { accepted, settle })
    }

    async fn await_prompt_acceptance(
        &self,
        session: &Session,
        turn: &Turn,
        generation: u64,
        response: ExecutorResult<PiRpcResponse>,
    ) -> ExecutorResult<()> {
        let Err(error) = response else {
            return Ok(());
        };
        let exited = session
            .borrow()
            .process
            .as_ref()
            .and_then(|process| *process.exit_receiver().borrow());
        if let Some(code) = exited {
            self.handle_exit(session, generation, code);
        }
        let completion = turn.borrow().completion;
        match completion {
            Completion::Stopped => Ok(()),
            Completion::Shutdown => Err(abort_error("Pi turn stopped during shutdown").into()),
            Completion::Failed => Err(provider_failure(
                turn.borrow()
                    .failure_message
                    .clone()
                    .unwrap_or_else(|| error.to_string()),
            )
            .into()),
            _ => {
                let message = error.to_string();
                self.complete_turn(
                    session,
                    turn,
                    Completion::Failed,
                    Some(format!("Pi rejected the turn: {message}")),
                );
                self.retire_in_background(session, "prompt rejected", PiRetireOptions::default());
                Err(provider_failure(message).into())
            }
        }
    }

    fn accept_prompt(
        &self,
        session: &Session,
        turn: &Turn,
        response: &PiRpcResponse,
    ) -> ExecutorResult<()> {
        let accepted = (|| {
            let disposition = pi_input_disposition(response, PiInputCommand::Prompt)?;
            let native_run_open = session.borrow().native_run_open;
            if disposition == PiInputDisposition::Queued
                || (disposition == PiInputDisposition::Started && native_run_open)
            {
                return Err(PiRpcTransportError::new(
                    "Pi accepted a prompt into an unexpected native run",
                    true,
                ));
            }
            if disposition == PiInputDisposition::Handled && !native_run_open {
                self.finish_settle(session);
                return Ok(false);
            }
            turn.borrow_mut().bound = true;
            session.borrow_mut().state = SessionState::Active;
            Ok(true)
        })();
        match accepted {
            Ok(true) => self.publish(turn, AgentRuntimeEvent::Steerable),
            Ok(false) => {}
            Err(error) => {
                self.complete_turn(session, turn, Completion::Failed, Some(error.to_string()));
                self.retire_in_background(
                    session,
                    "invalid prompt acceptance",
                    PiRetireOptions::default(),
                );
                return Err(error.into());
            }
        }
        Ok(())
    }

    fn route_event(&self, session: &Session, generation: u64, event: &Value) -> ExecutorResult<()> {
        {
            let session = session.borrow();
            if session.generation != generation || session.state == SessionState::Retiring {
                return Ok(());
            }
        }
        let timestamp = to_iso_string(self.now())?;
        match event["type"].as_str() {
            Some("agent_start") => {
                let turn = {
                    let mut session = session.borrow_mut();
                    session.native_run_open = true;
                    session.turn.clone()
                };
                if let Some(turn) = turn {
                    let mut turn = turn.borrow_mut();
                    if turn.settle_observed {
                        turn.post_settle_run_observed = true;
                    }
                } else {
                    self.retire_in_background(
                        session,
                        "unowned extension run",
                        PiRetireOptions::default(),
                    );
                }
            }
            Some("queue_update") => {
                let turn = session.borrow().turn.clone();
                if let Some(turn) = turn {
                    let mut turn = turn.borrow_mut();
                    if let Some(steering) = string_queue(&event["steering"]) {
                        turn.steering_queue = steering;
                    }
                    if let Some(follow_up) = string_queue(&event["followUp"]) {
                        turn.follow_up_queue = follow_up;
                    }
                } else if [&event["steering"], &event["followUp"]]
                    .into_iter()
                    .any(|queue| queue.as_array().is_some_and(|queue| !queue.is_empty()))
                {
                    self.retire_in_background(
                        session,
                        "unowned queued input",
                        PiRetireOptions::default(),
                    );
                }
            }
            Some("extension_ui_request") => {
                self.0.logger.warn(
                    "Pi extension requested unsupported RPC UI",
                    Some(&fields([
                        ("sessionId", json!(session.borrow().id)),
                        (
                            "method",
                            json!(event["method"].as_str().unwrap_or("unknown")),
                        ),
                    ])),
                );
            }
            Some("compaction_end") => {
                let turn = session.borrow().turn.clone();
                if let Some(turn) = turn.filter(|turn| !turn.borrow().settle_observed)
                    && let Some(message) = pi_compaction_message(event, &timestamp)
                {
                    self.publish_messages(&turn, [ChatMessage::Compaction(message)]);
                }
            }
            Some("message_end") => {
                self.route_message_end(session, &event["message"], &timestamp)?
            }
            Some("agent_settled") => {
                let turn = {
                    let mut session = session.borrow_mut();
                    session.native_run_open = false;
                    session.turn.clone()
                };
                // Extension preflight can settle before the prompted run is accepted.
                if turn.is_some_and(|turn| {
                    let turn = turn.borrow();
                    turn.bound && !turn.settle_observed
                }) {
                    self.handle_settle(session);
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn route_message_end(
        &self,
        session: &Session,
        raw: &Value,
        timestamp: &str,
    ) -> ExecutorResult<()> {
        let turn = session.borrow().turn.clone();
        let Some(turn) = turn else {
            self.0.logger.warn(
                "Ignoring Pi message without an active turn",
                Some(&fields([("sessionId", json!(session.borrow().id))])),
            );
            return Ok(());
        };
        if turn.borrow().settle_observed {
            return Ok(());
        }
        let role = raw["role"].as_str();
        if matches!(role, Some("user" | "assistant")) {
            session.borrow_mut().conversation_observed = true;
        }
        if role == Some("assistant") {
            let mut turn = turn.borrow_mut();
            turn.final_response = pi_final_response(raw);
            turn.failure_message = None;
        }
        if role == Some("user") {
            return Ok(());
        }
        let converted = convert_pi_message(
            raw,
            ConvertPiMessageOptions {
                include_user: false,
                ..Default::default()
            },
            self.0.clock.as_ref(),
        )?;
        if !converted.is_empty() {
            self.publish_messages(&turn, converted);
        }
        if let Some(reason @ ("error" | "aborted")) = raw["stopReason"].as_str() {
            let content = raw["errorMessage"]
                .as_str()
                .map_or_else(|| format!("Pi turn {reason}."), str::to_owned);
            turn.borrow_mut().failure_message = Some(content.clone());
            self.publish_messages(
                &turn,
                [ChatMessage::Error(ErrorMessage {
                    timestamp: timestamp.to_owned(),
                    content,
                })],
            );
        }
        Ok(())
    }

    fn handle_settle(&self, session: &Session) {
        {
            let mut session = session.borrow_mut();
            let Some(turn) = &session.turn else {
                return;
            };
            turn.borrow_mut().settle_observed = true;
            session.last_activity_at = self.now();
            if session.delivery_reservations > 0 {
                session.pending_finish = true;
                return;
            }
        }
        self.finish_settle(session);
    }

    fn flush_pending_finish(&self, session: &Session) {
        {
            let mut session = session.borrow_mut();
            if session.delivery_reservations > 0 || !session.pending_finish {
                return;
            }
            session.pending_finish = false;
        }
        self.finish_settle(session);
    }

    fn finish_settle(&self, session: &Session) {
        let (turn, should_retire, failure_message) = {
            let session = session.borrow();
            let Some(turn) = &session.turn else {
                return;
            };
            let active = turn.borrow();
            let should_retire = !active.steering_queue.is_empty()
                || !active.follow_up_queue.is_empty()
                || active.post_settle_run_observed
                || session.native_run_open;
            (turn.clone(), should_retire, active.failure_message.clone())
        };
        let completion = if failure_message
            .as_ref()
            .is_some_and(|message| !message.is_empty())
        {
            Completion::Failed
        } else {
            Completion::Finished
        };
        self.complete_turn(session, &turn, completion, failure_message);
        if should_retire {
            self.retire_in_background(
                session,
                "input remained uncertain at settle",
                PiRetireOptions::default(),
            );
        }
    }

    fn handle_exit(&self, session: &Session, generation: u64, code: i32) {
        let turn = {
            let mut session = session.borrow_mut();
            if session.generation != generation {
                return;
            }
            session.process = None;
            session.client = None;
            session.state = SessionState::Retiring;
            session.last_activity_at = self.now();
            session.turn.clone()
        };
        self.remove_session(session);
        if let Some(turn) = turn {
            self.complete_turn(
                session,
                &turn,
                Completion::Failed,
                Some(format!("Pi process exited before completion (code {code})")),
            );
        }
    }

    fn complete_turn(
        &self,
        session: &Session,
        turn: &Turn,
        outcome: Completion,
        failure_message: Option<String>,
    ) {
        let (run_id, final_response, settle) = {
            let mut turn = turn.borrow_mut();
            if turn.completion != Completion::Pending {
                return;
            }
            turn.completion = outcome;
            turn.failure_message.clone_from(&failure_message);
            (
                turn.operation.run_id.clone(),
                turn.final_response.clone(),
                turn.settle.take(),
            )
        };
        {
            let mut state = session.borrow_mut();
            if state
                .turn
                .as_ref()
                .is_some_and(|active| Rc::ptr_eq(active, turn))
            {
                state.turn = None;
            }
            state.pending_finish = false;
            state.last_activity_at = self.now();
        }
        let outcome = match outcome {
            Completion::Finished => Some(ProviderRunOutcome::Finished { final_response }),
            Completion::Stopped => Some(ProviderRunOutcome::Finished {
                final_response: None,
            }),
            Completion::Failed => Some(ProviderRunOutcome::Failed {
                error: Some(AgentRunFailureDetail {
                    code: AgentIntegrationErrorCode::PROVIDER_FAILURE
                        .as_str()
                        .to_owned(),
                    message: Some(
                        failure_message
                            .unwrap_or_else(|| "Pi turn failed before completion".to_owned()),
                    ),
                }),
            }),
            Completion::Shutdown | Completion::Pending => None,
        };
        if let Some(outcome) = outcome {
            self.publish(
                turn,
                AgentRuntimeEvent::RunEnded {
                    run_id,
                    outcome,
                    working_directory: None,
                },
            );
        }
        if let Some(settle) = settle {
            let _ = settle.send(());
        }
        let mut state = session.borrow_mut();
        if state.state != SessionState::Retiring
            && state.process.is_some()
            && state.client.is_some()
        {
            state.state = SessionState::Idle;
        }
    }

    fn publish_messages(&self, turn: &Turn, rows: impl IntoIterator<Item = ChatMessage>) {
        self.publish(
            turn,
            AgentRuntimeEvent::Rows {
                rows: runtime_rows(rows.into_iter().map(NativeSourced::new)),
            },
        );
    }

    fn publish(&self, turn: &Turn, event: AgentRuntimeEvent) {
        let publish = turn.borrow().operation.publish.clone();
        publish(event);
    }

    fn remove_session(&self, session: &Session) {
        self.0
            .live
            .borrow_mut()
            .retain(|live| !Rc::ptr_eq(live, session));
        let id = session.borrow().id.clone();
        let mut sessions = self.0.sessions.borrow_mut();
        if sessions
            .get(&id)
            .is_some_and(|current| Rc::ptr_eq(current, session))
        {
            sessions.shift_remove(&id);
        }
    }

    fn retire(&self, session: &Session, reason: &str, options: PiRetireOptions) -> SharedProbe<()> {
        let (turn, client, process) = {
            let mut state = session.borrow_mut();
            if state.state == SessionState::Retiring
                && let Some(exit) = state.exit_promise.clone()
            {
                return exit;
            }
            state.state = SessionState::Retiring;
            state.generation += 1;
            (
                state.turn.clone(),
                state.client.clone(),
                state.process.clone(),
            )
        };
        if let (Some(turn), Some(outcome)) = (turn, options.turn_outcome) {
            self.complete_turn(session, &turn, outcome, options.failure_message);
        }
        if let Some(client) = client {
            client.dispose(reason);
        }
        let task = shared_probe(
            &self.0.retirements,
            &format!("{:p}", Rc::as_ptr(session)),
            {
                let session = session.clone();
                let runtime = self.clone();
                || {
                    async move {
                        if let Some(process) = process {
                            terminate_pi_process(&process).await?;
                        }
                        {
                            let mut state = session.borrow_mut();
                            state.process = None;
                            state.client = None;
                        }
                        runtime.remove_session(&session);
                        Ok(())
                    }
                    .boxed_local()
                }
            },
        );
        session.borrow_mut().exit_promise = Some(task.clone());
        self.0.logger.debug(
            "Pi session retired",
            Some(&fields([
                ("sessionId", json!(utf16::truncate(&session.borrow().id, 8))),
                ("reason", json!(reason)),
            ])),
        );
        task
    }

    async fn retire_after_failure(
        &self,
        session: &Session,
        reason: &str,
        error: &dyn std::error::Error,
    ) {
        self.retire_and_log(
            session,
            reason,
            PiRetireOptions {
                turn_outcome: pending_turn(session).map(|_| Completion::Failed),
                failure_message: Some(error.to_string()),
            },
        )
        .await;
    }

    async fn retire_and_log(&self, session: &Session, reason: &str, options: PiRetireOptions) {
        if let Err(error) = self.retire(session, reason, options).await {
            self.log_retire_error(session, reason, error.as_ref());
        }
    }

    fn retire_in_background(
        &self,
        session: &Session,
        reason: &'static str,
        options: PiRetireOptions,
    ) {
        let task = self.retire(session, reason, options);
        let runtime = self.clone();
        let session = session.clone();
        tokio::task::spawn_local(async move {
            if let Err(error) = task.await {
                runtime.log_retire_error(&session, reason, error.as_ref());
            }
        });
    }

    fn log_retire_error(&self, session: &Session, reason: &str, error: &dyn std::error::Error) {
        self.0.logger.error(
            "Pi session retirement failed",
            Some(&fields([
                ("sessionId", json!(utf16::truncate(&session.borrow().id, 8))),
                ("reason", json!(reason)),
                ("error", json!(error.to_string())),
            ])),
        );
    }

    fn validate_steer_target(
        &self,
        chat: &str,
        id: &str,
        captured: &CapturedPiSteerTarget,
    ) -> Option<AgentSteerResult> {
        if self.0.shutting_down.get() {
            return Some(rejected_pi_steer(Reason::NoActiveTurn, "No active Pi turn"));
        }
        let session = captured.session.borrow();
        let turn = captured.turn.borrow();
        if self
            .session(id)
            .is_none_or(|active| !Rc::ptr_eq(&active, &captured.session))
            || session.chat_id != chat
            || session.state != SessionState::Active
            || session
                .turn
                .as_ref()
                .is_none_or(|active| !Rc::ptr_eq(active, &captured.turn))
            || session.generation != captured.generation
            || turn.stop_requested
        {
            return Some(rejected_pi_steer(
                Reason::TurnChanged,
                "The active Pi turn changed",
            ));
        }
        if turn.settle_observed || session.pending_finish {
            return Some(rejected_pi_steer(
                Reason::TurnChanged,
                "The active Pi turn settled before steering",
            ));
        }
        None
    }

    async fn steer_owned(&self, request: RuntimeSteerRequest) -> ExecutorResult<AgentSteerResult> {
        if trim_start(&request.input).starts_with('/') {
            return Ok(rejected_pi_steer(
                Reason::InvalidInput,
                "Pi interprets leading-/ steering text as a command; rephrase without the slash",
            ));
        }
        let captured = request
            .target
            .and_then(|target| target.downcast::<CapturedPiSteerTarget>().ok())
            .filter(|target| {
                target
                    .scope
                    .upgrade()
                    .is_some_and(|scope| Rc::ptr_eq(&scope, &self.0.steer_scope))
                    && !target.consumed.replace(true)
            });
        let Some(captured) = captured else {
            return Ok(rejected_pi_steer(Reason::NoActiveTurn, "No active Pi turn"));
        };
        let validate =
            || self.validate_steer_target(&request.chat_id, &request.agent_session_id, &captured);
        if let Some(rejection) = validate() {
            return Ok(rejection);
        }
        captured.session.borrow_mut().delivery_reservations += 1;
        let _reservation = SteerReservation {
            runtime: self,
            session: &captured.session,
        };
        (request.prepare_delivery)().await?;
        if let Some(rejection) = validate() {
            return Ok(rejection);
        }

        let acknowledged = Rc::new(Cell::new(false));
        let observer = Box::new({
            let runtime = self.clone();
            let captured = captured.clone();
            let acknowledged = acknowledged.clone();
            let chat = request.chat_id.clone();
            let id = request.agent_session_id.clone();
            move |_response: &PiRpcResponse| {
                acknowledged.set(
                    runtime
                        .validate_steer_target(&chat, &id, &captured)
                        .is_none(),
                );
                Ok(())
            }
        });
        let client = captured
            .session
            .borrow()
            .client
            .clone()
            .ok_or("Pi session has no RPC client")?;
        let response = client
            .send(
                command("steer", [("message", json!(request.input))]),
                STEER_RESPONSE_TIMEOUT_MS,
                Some(observer),
            )
            .await;
        let disposition = response
            .and_then(|response| Ok(pi_input_disposition(&response, PiInputCommand::Steer)?));
        match disposition {
            Ok(PiInputDisposition::Handled) => return Ok(AgentSteerResult::Accepted),
            Ok(_) => {}
            Err(error) => {
                if let Some(error) = error.downcast_ref::<PiRpcCommandError>() {
                    return Ok(classify_pi_steer_rejection(error));
                }
                let Some(error) = error.downcast_ref::<PiRpcTransportError>() else {
                    return Err(error);
                };
                let message = error.to_string();
                let outcome = if error.write_attempted {
                    self.retire_in_background(
                        &captured.session,
                        "steering delivery became uncertain",
                        PiRetireOptions {
                            turn_outcome: Some(Completion::Failed),
                            failure_message: Some(message.clone()),
                        },
                    );
                    AgentSteerFailureOutcome::Unknown
                } else {
                    AgentSteerFailureOutcome::NotSent
                };
                return Ok(AgentSteerResult::Failed { outcome, message });
            }
        }
        if !acknowledged.get() {
            self.retire_in_background(
                &captured.session,
                "steer missed the run",
                PiRetireOptions::default(),
            );
            return Ok(AgentSteerResult::Failed {
                outcome: AgentSteerFailureOutcome::Unknown,
                message:
                    "Pi queued the steering input, but delivery to the target turn is unconfirmed"
                        .to_owned(),
            });
        }
        let session = captured.session.borrow();
        self.0.logger.debug(
            "Pi steering accepted",
            Some(&fields([
                ("chatId", json!(session.chat_id)),
                ("runId", json!(captured.turn.borrow().operation.run_id)),
                ("sessionId", json!(utf16::truncate(&session.id, 8))),
            ])),
        );
        Ok(AgentSteerResult::Accepted)
    }
}

struct SteerReservation<'a> {
    runtime: &'a PiRpcRuntime,
    session: &'a Session,
}

impl Drop for SteerReservation<'_> {
    fn drop(&mut self) {
        self.session.borrow_mut().delivery_reservations -= 1;
        self.runtime.flush_pending_finish(self.session);
    }
}

struct LaunchGuard<'a> {
    launching: &'a RefCell<HashSet<String>>,
    id: Option<&'a str>,
}

impl LaunchGuard<'_> {
    fn release(&mut self) {
        if let Some(id) = self.id.take() {
            self.launching.borrow_mut().remove(id);
        }
    }
}

impl Drop for LaunchGuard<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

fn command<const N: usize>(kind: &str, values: [(&str, Value); N]) -> Map<String, Value> {
    std::iter::once(("type".to_owned(), json!(kind)))
        .chain(values.map(|(key, value)| (key.to_owned(), value)))
        .collect()
}

fn fields<const N: usize>(entries: [(&str, Value); N]) -> IndexMap<String, Opaque> {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.into()))
        .collect()
}

fn abort_error(message: &str) -> NamedError {
    NamedError {
        name: "AbortError".to_owned(),
        message: message.to_owned(),
        code: None,
    }
}

fn provider_failure(message: impl Into<String>) -> AgentIntegrationError {
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::PROVIDER_FAILURE,
        message,
        false,
        None,
    )
}

fn pending_turn(session: &Session) -> Option<Turn> {
    session
        .borrow()
        .turn
        .clone()
        .filter(|turn| turn.borrow().completion == Completion::Pending)
}

fn string_queue(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|value| value.as_str().map(str::to_owned))
        .collect()
}
