use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    time::Duration,
};

use futures::future::join_all;
use garcon_agents_common::{
    execution::runtime_events::{RuntimeSteerRequest, RuntimeSteerTarget},
    shared::idle_session_purger::{
        DEFAULT_IDLE_SESSION_MAX_AGE_MS, DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS, IdleSessionPurger,
        purge_idle_sessions,
    },
};
use garcon_contract::chat_types::{ChatMessage, ErrorMessage};
use garcon_interface::{
    execution::AgentRunningSession,
    host::AgentLogger,
    producer::AgentFinalResponse,
    resources::ExecutorResult,
    services::{AgentSteerRejectionReason, AgentSteerResult},
};
use garcon_js::{
    clock::{Clock, SystemClock, to_iso_string},
    json::Opaque,
};
use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::{
    app_server::{
        client::CodexAppServerClient,
        durability::{MaterializedThreadOptions, wait_for_materialized_thread},
        native_path_discovery_refresh::NativePathDiscoveryRefreshLimiter,
        operation_routes::{CodexOperation, publish_failed, publish_finished, publish_rows},
        protocol::{CodexTurnStatus, JsonRpcNotification},
        request_builders::{
            CodexConfirmedThreadSettings, CodexThreadConfiguration, CodexThreadSettings,
            CodexThreadSettingsTarget, TurnStartRequest, build_codex_env,
            build_thread_start_params, build_turn_start_params, codex_source_runtime_identity,
            codex_thread_settings_target, parse_leading_slash_command,
            thread_settings_target_from_snapshot, write_attachments_to_temp_files,
        },
        runtime_session_state::{CodexTurnRoutes, FinishSessionOptions, RunningStatus},
        runtime_support::{
            CAPACITY_RETRY_DELAYS, MAX_CAPACITY_RETRIES, NoopLogger, denial_response_for_request,
            has_terminal_pending_finish, humanize_codex_app_server_error, is_active_session_status,
            is_capacity_error, is_terminal_session_status, merge_finish_options,
        },
        steering::{rejected_codex_steer, steer_codex_session},
    },
    runtime_types::{
        CodexExecutionRequest, CodexProviderConfig, CodexStartRequest, CodexStartedSession,
    },
    service_tier::{assert_effective_tier, codex_service_tier, normalize_codex_service_tier},
    slash_command_discovery::CodexSkillDiscovery,
};
use garcon_interface::native_message_source::NativeSourced;

use super::{
    client_events::{BufferedClientEvent, CodexClientEvents},
    permission_events::{CodexApprovalEvents, CodexApprovalRoute},
    source_registry::{
        CodexSessionSource, CodexSourceActivation, CodexSourceRegistry, PendingFinish,
    },
    terminal::detached_turn_failure,
    turn_events::{CodexObservedTurnCompletion, dispatch_turn_notification},
    utility::CodexAppServerUtility,
};

mod capacity_retry;
mod fork;
mod resume;

type CodexClientFactory = Rc<
    dyn Fn(Option<IndexMap<String, String>>, Option<&CodexProviderConfig>) -> CodexAppServerClient,
>;

pub struct CodexAppServerRuntimeOptions {
    pub create_client: CodexClientFactory,
    pub new_occurrence_id: Rc<dyn Fn() -> String>,
    pub logger: Rc<dyn AgentLogger>,
    pub clock: Rc<dyn Clock>,
    pub materialization_timeout: Duration,
    pub settings_timeout: Duration,
    pub capacity_retry_delays: Vec<Duration>,
    pub retained_source_idle_ms: i64,
    pub retained_source_purge_interval_ms: u64,
    pub refresh: NativePathDiscoveryRefreshLimiter,
}

impl CodexAppServerRuntimeOptions {
    pub fn new(
        create_client: CodexClientFactory,
        new_occurrence_id: Rc<dyn Fn() -> String>,
    ) -> Self {
        Self {
            create_client,
            new_occurrence_id,
            logger: Rc::new(NoopLogger),
            clock: Rc::new(SystemClock),
            materialization_timeout: Duration::from_secs(10),
            settings_timeout: Duration::from_secs(10),
            capacity_retry_delays: CAPACITY_RETRY_DELAYS.to_vec(),
            retained_source_idle_ms: DEFAULT_IDLE_SESSION_MAX_AGE_MS,
            retained_source_purge_interval_ms: DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS,
            refresh: NativePathDiscoveryRefreshLimiter::default(),
        }
    }
}

