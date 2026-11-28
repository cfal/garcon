use super::{
    super::{
        operation_routes::Route,
        permissions::map_permission_mode,
        prompt::{build_prompt_body, parse_open_code_model},
        runtime_types::{
            OpenCodeExecutionRequest, OpenCodeResumeRequest, OpenCodeStartRequest,
            assert_open_code_execution_open, mark_open_code_execution_started,
        },
        sdk_result::{create_open_code_request_scope, throw_open_code_result_error},
        turn_events::{
            ActivateTurnInput, OpenCodeTurnContext, SessionData, activate_open_code_session_turn,
            create_open_code_turn_context, open_code_turn_requires_provider_quiescence,
        },
    },
    sessions::session_params,
    *,
};
use crate::js::prop;

impl OpenCodeRuntime {
    fn activate_turn(&self, id: &str, session: Option<&OpenCodeSession>, input: ActivateTurnInput) {
        if let Some(session) = session {
            activate_open_code_session_turn(session, input, self.now());
            return;
        }
        // INFALLIBLE: wall-clock time fits a JavaScript Date.
        let started_at =
            garcon_js::to_iso_string(self.options.clock.now_ms()).expect("valid wall clock time");
        self.sessions.borrow_mut().insert(
            id.to_owned(),
            OpenCodeSession::new(SessionData {
                status: SessionStatus::Running,
                aborting: None,
                chat_id: input.chat_id,
                model: input.model,
                thinking_variant: input.thinking_variant,
                permission_mode: input.permission_mode,
                directory: input.directory,
                started_at,
                last_activity_at: self.now(),
                provider_work_requires_quiescence: false,
                active_steering_deliveries: 0,
                deferred_terminal: None,
                pending_steering_revert_message_id: None,
                turn: input.turn,
            }),
        );
    }

    fn register_turn(
        &self,
        id: &str,
        session: Option<&OpenCodeSession>,
        input: ActivateTurnInput,
        supersedes: bool,
    ) -> ExecutorResult<Route> {
        let route = self.routes.register(
            id,
            &input.chat_id,
            input.turn.clone(),
            supersedes,
            input.permission_mode,
            input.directory.clone(),
        )?;
        self.activate_turn(id, session, input);
        Ok(route)
    }

    fn fail_admitted_turn(
        &self,
        route: &Route,
        request: &OpenCodeExecutionRequest,
        failure: &dyn Error,
        log_label: &str,
        stage_steering_cleanup: bool,
    ) {
        if route.turn.borrow().provider_message_id.is_none() {
            self.routes.unregister(route);
        }
        let id = &route.session_id;
        let session = self
            .session(id)
            .filter(|session| session.borrow().turn == route.turn);
        if request
            .execution_admission
            .as_ref()
            .is_some_and(|admission| admission.signal().is_cancelled())
        {
            if let Some(session) = session {
                let mut session = session.borrow_mut();
                session.provider_work_requires_quiescence =
                    open_code_turn_requires_provider_quiescence(&route.turn);
                session.status = SessionStatus::Completed;
                session.last_activity_at = self.now();
            }
            self.turn_waiters.borrow_mut().shift_remove(id);
            return;
        }
        let message = failure.to_string();
        self.logger.error(
            log_label,
            Some(&log_fields([
                ("agentSessionId", json!(id)),
                ("error", json!(message)),
            ])),
        );
        let Some(session) =
            session.filter(|session| session.borrow().status == SessionStatus::Running)
        else {
            return;
        };
        if stage_steering_cleanup {
            self.steering.stage_pending_cleanup(&session);
        }
        {
            let mut session = session.borrow_mut();
            session.provider_work_requires_quiescence =
                open_code_turn_requires_provider_quiescence(&route.turn);
            session.status = SessionStatus::Completed;
            session.last_activity_at = self.now();
        }
        self.turn_waiters.borrow_mut().shift_remove(id);
        let operation = route.turn.borrow().operation.clone();
        self.publish_failed(id, &operation, &message);
    }

