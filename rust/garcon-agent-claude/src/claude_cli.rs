use std::{
    cell::{Cell, RefCell},
    ffi::OsString,
    rc::Rc,
    time::Duration,
};

use futures::FutureExt;
use garcon_agents_common::{
    execution::{
        permission_modes::provider_startup_permission_mode,
        runtime_events::{AgentRuntimeEvent, AgentRuntimeOperation, ProviderRunOutcome},
    },
    shared::idle_session_purger::{
        DEFAULT_IDLE_SESSION_MAX_AGE_MS, DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS, IdleSessionPurger,
    },
};
use garcon_contract::{
    chat_modes::{ClaudeThinkingMode, PermissionMode, ThinkingMode},
    chat_types::{AssistantMessage, ChatMessage, CompactionMessage, ErrorMessage},
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    execution::AgentRunningSession,
    host::AgentLogger,
    native_message_source::{
        NativeMessageSourceInput, NativeSourced, attach_native_message_source,
    },
    producer::{AgentProviderPermissionLifecycle, AgentRunFailureDetail, AgentTerminalPermission},
    resources::ExecutorResult,
};
use garcon_js::{Number, json::Opaque, trim};
use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::{
    active_turn::ClaudeActiveTurn,
    cli_control::{ClaudeControlBroker, ClaudeControlRequestOptions},
    cli_environment::build_claude_cli_environment,
    cli_invocation::{ClaudeCliArgOptions, build_claude_cli_args},
    cli_process_transport::{
        ClaudeProcessExit, ClaudeProcessOptions, ClaudeProcessSignal, ClaudeProcessTransport,
        ClaudeProcessTransportOptions, ClaudeTransportFailure, ClaudeTransportFailureKind,
        Retirement, spawn_claude_subprocess,
    },
    cli_protocol::{
        ClaudeProviderSessionState, ClaudeResultCorrelation, ClaudeTurnInputEvent,
        ClaudeTurnTerminalState, claude_result_failure_message,
        convert_cli_message_to_chat_messages, is_claude_subagent_content, truthy,
    },
    cli_session_state::{
        ClaudeProviderStateHandlers, flush_deferred_claude_provider_idle,
        handle_claude_provider_lifecycle_message,
    },
    cli_version::{ClaudeCliVersionProbe, CliVersion},
    compaction::{extract_compaction_summary, is_compaction_summary_text, parse_compact_metadata},
    disk_attachments::{MaterializedClaudeDiskAttachments, materialize_claude_disk_attachments},
    interrupt_receipt::{
        ClaudeInterruptReceiptHandlers, ClaudeInterruptSession, handle_claude_interrupt_receipt,
    },
    model_context::resolve_claude_model,
    process_retirements::ClaudeProcessRetirementTracker,
    runtime_state::{
        CONVERSATION_RESET_FAILURE, ClaudeRunningSession, ClaudeSessionProcess,
        INTERRUPT_COMPLETION_TIMEOUT, INTERRUPT_RECEIPT_TIMEOUT, InterruptFallbackStage,
        PendingPermission,
    },
    runtime_types::{
        ClaudeProjectPathUpdate, ClaudeResumeRequest, ClaudeStartRequest,
        assert_claude_execution_open,
    },
    session_model::{ClaudeSessionModelOptions, configure_claude_session_model},
    session_options::{
        ClaudeSessionOptions, merge_claude_session_options,
        normalize_claude_thinking_mode_for_state,
    },
    steering::{
        CLAUDE_STEER_IDLE_FENCE_TIMEOUT, CLAUDE_STEER_WRITE_TIMEOUT, ClaudeSteeringController,
        ClaudeSteeringControllerOptions,
    },
    turn_publisher::ClaudeTurnPublisher,
    user_input::{
        ClaudeUserInputFrameOptions, build_claude_initial_user_content,
        build_claude_user_input_frame,
    },
};

pub type ClaudeStreamHandler = dyn Fn(&Rc<ClaudeRunningSession>, Opaque);
const CLAUDE_INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);

pub struct ClaudeCli {
    pub logger: Rc<dyn AgentLogger>,
    pub control: ClaudeControlBroker,
    pub publisher: ClaudeTurnPublisher,
    pub steering: ClaudeSteeringController,
    pub shutting_down: Cell<bool>,
    sessions: RefCell<IndexMap<String, Rc<ClaudeRunningSession>>>,
    retirements: ClaudeProcessRetirementTracker,
    idle_purger: IdleSessionPurger,
    pub pending_permissions: RefCell<Vec<PendingPermission>>,
    executable: Rc<dyn Fn() -> ExecutorResult<OsString>>,
    pub version_probe: Rc<ClaudeCliVersionProbe>,
}

impl ClaudeCli {
    pub fn new(executable: Rc<dyn Fn() -> OsString>, logger: Rc<dyn AgentLogger>) -> Rc<Self> {
        Self::with_executable_reader(Rc::new(move || Ok(executable())), logger)
    }

    pub fn with_executable_reader(
        executable: Rc<dyn Fn() -> ExecutorResult<OsString>>,
        logger: Rc<dyn AgentLogger>,
    ) -> Rc<Self> {
        Rc::new_cyclic(|runtime: &std::rc::Weak<Self>| {
            let runtime = runtime.clone();
            Self {
                executable,
                version_probe: Rc::new(ClaudeCliVersionProbe::default()),
                publisher: ClaudeTurnPublisher::new(logger.clone()),
                steering: ClaudeSteeringController::new(ClaudeSteeringControllerOptions {
                    session: Rc::new({
                        let runtime = runtime.clone();
                        move |id| runtime.upgrade().and_then(|runtime| runtime.session(id))
                    }),
                    is_shutting_down: Rc::new({
                        let runtime = runtime.clone();
                        move || {
                            runtime
                                .upgrade()
                                .is_none_or(|runtime| runtime.shutting_down.get())
                        }
                    }),
                    logger: logger.clone(),
                    write_timeout: CLAUDE_STEER_WRITE_TIMEOUT,
                    flush_deferred_idle: Rc::new({
                        let runtime = runtime.clone();
                        move |session, turn| {
                            if let Some(runtime) = runtime.upgrade() {
                                runtime.flush_provider_idle(session, turn);
                            }
                        }
                    }),
                }),
                logger,
                shutting_down: Cell::new(false),
                sessions: RefCell::default(),
                retirements: ClaudeProcessRetirementTracker::default(),
                idle_purger: IdleSessionPurger::default(),
                pending_permissions: RefCell::default(),
                control: ClaudeControlBroker::new(Rc::new(move |session_id, frame| {
                    let process = runtime
                        .upgrade()
                        .and_then(|runtime| runtime.session(&session_id))
                        .and_then(|session| session.process.borrow().clone());
                    match process {
                        Some(process) => process.transport.write_line(frame, Default::default()),
                        None => Box::pin(async move {
                            Err(
                                format!("Claude session {session_id} has no writable process")
                                    .into(),
                            )
                        }),
                    }
                })),
            }
        })
    }

    pub fn session(&self, id: &str) -> Option<Rc<ClaudeRunningSession>> {
        self.sessions.borrow().get(id).cloned()
    }

    pub fn register_session(
        &self,
        session: Rc<ClaudeRunningSession>,
    ) -> Option<Rc<ClaudeRunningSession>> {
        self.sessions
            .borrow_mut()
            .insert(session.id.clone(), session)
    }