struct ManagedRuntime {
    create_client: CodexClientFactory,
    logger: Rc<dyn AgentLogger>,
    clock: Rc<dyn Clock>,
    sources: RefCell<CodexSourceRegistry>,
    approvals: Rc<CodexApprovalEvents>,
    clients: RefCell<IndexMap<usize, CodexAppServerClient>>,
    utility: CodexAppServerUtility,
    skills: CodexSkillDiscovery,
    materialization_timeout: Duration,
    settings_timeout: Duration,
    capacity_retry_delays: Vec<Duration>,
    idle_purger: IdleSessionPurger,
    retained_source_idle_ms: i64,
    retained_source_purge_interval_ms: u64,
    closed: Cell<bool>,
}

#[derive(Clone)]
pub struct CodexAppServerRuntime(Rc<ManagedRuntime>);

struct CapturedSteerTarget {
    source: Weak<CodexSessionSource>,
    turn_id: String,
    used: Cell<bool>,
}

impl CodexAppServerRuntime {
    pub fn new(options: CodexAppServerRuntimeOptions) -> Self {
        let create_shared_client: Rc<dyn Fn() -> CodexAppServerClient> = {
            let create = options.create_client.clone();
            Rc::new(move || create(None, None))
        };
        let utility = CodexAppServerUtility::new(
            create_shared_client.clone(),
            options.logger.clone(),
            options.refresh,
        );
        let skills = CodexSkillDiscovery::new(create_shared_client, options.logger.clone());
        Self(Rc::new(ManagedRuntime {
            create_client: options.create_client,
            approvals: Rc::new(CodexApprovalEvents::new(
                options.logger.clone(),
                options.clock.clone(),
                options.new_occurrence_id,
            )),
            logger: options.logger,
            clock: options.clock,
            sources: RefCell::default(),
            clients: RefCell::default(),
            utility,
            skills,
            materialization_timeout: options.materialization_timeout,
            settings_timeout: options.settings_timeout,
            capacity_retry_delays: options
                .capacity_retry_delays
                .into_iter()
                .take(MAX_CAPACITY_RETRIES)
                .collect(),
            idle_purger: IdleSessionPurger::default(),
            retained_source_idle_ms: options.retained_source_idle_ms,
            retained_source_purge_interval_ms: options.retained_source_purge_interval_ms,
            closed: Cell::new(false),
        }))
    }

    pub async fn start_session(
        &self,
        request: CodexStartRequest,
    ) -> ExecutorResult<CodexStartedSession> {
        request.execution.assert_open()?;
        let (client, events) = self.new_client(
            request.execution.env_overrides.as_ref(),
            request.execution.activation.codex_config.as_ref(),
        )?;
        let mut active = None;
        let result = self
            .start_session_inner(&request, &client, &events, &mut active)
            .await;
        if let Err(error) = &result {
            let admission_closed = request.execution.assert_open().is_err();
            let message = humanize_codex_app_server_error(error.as_ref());
            if let Some(source) = active {
                let options = if admission_closed {
                    FinishSessionOptions {
                        aborted: true,
                        ..Default::default()
                    }
                } else {
                    FinishSessionOptions {
                        failed_message: Some(message),
                        ..Default::default()
                    }
                };
                self.finish_session(&source, options, Some(&request.execution.operation));
                if admission_closed {
                    self.retire_source(&source);
                    self.shutdown_client(&source.client).await;
                }
            } else {
                events.discard();
                if !admission_closed {
                    let op = &request.execution.operation;
                    publish_failed(self.0.logger.as_ref(), &op.chat_id, message, Some(op));
                }
                self.shutdown_client(&client).await;
            }
        }
        result
    }

    async fn start_session_inner(
        &self,
        request: &CodexStartRequest,
        client: &CodexAppServerClient,
        events: &CodexClientEvents,
        active: &mut Option<Rc<CodexSessionSource>>,
    ) -> ExecutorResult<CodexStartedSession> {
        let execution = &request.execution;
        let initialized = client.connect().await?;
        execution.assert_open()?;
        let params = build_thread_start_params(&execution.activation);
        let started = client.request("thread/start", Some(&params), None).await?;
        execution.assert_open()?;
        let source =
            self.activate_session(execution, client.clone(), &started, &initialized, None)?;
        *active = Some(source.clone());
        events.release()?;
        execution.assert_open()?;
        let reported_path = source.native_path.borrow().clone();
        if let Some(on_activated) = &request.on_session_activated {
            on_activated(CodexStartedSession {
                agent_session_id: source.thread_id.clone(),
                native_path: reported_path.clone(),
            });
        }
        execution.mark_started().await?;
        self.start_requested_turn(&source, execution).await?;

        let native_path = wait_for_materialized_thread(
            &source.thread_id,
            reported_path.as_deref(),
            MaterializedThreadOptions {
                timeout: self.0.materialization_timeout,
                ..Default::default()
            },
        )
        .await?;
        *source.native_path.borrow_mut() = Some(native_path.clone());
        self.0.utility.clear_thread_list_caches();
        Ok(CodexStartedSession {
            agent_session_id: source.thread_id.clone(),
            native_path: Some(native_path),
        })
    }