    pub(super) async fn quiesce_retired_provider_work(
        self: &Rc<Self>,
        instance: &Rc<OpenCodeInstance>,
        id: &str,
        session: &OpenCodeSession,
        scope: &OpenCodeRequestScope,
    ) -> ExecutorResult<()> {
        let turn = {
            let session = session.borrow();
            if !session.provider_work_requires_quiescence {
                return Ok(());
            }
            session.turn.clone()
        };
        let client = instance.client.clone();
        let result = self
            .scoped_request(
                "OpenCode retired session abort",
                client.clone(),
                OpenCodeRequest::SessionAbort,
                session_params(id),
                scope,
                OpenCodeRequestControl::default(),
            )
            .await?;
        self.assert_instance_current(instance)?;
        throw_open_code_result_error(&result, "OpenCode retired session abort failed")?;
        self.await_event_barrier(client, scope.directory.clone(), None)
            .await?;
        self.assert_instance_current(instance)?;
        self.routes.retire_turn(&turn);
        let mut session = session.borrow_mut();
        if session.turn == turn {
            session.provider_work_requires_quiescence = false;
        }
        Ok(())
    }

    async fn prepare_turn_session(
        self: &Rc<Self>,
        instance: &Rc<OpenCodeInstance>,
        id: &str,
        session: Option<&OpenCodeSession>,
        scope: &OpenCodeRequestScope,
    ) -> ExecutorResult<()> {
        if let Some(session) = session {
            self.quiesce_retired_provider_work(instance, id, session, scope)
                .await?;
            self.assert_instance_current(instance)?;
            self.steering
                .remove_unconsumed(instance.client.clone(), id, session, scope)
                .await?;
        }
        self.assert_instance_current(instance)
    }

    async fn admit_delivery(
        &self,
        instance: &Rc<OpenCodeInstance>,
        route: &Route,
        request: &OpenCodeExecutionRequest,
        scope: &OpenCodeRequestScope,
        closed_stream: &'static str,
    ) -> ExecutorResult<()> {
        self.assert_instance_current(instance)?;
        self.listener.start(scope.directory.clone()).await?;
        self.assert_instance_current(instance)?;
        if !self.session(&route.session_id).is_some_and(|session| {
            let session = session.borrow();
            session.status == SessionStatus::Running && session.turn == route.turn
        }) {
            return Err(error("Error", closed_stream));
        }
        if request.execution_admission.is_some() {
            mark_open_code_execution_started(request).await?;
        }
        self.assert_instance_current(instance)
    }

    pub(super) async fn run_turn_request(
        &self,
        request: OpenCodeEndpointRequest,
    ) -> ExecutorResult<OpenCodeSdkResult> {
        self.endpoint.request_started();
        let _lease = RequestLease(&self.endpoint);
        let signal = request.control.signal.unwrap_or_default();
        signal.throw_if_aborted()?;
        request
            .client
            .request(request.operation, request.parameters, &signal)
            .await
    }

    fn launch_prompt(
        self: &Rc<Self>,
        start: OpenCodeStartRequest,
        client: Rc<dyn OpenCodeClient>,
        route: Route,
        scope: OpenCodeRequestScope,
        variant: Option<&str>,
    ) {
        let attachments = start
            .images
            .into_iter()
            .map(|attachment| json!(attachment))
            .collect::<Vec<_>>();
        let mut parameters = session_params(&route.session_id);
        parameters.extend(build_prompt_body(
            &start.command,
            start.execution.model.as_deref(),
            &route.turn.borrow().provider_prompt_part_id,
            &attachments,
            variant,
        ));
        let request = turn_request(
            client,
            "OpenCode prompt",
            OpenCodeRequest::SessionPrompt,
            parameters,
            &route,
            &scope,
        );
        let runtime = self.clone();
        spawn_local(async move {
            runtime.complete_prompt_request(request, route, scope).await;
        });
    }

