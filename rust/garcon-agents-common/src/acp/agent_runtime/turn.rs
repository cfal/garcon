use std::mem;

use async_trait::async_trait;
use garcon_contract::chat_command_contracts::PermissionDecisionPayload;
use garcon_contract::chat_types::{ChatMessage, ErrorMessage};
use garcon_interface::native_message_source::NativeSourced;
use garcon_interface::producer::{
    AgentFinalResponse, AgentProviderPermissionLifecycle, AgentRequestedPermission,
    AgentRunFailureDetail, AgentTerminalPermission,
};
use garcon_js::clock::to_iso_string;

use crate::execution::runtime_events::{
    AgentRuntimeEvent, ProviderRunOutcome, RuntimePermissionResponse, runtime_rows,
};

use super::*;
use crate::acp::event_converter::{
    AcpBlockingRequestToolUse, AcpCustomRequest, AcpRuntimeBoundary, AcpSessionUpdateContext,
    as_object, as_string,
};
use crate::acp::policy::{AcpPrompt, configure_session_for};
use crate::acp::protocol::{AcpJsonRpcId, AcpJsonRpcMessage};
use crate::acp::runtime_helpers::{
    AcpPermissionChoice, automatic_permission_choice, fallback_permission_tool_use,
    permission_cancelled_outcome, permission_choice_outcome,
};
use crate::acp::runtime_session::AcpTurnContext;
use crate::acp::runtime_types::mark_acp_execution_started;
use crate::acp::transport::SentCallback;
use crate::acp::turn_prompts::{AcpTurnPromptEvents, AcpTurnPrompts};