    async fn start_requested_turn(
        &self,
        source: &CodexSessionSource,
        request: &CodexExecutionRequest,
    ) -> ExecutorResult<()> {
        let attachments = write_attachments_to_temp_files(&request.images).await?;
        source
            .cleanup_attachments
            .replace(Some(attachments.cleanup));
        let project_path = &request.activation.project_path;
        let skills = if !project_path.is_empty()
            && parse_leading_slash_command(&request.command).is_some()
        {
            self.0.skills.skill_refs(project_path).await.ok()
        } else {
            None
        };
        if request.assert_open().is_err() || !self.is_current(source) {
            let cleanup = source.cleanup_attachments.borrow_mut().take();
            if let Some(cleanup) = cleanup {
                cleanup.await;
            }
            return Err("Codex session ended before starting the turn".into());
        }
        let generation = source.turn_attempt.get();
        source
            .routes
            .borrow_mut()
            .expect_turn(request.operation.clone());
        let input = TurnStartRequest {
            thread_id: source.thread_id.clone(),
            command: request.command.clone(),
            image_paths: Some(attachments.image_paths),
            file_paths: Some(attachments.file_paths),
            model: request.activation.model.clone(),
            project_path: project_path.clone(),
            permission_mode: request.activation.permission_mode,
            thinking_mode: request.thinking_mode,
            speed: request.activation.speed,
            client_message_id: request.client_message_id.clone(),
            skills,
        };
        let response = source
            .client
            .request("turn/start", Some(&build_turn_start_params(&input)), None)
            .await?;
        if self.can_apply_turn_attempt(source, generation) {
            let turn_id = response["turn"]["id"]
                .as_str()
                .ok_or("Invalid Codex turn/start response id")?;
            CodexTurnRoutes::adopt_turn(&source.routes, turn_id, request.operation.clone());
        }
        Ok(())
    }

    fn activate_session(
        &self,
        request: &CodexExecutionRequest,
        client: CodexAppServerClient,
        response: &Value,
        initialized: &Value,
        previous_path: Option<&str>,
    ) -> ExecutorResult<Rc<CodexSessionSource>> {
        let thread = &response["thread"];
        let thread_id = thread["id"]
            .as_str()
            .ok_or("Invalid Codex thread response id")?;
        let requested = codex_thread_settings_target(&request.thread_configuration());
        let confirmed_settings = initial_thread_settings(&requested, response)?;
        let admitted_tier = codex_service_tier(request.activation.speed);
        assert_effective_tier(
            admitted_tier,
            response["serviceTier"].as_str(),
            &confirmed_settings.model,
        )?;
        let source = Rc::new(CodexSessionSource::new(
            thread_id.into(),
            client,
            request.operation.clone(),
            CodexSourceActivation {
                native_path: thread["path"].as_str().or(previous_path).map(str::to_owned),
                codex_home: initialized["codexHome"]
                    .as_str()
                    .filter(|home| !home.is_empty())
                    .map(str::to_owned),
                model_endpoint_id: request.model_endpoint_id.clone(),
                runtime_identity: codex_source_runtime_identity(
                    request.env_overrides.as_ref(),
                    request.activation.codex_config.as_ref(),
                ),
                started_at: self.timestamp()?,
                confirmed_settings,
                provider_owns_effort: requested.effort.is_none(),
                settings_timeout: self.0.settings_timeout,
                admitted_tier,
            },
        ));
        let previous = self.0.sources.borrow_mut().activate(source.clone());
        for retired in previous {
            self.cleanup_retired(&retired);
            let runtime = self.clone();
            let client = retired.client.clone();
            tokio::task::spawn_local(async move { runtime.shutdown_client(&client).await });
        }
        Ok(source)
    }

