use futures::FutureExt;
use garcon_agents_common::execution::runtime_events::runtime_rows;
use garcon_contract::chat_types::ChatMessage;
use garcon_interface::native_message_source::{
    NativeMessageSourceInput, NativeSourced, attach_native_message_source,
    get_native_message_source,
};
use tokio::task::yield_now;

use super::{
    super::{
        compaction_routing::{
            OpenCodeCompactionPartRouteInput, adopt_open_code_compaction_part_route,
            compaction_boundary_row, compaction_event_trigger,
        },
        event_converter::convert_open_code_event_to_chat_messages,
        global_event_listener::ConfirmEventDeliveryInput,
        operation_routes::{OpenCodeOperationEventSource, Route},
        prompt_response::parse_open_code_prompt_response,
        sdk_result::throw_open_code_result_error,
        sse_events::{
            OpenCodeAssistantTerminal, SseEvent, extract_session_id,
            is_open_code_compaction_continuation_part, is_open_code_compaction_control_part,
            is_open_code_manual_compaction_control_part, open_code_assistant_terminal,
            open_code_retry_notice,
        },
        turn_events::{
            accept_unique_open_code_turn_event, open_code_event_belongs_to_turn,
            open_code_turn_requires_provider_quiescence, should_warn_for_unrouted_open_code_event,
        },
        turn_failure::{
            OPEN_CODE_ABORTED_TURN_FAILURE_MESSAGE, latest_open_code_prompt_terminal,
            open_code_provider_failure_row,
        },
    },
    *,
};
use crate::js::prop;

impl OpenCodeRuntime {
    fn publish_rows(
        &self,
        id: &str,
        operation: &AgentRuntimeOperation,
        messages: Vec<NativeSourced<ChatMessage>>,
    ) {
        if !messages.is_empty() {
            self.publish(
                id,
                operation,
                AgentRuntimeEvent::Rows {
                    rows: runtime_rows(messages),
                },
            );
        }
    }

    pub(super) fn fail_turn_for_provider_error(
        &self,
        id: &str,
        session: &OpenCodeSession,
        message: &str,
        entry_id: Option<&str>,
    ) {
        self.steering.stage_pending_cleanup(session);
        let turn = {
            let mut session = session.borrow_mut();
            session.provider_work_requires_quiescence =
                open_code_turn_requires_provider_quiescence(&session.turn);
            session.status = SessionStatus::Completed;
            session.last_activity_at = self.now();
            session.turn.clone()
        };
        self.decisions.cancel_for_session(id, "cancelled");
        self.settle_waiter(id, Err(shared_error("Error", message)));
        let row =
            open_code_provider_failure_row(message, entry_id, &turn, self.options.clock.as_ref());
        let source = get_native_message_source(&row);
        let mut row = NativeSourced::new(ChatMessage::Error(row.value));
        attach_native_message_source(
            &mut row,
            source.as_ref().map(|source| NativeMessageSourceInput {
                entry_id: source.entry_id.as_deref(),
                ..Default::default()
            }),
        );
        let operation = turn.borrow().operation.clone();
        self.publish_rows(id, &operation, vec![row]);
        self.publish_failed(id, &operation, message);
    }