    pub fn begin_turn(
        &self,
        session: &ClaudeRunningSession,
        operation: AgentRuntimeOperation,
    ) -> ExecutorResult<Rc<ClaudeActiveTurn>> {
        if session.active_turn.borrow().is_some() {
            return Err(format!("Claude session {} already has an active turn", session.id).into());
        }
        let mut turn = ClaudeActiveTurn::new(session.background_task_count.get(), operation);
        turn.started_at_iso = Some(session.now_iso()?);
        let turn = Rc::new(turn);
        session.unowned_provider_activity.set(false);
        session.active_turn.replace(Some(turn.clone()));
        session.last_activity_at.set(turn.started_at);
        Ok(turn)
    }

    pub async fn spawn_cli(
        self: &Rc<Self>,
        session: &Rc<ClaudeRunningSession>,
        options: ClaudeSessionOptions,
        resume: bool,
        on_message: Rc<ClaudeStreamHandler>,
    ) -> ExecutorResult<()> {
        self.spawn_cli_with_version(session, options, resume, None, on_message)
            .await
    }

    async fn spawn_cli_with_version(
        self: &Rc<Self>,
        session: &Rc<ClaudeRunningSession>,
        options: ClaudeSessionOptions,
        resume: bool,
        version: Option<CliVersion>,
        on_message: Rc<ClaudeStreamHandler>,
    ) -> ExecutorResult<()> {
        let prior_retirement = session.retirement.borrow().clone();
        if let Some(prior) = prior_retirement {
            prior.as_ref().clone().await?;
        }
        self.retirements.wait(&session.id, &session.chat_id).await?;
        if self.shutting_down.get()
            || !self
                .session(&session.id)
                .is_some_and(|current| Rc::ptr_eq(&current, session))
        {
            return Err("Claude session ended before its process could start".into());
        }
        if session.process.borrow().is_some() {
            return Err(format!("Claude session {} already has a process", session.id).into());
        }
        let executable = (self.executable)()?;
        let args = build_claude_cli_args(ClaudeCliArgOptions {
            model: Some(&options.model),
            permission_mode: Some(options.permission_mode),
            thinking_mode: Some(options.thinking_mode),
            claude_thinking_mode: options.claude_thinking_mode,
            session_id: (!resume).then_some(session.id.as_str()),
            resume_session_id: resume.then_some(session.id.as_str()),
            stream_json: true,
            ..Default::default()
        })?;
        if let Some(version) = version {
            let fields = cli_log_fields([
                ("binary", json!(executable.to_string_lossy())),
                ("chatId", json!(session.chat_id)),
                ("sessionId", json!(session_log_id(&session.id))),
                ("resumed", json!(resume)),
                (
                    "cliVersion",
                    json!(version.map(Number::to_js_string).join(".")),
                ),
            ]);
            self.logger.info("Spawning Claude CLI", Some(&fields));
        }
        let mut environment = build_claude_cli_environment(
            &options.model,
            std::env::vars_os(),
            options
                .env_overrides
                .iter()
                .flatten()
                .map(|(key, value)| (key.into(), value.into())),
        )?;
        environment.insert("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS".into(), "1".into());
        let process = spawn_claude_subprocess(ClaudeProcessOptions {
            executable,
            arguments: args.into_iter().map(OsString::from).collect(),
            cwd: options.project_path.clone().into(),
            environment,
        })?;
        session
            .provider_state
            .set(ClaudeProviderSessionState::Unknown);
        session.background_task_count.set(0);
        session.unowned_provider_activity.set(false);
        session.current_thinking_mode.set(options.thinking_mode);
        session
            .current_claude_thinking_mode
            .set(normalize_claude_thinking_mode_for_state(
                options.claude_thinking_mode,
            ));
        session.current_model.replace(options.model.clone());
        session
            .current_env_overrides
            .replace(options.env_overrides.clone());
        session.options.replace(options);

        let pid = process.pid;
        let identity = Rc::new(());
        let current = {
            let runtime = Rc::downgrade(self);
            let session = Rc::downgrade(session);
            let identity = identity.clone();
            move || {
                runtime
                    .upgrade()
                    .zip(session.upgrade())
                    .filter(|(_, session)| session.is_current_process(&identity))
            }
        };
        let transport = ClaudeProcessTransport::new(ClaudeProcessTransportOptions {
            process,
            logger: self.logger.clone(),
            session_id: session.id.clone(),
            on_message: Rc::new({
                let current = current.clone();
                move |message| {
                    if let Some((runtime, session)) = current()
                        && runtime
                            .session(&session.id)
                            .is_some_and(|registered| Rc::ptr_eq(&registered, &session))
                        && !is_claude_subagent_content(message.as_value())
                        && !runtime.on_control_or_lifecycle(&session, message.as_value())
                    {
                        on_message(&session, message);
                    }
                }
            }),
            on_failure: Rc::new({
                let current = current.clone();
                move |failure| {
                    if let Some((runtime, session)) = current() {
                        runtime.handle_transport_failure(&session, failure);
                    }
                }
            }),
            on_eof: Rc::new({
                let current = current.clone();
                move || {
                    if let Some((runtime, session)) = current() {
                        runtime.handle_stdout_eof(&session);
                    }
                }
            }),
            on_exit: Rc::new({
                let runtime = Rc::downgrade(self);
                let session = Rc::downgrade(session);
                let identity = identity.clone();
                move |exit| {
                    if let Some((runtime, session)) = runtime.upgrade().zip(session.upgrade()) {
                        let current = session.is_current_process(&identity);
                        runtime.log_process_exit(&session, pid, &exit, current);
                        if current {
                            runtime.handle_process_exit(&session, exit.exit_code);
                        }
                    }
                }
            }),
            max_stdout_frame_bytes: None,
        });
        session.process.replace(Some(ClaudeSessionProcess {
            identity: identity.clone(),
            transport,
        }));
        let started_at = Instant::now();
        let initialize = self
            .control
            .request(
                &session.id,
                json!({"subtype":"initialize"}).into(),
                ClaudeControlRequestOptions {
                    timeout: Some(CLAUDE_INITIALIZE_TIMEOUT),
                    ..Default::default()
                },
            )
            .await;
        match initialize {
            Ok(response) => {
                let details = cli_log_fields([
                    ("chatId", json!(session.chat_id)),
                    ("sessionId", json!(session_log_id(&session.id))),
                    ("processId", json!(pid)),
                    ("durationMs", json!(started_at.elapsed().as_millis())),
                    (
                        "commandCount",
                        json!(response["commands"].as_array().map_or(0, Vec::len)),
                    ),
                ]);
                self.logger
                    .info("Claude CLI control protocol initialized", Some(&details));
                Ok(())
            }
            Err(error) => {
                if session.is_current_process(&identity)
                    && let Some(retirement) = self.retire_session_process(session)?
                {
                    retirement.as_ref().clone().await?;
                }
                Err(error)
            }
        }
    }

    async fn spawn_registered_cli(
        self: &Rc<Self>,
        session: &Rc<ClaudeRunningSession>,
        options: ClaudeSessionOptions,
        resume: bool,
        version: CliVersion,
    ) -> ExecutorResult<()> {
        let logger = self.logger.clone();
        self.spawn_cli_with_version(
            session,
            options,
            resume,
            Some(version),
            Rc::new(move |_, message| {
                if message["type"] == "system" {
                    return;
                }
                let fields = message
                    .get("type")
                    .cloned()
                    .map(|kind| IndexMap::from([("messageType".into(), kind.into())]));
                logger.info(
                    "Claude CLI emitted an unrecognized message type",
                    fields.as_ref(),
                );
            }),
        )
        .await
    }