    fn new_client(
        &self,
        env: Option<&IndexMap<String, String>>,
        config: Option<&CodexProviderConfig>,
    ) -> ExecutorResult<(CodexAppServerClient, CodexClientEvents)> {
        if self.0.closed.get() {
            return Err("Codex app-server runtime is shut down".into());
        }
        let client = (self.0.create_client)(build_codex_env(env, config), config);
        self.0
            .clients
            .borrow_mut()
            .insert(client.identity(), client.clone());
        let runtime = Rc::downgrade(&self.0);
        let on_exit_runtime = runtime.clone();
        let events = CodexClientEvents::buffer(
            &client,
            self.0.logger.clone(),
            move |client, event| {
                if let Some(runtime) = runtime.upgrade() {
                    Self(runtime).dispatch(client, event)?;
                }
                Ok(())
            },
            move |client, code| {
                if let Some(runtime) = on_exit_runtime.upgrade() {
                    Self(runtime).client_exited(client, code);
                }
                Ok(())
            },
        );
        Ok((client, events))
    }

    fn dispatch(
        &self,
        client: &CodexAppServerClient,
        event: BufferedClientEvent,
    ) -> ExecutorResult<()> {
        match event {
            BufferedClientEvent::ServerRequest(request) => {
                self.0
                    .approvals
                    .request(client, &request, |thread_id, turn_id| {
                        let (source, operation) = self
                            .0
                            .sources
                            .borrow()
                            .source_for_client_turn(client, thread_id, turn_id)?;
                        Some(CodexApprovalRoute {
                            operation,
                            permission_mode: source.settings.permission_mode(),
                            active: self.is_current(&source)
                                && is_active_session_status(source.status.get())
                                && source.routes.borrow().active_turn_id() == Some(turn_id),
                        })
                    })
            }
            BufferedClientEvent::Notification(note) => self.notify(client, &note),
        }
    }

    fn notify(
        &self,
        client: &CodexAppServerClient,
        note: &JsonRpcNotification,
    ) -> ExecutorResult<()> {
        let params = note.params.as_deref().unwrap_or(&Value::Null);
        if note.method == "serverRequest/resolved" {
            return self.0.approvals.resolved(client, params);
        }
        if note.method == "thread/settings/updated" {
            let source = params["threadId"].as_str().and_then(|thread_id| {
                self.0
                    .sources
                    .borrow()
                    .source_for_client_thread(client, thread_id)
            });
            if let Some(source) = source {
                let settings: CodexThreadSettings =
                    serde_json::from_value(params["threadSettings"].clone())?;
                source.settings.handle_updated(&settings);
            }
            return Ok(());
        }
        if note.method == "turn/started"
            && let (Some(thread_id), Some(turn_id)) =
                (params["threadId"].as_str(), params["turn"]["id"].as_str())
        {
            let source = self
                .0
                .sources
                .borrow()
                .session_for_client_thread(client, thread_id);
            if let Some(source) = source {
                let new_turn = source.routes.borrow().operation_for_turn(turn_id).is_none();
                if new_turn && source.settings.is_fenced() {
                    let client = client.clone();
                    let runtime = self.clone();
                    let params = json!({"threadId":thread_id,"turnId":turn_id});
                    tokio::task::spawn_local(async move {
                        if let Err(error) =
                            client.request("turn/interrupt", Some(&params), None).await
                        {
                            runtime
                                .log_error("Codex fenced-turn interruption failed", error.as_ref());
                        }
                    });
                    let operation = source.routes.borrow().last_or_source_operation();
                    self.finish_session(
                        &source,
                        FinishSessionOptions {
                            failed_message: Some(
                                "Codex automatic turn blocked after an ambiguous settings update"
                                    .into(),
                            ),
                            ..Default::default()
                        },
                        Some(&operation),
                    );
                    return Ok(());
                }
            }
        }
        if note.method == "error" {
            let route = params["threadId"]
                .as_str()
                .zip(params["turnId"].as_str())
                .and_then(|(thread_id, turn_id)| {
                    self.0
                        .sources
                        .borrow()
                        .source_for_client_turn(client, thread_id, turn_id)
                });
            if let Some((source, operation)) = route {
                let turn_id = params["turnId"].as_str().unwrap_or_default();
                let raw = &params["error"];
                let message = raw["message"]
                    .as_str()
                    .filter(|message| !message.is_empty())
                    .or_else(|| {
                        raw["additionalDetails"]
                            .as_str()
                            .filter(|message| !message.is_empty())
                    })
                    .unwrap_or("Codex app-server error");
                publish_rows(
                    self.0.logger.as_ref(),
                    &source.chat_id,
                    vec![NativeSourced::new(ChatMessage::Error(ErrorMessage {
                        timestamp: self.timestamp()?,
                        content: message.into(),
                    }))],
                    Some(&operation),
                );
                if params["willRetry"].as_bool() != Some(true) {
                    if self.is_current(&source)
                        && source.routes.borrow().active_turn_id() == Some(turn_id)
                    {
                        if is_capacity_error(Some(raw)) {
                            source
                                .pending_capacity_failure
                                .replace(Some((turn_id.into(), message.into())));
                            return Ok(());
                        }
                        self.finish_session(
                            &source,
                            FinishSessionOptions {
                                failed_message: Some(message.into()),
                                ..Default::default()
                            },
                            Some(&operation),
                        );
                    } else {
                        self.publish_terminal(
                            &source,
                            Some(&operation),
                            Some(message.into()),
                            None,
                        );
                    }
                }
            }
            return Ok(());
        }
        if let Some(completion) = dispatch_turn_notification(
            &self.0.sources,
            self.0.logger.as_ref(),
            client,
            &self.timestamp()?,
            note,
        ) {
            self.complete_turn(completion);
        }
        Ok(())
    }