impl AcpAgentRuntime {
    pub(super) fn run_prompt(
        &self,
        session: SessionRef,
        request: AcpExecutionRequest,
        prompt: AcpPrompt,
        on_execution_started: Option<SentCallback>,
    ) -> ExecutorResult<LocalBoxFuture<'static, ExecutorResult<()>>> {
        assert_acp_execution_open(&request)?;
        let turn = self.create_turn(&session, &request);
        {
            let mut session = session.borrow_mut();
            session.pending_turn = Some(Rc::clone(&turn));
            session.state = RuntimeSessionState::Running;
        }
        self.bind_turn_source(&session, &turn);
        let runtime = self.clone();
        Ok(Box::pin(async move {
            let execution_started = Rc::new(Cell::new(false));
            let dispatched = runtime
                .dispatch_prompt(
                    &session,
                    &turn,
                    &request,
                    &prompt,
                    on_execution_started,
                    Rc::clone(&execution_started),
                )
                .await;
            let aborted = turn.borrow().aborted;
            let admission_closed = request
                .execution_admission
                .as_ref()
                .is_some_and(|admission| admission.signal().is_cancelled());
            let failure_message = dispatched
                .as_ref()
                .err()
                .filter(|_| !aborted)
                .map(|error| humanize_error(error.as_ref()));
            let success = dispatched.is_ok() && !aborted;

            release_pending(&session, &turn);
            if execution_started.get() {
                if !success && can_route_source(&session, &turn) {
                    runtime.0.converter.take_turn_failure(&session.borrow().id);
                }
                runtime.emit_flushed_messages(&session, &turn);
            }
            {
                let mut session = session.borrow_mut();
                session.state = if aborted {
                    RuntimeSessionState::Aborted
                } else if !admission_closed
                    && failure_message
                        .as_ref()
                        .is_some_and(|message| !message.is_empty())
                {
                    RuntimeSessionState::Failed
                } else {
                    RuntimeSessionState::Idle
                };
                session.last_activity_at = runtime.0.clock.now_ms();
            }
            runtime.complete_turn(&session, &turn);
            let (run_id, retired, response, reported) = {
                let turn = turn.borrow();
                (
                    turn.operation.run_id.clone(),
                    turn.source_retired,
                    turn.final_response_text.clone(),
                    turn.reported_failure,
                )
            };
            if success && !retired {
                runtime.publish_turn_event(
                    &turn,
                    AgentRuntimeEvent::RunEnded {
                        run_id,
                        outcome: ProviderRunOutcome::Finished {
                            final_response: response.map(|text| AgentFinalResponse::Text { text }),
                        },
                        working_directory: None,
                    },
                );
            } else if !aborted
                && !admission_closed
                && !retired
                && let Some(message) = failure_message
                    .as_ref()
                    .filter(|message| !message.is_empty())
            {
                if !reported {
                    runtime.publish_error(&turn, message);
                }
                runtime.publish_turn_event(
                    &turn,
                    AgentRuntimeEvent::RunEnded {
                        run_id,
                        outcome: ProviderRunOutcome::Failed {
                            error: Some(AgentRunFailureDetail {
                                code: "PROVIDER_FAILURE".to_owned(),
                                message: Some(message.clone()),
                            }),
                        },
                        working_directory: None,
                    },
                );
            }
            runtime.cancel_permissions_for_turn(
                &session,
                &turn,
                if aborted {
                    AcpRetireReason::Aborted
                } else {
                    AcpRetireReason::SessionComplete
                },
            );
            if !execution_started.get() {
                runtime.retire_turn_source(&session, &turn, AcpRetireReason::Cancelled);
            }
            let connected = session.borrow().client.is_connected();
            if !connected {
                runtime.retire_session(&session, AcpRetireReason::Cancelled, true);
            }
            failure_message.map_or(Ok(()), |message| Err(plain_error(message)))
        }))
    }

    async fn dispatch_prompt(
        &self,
        session: &SessionRef,
        turn: &TurnRef,
        request: &AcpExecutionRequest,
        prompt: &[Value],
        on_execution_started: Option<SentCallback>,
        execution_started: Rc<Cell<bool>>,
    ) -> ExecutorResult<()> {
        let default_model = self
            .0
            .state
            .borrow()
            .agent_default_models
            .get(&session.borrow().project_path)
            .cloned();
        configure_session_for(&self.0.policy, session, request, default_model).await?;
        if turn.borrow().aborted {
            return Ok(());
        }
        if request.execution_admission.is_some() {
            mark_acp_execution_started(request).await?;
        }
        if turn.borrow().aborted {
            return Ok(());
        }
        assert_acp_execution_open(request)?;
        if session.borrow().retired {
            return Err(plain_error(format!(
                "{} ACP process exited before the prompt was sent",
                self.0.policy.agent_id
            )));
        }
        let on_sent: SentCallback = Rc::new({
            let session = Rc::clone(session);
            let turn = Rc::clone(turn);
            let runtime = self.clone();
            let project_path = request.project_path.clone();
            move || {
                release_pending(&session, &turn);
                if !runtime.activate_turn_source(&session, &turn, &project_path) {
                    return Ok(());
                }
                execution_started.set(true);
                if turn.borrow().aborted {
                    let id = session.borrow().id.clone();
                    runtime.abort(&id);
                }
                if let Some(started) = &on_execution_started {
                    started()?;
                }
                runtime.announce_steerable(&session, &turn);
                Ok(())
            }
        });
        let (id, client) = session_client(session);
        let prompts = turn.borrow().prompts.clone();
        prompts
            .run(|on_reply| {
                client.prompt_session(
                    AcpPromptSessionParams {
                        session_id: &id,
                        prompt,
                        config: None,
                    },
                    AcpRequestOptions {
                        on_sent: Some(on_sent),
                        on_reply: Some(on_reply),
                        ..Default::default()
                    },
                )
            })
            .await
    }

    fn create_turn(&self, session: &SessionRef, request: &AcpExecutionRequest) -> TurnRef {
        let admission = request
            .execution_admission
            .as_ref()
            .map(|admission| admission.signal().clone());
        let (settle, settled) = settlement();
        Rc::new_cyclic(|turn: &Weak<RefCell<AcpTurnContext>>| {
            let context = TurnContext {
                runtime: Rc::downgrade(&self.0),
                session: Rc::downgrade(session),
                turn: turn.clone(),
            };
            let prompts = AcpTurnPrompts::new(AcpTurnPromptEvents {
                steering: self.0.policy.steering.clone(),
                take_failure: Rc::new({
                    let context = context.clone();
                    move || {
                        Ok(context.resolve().and_then(|(runtime, session, turn)| {
                            can_route_source(&session, &turn)
                                .then(|| {
                                    runtime.0.converter.take_turn_failure(&session.borrow().id)
                                })
                                .flatten()
                        }))
                    }
                }),
                on_boundary: Rc::new({
                    let context = context.clone();
                    move |failure| {
                        if let Some((runtime, session, turn)) = context.resolve() {
                            runtime.record_prompt_boundary(
                                &session,
                                &turn,
                                failure,
                                admission.as_ref(),
                            );
                        }
                        Ok(())
                    }
                }),
                on_steerable: Rc::new(move || {
                    if let Some((runtime, session, turn)) = context.resolve() {
                        runtime.announce_steerable(&session, &turn);
                    }
                }),
            });
            RefCell::new(AcpTurnContext {
                session: Rc::downgrade(session),
                operation: request.operation.clone(),
                pending_permissions: Vec::new(),
                detach_source_listeners: Vec::new(),
                permission_mode: request.permission_mode,
                completed: false,
                aborted: false,
                source_retired: false,
                final_response_text: None,
                reported_failure: false,
                settle: Some(settle),
                settled,
                cancel_timer: None,
                prompts,
            })
        })
    }

    fn record_prompt_boundary(
        &self,
        session: &SessionRef,
        turn: &TurnRef,
        failure: Option<&str>,
        admission: Option<&CancellationToken>,
    ) {
        if !can_route_source(session, turn) {
            return;
        }
        let flushed = self.emit_flushed_messages(session, turn);
        let last_tool = flushed.iter().rposition(|message| {
            matches!(
                message,
                ChatMessage::ToolUse(_) | ChatMessage::ToolResult(_)
            )
        });
        let answers: Vec<_> = flushed
            .iter()
            .skip(last_tool.map_or(0, |index| index + 1))
            .filter_map(|message| match message {
                ChatMessage::Assistant(answer) => Some(answer.content.as_str()),
                _ => None,
            })
            .collect();
        let aborted = {
            let mut turn = turn.borrow_mut();
            turn.final_response_text = (!answers.is_empty()).then(|| answers.join("\n\n"));
            turn.aborted
        };
        if let Some(failure) = failure.filter(|failure| !failure.is_empty())
            && !aborted
            && !admission.is_some_and(CancellationToken::is_cancelled)
        {
            self.publish_error(turn, failure);
            turn.borrow_mut().reported_failure = true;
        }
    }

    fn activate_turn_source(
        &self,
        session: &SessionRef,
        turn: &TurnRef,
        project_path: &str,
    ) -> bool {
        let previous = {
            let session = session.borrow();
            if session.retired {
                return false;
            }
            session.source_turn.clone()
        };
        if let Some(previous) = previous.filter(|previous| !Rc::ptr_eq(previous, turn)) {
            self.retire_turn_source(session, &previous, AcpRetireReason::SessionComplete);
        }
        self.0.converter.begin_turn(&session.borrow().id);
        let mut session = session.borrow_mut();
        session.source_turn = Some(Rc::clone(turn));
        session.active_turn = Some(Rc::clone(turn));
        session.project_path = project_path.to_owned();
        session.state = RuntimeSessionState::Running;
        session.last_activity_at = self.0.clock.now_ms();
        true
    }

    fn bind_turn_source(&self, session: &SessionRef, turn: &TurnRef) {
        let client = Rc::clone(&session.borrow().client);
        let context = TurnContext {
            runtime: Rc::downgrade(&self.0),
            session: Rc::downgrade(session),
            turn: Rc::downgrade(turn),
        };
        let rpc = client.on_rpc_message({
            let context = context.clone();
            move |message| match context.resolve() {
                Some((runtime, session, turn)) if can_route_source(&session, &turn) => {
                    runtime.on_turn_rpc(&session, &turn, message)
                }
                _ => Ok(()),
            }
        });
        let stderr = client.on_stderr(move |line| {
            if !garcon_js::trim(line).is_empty()
                && let Some((runtime, session, turn)) = context.resolve()
                && can_route_source(&session, &turn)
            {
                runtime.flush_before_runtime_row(&session, &turn, AcpRuntimeBoundary::Stderr);
                runtime.publish_error(&turn, line);
            }
        });
        turn.borrow_mut()
            .detach_source_listeners
            .extend([rpc, stderr]);
    }

    fn on_turn_rpc(
        &self,
        session: &SessionRef,
        turn: &TurnRef,
        message: &AcpJsonRpcMessage,
    ) -> ExecutorResult<()> {
        match (message.method(), message.id()) {
            (Some("session/update"), _) => self.on_session_update(session, turn, message.params()),
            (Some("session/request_permission"), Some(id)) => {
                self.on_permission_request(session, turn, id, message.params())?
            }
            (Some(method), Some(id))
                if !self.on_custom_blocking_request(
                    session,
                    turn,
                    id.clone(),
                    method,
                    message.params(),
                )? =>
            {
                let client = Rc::clone(&session.borrow().client);
                client.respond_error(
                    id,
                    -32601.0,
                    &format!("Unsupported ACP request method: {method}"),
                    None,
                )?;
            }
            _ => {}
        }
        Ok(())
    }

    fn on_session_update(&self, session: &SessionRef, turn: &TurnRef, raw: &Value) {
        let params = as_object(raw);
        let id = session.borrow().id.clone();
        if params
            .get("sessionId")
            .and_then(as_string)
            .filter(|id| !id.is_empty())
            != Some(id.as_str())
        {
            self.warn(
                "Dropped an ACP session update without its owning native session.",
                &id,
                None,
            );
            return;
        }
        session.borrow_mut().last_activity_at = self.0.clock.now_ms();
        let context = self.session_update_context(session);
        let mut rows = self.0.converter.from_session_update(params, &context);
        let flags = {
            let turn = turn.borrow();
            (turn.completed, turn.aborted)
        };
        if flags.0 {
            if flags.1 {
                self.0.converter.take_turn_failure(&id);
            }
            rows.extend(self.0.converter.end_turn(&id, &context));
        }
        self.publish_messages(turn, rows);
    }

    fn on_permission_request(
        &self,
        session: &SessionRef,
        turn: &TurnRef,
        request_id: AcpJsonRpcId,
        raw: &Value,
    ) -> ExecutorResult<()> {
        let params = as_object(raw);
        let (id, client) = session_client(session);
        if params
            .get("sessionId")
            .and_then(as_string)
            .filter(|id| !id.is_empty())
            != Some(id.as_str())
        {
            self.warn(
                "Dropped an ACP permission request without its owning native session.",
                &id,
                None,
            );
            return Ok(());
        }
        let options: Vec<_> = params
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(as_object)
            .collect();
        let tool_call = as_object(params.get("toolCall").unwrap_or(&Value::Null));
        let context = self.session_update_context(session);
        let converted = self.0.converter.permission_tool_use(tool_call, &context);
        let (aborted, mode) = {
            let turn = turn.borrow();
            (turn.aborted, turn.permission_mode)
        };
        if aborted {
            return client.respond(request_id, permission_cancelled_outcome());
        }
        let automatic = automatic_permission_choice(
            mode,
            tool_call.get("kind"),
            self.0.policy.accepts_edits_on_client,
        );
        let approval = permission_choice_outcome(
            &options,
            automatic.unwrap_or(AcpPermissionChoice::AllowOnce),
        );
        if automatic.is_some() || approval["outcome"]["outcome"] == "cancelled" {
            return client.respond(request_id, approval);
        }
        let occurrence = (self.0.new_permission_id)();
        let tool = converted.unwrap_or_else(|| {
            fallback_permission_tool_use(tool_call, &occurrence, &context.timestamp)
        });
        let options: Vec<_> = options.into_iter().cloned().collect();
        self.request_permission(
            session,
            turn,
            request_id,
            occurrence,
            AcpBlockingRequestToolUse {
                tool,
                response_for_decision: Rc::new(move |decision| {
                    let options: Vec<_> = options.iter().collect();
                    let choice = if !decision.allow {
                        AcpPermissionChoice::Reject
                    } else if decision.always_allow == Some(true) {
                        AcpPermissionChoice::AllowAlways
                    } else {
                        AcpPermissionChoice::AllowOnce
                    };
                    permission_choice_outcome(&options, choice)
                }),
                response_for_cancellation: Rc::new(|_| permission_cancelled_outcome()),
            },
        );
        Ok(())
    }

    fn on_custom_blocking_request(
        &self,
        session: &SessionRef,
        turn: &TurnRef,
        request_id: AcpJsonRpcId,
        method: &str,
        params: &Value,
    ) -> ExecutorResult<bool> {
        let occurrence = (self.0.new_permission_id)();
        let context = self.session_update_context(session);
        let Some(request) = self.0.converter.custom_request_tool_use(
            &AcpCustomRequest {
                method,
                params,
                permission_occurrence_id: &occurrence,
            },
            &context,
        ) else {
            return Ok(false);
        };
        if turn.borrow().aborted {
            let client = Rc::clone(&session.borrow().client);
            client.respond(
                request_id,
                (request.response_for_cancellation)(AcpRetireReason::Aborted),
            )?;
        } else {
            self.request_permission(session, turn, request_id, occurrence, request);
        }
        Ok(true)
    }

    fn request_permission(
        &self,
        session: &SessionRef,
        turn: &TurnRef,
        request_id: AcpJsonRpcId,
        occurrence: String,
        request: AcpBlockingRequestToolUse,
    ) {
        let pending = Rc::new(PendingPermissionRequest {
            permission_occurrence_id: occurrence.clone(),
            tool_call_id: request.tool.tool_id().to_owned(),
            turn: Rc::downgrade(turn),
            request_id,
            response_for_decision: request.response_for_decision,
            response_for_cancellation: request.response_for_cancellation,
        });
        turn.borrow_mut()
            .pending_permissions
            .push(Rc::clone(&pending));
        self.0
            .state
            .borrow_mut()
            .pending_permissions
            .push(Rc::clone(&pending));
        self.flush_before_runtime_row(
            session,
            turn,
            AcpRuntimeBoundary::PermissionRequest {
                tool_call_id: pending.tool_call_id.clone(),
            },
        );
        let run_id = turn.borrow().operation.run_id.clone();
        self.publish_turn_event(
            turn,
            AgentRuntimeEvent::Permission {
                run_id,
                lifecycle: AgentProviderPermissionLifecycle::Requested(
                    AgentRequestedPermission::Requested {
                        permission_occurrence_id: occurrence,
                        requested_tool: Box::new(request.tool),
                        options: Vec::new(),
                        reason: None,
                    },
                ),
                decision: Some(Rc::new(PermissionResponse {
                    runtime: Rc::downgrade(&self.0),
                    pending,
                })),
            },
        );
    }

    fn resolve_permission(
        &self,
        pending: &Rc<PendingPermissionRequest>,
        decision: &PermissionDecisionPayload,
    ) -> ExecutorResult<()> {
        let no_longer_pending = || plain_error("ACP permission occurrence is no longer pending");
        let turn = pending.turn.upgrade().ok_or_else(no_longer_pending)?;
        let session = turn
            .borrow()
            .session
            .upgrade()
            .ok_or_else(no_longer_pending)?;
        if turn.borrow().source_retired
            || !self
                .0
                .state
                .borrow()
                .pending_permissions
                .iter()
                .any(|item| Rc::ptr_eq(item, pending))
        {
            return Err(no_longer_pending());
        }
        let client = Rc::clone(&session.borrow().client);
        client.respond(
            pending.request_id.clone(),
            (pending.response_for_decision)(decision),
        )?;
        self.flush_before_runtime_row(
            &session,
            &turn,
            AcpRuntimeBoundary::PermissionSettlement {
                tool_call_id: pending.tool_call_id.clone(),
            },
        );
        self.remove_permission(pending);
        turn.borrow_mut()
            .pending_permissions
            .retain(|item| !Rc::ptr_eq(item, pending));
        self.announce_steerable(&session, &turn);
        Ok(())
    }

    pub(super) fn cancel_permissions_for_turn(
        &self,
        session: &SessionRef,
        turn: &TurnRef,
        reason: AcpRetireReason,
    ) {
        let pending = turn.borrow().pending_permissions.clone();
        let client = Rc::clone(&session.borrow().client);
        let run_id = turn.borrow().operation.run_id.clone();
        for permission in pending {
            if !self.remove_permission(&permission) {
                continue;
            }
            let _ = client.respond(
                permission.request_id.clone(),
                (permission.response_for_cancellation)(reason),
            );
            self.flush_before_runtime_row(
                session,
                turn,
                AcpRuntimeBoundary::PermissionSettlement {
                    tool_call_id: permission.tool_call_id.clone(),
                },
            );
            self.publish_turn_event(
                turn,
                AgentRuntimeEvent::Permission {
                    run_id: run_id.clone(),
                    lifecycle: AgentProviderPermissionLifecycle::Terminal(
                        AgentTerminalPermission::Cancelled {
                            permission_occurrence_id: permission.permission_occurrence_id.clone(),
                            reason: Some(reason.as_str().to_owned()),
                        },
                    ),
                    decision: None,
                },
            );
        }
        turn.borrow_mut().pending_permissions.clear();
    }

    fn remove_permission(&self, permission: &Rc<PendingPermissionRequest>) -> bool {
        let mut state = self.0.state.borrow_mut();
        let position = state
            .pending_permissions
            .iter()
            .position(|item| Rc::ptr_eq(item, permission));
        if let Some(position) = position {
            state.pending_permissions.remove(position);
        }
        position.is_some()
    }

    pub(super) fn complete_turn(&self, session: &SessionRef, turn: &TurnRef) {
        let mut current = turn.borrow_mut();
        if current.completed {
            return;
        }
        current.completed = true;
        let mut session = session.borrow_mut();
        if same_turn(&session.active_turn, turn) {
            session.active_turn = None;
        }
        if let Some(settle) = current.settle.take() {
            let _ = settle.send(());
        }
    }

    fn emit_flushed_messages(&self, session: &SessionRef, turn: &TurnRef) -> Vec<ChatMessage> {
        if turn.borrow().source_retired {
            return Vec::new();
        }
        let context = self.session_update_context(session);
        let rows = self.0.converter.end_turn(&context.session_id, &context);
        self.publish_messages(turn, rows.iter().cloned());
        rows
    }

    fn publish_messages(&self, turn: &TurnRef, messages: impl IntoIterator<Item = ChatMessage>) {
        for message in messages {
            self.publish_turn_event(
                turn,
                AgentRuntimeEvent::Rows {
                    rows: runtime_rows([NativeSourced::new(message)]),
                },
            );
        }
    }

    fn publish_error(&self, turn: &TurnRef, message: &str) {
        self.publish_messages(
            turn,
            [ChatMessage::Error(ErrorMessage {
                timestamp: self.timestamp(),
                content: message.to_owned(),
            })],
        );
    }

    fn flush_before_runtime_row(
        &self,
        session: &SessionRef,
        turn: &TurnRef,
        boundary: AcpRuntimeBoundary,
    ) {
        if can_route_source(session, turn) {
            self.publish_messages(
                turn,
                self.0
                    .converter
                    .flush_pending(&self.session_update_context(session), &boundary),
            );
        }
    }

    fn publish_turn_event(&self, turn: &TurnRef, event: AgentRuntimeEvent) {
        let publish = {
            let turn = turn.borrow();
            if turn.source_retired {
                return;
            }
            Rc::clone(&turn.operation.publish)
        };
        publish(event);
    }

    fn announce_steerable(&self, session: &SessionRef, turn: &TurnRef) {
        if self.steer_rejection(session, turn).is_none() {
            self.publish_turn_event(turn, AgentRuntimeEvent::Steerable);
        }
    }

    pub(super) fn retire_superseded_chat_sessions(&self, current: &SessionRef) {
        let chat_id = current.borrow().chat_id.clone();
        for session in self.sessions() {
            if !Rc::ptr_eq(current, &session) && session.borrow().chat_id == chat_id {
                self.retire_session(&session, AcpRetireReason::SessionComplete, false);
            }
        }
    }

    fn retire_turn_source(&self, session: &SessionRef, turn: &TurnRef, reason: AcpRetireReason) {
        if turn.borrow().source_retired {
            return;
        }
        self.cancel_permissions_for_turn(session, turn, reason);
        let detach = {
            let mut turn = turn.borrow_mut();
            turn.source_retired = true;
            mem::take(&mut turn.detach_source_listeners)
        };
        for detach in detach {
            detach();
        }
        let mut session = session.borrow_mut();
        if same_turn(&session.source_turn, turn) {
            session.source_turn = None;
        }
    }

    pub(super) fn retire_session(
        &self,
        session: &SessionRef,
        reason: AcpRetireReason,
        process_exited: bool,
    ) {
        let (id, client, turns) = {
            let mut current = session.borrow_mut();
            if current.retired {
                return;
            }
            current.retired = true;
            current.last_activity_at = self.0.clock.now_ms();
            let mut turns: Vec<TurnRef> = Vec::new();
            for turn in [
                &current.active_turn,
                &current.source_turn,
                &current.pending_turn,
            ]
            .into_iter()
            .flatten()
            {
                if !turns.iter().any(|known| Rc::ptr_eq(known, turn)) {
                    turns.push(Rc::clone(turn));
                }
            }
            (current.id.clone(), Rc::clone(&current.client), turns)
        };
        for turn in turns {
            if can_route_source(session, &turn) {
                self.0.converter.take_turn_failure(&id);
                self.emit_flushed_messages(session, &turn);
            }
            if reason == AcpRetireReason::Aborted
                || (!process_exited && same_turn(&session.borrow().pending_turn, &turn))
            {
                turn.borrow_mut().aborted = true;
            }
            self.complete_turn(session, &turn);
            self.retire_turn_source(session, &turn, reason);
        }
        if self
            .session(&id)
            .is_some_and(|owner| Rc::ptr_eq(&owner, session))
        {
            self.0.state.borrow_mut().sessions.shift_remove(&id);
            self.0.converter.release_session(&id);
        }
        client.close();
    }

    fn session_update_context(&self, session: &SessionRef) -> AcpSessionUpdateContext {
        let session = session.borrow();
        AcpSessionUpdateContext {
            chat_id: session.chat_id.clone(),
            session_id: session.id.clone(),
            timestamp: self.timestamp(),
        }
    }

    fn timestamp(&self) -> String {
        // INFALLIBLE: wall-clock timestamps are within the JavaScript Date range.
        to_iso_string(self.0.clock.now_ms()).expect("the timestamp is in the Date range")
    }
}