    pub async fn start_claude_cli_session(
        self: &Rc<Self>,
        request: ClaudeStartRequest,
    ) -> ExecutorResult<String> {
        let ClaudeStartRequest {
            execution,
            agent_session_id,
            on_session_activated,
        } = request;
        let admission = execution.execution_admission.as_deref();
        assert_claude_execution_open(admission)?;
        resolve_claude_model(&execution.model)?;
        if execution.chat_id.is_empty() {
            return Err("chatId is required when starting a Claude session".into());
        }
        if agent_session_id.is_empty() {
            return Err("agentSessionId is required when starting a Claude session".into());
        }

        let options = execution.session_options(&agent_session_id);
        let session = Rc::new(ClaudeRunningSession::new(options.clone()));
        session
            .initialization
            .replace(Some(CancellationToken::new()));
        let active_turn = self.begin_turn(&session, execution.operation)?;
        let previous = self.register_session(session.clone());
        let version = async {
            if let Some(previous) = previous {
                self.retire_session(&previous).await?;
            }
            if !self.is_current_session(&session) {
                return Ok(None);
            }
            if let Some(activate) = on_session_activated {
                activate();
            }
            self.version_probe
                .assert_compatible(&(self.executable)()?)
                .await
                .map(Some)
        }
        .await;
        let version = match version {
            Ok(Some(version)) if self.is_current_session(&session) => version,
            Ok(_) => return Ok(agent_session_id),
            Err(error) => {
                if self.is_current_session(&session) {
                    session.active_turn.take();
                    active_turn.finish();
                    self.sessions.borrow_mut().shift_remove(&agent_session_id);
                }
                complete_session_initialization(&session);
                return Err(error);
            }
        };

        let mut prepared = None;
        let mut result = async {
            assert_claude_execution_open(admission)?;
            self.spawn_registered_cli(&session, options, false, version)
                .await?;
            assert_claude_execution_open(admission)?;
            let attachments = prepared.insert(
                materialize_claude_disk_attachments(&execution.command, &execution.images).await?,
            );
            if let Some(admission) = admission {
                admission.mark_started().await?;
            }
            self.send_user_message(&session, &active_turn, attachments)
                .await?;
            complete_session_initialization(&session);
            active_turn.completion().await;
            Ok(())
        }
        .await;
        if result.is_err() && self.is_current_session(&session) {
            match self.retire_session(&session).await {
                Ok(()) => {
                    if self.is_current_session(&session) {
                        self.sessions.borrow_mut().shift_remove(&agent_session_id);
                    }
                }
                Err(retirement) => result = Err(retirement),
            }
        }
        complete_session_initialization(&session);
        if let Some(prepared) = prepared {
            prepared.cleanup().await;
        }
        result.map(|()| agent_session_id)
    }

    pub async fn run_claude_turn(
        self: &Rc<Self>,
        request: ClaudeResumeRequest,
    ) -> ExecutorResult<()> {
        let ClaudeResumeRequest {
            execution,
            agent_session_id,
            ..
        } = request;
        let admission = execution.execution_admission.as_deref();
        assert_claude_execution_open(admission)?;
        resolve_claude_model(&execution.model)?;
        if agent_session_id.is_empty() {
            return Err("Cannot resume without session ID".into());
        }
        if execution.chat_id.is_empty() {
            return Err("Cannot resume without chat ID".into());
        }
        let version = self
            .version_probe
            .assert_compatible(&(self.executable)()?)
            .await?;
        assert_claude_execution_open(admission)?;
        if self.shutting_down.get() {
            return Err("Claude runtime is shutting down".into());
        }

        let options = execution.session_options(&agent_session_id);
        let mut session = self.session(&agent_session_id);
        let initialization = session
            .as_ref()
            .and_then(|session| session.initialization.borrow().clone());
        if let Some(initialization) = initialization {
            initialization.cancelled().await;
            session = self.session(&agent_session_id);
        }
        let session = session.unwrap_or_else(|| {
            let session = Rc::new(ClaudeRunningSession::new(options.clone()));
            self.register_session(session.clone());
            session
        });
        if self.shutting_down.get() {
            return Err("Claude runtime is shutting down".into());
        }

        let aborting = session
            .active_turn
            .borrow()
            .clone()
            .filter(|turn| turn.protocol.borrow().abort_requested());
        if let Some(turn) = aborting {
            turn.completion().await;
            assert_claude_execution_open(admission)?;
        }
        if session.active_turn.borrow().is_some() || session.resume_owner.borrow().is_some() {
            return Err(
                format!("Claude session {agent_session_id} already has an active turn").into(),
            );
        }
        let owner = Rc::new(());
        session.resume_owner.replace(Some(owner.clone()));
        let is_resume_owner = || {
            session
                .resume_owner
                .borrow()
                .as_ref()
                .is_some_and(|current| Rc::ptr_eq(current, &owner))
        };
        let mut owned_turn = None;
        let mut prepared = None;
        let mut result = async {
            if execution.chat_id != session.chat_id {
                return Err("Chat ID mismatch".into());
            }
            let desired_options = merge_claude_session_options(&session.options.borrow(), options);
            resolve_claude_model(&desired_options.model)?;
            session.options.replace(desired_options.clone());
            session.last_activity_at.set(Instant::now());

            let permission_mode = desired_options.permission_mode;
            let previous_mode = if session.process.borrow().is_some() {
                provider_startup_permission_mode(Some(session.current_permission_mode.get()))
            } else {
                PermissionMode::Default
            };
            let desired_mode = provider_startup_permission_mode(Some(permission_mode));
            let permission_startup_changed = previous_mode != desired_mode
                && [previous_mode, desired_mode].contains(&PermissionMode::BypassPermissions);
            let thinking_mode =
                normalize_claude_thinking_mode_for_state(desired_options.claude_thinking_mode);
            let env_changed = env_overrides_changed(
                session.current_env_overrides.borrow().as_ref(),
                desired_options.env_overrides.as_ref(),
            );
            let needs_retirement = session.process.borrow().is_some()
                && (desired_options.thinking_mode != session.current_thinking_mode.get()
                    || thinking_mode != session.current_claude_thinking_mode.get()
                    || permission_startup_changed
                    || env_changed);
            if needs_retirement {
                self.wait_for_session_retirement(&session).await?;
            }

            let retire = || self.wait_for_session_retirement(&session).boxed_local();
            let spawn = || {
                self.spawn_registered_cli(&session, desired_options.clone(), true, version)
                    .boxed_local()
            };
            configure_claude_session_model(
                &session,
                &desired_options.model,
                ClaudeSessionModelOptions {
                    execution_admission: admission,
                    control_broker: &self.control,
                    logger: self.logger.as_ref(),
                    is_current_session: &|| {
                        !self.shutting_down.get()
                            && self.is_current_session(&session)
                            && is_resume_owner()
                    },
                    retire_process: &retire,
                    resume_process: &spawn,
                },
            )
            .await?;

            if permission_mode != session.current_permission_mode.get() {
                self.set_internal_permission_mode(&agent_session_id, permission_mode);
            }
            session.current_permission_mode.set(permission_mode);

            assert_claude_execution_open(admission)?;
            let turn = owned_turn.insert(self.begin_turn(&session, execution.operation)?);
            let attachments = prepared.insert(
                materialize_claude_disk_attachments(&execution.command, &execution.images).await?,
            );
            if let Some(admission) = admission {
                admission.mark_started().await?;
            }
            self.send_user_message(&session, turn, attachments).await?;
            turn.completion().await;
            Ok(())
        }
        .await;
        if result.is_err()
            && owned_turn
                .as_ref()
                .is_some_and(|turn| session.is_current_turn(turn))
            && let Err(retirement) = self.retire_session(&session).await
        {
            result = Err(retirement);
        }
        if is_resume_owner() {
            session.resume_owner.take();
        }
        if let Some(prepared) = prepared {
            prepared.cleanup().await;
        }
        result
    }