    fn complete_turn(&self, completion: CodexObservedTurnCompletion) {
        let source = &completion.source;
        let operation = Some(&completion.operation);
        let failure = detached_turn_failure(&completion.turn).map(str::to_owned);
        if !completion.is_active {
            self.publish_terminal(
                source,
                operation.map(Rc::as_ref),
                failure,
                completion.final_response,
            );
            return;
        }
        source.turn_attempt.set(source.turn_attempt.get() + 1);
        let capacity =
            source
                .pending_capacity_failure
                .borrow_mut()
                .take()
                .filter(|(turn_id, _)| {
                    completion.turn.status == Some(CodexTurnStatus::Failed)
                        && *turn_id == completion.turn.id
                });
        if let Some(message) = failure {
            if completion.turn.status == Some(CodexTurnStatus::Failed)
                && (capacity.is_some() || is_capacity_error(completion.turn.error.as_deref()))
            {
                let message = capacity
                    .as_ref()
                    .map_or(message.as_str(), |(_, message)| message);
                if self.schedule_capacity_retry(
                    source.clone(),
                    completion.operation.clone(),
                    message,
                ) {
                    return;
                }
            }
            let message = capacity.map_or(message, |(_, message)| message);
            self.finish_session(
                source,
                FinishSessionOptions {
                    failed_message: Some(message),
                    ..Default::default()
                },
                operation,
            );
            return;
        }
        source.capacity_retry_count.set(0);
        let aborted = completion.turn.status == Some(CodexTurnStatus::Interrupted)
            || source.status.get() == RunningStatus::Interrupting;
        source.status.set(RunningStatus::Completing);
        source.routes.borrow_mut().finish_active_turn();
        self.0.utility.clear_thread_list_caches();
        self.finish_session_with_response(
            source,
            FinishSessionOptions {
                aborted,
                emit_finished_on_abort: aborted,
                failed_message: None,
            },
            operation,
            if aborted {
                None
            } else {
                completion.final_response
            },
        );
    }

    fn finish_session(
        &self,
        source: &CodexSessionSource,
        options: FinishSessionOptions,
        operation: Option<&Rc<CodexOperation>>,
    ) {
        self.finish_session_with_response(source, options, operation, None);
    }

    fn finish_session_with_response(
        &self,
        source: &CodexSessionSource,
        options: FinishSessionOptions,
        operation: Option<&Rc<CodexOperation>>,
        response: Option<AgentFinalResponse>,
    ) {
        if !self.is_current(source) {
            return;
        }
        if source.deliveries.get() > 0 {
            let mut pending = source.pending_finish.borrow_mut();
            let previous = pending.take();
            let operation = operation.cloned().or_else(|| {
                previous
                    .as_ref()
                    .and_then(|current| current.operation.clone())
            });
            let options = merge_finish_options(
                previous.as_ref().map(|current| current.options.clone()),
                options,
            );
            let response = if options.aborted || options.failed_message.is_some() {
                None
            } else {
                response.or_else(|| previous.and_then(|current| current.response))
            };
            *pending = Some(PendingFinish {
                options,
                operation,
                response,
            });
            return;
        }
        self.0.sources.borrow_mut().finish(source);
        source.idle_since.set(Some(self.0.clock.now_ms()));
        source.status.set(if options.failed_message.is_some() {
            RunningStatus::Failed
        } else if options.aborted {
            RunningStatus::Aborted
        } else {
            RunningStatus::Completed
        });
        self.0.utility.clear_thread_list_caches();
        source.interrupt.clear();
        source.routes.borrow_mut().finish_active_turn();
        self.cancel_approvals(
            source,
            if options.aborted {
                "aborted"
            } else {
                "session-complete"
            },
            true,
        );
        self.clean_attachments(source);
        if options.failed_message.is_some() || !options.aborted || options.emit_finished_on_abort {
            self.publish_terminal(
                source,
                operation.map(Rc::as_ref),
                options.failed_message,
                response,
            );
        }
        source.terminal.notify_waiters();
    }