    pub async fn start_session(
        self: &Rc<Self>,
        request: OpenCodeStartRequest,
    ) -> ExecutorResult<String> {
        let _admission = TurnAdmission::new(self);
        let execution = &request.execution;
        assert_open_code_execution_open(execution)?;
        let scope = create_open_code_request_scope(Some(&execution.project_path));
        let instance = self.ensure().await?;
        let generation = self.generation.get();
        self.listener.start(scope.directory.clone()).await?;
        self.assert_instance_current(&instance)?;
        assert_open_code_execution_open(execution)?;
        let client = instance.client.clone();
        let result = self
            .scoped_request(
                "OpenCode session create",
                client.clone(),
                OpenCodeRequest::SessionCreate,
                Map::from_iter([(
                    "permission".to_owned(),
                    json!(map_permission_mode(execution.permission_mode.as_str())),
                )]),
                &scope,
                OpenCodeRequestControl::default(),
            )
            .await?;
        let id = created_session_id(&result)?;
        let turn =
            create_open_code_turn_context(execution.operation.clone(), false, self.new_id.as_ref());
        let prepared = async {
            self.assert_instance_current(&instance)?;
            let variant = self
                .models
                .resolve_thinking_variant_for_turn(
                    execution.model.as_deref(),
                    execution.thinking_mode,
                )
                .await;
            self.assert_instance_current(&instance)?;
            Ok(variant)
        }
        .await;
        let variant = match prepared {
            Ok(variant) => variant,
            Err(failure) => {
                self.delete_session_best_effort(id, scope, Some((client, Some(generation))))
                    .await;
                return Err(failure);
            }
        };
        let route = match self.register_turn(
            &id,
            None,
            turn_input(execution, &scope, variant.clone(), turn),
            true,
        ) {
            Ok(route) => route,
            Err(failure) => {
                self.delete_session_best_effort(id, scope, Some((client, Some(generation))))
                    .await;
                return Err(failure);
            }
        };
        self.logger.info(
            "OpenCode session created and registered",
            Some(&log_fields([("agentSessionId", json!(id))])),
        );
        if let Err(failure) = self
            .admit_delivery(
                &instance,
                &route,
                execution,
                &scope,
                "OpenCode event stream ended before prompt delivery",
            )
            .await
        {
            self.routes.unregister(&route);
            self.sessions.borrow_mut().shift_remove(&id);
            self.delete_session_best_effort(id, scope, Some((client, Some(generation))))
                .await;
            return Err(failure);
        }
        if let Some(activate) = &request.on_session_activated {
            activate(&id);
        }
        self.launch_prompt(request, client, route, scope, variant.as_deref());
        Ok(id)
    }

    pub async fn run_turn(self: &Rc<Self>, request: OpenCodeResumeRequest) -> ExecutorResult<()> {
        let _admission = TurnAdmission::new(self);
        let id = &request.agent_session_id;
        let execution = &request.start.execution;
        assert_open_code_execution_open(execution)?;
        if let Some(session) = self.session(id) {
            self.quiesce_session_before_turn(id, &session).await;
        }
        let session = self.session(id);
        let scope = turn_scope(execution, session.as_ref());
        let instance = self.ensure().await?;
        self.listener.start(scope.directory.clone()).await?;
        self.assert_instance_current(&instance)?;
        assert_open_code_execution_open(execution)?;
        let turn =
            create_open_code_turn_context(execution.operation.clone(), false, self.new_id.as_ref());
        self.prepare_turn_session(&instance, id, session.as_ref(), &scope)
            .await?;
        let variant = self
            .models
            .resolve_thinking_variant_for_turn(execution.model.as_deref(), execution.thinking_mode)
            .await;
        self.assert_instance_current(&instance)?;
        let waiter = self.create_waiter(id)?;
        let route = self
            .register_turn(
                id,
                session.as_ref(),
                turn_input(execution, &scope, variant.clone(), turn),
                false,
            )
            .inspect_err(|_| {
                self.turn_waiters.borrow_mut().shift_remove(id);
            })?;
        if let Err(failure) = self
            .admit_delivery(
                &instance,
                &route,
                execution,
                &scope,
                "OpenCode event stream ended before prompt delivery",
            )
            .await
        {
            self.fail_admitted_turn(
                &route,
                execution,
                failure.as_ref(),
                "OpenCode query failed",
                true,
            );
            return Err(failure);
        }
        self.launch_prompt(
            request.start,
            instance.client.clone(),
            route,
            scope,
            variant.as_deref(),
        );
        waiter.await?.map_err(Into::into)
    }