    async fn send_user_message(
        &self,
        session: &ClaudeRunningSession,
        turn: &ClaudeActiveTurn,
        prepared: &MaterializedClaudeDiskAttachments<'_>,
    ) -> ExecutorResult<()> {
        let input_uuid = turn.protocol.borrow().input_uuid.clone();
        let content =
            build_claude_initial_user_content(&prepared.command, &prepared.inline_attachments)?;
        let frame = build_claude_user_input_frame(ClaudeUserInputFrameOptions {
            content: &content,
            session_id: &session.id,
            uuid: &input_uuid,
            priority: None,
        })?;
        let process = self
            .session(&session.id)
            .and_then(|session| session.process.borrow().clone())
            .ok_or_else(|| format!("Claude session {} has no writable process", session.id))?;
        process
            .transport
            .write_line(frame, Default::default())
            .await
    }

    fn is_current_session(&self, session: &Rc<ClaudeRunningSession>) -> bool {
        self.session(&session.id)
            .is_some_and(|current| Rc::ptr_eq(&current, session))
    }

    pub async fn prepare_claude_project_path_update(
        &self,
        request: ClaudeProjectPathUpdate,
    ) -> ExecutorResult<()> {
        let Some(id) = request
            .agent_session_id
            .as_deref()
            .filter(|id| !id.is_empty())
        else {
            return Ok(());
        };
        let busy = |message| {
            AgentIntegrationError::new(
                AgentIntegrationErrorCode::SESSION_BUSY,
                message,
                false,
                None,
            )
        };
        let session = self.session(id);
        if session
            .as_ref()
            .is_some_and(|session| session.chat_id != request.chat_id)
        {
            return Err(busy("Chat ID mismatch").into());
        }
        if session
            .as_ref()
            .is_some_and(|session| session.active_turn.borrow().is_some())
        {
            return Err(busy("Cannot update project path while Claude is running").into());
        }
        if self
            .pending_permissions
            .borrow()
            .iter()
            .any(|pending| pending.agent_session_id == id)
        {
            return Err(
                busy("Cannot update project path while Claude is waiting for permission").into(),
            );
        }
        if let Some(session) = session {
            self.wait_for_session_retirement(&session).await?;
        }
        self.retirements.wait(id, &request.chat_id).await
    }

    pub fn set_internal_permission_mode(&self, id: &str, mode: PermissionMode) {
        let Some(session) = self.session(id) else {
            return;
        };
        session.current_permission_mode.set(mode);
        session.options.borrow_mut().permission_mode = mode;
        if session.process.borrow().is_some() {
            let provider_mode = provider_startup_permission_mode(Some(mode));
            let update = self.control.request(
                id,
                json!({"subtype":"set_permission_mode", "mode":provider_mode}).into(),
                Default::default(),
            );
            let logger = self.logger.clone();
            let session_id = session_log_id(id);
            tokio::task::spawn_local(async move {
                if let Err(error) = update.await {
                    let fields = cli_log_fields([
                        ("sessionId", json!(session_id)),
                        ("error", json!(error.to_string())),
                    ]);
                    logger.warn("Claude CLI permission-mode update failed", Some(&fields));
                }
            });
        }
    }

    pub fn set_internal_thinking_mode(self: &Rc<Self>, id: &str, mode: ThinkingMode) {
        let Some(session) = self.session(id) else {
            return;
        };
        session.options.borrow_mut().thinking_mode = mode;
        if session.process.borrow().is_some()
            && session.active_turn.borrow().is_none()
            && mode != session.current_thinking_mode.get()
        {
            self.retire_process_in_background(&session);
        }
    }

    pub fn set_internal_claude_thinking_mode(self: &Rc<Self>, id: &str, mode: ClaudeThinkingMode) {
        let Some(session) = self.session(id) else {
            return;
        };
        session.options.borrow_mut().claude_thinking_mode = Some(mode);
        if session.process.borrow().is_some()
            && session.active_turn.borrow().is_none()
            && mode != session.current_claude_thinking_mode.get()
        {
            self.retire_process_in_background(&session);
        }
    }

    pub fn fail_claude_internal_session(
        self: &Rc<Self>,
        agent_session_id: &str,
        message: String,
        operation: AgentRuntimeOperation,
    ) {
        if let Some(session) = self.session(agent_session_id) {
            self.fail_session(&session, message);
            self.retire_process_in_background(&session);
        } else {
            (operation.publish)(AgentRuntimeEvent::RunEnded {
                run_id: operation.run_id,
                outcome: ProviderRunOutcome::Failed {
                    error: Some(AgentRunFailureDetail {
                        code: "PROVIDER_FAILURE".into(),
                        message: Some(message),
                    }),
                },
                working_directory: None,
            });
        }
    }

    pub fn running_sessions(&self) -> Vec<AgentRunningSession> {
        self.sessions
            .borrow()
            .values()
            .filter_map(|session| {
                let active = session.active_turn.borrow();
                let turn = active.as_ref()?;
                Some(AgentRunningSession {
                    agent_session_id: session.id.clone(),
                    status: Some("running".into()),
                    started_at: turn.started_at_iso.clone(),
                })
            })
            .collect()
    }

    pub async fn release_session(
        &self,
        chat_id: &str,
        agent_session_id: Option<&str>,
    ) -> ExecutorResult<()> {
        let Some(id) = agent_session_id.filter(|id| !id.is_empty()) else {
            return Ok(());
        };
        let Some(session) = self.session(id) else {
            return self.retirements.wait(id, chat_id).await;
        };
        if session.chat_id != chat_id {
            return Ok(());
        }
        self.sessions.borrow_mut().shift_remove(id);
        session.resume_owner.take();
        self.retire_session(&session).await
    }

    pub fn start_purge_timer(self: &Rc<Self>) {
        let runtime = Rc::downgrade(self);
        self.idle_purger
            .start(DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS, move || {
                let Some(runtime) = runtime.upgrade() else {
                    return;
                };
                let now = Instant::now();
                let max_age = Duration::from_millis(DEFAULT_IDLE_SESSION_MAX_AGE_MS as u64);
                let mut evicted = Vec::new();
                runtime.sessions.borrow_mut().retain(|_, session| {
                    if session.active_turn.borrow().is_none()
                        && now.duration_since(session.last_activity_at.get()) >= max_age
                    {
                        evicted.push(session.clone());
                        false
                    } else {
                        true
                    }
                });
                for session in evicted {
                    let runtime = runtime.clone();
                    let retirement = runtime.begin_session_retirement(&session);
                    tokio::task::spawn_local(async move {
                        if let Err(error) = await_retirement(retirement).await {
                            let fields = cli_log_fields([
                                ("sessionId", json!(session_log_id(&session.id))),
                                ("error", json!(error.to_string())),
                            ]);
                            runtime
                                .logger
                                .error("Claude idle process retirement failed", Some(&fields));
                        }
                    });
                }
            });
    }