    fn fail_prompt_request(&self, route: &Route, failure: Box<dyn Error>) {
        let id = &route.session_id;
        let session = self.session(id).filter(|session| {
            let session = session.borrow();
            session.status == SessionStatus::Running && session.turn == route.turn
        });
        if let Some(session) = session.filter(|_| self.routes.is_registered(route)) {
            match latest_open_code_prompt_terminal(&route.turn) {
                Some(OpenCodeAssistantTerminal::Failed { message_id, error }) => self
                    .fail_turn_for_provider_error(
                        id,
                        &session,
                        error.as_deref().unwrap_or("OpenCode session failed"),
                        Some(&message_id),
                    ),
                Some(terminal @ OpenCodeAssistantTerminal::Aborted { .. }) => {
                    self.logger.debug(
                        "OpenCode prompt failed after an aborted terminal",
                        Some(&log_fields([("error", json!(failure.to_string()))])),
                    );
                    self.settle_turn_terminal(id, &session, terminal);
                }
                _ => {
                    let message = failure.to_string();
                    self.logger.error(
                        "OpenCode prompt failed",
                        Some(&log_fields([
                            ("agentSessionId", json!(id)),
                            ("error", json!(message)),
                        ])),
                    );
                    self.steering.stage_pending_cleanup(&session);
                    {
                        let mut session = session.borrow_mut();
                        session.provider_work_requires_quiescence =
                            open_code_turn_requires_provider_quiescence(&route.turn);
                        session.status = SessionStatus::Completed;
                        session.last_activity_at = self.now();
                    }
                    self.decisions.cancel_for_session(id, "cancelled");
                    self.settle_waiter(id, Err(failure.into()));
                    let operation = route.turn.borrow().operation.clone();
                    self.publish_failed(id, &operation, &message);
                }
            }
            if !self.session(id).is_some_and(|session| {
                let session = session.borrow();
                session.status == SessionStatus::Running && session.turn == route.turn
            }) {
                self.routes.unregister(route);
            }
        }
        if self.is_temporarily_unavailable() {
            self.idle.close_instance_if_idle();
        }
    }

    fn settle_turn_terminal(
        &self,
        id: &str,
        session: &OpenCodeSession,
        terminal: OpenCodeAssistantTerminal,
    ) {
        let turn = {
            let mut session = session.borrow_mut();
            if session.status != SessionStatus::Running {
                return;
            }
            if session.aborting == Some(true) || session.active_steering_deliveries > 0 {
                session.deferred_terminal = Some(terminal);
                return;
            }
            session.deferred_terminal = None;
            session.turn.clone()
        };
        let message_id = terminal.message_id();
        if !turn.borrow().pending_steering_message_ids.is_empty() {
            self.fail_turn_for_provider_error(
                id,
                session,
                "OpenCode stopped before processing accepted steering input",
                Some(message_id),
            );
            return;
        }
        match &terminal {
            OpenCodeAssistantTerminal::Aborted { .. } => {
                self.logger.warn(
                    "OpenCode interrupted the current turn",
                    Some(&log_fields([
                        ("agentSessionId", json!(id)),
                        ("messageId", json!(message_id)),
                    ])),
                );
                self.fail_turn_for_provider_error(
                    id,
                    session,
                    OPEN_CODE_ABORTED_TURN_FAILURE_MESSAGE,
                    Some(message_id),
                );
            }
            OpenCodeAssistantTerminal::Failed { error, .. } => {
                self.fail_turn_for_provider_error(
                    id,
                    session,
                    error.as_deref().unwrap_or("OpenCode session failed"),
                    Some(message_id),
                );
            }
            OpenCodeAssistantTerminal::Finished { .. } => {
                self.decisions.cancel_for_session(id, "session-complete");
                {
                    let mut session = session.borrow_mut();
                    session.status = SessionStatus::Completed;
                    session.last_activity_at = self.now();
                }
                self.settle_waiter(id, Ok(()));
                let (operation, response) = {
                    let mut turn = turn.borrow_mut();
                    (
                        turn.operation.clone(),
                        turn.final_response
                            .take()
                            .filter(|candidate| candidate.message_id == message_id)
                            .map(|candidate| candidate.response),
                    )
                };
                self.publish_finished(id, &operation, response);
            }
        }
    }

    pub(super) fn release_deferred_terminal(&self, id: &str, session: &OpenCodeSession) {
        let terminal = {
            let mut session = session.borrow_mut();
            if session.aborting == Some(true) || session.active_steering_deliveries > 0 {
                return;
            }
            session.deferred_terminal.take()
        };
        if let Some(terminal) = terminal {
            self.settle_turn_terminal(id, session, terminal);
            let session = session.borrow();
            if session.status != SessionStatus::Running {
                self.routes.retire_turn(&session.turn);
            }
        }
    }

