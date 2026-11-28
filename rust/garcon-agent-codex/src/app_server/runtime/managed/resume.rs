use std::rc::Rc;

use garcon_agents_common::shared::shared_probe::wait_unless_aborted;
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code};
use serde_json::json;

use crate::{
    app_server::{
        request_builders::{build_thread_resume_params, codex_source_runtime_identity},
        runtime_support::{
            has_terminal_pending_finish, is_active_session_status, is_terminal_session_status,
        },
    },
    native_path::resolve_codex_native_path,
    runtime_types::CodexResumeRequest,
    service_tier::{CodexServiceTier, codex_service_tier},
};

use super::{
    CodexAppServerClient, CodexAppServerRuntime, CodexClientEvents, CodexExecutionRequest,
    CodexSessionSource, ExecutorResult, FinishSessionOptions, RunningStatus,
    humanize_codex_app_server_error, publish_failed,
};

type OpeningClient = (CodexAppServerClient, CodexClientEvents);

impl CodexAppServerRuntime {
    pub async fn run_turn(&self, request: CodexResumeRequest) -> ExecutorResult<()> {
        self.resume_admitted(request, ResumeAction::Turn).await
    }

    pub async fn compact(&self, request: CodexResumeRequest) -> ExecutorResult<()> {
        request.execution.assert_open()?;
        if self
            .0
            .sources
            .borrow()
            .active(&request.agent_session_id)
            .is_some()
        {
            return Err("Cannot compact while a Codex turn is active".into());
        }
        self.resume_admitted(request, ResumeAction::Compaction)
            .await
    }

    async fn resume_admitted(
        &self,
        request: CodexResumeRequest,
        action: ResumeAction,
    ) -> ExecutorResult<()> {
        let runtime = self.clone();
        tokio::task::spawn_local(async move { runtime.resume_and_deliver(request, action).await })
            .await?
    }

    async fn resume_and_deliver(
        &self,
        mut request: CodexResumeRequest,
        action: ResumeAction,
    ) -> ExecutorResult<()> {
        request.execution.assert_open()?;
        let mut opening = None;
        let mut active = None;
        let result = async {
            let source = self.resume_session(&mut request, &mut opening).await?;
            active = Some(source.clone());
            let events = opening.as_ref().map(|(_, events)| events);
            match action {
                ResumeAction::Turn => {
                    self.deliver_resumed_turn(&source, &request.execution, events)
                        .await
                }
                ResumeAction::Compaction => {
                    self.deliver_compaction(&source, &request.execution, events)
                        .await
                }
            }
        }
        .await;
        if let Err(error) = &result {
            let operation = &request.execution.operation;
            let message = humanize_codex_app_server_error(error.as_ref());
            let admission_closed = request.execution.assert_open().is_err();
            if let Some(source) = active {
                if let Some((_, events)) = &opening {
                    events.discard();
                }
                let options = FinishSessionOptions {
                    aborted: admission_closed,
                    failed_message: (!admission_closed).then_some(message),
                    ..Default::default()
                };
                self.finish_session(&source, options, Some(operation));
                if admission_closed && action == ResumeAction::Turn {
                    self.retire_source(&source);
                    self.shutdown_client(&source.client).await;
                }
            } else {
                if !admission_closed {
                    publish_failed(
                        self.0.logger.as_ref(),
                        &operation.chat_id,
                        message,
                        Some(operation),
                    );
                }
                if let Some((client, events)) = opening {
                    events.discard();
                    self.shutdown_client(&client).await;
                }
            }
        }
        result
    }

    async fn deliver_resumed_turn(
        &self,
        source: &CodexSessionSource,
        execution: &CodexExecutionRequest,
        events: Option<&CodexClientEvents>,
    ) -> ExecutorResult<()> {
        source.deliveries.set(source.deliveries.get() + 1);
        let outcome = async {
            if !self.is_current(source) {
                return Err("Codex session ended while resuming the thread".into());
            }
            let _input = source.input_lane.lock().await;
            if let Some(events) = events {
                events.release()?;
            }
            if !self.is_current(source)
                || has_terminal_pending_finish(
                    source
                        .pending_finish
                        .borrow()
                        .as_ref()
                        .map(|pending| &pending.options),
                )
            {
                return Err("Codex session ended before turn delivery".into());
            }
            source
                .settings
                .record_explicit_effort(&execution.thread_configuration());
            execution.mark_started().await?;
            self.start_requested_turn(source, execution).await?;
            if source.routes.borrow().active_turn_id().is_some()
                && !has_terminal_pending_finish(
                    source
                        .pending_finish
                        .borrow()
                        .as_ref()
                        .map(|pending| &pending.options),
                )
            {
                source.pending_finish.borrow_mut().take();
            }
            Ok(())
        }
        .await;
        source.deliveries.set(source.deliveries.get() - 1);
        self.flush_pending_finish(source);
        outcome
    }