    pub async fn shutdown(&self) {
        self.shutting_down.set(true);
        self.idle_purger.stop();
        self.control.shutdown("Claude runtime shut down");
        let sessions: Vec<_> = self.sessions.borrow().values().cloned().collect();
        let retirements =
            futures::future::join_all(sessions.iter().map(|session| self.retire_session(session)))
                .await;
        for (session, result) in sessions.iter().zip(retirements) {
            if let Err(error) = result {
                let fields = cli_log_fields([
                    ("sessionId", json!(session_log_id(&session.id))),
                    ("error", json!(error.to_string())),
                ]);
                self.logger
                    .error("Claude process shutdown failed", Some(&fields));
            }
        }
        self.sessions.borrow_mut().clear();
        self.pending_permissions.borrow_mut().clear();
    }

    async fn retire_session(&self, session: &Rc<ClaudeRunningSession>) -> ExecutorResult<()> {
        await_retirement(self.begin_session_retirement(session)).await
    }

    fn begin_session_retirement(
        &self,
        session: &Rc<ClaudeRunningSession>,
    ) -> ExecutorResult<Option<Rc<Retirement>>> {
        if let Some(turn) = session.active_turn.take() {
            turn.clear_abort_timer();
            turn.finish();
        }
        complete_session_initialization(session);
        self.cancel_pending_permissions(session);
        self.retire_session_process(session)
    }

    async fn wait_for_session_retirement(
        &self,
        session: &Rc<ClaudeRunningSession>,
    ) -> ExecutorResult<()> {
        await_retirement(self.retire_session_process(session)).await
    }

    pub fn finish_turn(&self, session: &ClaudeRunningSession) {
        self.settle_turn(session, None);
    }

    fn on_control_or_lifecycle(
        self: &Rc<Self>,
        session: &Rc<ClaudeRunningSession>,
        message: &Value,
    ) -> bool {
        let turn = session.active_turn.borrow().clone();
        if let Some(turn) = turn {
            let input = turn.protocol.borrow_mut().observe_input(message);
            match input {
                Some(ClaudeTurnInputEvent::Started { source }) => {
                    (turn.operation.publish)(AgentRuntimeEvent::Steerable);
                    let details = cli_log_fields([
                        ("chatId", json!(session.chat_id)),
                        ("runId", json!(turn.operation.run_id)),
                        ("sessionId", json!(session_log_id(&session.id))),
                        ("processId", json!(session.process_id())),
                        (
                            "inputId",
                            json!(session_log_id(&turn.protocol.borrow().input_uuid)),
                        ),
                        ("source", json!(source)),
                        (
                            "submitToStartMs",
                            json!(turn.started_at.elapsed().as_millis()),
                        ),
                    ]);
                    self.logger
                        .debug("Claude CLI user input started", Some(&details));
                }
                Some(ClaudeTurnInputEvent::TerminalBeforeStart { state }) => {
                    self.handle_input_terminal_before_start(session, &turn, state);
                    return true;
                }
                None => {}
            }
            if let Some(observation) = turn.steering.observe(message) {
                self.steering
                    .handle_observation(session, &turn, observation);
            }
        }
        match message["type"].as_str() {
            Some("control_response") => {
                self.control.handle_response(&session.id, message);
            }
            Some("control_request") => self.handle_permission_control_request(session, message),
            Some("control_cancel_request") => {
                self.handle_permission_control_cancel(session, message)
            }
            Some("system") => return self.handle_system_message(session, message),
            Some("assistant" | "user") => self.handle_content_message(session, message),
            Some("result") => self.handle_result_message(session, message),
            Some("conversation_reset") => self.handle_conversation_reset(session, message),
            Some(
                "command_lifecycle" | "stream_event" | "tool_progress" | "tool_use_summary"
                | "auth_status" | "keep_alive",
            ) => {}
            _ => return false,
        }
        true
    }

    fn handle_system_message(
        self: &Rc<Self>,
        session: &Rc<ClaudeRunningSession>,
        message: &Value,
    ) -> bool {
        if handle_claude_provider_lifecycle_message(
            message,
            session,
            &self.provider_state_handlers(),
        ) {
            return true;
        }
        let turn = session.active_turn.borrow().clone();
        let common = || {
            [
                ("chatId", json!(session.chat_id)),
                (
                    "runId",
                    json!(turn.as_ref().map(|turn| turn.operation.run_id.as_str())),
                ),
                ("sessionId", json!(session_log_id(&session.id))),
                ("processId", json!(session.process_id())),
            ]
        };
        match message["subtype"].as_str() {
            Some("init") => {
                let provider_id = message["session_id"].as_str().unwrap_or_default();
                let mut details = cli_log_fields(common());
                details.insert("providerSessionId".into(), json!(provider_id).into());
                details.insert(
                    "model".into(),
                    json!(message["model"].as_str().unwrap_or_default()).into(),
                );
                self.logger
                    .info("Claude CLI session initialized", Some(&details));
                if provider_id != session.id {
                    let id = if provider_id.is_empty() {
                        "missing"
                    } else {
                        provider_id
                    };
                    self.fail_session(session, format!("Unexpected Claude session ID: {id}"));
                    self.retire_process_in_background(session);
                }
            }
            Some("api_retry") => {
                if let Some(turn) = &turn {
                    let (retry, started) = {
                        let mut protocol = turn.protocol.borrow_mut();
                        (protocol.record_api_retry(message), protocol.input_started())
                    };
                    let mut details = cli_log_fields(common());
                    details.insert("matchedUserInput".into(), json!(started).into());
                    let number = |value: Option<Number>| {
                        Opaque::from_value(value.map_or(Value::Null, |value| Value::from(value.0)))
                    };
                    details.extend(
                        [
                            ("attempt", number(retry.attempt)),
                            ("maxRetries", number(retry.max_retries)),
                            ("delayMs", number(retry.delay_ms)),
                            ("errorStatus", retry.error_status.unwrap_or_default()),
                            (
                                "error",
                                retry.error.map_or(Value::Null, Value::String).into(),
                            ),
                        ]
                        .map(|(key, value)| (key.to_owned(), value)),
                    );
                    self.logger
                        .warn("Claude API request is retrying", Some(&details));
                }
            }
            Some("status") if message["compact_result"] == "failed" => {
                if let Some(turn) = turn.filter(|turn| turn.protocol.borrow().input_started()) {
                    let timestamp = match session.now_iso() {
                        Ok(timestamp) => timestamp,
                        Err(error) => {
                            self.fail_session(session, error.to_string());
                            return true;
                        }
                    };
                    turn.pending_compaction.take();
                    let reason = message["compact_error"]
                        .as_str()
                        .filter(|text| !text.is_empty())
                        .unwrap_or("Compaction failed");
                    turn.protocol.borrow_mut().add_output_messages(1, false);
                    self.publisher.messages(
                        &session.id,
                        &turn,
                        vec![NativeSourced::new(ChatMessage::Error(ErrorMessage {
                            timestamp,
                            content: reason.to_owned(),
                        }))],
                    );
                }
            }
            Some("compact_boundary") => {
                if let Some(turn) = turn.filter(|turn| turn.protocol.borrow().input_started()) {
                    turn.pending_compaction
                        .set(Some(parse_compact_metadata(&message["compact_metadata"])));
                }
            }
            _ => return false,
        }
        true
    }