    fn flush_pending_finish(&self, source: &CodexSessionSource) {
        if source.deliveries.get() != 0 {
            return;
        }
        let pending = source.pending_finish.borrow_mut().take();
        if let Some(pending) = pending {
            self.finish_session_with_response(
                source,
                pending.options,
                pending.operation.as_ref(),
                pending.response,
            );
        }
    }

    fn publish_terminal(
        &self,
        source: &CodexSessionSource,
        operation: Option<&CodexOperation>,
        failure: Option<String>,
        response: Option<AgentFinalResponse>,
    ) {
        if operation.is_some_and(|operation| !operation.mark_terminal()) {
            return;
        }
        if let Some(message) = failure {
            publish_failed(self.0.logger.as_ref(), &source.chat_id, message, operation);
        } else {
            publish_finished(self.0.logger.as_ref(), &source.chat_id, operation, response);
        }
    }

    fn client_exited(&self, client: &CodexAppServerClient, code: i32) {
        let source = self.0.sources.borrow().for_client(client);
        if let Some(source) = source {
            if is_active_session_status(source.status.get()) {
                let operation = source.routes.borrow().source_operation();
                self.finish_session(
                    &source,
                    FinishSessionOptions {
                        failed_message: Some(format!("Codex app-server exited with code {code}")),
                        ..Default::default()
                    },
                    Some(&operation),
                );
            }
            self.retire_source(&source);
        }
        self.0.clients.borrow_mut().shift_remove(&client.identity());
    }

    fn retire_source(&self, source: &CodexSessionSource) {
        let retired = self.0.sources.borrow_mut().retire(&source.client);
        if let Some(retired) = retired {
            self.cleanup_retired(&retired);
        } else {
            self.clean_attachments(source);
        }
    }

    fn cleanup_retired(&self, source: &CodexSessionSource) {
        self.cancel_approvals(source, "cancelled", false);
        self.clean_attachments(source);
    }

    fn clean_attachments(&self, source: &CodexSessionSource) {
        if let Some(cleanup) = source.cleanup_attachments.borrow_mut().take() {
            tokio::task::spawn_local(cleanup);
        }
    }

    fn cancel_approvals(&self, source: &CodexSessionSource, reason: &str, deny: bool) {
        let result = self.0.approvals.cancel(&source.client, reason, |approval| {
            if deny {
                let pending = &approval.pending;
                let denial =
                    denial_response_for_request(&pending.method, Some(pending.params.as_value()));
                if let Err(error) = source.client.respond(&pending.request_id, &denial) {
                    self.log_error("Codex terminal approval denial failed", error.as_ref());
                }
            }
            Ok(())
        });
        if let Err(error) = result {
            self.log_error("Codex approval cancellation failed", error.as_ref());
        }
    }

    pub async fn abort(&self, thread_id: &str) -> bool {
        let source = self.0.sources.borrow().active(thread_id);
        let Some(source) = source else { return false };
        let active = source.routes.borrow().active_turn_id().map(str::to_owned);
        let Some(turn_id) = active else {
            source.status.set(RunningStatus::Aborted);
            self.finish_session(
                &source,
                FinishSessionOptions {
                    aborted: true,
                    ..Default::default()
                },
                None,
            );
            return true;
        };
        if source.status.get() == RunningStatus::Interrupting {
            return match source.interrupt.current() {
                Some(current) => current.await,
                None => true,
            };
        }
        source.status.set(RunningStatus::Interrupting);
        let runtime = self.clone();
        let occupied = Rc::downgrade(&source);
        source
            .interrupt
            .begin(
                source.client.clone(),
                source.thread_id.clone(),
                turn_id,
                self.0.logger.clone(),
                move || {
                    if let Some(source) = occupied.upgrade()
                        && runtime.is_current(&source)
                        && source.status.get() == RunningStatus::Interrupting
                    {
                        source.status.set(RunningStatus::Running);
                    }
                },
            )
            .await
    }

