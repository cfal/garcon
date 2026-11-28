use std::{
    cell::{Cell, RefCell},
    ffi::OsString,
    rc::Rc,
};

use garcon_agents_common::execution::runtime_events::{AgentRuntimeEvent, AgentRuntimeOperation};
use garcon_interface::{
    host::AgentLogger,
    producer::{AgentProviderPermissionLifecycle, AgentTerminalPermission},
    resources::ExecutorResult,
};
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde_json::json;
use tokio::time::Instant;

use crate::{
    active_turn::ClaudeActiveTurn,
    cli_control::{ClaudeControlBroker, ClaudeControlRequestOptions},
    cli_environment::build_claude_cli_environment,
    cli_invocation::{ClaudeCliArgOptions, build_claude_cli_args},
    cli_process_transport::{
        ClaudeProcessOptions, ClaudeProcessSignal, ClaudeProcessTransport,
        ClaudeProcessTransportOptions, ClaudeTransportFailure, ClaudeTransportFailureKind,
        spawn_claude_subprocess,
    },
    cli_protocol::ClaudeProviderSessionState,
    cli_session_state::{
        ClaudeProviderStateHandlers, flush_deferred_claude_provider_idle,
        handle_claude_provider_lifecycle_message,
    },
    interrupt_receipt::{
        ClaudeInterruptReceiptHandlers, ClaudeInterruptSession, handle_claude_interrupt_receipt,
    },
    process_retirements::ClaudeProcessRetirementTracker,
    runtime_state::{
        ClaudeRunningSession, ClaudeSessionProcess, INTERRUPT_COMPLETION_TIMEOUT,
        INTERRUPT_RECEIPT_TIMEOUT, InterruptFallbackStage, PendingPermission,
    },
    session_options::{ClaudeSessionOptions, normalize_claude_thinking_mode_for_state},
    steering::{
        CLAUDE_STEER_IDLE_FENCE_TIMEOUT, CLAUDE_STEER_WRITE_TIMEOUT, ClaudeSteeringController,
        ClaudeSteeringControllerOptions,
    },
    turn_publisher::ClaudeTurnPublisher,
};

pub type ClaudeStreamHandler = dyn Fn(&Rc<ClaudeRunningSession>, Opaque);

pub struct ClaudeCli {
    pub logger: Rc<dyn AgentLogger>,
    pub control: ClaudeControlBroker,
    pub publisher: ClaudeTurnPublisher,
    pub steering: ClaudeSteeringController,
    pub shutting_down: Cell<bool>,
    sessions: RefCell<IndexMap<String, Rc<ClaudeRunningSession>>>,
    retirements: ClaudeProcessRetirementTracker,
    pub pending_permissions: RefCell<Vec<PendingPermission>>,
    executable: Rc<dyn Fn() -> OsString>,
}

impl ClaudeCli {
    pub fn new(executable: Rc<dyn Fn() -> OsString>, logger: Rc<dyn AgentLogger>) -> Rc<Self> {
        Rc::new_cyclic(|runtime: &std::rc::Weak<Self>| {
            let runtime = runtime.clone();
            Self {
                executable,
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
        let turn = Rc::new(ClaudeActiveTurn::new(
            session.background_task_count.get(),
            operation,
        ));
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
            executable: (self.executable)(),
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
            on_exit: Rc::new(move |exit| {
                if let Some((runtime, session)) = current() {
                    runtime.handle_process_exit(&session, exit.exit_code);
                }
            }),
            max_stdout_frame_bytes: None,
        });
        session.process.replace(Some(ClaudeSessionProcess {
            identity,
            transport,
        }));
        Ok(())
    }

    pub fn finish_turn(&self, session: &ClaudeRunningSession) {
        self.settle_turn(session, None);
    }

    fn on_control_or_lifecycle(
        self: &Rc<Self>,
        session: &Rc<ClaudeRunningSession>,
        message: &serde_json::Value,
    ) -> bool {
        let turn = session.active_turn.borrow().clone();
        if let Some(turn) = turn
            && let Some(observation) = turn.steering.observe(message)
        {
            self.steering
                .handle_observation(session, &turn, observation);
        }
        if message["type"] == "control_response" {
            self.control.handle_response(&session.id, message);
            return true;
        }
        if message["type"] == "control_request" {
            self.handle_permission_control_request(session, message);
            return true;
        }
        if message["type"] == "control_cancel_request" {
            self.handle_permission_control_cancel(session, message);
            return true;
        }
        message["type"] == "system"
            && handle_claude_provider_lifecycle_message(
                message,
                session,
                &self.provider_state_handlers(),
            )
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
                                Opaque::from_value(json!(id.chars().take(8).collect::<String>())),
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
        let retirement = Rc::new(process.transport.retire());
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