    fn handle_content_message(&self, session: &ClaudeRunningSession, message: &Value) {
        let Some(turn) = session.active_turn.borrow().clone() else {
            return;
        };
        let assistant = message["type"] == "assistant";
        if !turn.protocol.borrow().input_started() {
            if assistant {
                self.logger.info(
                    "Claude CLI emitted assistant output for an internal turn",
                    Some(&cli_log_fields([
                        ("chatId", json!(session.chat_id)),
                        ("runId", json!(turn.operation.run_id)),
                        ("sessionId", json!(session_log_id(&session.id))),
                        ("processId", json!(session.process_id())),
                    ])),
                );
            }
            return;
        }
        let timestamp = match session.now_iso() {
            Ok(timestamp) => timestamp,
            Err(error) => {
                self.fail_session(session, error.to_string());
                return;
            }
        };
        let rows = convert_cli_message_to_chat_messages(message, &timestamp);
        if !rows.is_empty() {
            turn.protocol.borrow_mut().add_output_messages(
                rows.len(),
                assistant
                    && rows
                        .iter()
                        .any(|row| matches!(row.value, ChatMessage::Assistant(_))),
            );
            self.publisher.messages(&session.id, &turn, rows);
        }
        if assistant {
            return;
        }
        let Some(content) = message["message"]["content"]
            .as_str()
            .filter(|text| is_compaction_summary_text(text))
        else {
            return;
        };
        let Some(compaction) = turn.pending_compaction.take() else {
            return;
        };
        let timestamp = match session.now_iso() {
            Ok(timestamp) => timestamp,
            Err(error) => {
                self.fail_session(session, error.to_string());
                return;
            }
        };
        turn.protocol.borrow_mut().add_output_messages(1, false);
        let mut row = NativeSourced::new(ChatMessage::Compaction(CompactionMessage {
            timestamp,
            trigger: compaction.trigger,
            summary: extract_compaction_summary(content).to_owned(),
            pre_tokens: compaction.pre_tokens,
            post_tokens: compaction.post_tokens,
        }));
        if let Some(entry_id) = message["uuid"].as_str().filter(|id| !id.is_empty()) {
            // The summary UUID and ordinal also identify the imported native row.
            attach_native_message_source(
                &mut row,
                Some(NativeMessageSourceInput {
                    entry_id: Some(entry_id),
                    within_source_ordinal: Some(0.0),
                    ..Default::default()
                }),
            );
        }
        self.publisher.messages(&session.id, &turn, vec![row]);
    }

    // A conversation reset does not change Garcon's native binding.
    // https://github.com/anthropics/claude-agent-sdk-python/blob/a8b1e285/src/claude_agent_sdk/types.py#L1417-L1440
    fn handle_conversation_reset(
        self: &Rc<Self>,
        session: &Rc<ClaudeRunningSession>,
        message: &Value,
    ) {
        let turn = session.active_turn.borrow().clone();
        let details = cli_log_fields([
            ("chatId", json!(session.chat_id)),
            (
                "runId",
                json!(turn.as_ref().map(|turn| turn.operation.run_id.as_str())),
            ),
            ("sessionId", json!(session_log_id(&session.id))),
            ("processId", json!(session.process_id())),
            ("newConversationId", message["new_conversation_id"].clone()),
        ]);
        self.logger
            .warn("Claude CLI discarded the conversation", Some(&details));
        if let Some(turn) = turn {
            turn.protocol.borrow_mut().clear_recorded_result_failure();
            self.fail_session(session, CONVERSATION_RESET_FAILURE.into());
        }
        self.retire_process_in_background(session);
    }

    fn handle_result_message(&self, session: &ClaudeRunningSession, message: &Value) {
        let Some(turn) = session.active_turn.borrow().clone() else {
            return;
        };
        let mut protocol = turn.protocol.borrow_mut();
        let error = truthy(&message["is_error"]);
        let text = message["result"].as_str().map(trim).unwrap_or_default();
        let details = cli_log_fields([
            ("chatId", json!(session.chat_id)),
            ("runId", json!(turn.operation.run_id)),
            ("sessionId", json!(session_log_id(&session.id))),
            ("processId", json!(session.process_id())),
            ("inputId", json!(session_log_id(&protocol.input_uuid))),
            (
                "resultInputId",
                json!(message["user_message_uuid"].as_str().map(session_log_id)),
            ),
            (
                "outcome",
                json!(message["subtype"].as_str().unwrap_or(if error {
                    "error"
                } else {
                    "unknown"
                })),
            ),
            ("isError", json!(error)),
            ("apiErrorStatus", message["api_error_status"].clone()),
            ("terminalReason", message["terminal_reason"].clone()),
            ("stopReason", message["stop_reason"].clone()),
            ("durationMs", message["duration_ms"].clone()),
            ("numTurns", message["num_turns"].clone()),
            ("outputMessages", json!(protocol.output_message_count())),
            ("hasResult", json!(!text.is_empty())),
            (
                "permissionDenials",
                json!(message["permission_denials"].as_array().map_or(0, Vec::len)),
            ),
        ]);
        let correlation = protocol.correlate_result(message);
        if correlation == ClaudeResultCorrelation::BeforeStart {
            protocol.record_result_before_start(message.clone().into());
            drop(protocol);
            let log = "Claude CLI emitted an uncorrelated result while user input was pending";
            if error {
                self.logger.warn(log, Some(&details));
            } else {
                self.logger.info(log, Some(&details));
            }
            return;
        }
        if correlation == ClaudeResultCorrelation::Mismatched {
            drop(protocol);
            self.logger.warn(
                "Claude CLI emitted a result for another user input",
                Some(&details),
            );
            return;
        }
        let fallback =
            !error && !protocol.assistant_content_since_last_result() && !text.is_empty();
        if fallback {
            protocol.add_output_messages(1, true);
        }
        drop(protocol);
        if fallback {
            let timestamp = match session.now_iso() {
                Ok(timestamp) => timestamp,
                Err(error) => {
                    self.fail_session(session, error.to_string());
                    return;
                }
            };
            self.publisher.messages(
                &session.id,
                &turn,
                vec![NativeSourced::new(ChatMessage::Assistant(
                    AssistantMessage {
                        timestamp,
                        content: text.to_owned(),
                        questions: None,
                    },
                ))],
            );
        }
        let clean_abort = {
            let mut protocol = turn.protocol.borrow_mut();
            protocol.record_accepted_result(message);
            protocol.clean_abort_result_seen()
        };
        let log = if correlation == ClaudeResultCorrelation::Input {
            "Claude CLI input result received; awaiting provider idle"
        } else {
            "Claude CLI continuation result received; awaiting provider idle"
        };
        if error && !clean_abort {
            self.logger.warn(log, Some(&details));
        } else {
            self.logger.info(log, Some(&details));
        }
    }