    fn dispatch_event(&self, event: &SseEvent, route: &Route) -> ExecutorResult<()> {
        let operation = route.turn.borrow().operation.clone();
        if let Some(trigger) = compaction_event_trigger(event, &route.turn) {
            let manual = route.turn.borrow().compaction;
            if manual && route.turn.borrow().manual_compaction_boundary_published {
                return Ok(());
            }
            if let Some(boundary) = compaction_boundary_row(event, trigger)? {
                if manual {
                    route.turn.borrow_mut().manual_compaction_boundary_published = true;
                }
                let mut row = NativeSourced::new(ChatMessage::Compaction(boundary.row));
                attach_native_message_source(
                    &mut row,
                    Some(NativeMessageSourceInput {
                        entry_id: Some(&boundary.summary_message_id),
                        ..Default::default()
                    }),
                );
                self.publish_rows(&route.session_id, &operation, vec![row]);
            }
        } else if let Some(messages) = convert_open_code_event_to_chat_messages(
            event,
            &route.turn,
            self.logger.as_ref(),
            self.options.clock.as_ref(),
        ) {
            self.publish_rows(&route.session_id, &operation, messages);
        }
        Ok(())
    }

    fn dispatch_prompt_response(
        &self,
        result: &Value,
        route: &Route,
    ) -> ExecutorResult<OpenCodeAssistantTerminal> {
        let response = parse_open_code_prompt_response(result, &route.session_id)?;
        let parent = response
            .response_parent_id
            .as_deref()
            .unwrap_or(&response.message_id);
        if !self.routes.activate_from_response(route, parent) {
            return Err(error(
                "Error",
                "OpenCode operation route retired before prompt completion",
            ));
        }
        if let Some(parent) = response.response_parent_id {
            route
                .turn
                .borrow_mut()
                .provider_continuation_message_ids
                .insert(parent);
        }
        self.routes.observe(route, &response.message_event);
        if !response.is_compaction {
            route
                .turn
                .borrow_mut()
                .assistant_message_ids
                .insert(response.message_id.clone());
            self.dispatch_event(&response.message_event, route)?;
        }
        route.turn.borrow_mut().final_response = response.final_response;
        if !response.is_compaction {
            for part in response.parts.into_iter().filter(Value::is_object) {
                let event = SseEvent {
                    id: None,
                    kind: "message.part.updated".to_owned(),
                    properties: Some(Map::from_iter([
                        ("sessionID".to_owned(), json!(route.session_id)),
                        ("part".to_owned(), part),
                    ])),
                };
                self.routes.observe(route, &event);
                self.dispatch_event(&event, route)?;
            }
        }
        Ok(
            open_code_assistant_terminal(&response.message_event).unwrap_or(
                OpenCodeAssistantTerminal::Finished {
                    message_id: response.message_id,
                },
            ),
        )
    }

    pub(super) async fn complete_prompt_request(
        self: &Rc<Self>,
        request: OpenCodeEndpointRequest,
        route: Route,
        scope: OpenCodeRequestScope,
    ) {
        let mut source_retired = false;
        let result: ExecutorResult<()> = async {
            let client = request.client.clone();
            let result = self.run_turn_request(request).await?;
            self.await_event_barrier(
                client,
                scope.directory,
                Some(route.request_abort_controller.clone()),
            )
            .await?;
            source_retired = true;
            route.request_abort_controller.throw_if_aborted()?;
            throw_open_code_result_error(&result, "OpenCode prompt failed")?;
            let terminal = self.dispatch_prompt_response(&result, &route)?;
            if let Some(session) = self
                .session(&route.session_id)
                .filter(|session| session.borrow().turn == route.turn)
            {
                let terminal = route
                    .turn
                    .borrow()
                    .assistant_terminals
                    .get(terminal.message_id())
                    .cloned()
                    .unwrap_or(terminal);
                self.settle_turn_terminal(&route.session_id, &session, terminal);
            }
            Ok(())
        }
        .await;
        if let Err(failure) = result {
            self.fail_prompt_request(&route, failure);
        }
        if source_retired {
            if let Some(session) = self
                .session(&route.session_id)
                .filter(|session| session.borrow().turn == route.turn)
            {
                route.turn.borrow_mut().provider_prompt_request_completed = true;
                session.borrow_mut().provider_work_requires_quiescence =
                    open_code_turn_requires_provider_quiescence(&route.turn);
            }
            self.routes.unregister(&route);
        }
    }