    async fn deliver_compaction(
        &self,
        source: &CodexSessionSource,
        execution: &CodexExecutionRequest,
        events: Option<&CodexClientEvents>,
    ) -> ExecutorResult<()> {
        source.items.borrow_mut().mark_manual_compaction();
        if let Some(events) = events {
            events.release()?;
        }
        execution.mark_started().await?;
        source
            .routes
            .borrow_mut()
            .expect_turn(execution.operation.clone());
        source
            .client
            .request(
                "thread/compact/start",
                Some(&json!({ "threadId": source.thread_id })),
                None,
            )
            .await?;
        Ok(())
    }

    async fn resume_session(
        &self,
        request: &mut CodexResumeRequest,
        opening: &mut Option<OpeningClient>,
    ) -> ExecutorResult<Rc<CodexSessionSource>> {
        let thread_id = request.agent_session_id.clone();
        let chat_id = request.execution.operation.chat_id.clone();
        let runtime_identity = codex_source_runtime_identity(
            request.execution.env_overrides.as_ref(),
            request.execution.activation.codex_config.as_ref(),
        );
        let retained = self
            .0
            .sources
            .borrow()
            .latest_for_chat(&chat_id)
            .filter(|source| source.thread_id == thread_id);
        let path_changed = retained.as_ref().is_some_and(|source| {
            source
                .native_path
                .borrow()
                .as_deref()
                .zip(request.native_path.as_deref())
                .is_some_and(|(retained, requested)| retained != requested)
        });
        if path_changed {
            self.resolve_resume_path(request).await?;
        }
        let can_reuse = |source: &CodexSessionSource, request: &CodexResumeRequest| {
            source.runtime_identity == runtime_identity
                && source
                    .native_path
                    .borrow()
                    .as_deref()
                    .zip(request.native_path.as_deref())
                    .is_none_or(|(retained, requested)| retained == requested)
                && can_reuse_settings(source, &request.execution)
        };
        let mut interrupted_writer_ready = false;
        if let Some(source) = &retained
            && self.is_retained(source)
            && is_active_session_status(source.status.get())
        {
            match source.status.get() {
                RunningStatus::Interrupting if can_reuse(source, request) => {
                    let acknowledgement = source.interrupt.current().ok_or_else(|| busy(
                        "Codex thread interruption has not established a replacement-turn barrier",
                    ))?;
                    interrupted_writer_ready =
                        wait_for_admission(&request.execution, acknowledgement).await?;
                    if !interrupted_writer_ready {
                        return Err(busy(
                            "Codex turn interruption failed before the next turn could start",
                        )
                        .into());
                    }
                }
                RunningStatus::Interrupting | RunningStatus::Completing => {
                    self.wait_for_terminal(source, &request.execution).await?;
                }
                _ => return Err(busy("Codex thread already has an active turn").into()),
            }
            request.execution.assert_open()?;
        }

        let writer_ready = |source: &CodexSessionSource| {
            is_terminal_session_status(source.status.get())
                || (source.status.get() == RunningStatus::Interrupting && interrupted_writer_ready)
        };
        let mut path_resolved = false;
        loop {
            if let Some(source) = &retained {
                if source.status.get() == RunningStatus::Interrupting
                    && interrupted_writer_ready
                    && self.is_retained(source)
                    && !can_reuse_settings(source, &request.execution)
                {
                    self.wait_for_terminal(source, &request.execution).await?;
                    request.execution.assert_open()?;
                }
                if source.settings.has_pending_configuration() {
                    source.settings.with_delivery(async {}).await;
                    request.execution.assert_open()?;
                    if !self.is_retained(source) {
                        return Err(busy("Codex session changed while updating settings").into());
                    }
                    if !writer_ready(source) {
                        return Err(
                            busy("Codex thread became active while settling settings").into()
                        );
                    }
                    continue;
                }
                if self.is_retained(source) && writer_ready(source) && can_reuse(source, request) {
                    return self.reactivate(source, request);
                }
            }
            if path_resolved {
                break;
            }
            self.resolve_resume_path(request).await?;
            path_resolved = true;
        }
        if let Some(source) = &retained
            && is_terminal_session_status(source.status.get())
        {
            self.retire_source(source);
            self.shutdown_client(&source.client).await;
        }

        let (client, events) = self.new_client(&request.execution)?;
        *opening = Some((client.clone(), events));
        let initialize = client.connect().await?;
        request.execution.assert_open()?;
        let params = build_thread_resume_params(
            &request.execution.activation,
            &thread_id,
            request.native_path.as_deref(),
        );
        let resumed = client.request("thread/resume", Some(&params), None).await?;
        request.execution.assert_open()?;
        self.activate_session(
            &request.execution,
            client,
            &resumed,
            &initialize,
            request.native_path.as_deref(),
        )
    }

