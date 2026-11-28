use garcon_contract::chat_modes::PermissionMode;
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    execution::AgentRunningSession,
};

use super::{
    super::{
        endpoint_coordinator::OpenCodeForkOptions,
        permissions::map_permission_mode,
        runtime_types::OpenCodeSessionSettingsPatch,
        sdk_result::{
            create_open_code_request_scope, is_open_code_not_found_result,
            throw_open_code_result_error,
        },
        turn_events::relocate_open_code_session,
    },
    *,
};

const RETAINED_SESSION_DELETION_LIMIT: usize = 256;

pub(super) fn session_params(id: &str) -> Map<String, Value> {
    Map::from_iter([("sessionID".to_owned(), json!(id))])
}

impl OpenCodeRuntime {
    pub(super) async fn delete_session_best_effort(
        self: &Rc<Self>,
        id: String,
        scope: OpenCodeRequestScope,
        original: Option<(Rc<dyn OpenCodeClient>, Option<u64>)>,
    ) {
        let runtime = self.clone();
        let _ = self
            .endpoint
            .run_protected_native_cleanup(move || async move {
                let current = runtime.get_client_if_initialized();
                let client = match (original, current) {
                    (Some((original, generation)), Some(current))
                        if Rc::ptr_eq(&original, &current)
                            && generation.is_none_or(|generation| {
                                generation == runtime.generation.get()
                            }) =>
                    {
                        Some(original)
                    }
                    (_, current) => current,
                };
                if let Some(client) = client {
                    if runtime
                        .delete_through(
                            "OpenCode cancelled session delete",
                            &id,
                            client.clone(),
                            &scope,
                        )
                        .await
                        .is_err()
                    {
                        runtime.retain_session_deletion(id, scope, Some(client));
                    }
                } else {
                    runtime.retain_session_deletion(id, scope, None);
                }
                Ok(())
            })
            .await;
    }

    async fn delete_through(
        &self,
        label: &'static str,
        id: &str,
        client: Rc<dyn OpenCodeClient>,
        scope: &OpenCodeRequestScope,
    ) -> ExecutorResult<()> {
        let result = self
            .scoped_request(
                label,
                client,
                OpenCodeRequest::SessionDelete,
                session_params(id),
                scope,
                OpenCodeRequestControl::default(),
            )
            .await?;
        if !is_open_code_not_found_result(&result) {
            throw_open_code_result_error(&result, "OpenCode cancelled session delete failed")?;
        }
        Ok(())
    }

    fn retain_session_deletion(
        self: &Rc<Self>,
        id: String,
        scope: OpenCodeRequestScope,
        attempted: Option<Rc<dyn OpenCodeClient>>,
    ) {
        {
            let mut pending = self.pending_session_deletions.borrow_mut();
            pending.shift_remove(&id);
            if pending.len() >= RETAINED_SESSION_DELETION_LIMIT {
                self.logger.warn(
                    "Discarding an OpenCode retained session deletion at capacity",
                    Some(&log_fields([
                        ("sessionId", json!(id)),
                        ("retained", json!(pending.len())),
                    ])),
                );
                return;
            }
            pending.insert(id, scope);
        }
        if attempted
            .zip(self.get_client_if_initialized())
            .is_some_and(|(old, current)| !Rc::ptr_eq(&old, &current))
        {
            self.drain_pending_session_deletions();
        }
    }

    pub(super) fn drain_pending_session_deletions(self: &Rc<Self>) {
        for (id, scope) in self.pending_session_deletions.take() {
            let runtime = self.clone();
            // Protected work is spawned by the coordinator even when its result is unused.
            drop(
                self.endpoint
                    .run_protected_native_cleanup(move || async move {
                        let attempted = RefCell::new(None);
                        let result = runtime
                            .with_client_lease(
                                |client| {
                                    attempted.replace(Some(client.clone()));
                                    runtime.delete_through(
                                        "OpenCode retained session delete",
                                        &id,
                                        client,
                                        &scope,
                                    )
                                },
                                None,
                            )
                            .await;
                        if result.is_err() {
                            runtime.retain_session_deletion(id, scope, attempted.into_inner());
                        }
                        Ok(())
                    }),
            );
        }
    }

    pub fn run_protected_native_fork<T, F>(
        &self,
        operation: impl FnOnce() -> F,
    ) -> LocalBoxFuture<'static, ExecutorResult<T>>
    where
        T: 'static,
        F: Future<Output = ExecutorResult<T>> + 'static,
    {
        self.endpoint.run_protected_native_fork(operation)
    }