    pub(super) fn handle_global_event(
        &self,
        client: Rc<dyn OpenCodeClient>,
        event: SseEvent,
    ) -> ExecutorResult<()> {
        let session_id = extract_session_id(&event);
        let Some(id) = session_id
            .as_ref()
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            if event.kind != "server.heartbeat" {
                self.logger.debug(
                    "OpenCode SSE event has no session ID",
                    Some(&log_fields([("eventType", json!(event.kind))])),
                );
            }
            return Ok(());
        };
        if event.kind == "session.status" {
            return self.handle_session_status_event(id, &event);
        }
        self.routes.bind_task_descendant_session(&event);
        let child = self.routes.resolve_task_child(id);
        if let Some(child) = &child
            && !matches!(event.kind.as_str(), "permission.asked" | "question.asked")
        {
            self.logger.debug(
                "Ignoring an OpenCode task child transcript event",
                Some(&log_fields([
                    ("eventId", json!(event.id)),
                    ("eventType", json!(event.kind)),
                    ("parentSessionId", json!(child.session_id)),
                    ("childSessionId", json!(id)),
                ])),
            );
            return Ok(());
        }
        let compaction_part = is_open_code_compaction_control_part(&event)
            || is_open_code_compaction_continuation_part(&event)
            || is_open_code_manual_compaction_control_part(&event);
        let route = child.clone().or_else(|| {
            if compaction_part {
                adopt_open_code_compaction_part_route(OpenCodeCompactionPartRouteInput {
                    event: &event,
                    logger: self.logger.as_ref(),
                    operation_routes: &self.routes,
                    session: self.session(id).as_ref(),
                    session_id: id,
                })
            } else {
                self.routes.resolve(id, &event)
            }
        });
        let Some(route) = route else {
            if compaction_part {
                return Ok(());
            }
            let part = event.property("part");
            let info = event.property("info");
            let tool = event.property("tool");
            let fields = log_fields([
                ("eventId", json!(event.id)),
                ("eventType", json!(event.kind)),
                ("sessionId", json!(id)),
                ("partId", json!(prop(part, "id").as_str())),
                (
                    "messageId",
                    json!(
                        prop(part, "messageID")
                            .as_str()
                            .or_else(|| event.property("messageID").as_str())
                    ),
                ),
                ("parentId", json!(prop(info, "parentID").as_str())),
                ("infoId", json!(prop(info, "id").as_str())),
                ("toolMessageId", json!(prop(tool, "messageID").as_str())),
            ]);
            let message = "Ignoring an OpenCode event without an operation identity";
            if should_warn_for_unrouted_open_code_event(&event.kind, self.session(id).is_some()) {
                self.logger.warn(message, Some(&fields));
            } else {
                self.logger.debug(message, Some(&fields));
            }
            return Ok(());
        };
        if !accept_unique_open_code_turn_event(&route.turn, &event, self.logger.as_ref()) {
            return Ok(());
        }
        let source = if child.is_some() {
            OpenCodeOperationEventSource::TaskChild {
                session_id: id.to_owned(),
            }
        } else {
            OpenCodeOperationEventSource::Operation {
                session_id: id.to_owned(),
            }
        };
        if self.decisions.handle(client, &event, &source, &route) {
            return Ok(());
        }
        if let Some(session) = self
            .session(&route.session_id)
            .filter(|session| session.borrow().turn == route.turn)
        {
            self.steering.observe_acknowledgement(&session, &event);
        }
        let belongs = open_code_event_belongs_to_turn(&route.turn, &event);
        self.routes.observe(&route, &event);
        if belongs {
            self.routes.bind_task_child_session(&route, &event);
            self.dispatch_event(&event, &route)?;
            if let Some(terminal) = open_code_assistant_terminal(&event) {
                let compaction = {
                    let mut turn = route.turn.borrow_mut();
                    turn.assistant_terminals
                        .insert(terminal.message_id().to_owned(), terminal.clone());
                    turn.compaction
                };
                if compaction
                    && let Some(session) = self
                        .session(&route.session_id)
                        .filter(|session| session.borrow().turn == route.turn)
                {
                    self.settle_turn_terminal(&route.session_id, &session, terminal);
                }
            }
        }
        Ok(())
    }

    fn handle_session_status_event(&self, id: &str, event: &SseEvent) -> ExecutorResult<()> {
        let Some(notice) = open_code_retry_notice(event)? else {
            return Ok(());
        };
        let Some(session) = self
            .session(id)
            .filter(|session| session.borrow().status == SessionStatus::Running)
        else {
            return Ok(());
        };
        let turn = session.borrow().turn.clone();
        let operation = {
            let mut turn = turn.borrow_mut();
            if turn.last_retry_notice_key.as_ref() == Some(&notice.key) {
                return Ok(());
            }
            turn.last_retry_notice_key = Some(notice.key);
            turn.operation.clone()
        };
        self.publish(
            id,
            &operation,
            AgentRuntimeEvent::Notice {
                run_id: operation.run_id.clone(),
                title: Some(notice.title),
                content: notice.content,
            },
        );
        Ok(())
    }

    pub(super) async fn await_event_barrier(
        self: &Rc<Self>,
        client: Rc<dyn OpenCodeClient>,
        directory: Option<String>,
        signal: Option<AbortSignal>,
    ) -> ExecutorResult<()> {
        if !self.options.requires_executable {
            return Ok(());
        }
        with_abortable_timeout(
            |signal| {
                self.clone()
                    .confirm_event_delivery(ConfirmEventDeliveryInput {
                        client,
                        directory,
                        signal,
                        wait_for_event: Rc::new({
                            let listener = self.listener.clone();
                            move |matches, signal| listener.wait_for_event(matches, signal)
                        }),
                    })
            },
            Some(self.options.request_timeout_ms),
            "OpenCode prompt event delivery",
            signal.as_ref(),
        )
        .await
    }

    pub(super) fn confirm_event_delivery(
        self: Rc<Self>,
        input: ConfirmEventDeliveryInput,
    ) -> LocalBoxFuture<'static, ExecutorResult<()>> {
        async move {
            let marker = format!("garcon-event-stream-readiness-{}", (self.new_id)());
            let mut delivery = (input.wait_for_event)(
                Rc::new({
                    let marker = marker.clone();
                    move |event| {
                        event.kind == "tui.toast.show"
                            && event.property("message").as_str() == Some(marker.as_str())
                    }
                }),
                Some(input.signal.clone()),
            );
            let scope = OpenCodeRequestScope {
                directory: input.directory,
            };
            // The global route registers its bus listener lazily after server.connected.
            // An echoed TUI event proves delivery without creating a provider session.
            loop {
                if let Some(result) = (&mut delivery).now_or_never() {
                    return result.map(|_| ());
                }
                let result = self
                    .scoped_request(
                        "OpenCode event stream delivery probe",
                        input.client.clone(),
                        OpenCodeRequest::ShowToast,
                        Map::from_iter([
                            ("message".to_owned(), json!(marker)),
                            ("variant".to_owned(), json!("info")),
                            ("duration".to_owned(), json!(1)),
                        ]),
                        &scope,
                        OpenCodeRequestControl {
                            signal: Some(input.signal.clone()),
                            ..Default::default()
                        },
                    )
                    .await?;
                throw_open_code_result_error(
                    &result,
                    "OpenCode event stream delivery probe failed",
                )?;
                yield_now().await;
            }
        }
        .boxed_local()
    }
}