    pub fn capture_steer_target(&self, thread_id: &str) -> Option<RuntimeSteerTarget> {
        let source = self.steerable_source(thread_id)?;
        let turn_id = source.routes.borrow().active_turn_id()?.to_owned();
        Some(Rc::new(CapturedSteerTarget {
            source: Rc::downgrade(&source),
            turn_id,
            used: Cell::new(false),
        }))
    }

    pub async fn steer(&self, request: RuntimeSteerRequest) -> ExecutorResult<AgentSteerResult> {
        use AgentSteerRejectionReason as Reason;
        let no_active_turn = || rejected_codex_steer(Reason::NoActiveTurn, "No active Codex turn");
        let Some(source) = self.steerable_source(&request.agent_session_id) else {
            return Ok(no_active_turn());
        };
        let Some(target) = request
            .target
            .as_deref()
            .and_then(|target| target.downcast_ref::<CapturedSteerTarget>())
        else {
            return Ok(no_active_turn());
        };
        if target.used.replace(true) {
            return Ok(no_active_turn());
        }
        if !target
            .source
            .upgrade()
            .is_some_and(|captured| Rc::ptr_eq(&captured, &source))
            || source.routes.borrow().active_turn_id() != Some(target.turn_id.as_str())
        {
            return Ok(rejected_codex_steer(
                Reason::TurnChanged,
                "The active Codex turn changed",
            ));
        }
        let turn_id = target.turn_id.clone();
        source.deliveries.set(source.deliveries.get() + 1);
        let runtime = self.clone();
        let task = tokio::task::spawn_local(async move {
            let result =
                steer_codex_session(&source.client, &source.thread_id, &turn_id, request).await;
            source.deliveries.set(source.deliveries.get() - 1);
            runtime.flush_pending_finish(&source);
            result
        });
        task.await?
    }

    fn steerable_source(&self, thread_id: &str) -> Option<Rc<CodexSessionSource>> {
        self.0.sources.borrow().active(thread_id).filter(|source| {
            !is_terminal_session_status(source.status.get())
                && !has_terminal_pending_finish(
                    source
                        .pending_finish
                        .borrow()
                        .as_ref()
                        .map(|pending| &pending.options),
                )
        })
    }

    pub fn running_sessions(&self) -> Vec<AgentRunningSession> {
        self.0
            .sources
            .borrow()
            .active_sources()
            .filter_map(|session| {
                let status = match session.status.get() {
                    RunningStatus::Running => "running",
                    RunningStatus::Interrupting => "interrupting",
                    RunningStatus::Completing => "completing",
                    _ => return None,
                };
                Some(AgentRunningSession {
                    agent_session_id: session.thread_id.clone(),
                    status: Some(status.into()),
                    started_at: Some(session.started_at.borrow().clone()),
                })
            })
            .collect()
    }

    pub async fn update_session_settings(
        &self,
        thread_id: &str,
        update: &CodexThreadConfiguration,
    ) -> ExecutorResult<()> {
        let source = {
            let sources = self.0.sources.borrow();
            sources.active(thread_id).or_else(|| {
                sources
                    .all_sources()
                    .find(|source| source.thread_id == thread_id)
                    .cloned()
            })
        };
        if let Some(source) = source {
            source.settings.update(update).await?;
        }
        Ok(())
    }

    pub async fn resolve_native_path(
        &self,
        thread_id: Option<&str>,
    ) -> ExecutorResult<Option<String>> {
        self.0.utility.resolve_native_path(thread_id).await
    }

    pub fn request_native_path_discovery_refresh(&self, thread_id: &str) {
        self.0
            .utility
            .request_native_path_discovery_refresh(thread_id);
    }

    pub fn is_running(&self, thread_id: &str) -> bool {
        self.0
            .sources
            .borrow()
            .active(thread_id)
            .is_some_and(|source| is_active_session_status(source.status.get()))
    }

    pub fn source_endpoint_id(&self, thread_id: &str) -> Option<Option<String>> {
        let sources = self.0.sources.borrow();
        sources
            .active(thread_id)
            .or_else(|| {
                sources
                    .all_sources()
                    .find(|source| source.thread_id == thread_id)
                    .cloned()
            })
            .map(|source| source.model_endpoint_id.clone())
    }

    pub async fn release_session(&self, chat_id: &str, thread_id: Option<&str>) {
        let sources = self.0.sources.borrow().for_release(chat_id, thread_id);
        for source in &sources {
            self.retire_source(source);
        }
        join_all(
            sources
                .iter()
                .map(|source| self.shutdown_client(&source.client)),
        )
        .await;
    }