    pub async fn fork_session(
        self: &Rc<Self>,
        source_id: &str,
        options: OpenCodeForkOptions,
        permission_mode: Option<PermissionMode>,
    ) -> ExecutorResult<String> {
        if self
            .session(garcon_js::trim(source_id))
            .is_some_and(|session| {
                let session = session.borrow();
                session.status == SessionStatus::Running && session.turn.borrow().compaction
            })
        {
            return Err(AgentIntegrationError::new(
                Code::TRANSCRIPT_UNAVAILABLE,
                "The OpenCode source session is compacting; fork after it settles",
                true,
                Some(Map::from_iter([(
                    "nativeForkReason".to_owned(),
                    json!("not-settled"),
                )])),
            )
            .into());
        }
        let scope = create_open_code_request_scope(options.project_path.as_deref());
        let signal = options.signal.clone();
        let id = self
            .endpoint
            .fork_session(
                source_id,
                options,
                |request| self.run_request(request),
                |client, id, scope| async move {
                    self.delete_session_best_effort(id, scope, Some((client, None)))
                        .await;
                    Ok(())
                },
            )
            .await?;
        if let Some(signal) = signal.as_ref().filter(|signal| signal.aborted()) {
            self.delete_session_best_effort(id.clone(), scope.clone(), None)
                .await;
            signal.throw_if_aborted()?;
        }
        if let Some(mode) = permission_mode {
            let update = self
                .with_client_lease(
                    |client| async {
                        let mut params = session_params(&id);
                        params.insert(
                            "permission".to_owned(),
                            json!(map_permission_mode(mode.as_str())),
                        );
                        let result = self
                            .scoped_request(
                                "OpenCode fork permission update",
                                client,
                                OpenCodeRequest::SessionUpdate,
                                params,
                                &scope,
                                OpenCodeRequestControl {
                                    signal: signal.clone(),
                                    timeout: OpenCodeRequestTimeout::Unbounded,
                                },
                            )
                            .await?;
                        throw_open_code_result_error(
                            &result,
                            "Failed to apply OpenCode fork permission mode",
                        )?;
                        if let Some(signal) = &signal {
                            signal.throw_if_aborted()?;
                        }
                        Ok(())
                    },
                    signal.clone(),
                )
                .await;
            if let Err(failure) = update {
                self.delete_session_best_effort(id, scope, None).await;
                if let Some(signal) = &signal {
                    signal.throw_if_aborted()?;
                }
                return Err(AgentIntegrationError::new(
                    Code::TRANSCRIPT_UNAVAILABLE,
                    failure.to_string(),
                    true,
                    None,
                )
                .into());
            }
        }
        Ok(id)
    }

    pub async fn discard_session(self: &Rc<Self>, id: &str, project_path: Option<&str>) {
        self.delete_session_best_effort(
            id.to_owned(),
            create_open_code_request_scope(project_path),
            None,
        )
        .await;
    }

    pub async fn move_session(
        self: &Rc<Self>,
        id: &str,
        directory: &str,
        signal: AbortSignal,
    ) -> ExecutorResult<()> {
        self.endpoint
            .move_session(id, directory, signal, |request| self.run_request(request))
            .await?;
        if let Some(session) = self.session(garcon_js::trim(id)) {
            relocate_open_code_session(&session, garcon_js::trim(directory), self.now());
        }
        Ok(())
    }

    pub async fn release_session(
        self: &Rc<Self>,
        chat_id: &str,
        id: Option<&str>,
    ) -> ExecutorResult<()> {
        let Some(id) = id.filter(|id| !id.is_empty()) else {
            return Ok(());
        };
        let Some(session) = self
            .session(id)
            .filter(|session| session.borrow().chat_id == chat_id)
        else {
            return Ok(());
        };
        let id = id.to_owned();
        let chat_id = chat_id.to_owned();
        let runtime = self.clone();
        self.endpoint
            .run_protected_native_cleanup(move || async move {
                let pending = runtime
                    .pending_session_aborts
                    .borrow()
                    .get(&session)
                    .cloned();
                if let Some(pending) = pending {
                    pending.await;
                }
                if !runtime.is_current_session(&id, &session) {
                    return Ok(());
                }
                let instance = runtime.instance.borrow().clone();
                if let Some(instance) = instance {
                    let scope = {
                        let mut data = session.borrow_mut();
                        if data.status == SessionStatus::Running {
                            data.provider_work_requires_quiescence = true;
                        }
                        OpenCodeRequestScope {
                            directory: data.directory.clone(),
                        }
                    };
                    runtime
                        .quiesce_retired_provider_work(&instance, &id, &session, &scope)
                        .await?;
                }
                if !runtime.is_current_session(&id, &session) {
                    return Ok(());
                }
                runtime.routes.retire_session(&chat_id, &id);
                runtime.decisions.cancel_for_session(&id, "cancelled");
                runtime.settle_waiter(&id, Err(shared_error("Error", "OpenCode session released")));
                runtime.sessions.borrow_mut().shift_remove(&id);
                Ok(())
            })
            .await
    }