    fn handle_input_terminal_before_start(
        &self,
        session: &ClaudeRunningSession,
        turn: &ClaudeActiveTurn,
        state: ClaudeTurnTerminalState,
    ) {
        let mut protocol = turn.protocol.borrow_mut();
        let prior = protocol.take_result_before_start();
        let aborted = protocol.abort_requested();
        let state_name = match state {
            ClaudeTurnTerminalState::Completed => "completed",
            ClaudeTurnTerminalState::Cancelled => "cancelled",
            ClaudeTurnTerminalState::Discarded => "discarded",
        };
        let details = cli_log_fields([
            ("chatId", json!(session.chat_id)),
            ("runId", json!(turn.operation.run_id)),
            ("sessionId", json!(session_log_id(&session.id))),
            ("processId", json!(session.process_id())),
            ("inputId", json!(session_log_id(&protocol.input_uuid))),
            ("state", json!(state_name)),
            ("abortRequested", json!(aborted)),
            (
                "precedingResultOutcome",
                prior
                    .as_ref()
                    .map_or(serde_json::Value::Null, |msg| msg["subtype"].clone()),
            ),
            (
                "precedingResultWasError",
                json!(prior.as_ref().is_some_and(|msg| truthy(&msg["is_error"]))),
            ),
        ]);
        drop(protocol);
        if state == ClaudeTurnTerminalState::Cancelled && aborted {
            self.logger.info(
                "Claude CLI cancelled queued user input after an interrupt",
                Some(&details),
            );
            turn.confirm_pre_start_abort();
            self.finish_turn(session);
            return;
        }
        self.logger.warn(
            "Claude CLI submitted input ended before starting",
            Some(&details),
        );
        let failure = if let Some(prior) = prior.filter(|prior| truthy(&prior["is_error"])) {
            claude_result_failure_message(prior.as_value())
        } else if state == ClaudeTurnTerminalState::Completed {
            "Claude CLI marked the submitted message complete without starting it or producing a response.".to_owned()
        } else {
            format!("Claude CLI {state_name} the submitted message before it started.")
        };
        self.fail_session(session, failure);
    }

    fn provider_state_handlers(self: &Rc<Self>) -> ClaudeProviderStateHandlers {
        let weak = Rc::downgrade(self);
        ClaudeProviderStateHandlers {
            logger: self.logger.clone(),
            finish: Rc::new({
                let weak = weak.clone();
                move |session| {
                    if let Some(runtime) = weak.upgrade() {
                        runtime.finish_turn(session);
                    }
                }
            }),
            fail: Rc::new({
                let weak = weak.clone();
                move |session, message| {
                    if let Some(runtime) = weak.upgrade() {
                        runtime.fail_session(session, message);
                    }
                }
            }),
            retire: Rc::new(move |session| {
                if let Some(runtime) = weak.upgrade() {
                    runtime.retire_process_in_background(session);
                }
            }),
            steering_idle_fence_timeout: CLAUDE_STEER_IDLE_FENCE_TIMEOUT,
        }
    }

    fn flush_provider_idle(
        self: &Rc<Self>,
        session: &Rc<ClaudeRunningSession>,
        turn: &ClaudeActiveTurn,
    ) {
        if session.is_current_turn(turn) {
            flush_deferred_claude_provider_idle(session, &self.provider_state_handlers());
        }
    }

    pub fn fail_session(&self, session: &ClaudeRunningSession, message: String) {
        self.settle_turn(session, Some(message));
    }

    fn settle_turn(&self, session: &ClaudeRunningSession, failure: Option<String>) {
        let Some(turn) = session.active_turn.take() else {
            return;
        };
        turn.clear_abort_timer();
        if failure.is_some() || !turn.protocol.borrow().abort_requested() {
            self.control
                .reject_session(&session.id, "Claude turn settled", Some("interrupt"));
        }
        self.cancel_pending_permissions(session);
        session.last_activity_at.set(Instant::now());
        if let Some(failure) = failure {
            let failure = turn
                .protocol
                .borrow()
                .recorded_result_failure_message()
                .map(str::to_owned)
                .unwrap_or(failure);
            self.publisher.failed(&session.id, &turn, failure);
        } else {
            self.publisher.finished(&session.id, &turn);
        }
        turn.finish();
    }

    fn cancel_pending_permissions(&self, session: &ClaudeRunningSession) {
        let cancelled: Vec<_> = self
            .pending_permissions
            .borrow_mut()
            .extract_if(.., |pending| pending.agent_session_id == session.id)
            .collect();
        for pending in cancelled {
            self.publisher.event(
                &session.id,
                &pending.turn,
                AgentRuntimeEvent::Permission {
                    run_id: pending.turn.operation.run_id.clone(),
                    lifecycle: AgentProviderPermissionLifecycle::Terminal(
                        AgentTerminalPermission::Cancelled {
                            permission_occurrence_id: pending.permission_occurrence_id,
                            reason: Some("cancelled".into()),
                        },
                    ),
                    decision: None,
                },
            );
        }
    }

    fn handle_transport_failure(
        self: &Rc<Self>,
        session: &Rc<ClaudeRunningSession>,
        failure: ClaudeTransportFailure,
    ) {
        let kind = match failure.kind {
            ClaudeTransportFailureKind::Stdout => "stdout",
            ClaudeTransportFailureKind::Stderr => "stderr",
            ClaudeTransportFailureKind::Write => "write",
        };
        let turn = session.active_turn.borrow().clone();
        if let Some(turn) = turn {
            turn.mark_interrupt_request_failed();
            self.control.reject_session(
                &session.id,
                &format!("Claude CLI {kind} transport failed: {}", failure.message),
                Some("interrupt"),
            );
            self.fail_session(
                session,
                format!("Claude CLI {kind} failed: {}", failure.message),
            );
        }
        self.retire_process_in_background(session);
    }

    fn handle_stdout_eof(self: &Rc<Self>, session: &Rc<ClaudeRunningSession>) {
        let Some(turn) = session.active_turn.borrow().clone() else {
            return;
        };
        turn.mark_interrupt_request_failed();
        self.control.reject_session(
            &session.id,
            "Claude CLI stdout ended during an active turn",
            Some("interrupt"),
        );
        self.fail_session(
            session,
            "Claude CLI stdout ended before the submitted message produced a terminal result."
                .into(),
        );
        self.retire_process_in_background(session);
    }

    fn handle_process_exit(&self, session: &ClaudeRunningSession, code: i32) {
        session.process.take();
        session.last_activity_at.set(Instant::now());
        let turn = session.active_turn.borrow().clone();
        if let Some(turn) = &turn {
            turn.clear_abort_timer();
        }
        let message = format!("Claude CLI process exited with code {code}");
        self.control.reject_session(&session.id, &message, None);
        self.cancel_pending_permissions(session);
        if let Some(turn) = turn {
            turn.mark_interrupt_request_failed();
            self.fail_session(session, message);
        }
    }

    fn log_process_exit(
        &self,
        session: &ClaudeRunningSession,
        pid: Option<u32>,
        exit: &ClaudeProcessExit,
        current: bool,
    ) {
        let turn = session.active_turn.borrow().clone();
        let during_turn = current && turn.is_some();
        let fields = cli_log_fields([
            ("chatId", json!(session.chat_id)),
            (
                "runId",
                json!(turn.as_ref().map(|turn| turn.operation.run_id.as_str())),
            ),
            ("sessionId", json!(session_log_id(&session.id))),
            ("processId", json!(pid)),
            ("exitCode", json!(exit.exit_code)),
            ("stderrBytes", json!(exit.stderr_bytes)),
            ("stderrLines", json!(exit.stderr_lines)),
            ("stderrRetainedBytes", json!(exit.stderr_retained_bytes)),
            ("stderrTailDigest", json!(exit.stderr_tail_digest)),
            ("stderrTruncated", json!(exit.stderr_truncated)),
            ("duringTurn", json!(during_turn)),
        ]);
        if during_turn {
            self.logger.error(
                "Claude CLI process exited during an active turn",
                Some(&fields),
            );
        } else {
            self.logger.info("Claude CLI process exited", Some(&fields));
        }
    }