    fn reactivate(
        &self,
        source: &Rc<CodexSessionSource>,
        request: &CodexResumeRequest,
    ) -> ExecutorResult<Rc<CodexSessionSource>> {
        let now = self.timestamp()?;
        let execution = &request.execution;
        self.clean_attachments(source);
        if let Some(path) = &request.native_path {
            source.native_path.replace(Some(path.clone()));
        }
        source.status.set(RunningStatus::Running);
        source.started_at.replace(now);
        source.idle_since.set(None);
        source.pending_finish.borrow_mut().take();
        source.interrupt.clear();
        source.live_raw_results.borrow_mut().clear();
        source.capacity_retry_count.set(0);
        source.pending_capacity_failure.borrow_mut().take();
        source
            .admitted_model
            .replace(execution.activation.model.clone());
        source
            .admitted_tier
            .set(codex_service_tier(execution.activation.speed));
        source.turn_attempt.set(source.turn_attempt.get() + 1);
        source
            .routes
            .borrow_mut()
            .reactivate(execution.operation.clone());
        self.0.sources.borrow_mut().activate(source.clone());
        Ok(source.clone())
    }

    fn is_retained(&self, source: &Rc<CodexSessionSource>) -> bool {
        self.0
            .sources
            .borrow()
            .latest_for_chat(&source.chat_id)
            .is_some_and(|current| Rc::ptr_eq(&current, source))
    }

    async fn wait_for_terminal(
        &self,
        source: &Rc<CodexSessionSource>,
        execution: &CodexExecutionRequest,
    ) -> ExecutorResult<()> {
        if !self.is_retained(source) || is_terminal_session_status(source.status.get()) {
            return execution.assert_open();
        }
        wait_for_admission(execution, source.terminal.notified()).await
    }

    async fn resolve_resume_path(&self, request: &mut CodexResumeRequest) -> ExecutorResult<()> {
        let Some(path) = request
            .native_path
            .as_deref()
            .filter(|path| !path.is_empty())
        else {
            return Ok(());
        };
        let signal = request
            .execution
            .admission
            .as_ref()
            .map(|admission| admission.signal().clone())
            .unwrap_or_default();
        let thread_id = &request.agent_session_id;
        let resolved = resolve_codex_native_path(
            Some(thread_id),
            Some(path),
            || self.resolve_native_path(Some(thread_id)),
            self.0.logger.as_ref(),
            &signal,
        )
        .await?;
        request.execution.assert_open()?;
        let Some(resolved) = resolved else {
            self.0
                .utility
                .request_native_path_discovery_refresh(thread_id);
            return Err(AgentIntegrationError::new(
                Code::TRANSCRIPT_UNAVAILABLE,
                "Codex native transcript could not be resolved",
                true,
                None,
            )
            .into());
        };
        request.native_path = Some(resolved);
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ResumeAction {
    Turn,
    Compaction,
}

fn can_reuse_settings(source: &CodexSessionSource, request: &CodexExecutionRequest) -> bool {
    !source.settings.is_fenced()
        && !source.settings.has_pending_confirmation()
        && codex_service_tier(request.activation.speed) == CodexServiceTier::Default
        && source.admitted_tier.get() == CodexServiceTier::Default
        && source.settings.confirmed().service_tier == "default"
        && (source.settings.provider_owns_effort()
            || crate::app_server::request_builders::codex_thread_settings_target(
                &request.thread_configuration(),
            )
            .effort
            .is_some())
}

fn busy(message: &str) -> AgentIntegrationError {
    AgentIntegrationError::new(Code::SESSION_BUSY, message, true, None)
}

async fn wait_for_admission<T>(
    execution: &CodexExecutionRequest,
    wait: impl Future<Output = T>,
) -> ExecutorResult<T> {
    wait_unless_aborted(
        async { Ok::<_, Box<dyn std::error::Error>>(wait.await) },
        execution
            .admission
            .as_ref()
            .map(|admission| admission.signal()),
    )
    .await
}