    pub fn start_purge_timer(&self) {
        if self.0.closed.get() {
            return;
        }
        let runtime = Rc::downgrade(&self.0);
        self.0
            .idle_purger
            .start(self.0.retained_source_purge_interval_ms, move || {
                if let Some(runtime) = runtime.upgrade() {
                    Self(runtime).purge_idle_sources();
                }
            });
    }

    fn purge_idle_sources(&self) {
        let sources: Vec<_> = self
            .0
            .sources
            .borrow()
            .all_sources()
            .filter_map(|source| source.idle_since.get().map(|idle| (idle, source.clone())))
            .collect();
        purge_idle_sessions(
            sources,
            |source| {
                self.is_current(source)
                    || is_active_session_status(source.status.get())
                    || source.interrupt.current().is_some()
                    || source.deliveries.get() > 0
                    || source.settings.has_pending_configuration()
            },
            |source| source.idle_since.get().unwrap_or(i64::MAX),
            |_, source| {
                self.retire_source(&source);
                let runtime = self.clone();
                tokio::task::spawn_local(async move {
                    runtime.shutdown_client(&source.client).await;
                });
            },
            self.0.clock.now_ms(),
            self.0.retained_source_idle_ms,
        );
    }

    pub async fn shutdown(&self) {
        self.0.closed.set(true);
        self.0.idle_purger.stop();
        let sources: Vec<_> = self.0.sources.borrow().all_sources().cloned().collect();
        for source in &sources {
            self.retire_source(source);
        }
        let clients: Vec<_> = self.0.clients.borrow().values().cloned().collect();
        join_all(clients.iter().map(|client| self.shutdown_client(client))).await;
        self.0.skills.clear().await;
        self.0.utility.shutdown().await;
    }

    async fn shutdown_client(&self, client: &CodexAppServerClient) {
        if let Err(error) = client.shutdown().await {
            self.log_error("Codex app-server shutdown failed", error.as_ref());
        }
        self.0.clients.borrow_mut().shift_remove(&client.identity());
    }

    fn is_current(&self, source: &CodexSessionSource) -> bool {
        self.0
            .sources
            .borrow()
            .active(&source.thread_id)
            .is_some_and(|current| std::ptr::eq(current.as_ref(), source))
    }

    fn timestamp(&self) -> ExecutorResult<String> {
        Ok(to_iso_string(self.0.clock.now_ms())?)
    }

    fn log_error(&self, message: &str, error: &dyn std::error::Error) {
        self.0.logger.warn(
            message,
            Some(&IndexMap::from([(
                "error".into(),
                Opaque::from_value(json!(error.to_string())),
            )])),
        );
    }
}

fn initial_thread_settings(
    requested: &CodexThreadSettingsTarget,
    response: &Value,
) -> ExecutorResult<CodexConfirmedThreadSettings> {
    let thread = &response["thread"];
    let model = response["model"]
        .as_str()
        .filter(|value| !value.is_empty())
        .or_else(|| thread["model"].as_str().filter(|value| !value.is_empty()))
        .unwrap_or(&requested.model)
        .to_owned();
    let effort = match response
        .get("reasoningEffort")
        .or_else(|| thread.get("reasoningEffort"))
    {
        Some(effort) => effort.as_str().map(str::to_owned),
        None => requested.effort.clone(),
    };
    let service_tier = response["serviceTier"].as_str();
    if let (Some(approval_policy), Some(approvals_reviewer), Some(sandbox)) = (
        response.get("approvalPolicy"),
        response["approvalsReviewer"].as_str(),
        response.get("sandbox"),
    ) {
        return Ok(thread_settings_target_from_snapshot(
            &CodexThreadSettings {
                model,
                service_tier: service_tier.map(str::to_owned),
                effort,
                approval_policy: approval_policy.clone(),
                approvals_reviewer: approvals_reviewer.into(),
                sandbox_policy: serde_json::from_value(sandbox.clone())?,
            },
            requested.permission_mode,
        ));
    }
    Ok(CodexConfirmedThreadSettings {
        model,
        service_tier: normalize_codex_service_tier(service_tier).into(),
        effort,
        approval_policy: json!(requested.approval_policy),
        approvals_reviewer: requested.approvals_reviewer.clone(),
        sandbox_policy: requested.sandbox_policy.clone(),
        permission_mode: requested.permission_mode,
    })
}