    pub fn abort(self: &Rc<Self>, id: &str) -> LocalBoxFuture<'static, bool> {
        let Some(session) = self
            .session(id)
            .filter(|session| session.borrow().status == SessionStatus::Running)
        else {
            return async { false }.boxed_local();
        };
        if let Some(pending) = self.pending_session_aborts.borrow().get(&session).cloned() {
            return pending.boxed_local();
        }
        let turn = session.borrow().turn.clone();
        self.steering.stage_pending_cleanup(&session);
        {
            let mut session = session.borrow_mut();
            session.provider_work_requires_quiescence = true;
            session.aborting = Some(true);
        }
        let (send, receive) = oneshot::channel();
        let pending = async move { receive.await.unwrap_or(false) }
            .boxed_local()
            .shared();
        self.pending_session_aborts
            .borrow_mut()
            .insert(session.clone(), pending.clone());
        let runtime = self.clone();
        let id = id.to_owned();
        spawn_local(async move {
            let result = runtime.abort_running_session(&id, &session, &turn).await;
            runtime
                .pending_session_aborts
                .borrow_mut()
                .shift_remove(&session);
            let _ = send.send(result);
        });
        pending.boxed_local()
    }

    async fn abort_running_session(
        self: &Rc<Self>,
        id: &str,
        session: &OpenCodeSession,
        turn: &super::super::turn_events::OpenCodeTurnContext,
    ) -> bool {
        let runtime = self;
        let result: ExecutorResult<()> = async {
            let client = runtime.get_client().await?;
            let scope = OpenCodeRequestScope {
                directory: session.borrow().directory.clone(),
            };
            let result = runtime
                .scoped_request(
                    "OpenCode session abort",
                    client.clone(),
                    OpenCodeRequest::SessionAbort,
                    session_params(id),
                    &scope,
                    OpenCodeRequestControl::default(),
                )
                .await?;
            throw_open_code_result_error(&result, "OpenCode session abort failed")?;
            runtime
                .await_event_barrier(client, scope.directory, None)
                .await
        }
        .await;
        session.borrow_mut().aborting = Some(false);
        if let Err(failure) = result {
            runtime.logger.warn(
                "OpenCode session abort failed",
                Some(&log_fields([
                    ("agentSessionId", json!(id)),
                    ("error", json!(failure.to_string())),
                ])),
            );
            runtime.release_deferred_terminal(id, session);
            return false;
        }
        {
            let mut data = session.borrow_mut();
            data.provider_work_requires_quiescence = false;
            if !runtime.is_current_session(id, session)
                || data.status != SessionStatus::Running
                || data.turn != *turn
            {
                return false;
            }
            data.status = SessionStatus::Aborted;
            data.deferred_terminal = None;
            data.last_activity_at = runtime.now();
        }
        runtime.routes.retire_turn(turn);
        runtime.decisions.cancel_for_session(id, "aborted");
        let operation = turn.borrow().operation.clone();
        runtime.publish_finished(id, &operation, None);
        runtime.settle_waiter(id, Err(shared_error("Error", "OpenCode session aborted")));
        true
    }

    pub(super) async fn quiesce_session_before_turn(
        self: &Rc<Self>,
        id: &str,
        session: &OpenCodeSession,
    ) {
        let pending = self.pending_session_aborts.borrow().get(session).cloned();
        let running = session.borrow().status == SessionStatus::Running;
        if let Some(pending) = pending {
            pending.await;
        } else if running {
            self.abort(id).await;
        }
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.session(id)
            .is_some_and(|session| session.borrow().status == SessionStatus::Running)
    }

    pub fn update_session_settings(&self, id: &str, patch: OpenCodeSessionSettingsPatch) {
        if let Some(session) = self.session(id)
            && let Some(mode) = patch.permission_mode
        {
            session.borrow_mut().permission_mode = mode;
        }
    }

    pub fn running_sessions(&self) -> Vec<AgentRunningSession> {
        self.sessions
            .borrow()
            .iter()
            .filter_map(|(id, session)| {
                let session = session.borrow();
                (session.status == SessionStatus::Running).then(|| AgentRunningSession {
                    agent_session_id: id.clone(),
                    status: Some("running".to_owned()),
                    started_at: Some(session.started_at.clone()),
                })
            })
            .collect()
    }
}