fn session_client(session: &SessionRef) -> (String, Rc<AcpClient>) {
    let session = session.borrow();
    (session.id.clone(), Rc::clone(&session.client))
}

fn release_pending(session: &SessionRef, turn: &TurnRef) {
    let mut session = session.borrow_mut();
    if same_turn(&session.pending_turn, turn) {
        session.pending_turn = None;
    }
}

fn can_route_source(session: &SessionRef, turn: &TurnRef) -> bool {
    same_turn(&session.borrow().source_turn, turn) && !turn.borrow().source_retired
}

#[derive(Clone)]
struct TurnContext {
    runtime: Weak<RuntimeInner>,
    session: Weak<RefCell<AcpAgentRuntimeSession>>,
    turn: Weak<RefCell<AcpTurnContext>>,
}

impl TurnContext {
    fn resolve(&self) -> Option<(AcpAgentRuntime, SessionRef, TurnRef)> {
        Some((
            AcpAgentRuntime(self.runtime.upgrade()?),
            self.session.upgrade()?,
            self.turn.upgrade()?,
        ))
    }
}

struct PermissionResponse {
    runtime: Weak<RuntimeInner>,
    pending: Rc<PendingPermissionRequest>,
}

#[async_trait(?Send)]
impl RuntimePermissionResponse for PermissionResponse {
    fn permission_occurrence_id(&self) -> &str {
        &self.pending.permission_occurrence_id
    }

    async fn respond(&self, decision: PermissionDecisionPayload) -> ExecutorResult<()> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| plain_error("ACP permission occurrence is no longer pending"))?;
        AcpAgentRuntime(runtime).resolve_permission(&self.pending, &decision)
    }
}