    pub async fn compact(
        self: &Rc<Self>,
        id: &str,
        execution: OpenCodeExecutionRequest,
    ) -> ExecutorResult<()> {
        let _admission = TurnAdmission::new(self);
        assert_open_code_execution_open(&execution)?;
        let session = self.session(id);
        if session
            .as_ref()
            .is_some_and(|session| session.borrow().status == SessionStatus::Running)
        {
            return Err(error(
                "Error",
                "Cannot compact while an OpenCode turn is active",
            ));
        }
        let scope = turn_scope(&execution, session.as_ref());
        let instance = self.ensure().await?;
        self.listener.start(scope.directory.clone()).await?;
        self.assert_instance_current(&instance)?;
        assert_open_code_execution_open(&execution)?;
        let turn =
            create_open_code_turn_context(execution.operation.clone(), true, self.new_id.as_ref());
        let _retire = RetireTurn(&self.routes, &turn);
        self.prepare_turn_session(&instance, id, session.as_ref(), &scope)
            .await?;
        let waiter = self.create_waiter(id)?;
        let route = self
            .register_turn(
                id,
                session.as_ref(),
                turn_input(&execution, &scope, None, turn.clone()),
                false,
            )
            .inspect_err(|_| {
                self.turn_waiters.borrow_mut().shift_remove(id);
            })?;
        let result = async {
            self.admit_delivery(
                &instance,
                &route,
                &execution,
                &scope,
                "OpenCode event stream ended before compaction delivery",
            )
            .await?;
            let mut params = session_params(id);
            if let Some(model) = parse_open_code_model(execution.model.as_deref()) {
                params.insert("providerID".to_owned(), json!(model.provider_id));
                params.insert("modelID".to_owned(), json!(model.model_id));
            }
            let client = instance.client.clone();
            let result = self
                .run_turn_request(turn_request(
                    client.clone(),
                    "OpenCode compaction",
                    OpenCodeRequest::SessionSummarize,
                    params,
                    &route,
                    &scope,
                ))
                .await?;
            self.await_event_barrier(
                client,
                scope.directory,
                Some(route.request_abort_controller.clone()),
            )
            .await?;
            throw_open_code_result_error(&result, "OpenCode compaction failed")?;
            if turn.borrow().provider_message_id.is_none() {
                return Err(error(
                    "Error",
                    "OpenCode compaction did not create a compaction message",
                ));
            }
            Ok(())
        }
        .await;
        if let Err(failure) = result {
            self.fail_admitted_turn(
                &route,
                &execution,
                failure.as_ref(),
                "OpenCode compaction failed",
                false,
            );
            return Err(failure);
        }
        waiter.await?.map_err(Into::into)
    }
}

pub(super) fn created_session_id(result: &OpenCodeSdkResult) -> ExecutorResult<String> {
    throw_open_code_result_error(result, "Failed to create OpenCode session")?;
    prop(prop(&**result, "data"), "id")
        .as_str()
        .map(garcon_js::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            error(
                "Error",
                "Failed to create OpenCode session: missing session id",
            )
        })
}

fn turn_scope(
    execution: &OpenCodeExecutionRequest,
    session: Option<&OpenCodeSession>,
) -> OpenCodeRequestScope {
    let mut scope = create_open_code_request_scope(Some(&execution.project_path));
    if scope.directory.is_none() {
        scope.directory = session.and_then(|session| session.borrow().directory.clone());
    }
    scope
}

fn turn_input(
    request: &OpenCodeExecutionRequest,
    scope: &OpenCodeRequestScope,
    variant: Option<String>,
    turn: OpenCodeTurnContext,
) -> ActivateTurnInput {
    ActivateTurnInput {
        chat_id: request.chat_id.clone(),
        model: request.model.clone(),
        thinking_variant: variant,
        permission_mode: request.permission_mode,
        directory: scope.directory.clone(),
        turn,
    }
}

fn turn_request(
    client: Rc<dyn OpenCodeClient>,
    label: &'static str,
    operation: OpenCodeRequest,
    parameters: Map<String, Value>,
    route: &Route,
    scope: &OpenCodeRequestScope,
) -> OpenCodeEndpointRequest {
    OpenCodeEndpointRequest {
        client,
        label,
        operation,
        parameters: with_open_code_request_scope(parameters, scope),
        control: OpenCodeRequestControl {
            signal: Some(route.request_abort_controller.clone()),
            timeout: OpenCodeRequestTimeout::Unbounded,
        },
    }
}

struct TurnAdmission<'a>(&'a OpenCodeRuntime);

impl<'a> TurnAdmission<'a> {
    fn new(runtime: &'a OpenCodeRuntime) -> Self {
        runtime.endpoint.turn_admission_started();
        Self(runtime)
    }
}

impl Drop for TurnAdmission<'_> {
    fn drop(&mut self) {
        self.0.endpoint.turn_admission_finished();
        if self.0.is_temporarily_unavailable() {
            self.0.idle.close_instance_if_idle();
        }
    }
}

struct RetireTurn<'a>(&'a OpenCodeOperationRoutes, &'a OpenCodeTurnContext);

impl Drop for RetireTurn<'_> {
    fn drop(&mut self) {
        self.0.retire_turn(self.1);
    }
}