    pub fn retire_process_in_background(self: &Rc<Self>, session: &Rc<ClaudeRunningSession>) {
        match self.retire_session_process(session) {
            Ok(Some(retirement)) => {
                let logger = self.logger.clone();
                let id = session.id.clone();
                let chat_id = session.chat_id.clone();
                tokio::task::spawn_local(async move {
                    if let Err(error) = retirement.as_ref().clone().await {
                        let fields = IndexMap::from_iter([
                            ("chatId".into(), Opaque::from_value(json!(chat_id))),
                            (
                                "sessionId".into(),
                                Opaque::from_value(json!(session_log_id(&id))),
                            ),
                            ("error".into(), Opaque::from_value(json!(error))),
                        ]);
                        logger.error("Claude CLI process retirement failed", Some(&fields));
                    }
                });
            }
            Ok(None) => {}
            Err(error) => self.logger.error(&error.to_string(), None),
        }
    }

    pub fn retire_session_process(
        &self,
        session: &Rc<ClaudeRunningSession>,
    ) -> ExecutorResult<Option<Rc<crate::cli_process_transport::Retirement>>> {
        if let Some(turn) = session.active_turn.borrow().as_ref() {
            turn.clear_abort_timer();
        }
        self.control
            .reject_session(&session.id, "Claude CLI process was retired", None);
        let Some(process) = session.process.take() else {
            return Ok(session.retirement.borrow().clone());
        };
        let exited = Rc::new(process.transport.exited());
        let prior = session.retirement.borrow().clone();
        let retirement = Rc::new(if let Some(prior) = prior {
            let retirement = async move {
                prior.as_ref().clone().await?;
                process.transport.retire().await
            }
            .boxed_local()
            .shared();
            tokio::task::spawn_local(retirement.clone());
            retirement
        } else {
            process.transport.retire()
        });
        session.retirement.replace(Some(retirement.clone()));
        self.retirements
            .track(&session.id, &session.chat_id, exited.clone())?;
        let weak_session = Rc::downgrade(session);
        let guard = retirement.clone();
        tokio::task::spawn_local(async move {
            if exited.as_ref().clone().await.is_ok()
                && let Some(session) = weak_session.upgrade()
                && session
                    .retirement
                    .borrow()
                    .as_ref()
                    .is_some_and(|current| Rc::ptr_eq(current, &guard))
            {
                session.retirement.take();
            }
        });
        Ok(Some(retirement))
    }

    pub async fn abort_session(self: &Rc<Self>, id: &str) -> ExecutorResult<bool> {
        let Some(session) = self.session(id) else {
            return Ok(false);
        };
        let Some(turn) = session.active_turn.borrow().clone() else {
            return Ok(false);
        };
        if session.process.borrow().is_none() {
            return Ok(false);
        }

        turn.protocol.borrow_mut().mark_abort_requested();
        self.arm_abort_fallback(&session, &turn, InterruptFallbackStage::Receipt);
        let cancellation = tokio_util::sync::CancellationToken::new();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        let response = self.control.request(
            id,
            json!({"subtype":"interrupt", "cancel_queued":true}).into(),
            ClaudeControlRequestOptions {
                signal: Some(cancellation),
                ..Default::default()
            },
        );
        let receipt = tokio::select! {
            biased;
            response = response => response,
            () = turn.pre_start_abort_confirmation() => return Ok(true),
            () = turn.completion() => return Ok(false),
        };
        match receipt {
            Ok(receipt) => Ok(handle_claude_interrupt_receipt(
                ClaudeInterruptSession {
                    id,
                    chat_id: &session.chat_id,
                    process_id: session.process_id(),
                    is_current: &|candidate| session.is_current_turn(candidate),
                },
                &turn,
                receipt.as_value(),
                ClaudeInterruptReceiptHandlers {
                    logger: self.logger.as_ref(),
                    finish: &|| self.finish_turn(&session),
                    clear_abort_timer: &|| turn.clear_abort_timer(),
                    arm_completion_fallback: &|| {
                        self.arm_abort_fallback(&session, &turn, InterruptFallbackStage::Completion)
                    },
                    flush_deferred_idle: &|| self.flush_provider_idle(&session, &turn),
                },
            )),
            Err(error) => {
                if !session.is_current_turn(&turn) {
                    return if turn.interrupt_request_failed() {
                        Err(error)
                    } else {
                        Ok(false)
                    };
                }
                self.logger
                    .warn("Claude CLI interrupt request failed", None);
                self.force_abort_process(&session, &turn, "Claude CLI interrupt request failed.");
                Err(error)
            }
        }
    }

    fn force_abort_process(
        self: &Rc<Self>,
        session: &Rc<ClaudeRunningSession>,
        turn: &ClaudeActiveTurn,
        reason: &str,
    ) {
        if !session.is_current_turn(turn) {
            return;
        }
        let process = session.process.borrow().clone();
        self.fail_session(session, reason.into());
        if let Some(process) = process {
            if !process.transport.killed() {
                let _ = process.transport.kill(ClaudeProcessSignal::Term);
            }
            self.retire_process_in_background(session);
        }
    }

    fn arm_abort_fallback(
        self: &Rc<Self>,
        session: &Rc<ClaudeRunningSession>,
        turn: &Rc<ClaudeActiveTurn>,
        stage: InterruptFallbackStage,
    ) {
        let Some(process) = session.process.borrow().clone() else {
            return;
        };
        let duration = match stage {
            InterruptFallbackStage::Receipt => INTERRUPT_RECEIPT_TIMEOUT,
            InterruptFallbackStage::Completion => INTERRUPT_COMPLETION_TIMEOUT,
        };
        let runtime = Rc::downgrade(self);
        let session = Rc::downgrade(session);
        turn.clear_abort_timer();
        let deadline = Instant::now() + duration;
        let active_turn = Rc::downgrade(turn);
        turn.abort_timer.set(Some(
            tokio::task::spawn_local(async move {
                tokio::time::sleep_until(deadline).await;
                let (Some(runtime), Some(session), Some(turn)) =
                    (runtime.upgrade(), session.upgrade(), active_turn.upgrade())
                else {
                    return;
                };
                turn.abort_timer.take();
                if !session.is_current_process(&process.identity) || process.transport.killed() {
                    return;
                }
                runtime
                    .logger
                    .warn("Claude CLI interrupt was not confirmed", None);
                if matches!(stage, InterruptFallbackStage::Receipt) {
                    turn.mark_interrupt_request_failed();
                    runtime.control.reject_session(
                        &session.id,
                        "Claude CLI interrupt control request timed out",
                        Some("interrupt"),
                    );
                }
                runtime.force_abort_process(
                    &session,
                    &turn,
                    "Claude CLI did not confirm the interrupt.",
                );
            })
            .abort_handle(),
        ));
    }
}

#[cfg(all(test, unix))]
mod tests;

fn session_log_id(id: &str) -> String {
    String::from_utf16_lossy(&id.encode_utf16().take(8).collect::<Vec<_>>())
}

fn complete_session_initialization(session: &ClaudeRunningSession) {
    if let Some(initialization) = session.initialization.take() {
        initialization.cancel();
    }
}

async fn await_retirement(
    retirement: ExecutorResult<Option<Rc<Retirement>>>,
) -> ExecutorResult<()> {
    if let Some(retirement) = retirement? {
        retirement.as_ref().clone().await?;
    }
    Ok(())
}

fn env_overrides_changed(
    previous: Option<&IndexMap<String, String>>,
    current: Option<&IndexMap<String, String>>,
) -> bool {
    previous.filter(|environment| !environment.is_empty())
        != current.filter(|environment| !environment.is_empty())
}

fn cli_log_fields<const N: usize>(
    fields: [(&str, serde_json::Value); N],
) -> IndexMap<String, Opaque> {
    IndexMap::from_iter(fields.map(|(key, value)| (key.to_owned(), value.into())))
}
