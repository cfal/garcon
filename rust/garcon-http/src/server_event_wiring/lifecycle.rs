use std::{
    cell::{OnceCell, RefCell},
    collections::{HashMap, HashSet},
    rc::Rc,
};

use futures::FutureExt;
use garcon_base::{
    domain_error::DomainErrorKind,
    log::{Logger, create_logger},
};
use garcon_chats::chat_activity_outcomes::ActivityOutcomeAttempt;
use garcon_contract::{
    chat_stop::{ChatStopIntent, ChatStopOutcome},
    error_codes::{ErrorCode, is_error_code},
    executors::effective_executor_id,
    ws_events::{
        AgentRunFailedMessage, AgentRunFinishedMessage, AgentRunFinishedOutcome,
        ChatOperationalNoticeDetail, ChatOperationalNoticeMessage, ChatOperationalNoticeType,
        ChatProcessingUpdatedMessage, ChatSessionCreatedMessage, ChatSessionStoppedMessage,
    },
};
use garcon_execution::{
    agent_registry::AgentRegistry,
    chat_execution_coordinator::ChatExecutionCoordinator,
    command_ledger::{
        CommandLedger, CommandLedgerChange, CommandLedgerDetail, CommandTerminalStatus,
        InterruptionReason, command_ledger_key,
    },
    control_state::to_client_chat_execution_control_state,
    event_bus::{AgentRunCompletionOutcome, TurnEventMetadata},
    listener_dispatch::ListenerWork,
    turn_finalization_tracker::QueuedTurnFinalizationOutcome,
    turn_identity::{TurnCommandType, TurnIdentity},
    turn_terminal_settlement::{AgentTurnSettlementOutcome, WorkingDirectorySettlement},
};
use garcon_js::{Clock, Number, to_iso_string};

use super::task_queue::Completion;
use super::{
    ChatExecutionControlUpdatedMessage, ChatId, ExecutorResult, ServerEventWiring, ServerWsMessage,
    Value, parse_chat_id,
};

const TURN_FAILURE_DEDUPE_MS: i64 = 30_000;

#[derive(Default)]
pub(super) struct LifecycleState {
    commands: OnceCell<Rc<CommandLedger>>,
    recent_turn_failures: RefCell<HashMap<String, i64>>,
    inline_terminal_releases: RefCell<HashSet<ChatId>>,
}

enum Terminal {
    Finished(i32, AgentRunCompletionOutcome),
    Failed { message: String, code: String },
}

impl ServerEventWiring {
    pub fn wire_execution(
        self: &Rc<Self>,
        coordinator: &Rc<ChatExecutionCoordinator>,
        agents: &Rc<AgentRegistry>,
        commands: Rc<CommandLedger>,
        clock: Rc<dyn Clock>,
        mark_search_catalog_dirty: Rc<dyn Fn(&str)>,
    ) -> ExecutorResult<()> {
        self.lifecycle
            .commands
            .set(commands)
            .map_err(|_| "Execution events are already wired")?;
        let wiring = Rc::downgrade(self);
        coordinator.on_execution_control_updated(move |chat, state| {
            if let Some(wiring) = wiring.upgrade() {
                (wiring.deps.publish_execution_control)(ChatExecutionControlUpdatedMessage::new(
                    chat.into(),
                    Box::new(to_client_chat_execution_control_state(state)),
                ))?;
            }
            Ok(())
        });
        let wiring = Rc::downgrade(self);
        coordinator.on_processing_invalidated(move |chat| {
            if let Some(wiring) = wiring.upgrade() {
                let id = chat_id(chat)?;
                if !wiring
                    .lifecycle
                    .inline_terminal_releases
                    .borrow()
                    .contains(&id)
                {
                    wiring.schedule_processing(&id);
                }
            }
            Ok(())
        });
        let wiring = Rc::downgrade(self);
        coordinator.on_turn_started(move |chat, run| {
            if let Some(wiring) = wiring.upgrade() {
                wiring.deps.metadata.begin_run_attempt(&chat_id(chat)?, run);
            }
            Ok(())
        });
        let wiring = Rc::downgrade(self);
        coordinator.on_input_accepted(move |chat, run| {
            if let Some(wiring) = wiring.upgrade() {
                let id = chat_id(chat)?;
                wiring.deps.metadata.clear_run_outcome(&id, run);
                drop(wiring.queue.clone().schedule(
                    chat,
                    "accepted input activity publication",
                    async move { wiring.publish_activity(&id) },
                ));
            }
            Ok(())
        });
        let wiring = Rc::downgrade(self);
        coordinator.on_session_stopped(move |chat, outcome, intent, turn| {
            if let Some(wiring) = wiring.upgrade() {
                wiring.session_stopped(chat_id(chat)?, outcome, intent, turn);
            }
            Ok(())
        });
        let wiring = Rc::downgrade(self);
        let failure_clock = clock.clone();
        coordinator.on_turn_failed(move |chat, message, opts| {
            if let Some(wiring) = wiring.upgrade() {
                wiring.queue_failure(
                    chat_id(chat)?,
                    message.into(),
                    TurnEventMetadata {
                        turn_id: opts.turn_id.clone(),
                        client_request_id: opts.client_request_id.clone(),
                        command_type: opts.command_type,
                        ..Default::default()
                    },
                    failure_clock.clone(),
                );
            }
            Ok(())
        });
        let wiring = Rc::downgrade(self);
        let notice_clock = clock.clone();
        coordinator.on_project_unavailable(move |chat, error| {
            if let Some(wiring) = wiring.upgrade()
                && let DomainErrorKind::ProjectUnavailable {
                    project_path,
                    reason,
                } = &error.kind
            {
                let id = chat_id(chat)?;
                let message = error.message.clone();
                let detail = ChatOperationalNoticeDetail::ProjectUnavailable {
                    project_path: project_path.clone(),
                    reason: *reason,
                };
                let clock = notice_clock.clone();
                drop(wiring.queue.clone().schedule(
                    chat,
                    "project unavailable notice",
                    async move {
                        wiring.notify_operational_notice(
                            &id,
                            ChatOperationalNoticeType::Warning,
                            message,
                            Some(detail),
                            clock.as_ref(),
                        )
                    },
                ));
            }
            Ok(())
        });
        let wiring = Rc::downgrade(self);
        let registry = Rc::downgrade(agents);
        coordinator.on_turn_settled(move |chat, turn| {
            if let Some(wiring) = wiring.upgrade()
                && !wiring.deps.registry.has_chat(chat)
            {
                wiring.deps.metadata.delete_chat_activity(&chat_id(chat)?);
            }
            if let Some(agents) = registry.upgrade() {
                agents.events().settle_turn(
                    chat,
                    &TurnEventMetadata {
                        turn_id: turn.turn_id.clone(),
                        client_request_id: turn.client_request_id.clone(),
                        ..Default::default()
                    },
                );
            }
            Ok(())
        });

        let agents = agents.events();
        let execution = Rc::downgrade(coordinator);
        agents.on_run_steerable(Rc::new(move |chat| {
            ListenerWork::Synchronous(
                execution
                    .upgrade()
                    .map_or(Ok(()), |execution| execution.retry_queued_steers(chat)),
            )
        }));
        let wiring = Rc::downgrade(self);
        agents.on_session_created(Rc::new(move |chat| {
            let Some(wiring) = wiring
                .upgrade()
                .filter(|wiring| wiring.deps.registry.has_chat(chat))
            else {
                return ListenerWork::Synchronous(Ok(()));
            };
            let id = chat.to_owned();
            let mark_search_catalog_dirty = mark_search_catalog_dirty.clone();
            let task = wiring
                .queue
                .clone()
                .schedule(chat, "session publication", async move {
                    mark_search_catalog_dirty(&id);
                    (wiring.deps.publish)(ServerWsMessage::ChatSessionCreated(
                        ChatSessionCreatedMessage::new(id),
                    ))
                });
            ListenerWork::Pending(
                async move {
                    task.await;
                    Ok(())
                }
                .boxed_local(),
            )
        }));
        let wiring = Rc::downgrade(self);
        let execution = Rc::downgrade(coordinator);
        let finish_clock = clock.clone();
        agents.on_finished(Rc::new(move |chat, exit_code, turn, outcome| {
            let (Some(wiring), Some(execution)) = (wiring.upgrade(), execution.upgrade()) else {
                return ListenerWork::Synchronous(Ok(()));
            };
            wiring.agent_terminal(
                execution,
                chat,
                turn,
                Terminal::Finished(exit_code, outcome),
                finish_clock.clone(),
            )
        }));
        let wiring = Rc::downgrade(self);
        let execution = Rc::downgrade(coordinator);
        agents.on_failed(Rc::new(move |chat, message, code, turn| {
            let (Some(wiring), Some(execution)) = (wiring.upgrade(), execution.upgrade()) else {
                return ListenerWork::Synchronous(Ok(()));
            };
            wiring.agent_terminal(
                execution,
                chat,
                turn,
                Terminal::Failed {
                    message: message.into(),
                    code: code.into(),
                },
                clock.clone(),
            )
        }));
        Ok(())
    }

    pub fn notify_operational_notice(
        &self,
        chat_id: &ChatId,
        notice_type: ChatOperationalNoticeType,
        content: String,
        detail: Option<ChatOperationalNoticeDetail>,
        clock: &dyn Clock,
    ) -> ExecutorResult<()> {
        if !self.deps.registry.has_chat(chat_id) {
            return Ok(());
        }
        (self.deps.publish)(ServerWsMessage::ChatOperationalNotice(
            ChatOperationalNoticeMessage::new(
                chat_id.to_string(),
                notice_type,
                content,
                to_iso_string(clock.now_ms())?,
                detail,
            ),
        ))
    }

    pub fn executor_processing_invalidated(self: &Rc<Self>, executor_id: &str) {
        for chat in self.deps.processing.snapshot() {
            let entry = self.deps.registry.get_chat(&chat.chat_id);
            if effective_executor_id(
                entry
                    .as_ref()
                    .and_then(|entry| entry.executor_id.as_deref()),
            ) == executor_id
                && let Ok(chat_id) = chat_id(&chat.chat_id)
            {
                self.schedule_processing(&chat_id);
            }
        }
    }

    fn schedule_processing(self: &Rc<Self>, chat_id: &ChatId) {
        if !self.deps.registry.has_chat(chat_id) {
            return;
        }
        let phase = self.deps.processing.phase(chat_id);
        let id = chat_id.clone();
        let wiring = self.clone();
        drop(
            self.queue
                .schedule(chat_id, "processing broadcast", async move {
                    if wiring.deps.registry.has_chat(&id) {
                        wiring.publish_processing(&id, phase)?;
                    }
                    Ok(())
                }),
        );
    }

    fn publish_processing(
        &self,
        chat_id: &ChatId,
        phase: Option<super::ChatProcessingPhase>,
    ) -> ExecutorResult<()> {
        (self.deps.publish)(ServerWsMessage::ChatProcessingUpdated(
            ChatProcessingUpdatedMessage::new(chat_id.to_string(), phase),
        ))?;
        self.publish_activity_at(chat_id, phase)
    }

    fn session_stopped(
        self: &Rc<Self>,
        chat_id: ChatId,
        outcome: ChatStopOutcome,
        intent: ChatStopIntent,
        turn: Option<&TurnIdentity>,
    ) {
        create_logger("server").info(&format!(
            "queue: Stop resolved ({chat_id}, {intent:?}, {outcome:?}, {:?})",
            self.deps.processing.phase(&chat_id)
        ));
        let already_idle = outcome == ChatStopOutcome::AlreadyIdle;
        if already_idle {
            self.schedule_processing(&chat_id);
        }
        let turn_id = turn
            .and_then(|turn| turn.turn_id.clone())
            .filter(|id| !id.is_empty());
        let id = chat_id.clone();
        let wiring = self.clone();
        drop(
            self.queue
                .schedule(&chat_id, "session-stopped broadcast", async move {
                    if outcome == ChatStopOutcome::InterruptRequested
                        && let Some(turn_id) = turn_id
                    {
                        let reason = if intent == ChatStopIntent::ChatDeletion {
                            InterruptionReason::ChatDeleted
                        } else {
                            InterruptionReason::UserStop
                        };
                        wiring
                            .command_ledger()?
                            .mark_interrupted_without_run_terminal(&id, &turn_id, reason)
                            .await?;
                    }
                    if wiring.deps.registry.has_chat(&id) {
                        (wiring.deps.publish)(ServerWsMessage::ChatSessionStopped(
                            ChatSessionStoppedMessage::new(id.to_string(), outcome, intent),
                        ))?;
                    }
                    Ok(())
                }),
        );
        if !already_idle {
            self.schedule_processing(&chat_id);
        }
    }

    fn queue_failure(
        self: &Rc<Self>,
        chat_id: ChatId,
        message: String,
        turn: TurnEventMetadata,
        clock: Rc<dyn Clock>,
    ) {
        let failed_attempt = self
            .deps
            .metadata
            .capture_failure_attempt(&chat_id, turn.turn_id.as_deref());
        let wiring = self.clone();
        let id = chat_id.clone();
        drop(
            self.queue
                .schedule(&chat_id, "queued turn failure handling", async move {
                    wiring.publish_processing(&id, wiring.deps.processing.phase(&id))?;
                    wiring
                        .handle_failure(
                            &id,
                            &message,
                            None,
                            Some(&turn),
                            failed_attempt.as_ref(),
                            clock.as_ref(),
                            true,
                        )
                        .await
                }),
        );
    }

    fn agent_terminal(
        self: &Rc<Self>,
        coordinator: Rc<ChatExecutionCoordinator>,
        chat: &str,
        turn: Option<&TurnEventMetadata>,
        terminal: Terminal,
        clock: Rc<dyn Clock>,
    ) -> ListenerWork<'static> {
        if !self.deps.registry.has_chat(chat) {
            return ListenerWork::Synchronous(Ok(()));
        }
        let chat_id = match chat_id(chat) {
            Ok(id) => id,
            Err(error) => return ListenerWork::Synchronous(Err(error.into())),
        };
        let queued_finalization = coordinator
            .get_queued_turn_finalization(chat, turn.and_then(|turn| turn.turn_id.as_deref()));
        let mut failed_attempt = self
            .deps
            .metadata
            .capture_failure_attempt(&chat_id, turn.and_then(|turn| turn.turn_id.as_deref()));
        let turn = turn.cloned();
        let wiring = self.clone();
        let settlement_failure = Rc::new(RefCell::new(None));
        let deferred = settlement_failure.clone();
        let task = self
            .queue
            .schedule(chat, "agent turn terminal", async move {
                let mut released = false;
                let was_finished = matches!(terminal, Terminal::Finished(..));
                let result = async {
                    if !wiring.deps.registry.has_chat(&chat_id)
                        || (match queued_finalization {
                            Some(finalization) => {
                                finalization.wait().await
                                    != QueuedTurnFinalizationOutcome::Committed
                            }
                            None => false,
                        })
                    {
                        return Ok(());
                    }
                    let outcome = match &terminal {
                        Terminal::Finished(..) => AgentTurnSettlementOutcome::Finished,
                        Terminal::Failed { .. } => AgentTurnSettlementOutcome::Failed,
                    };
                    let settlement = wiring
                        .release_ownership(&coordinator, &chat_id, turn.as_ref(), outcome)
                        .await?;
                    released = true;
                    match (terminal, settlement) {
                        (terminal, WorkingDirectorySettlement::Failed { message }) => {
                            let (message, code) = match terminal {
                                Terminal::Finished(..) => (
                                    message,
                                    ErrorCode::PROJECT_PATH_DESTINATION_REJECTED.as_str().into(),
                                ),
                                Terminal::Failed {
                                    message: original,
                                    code,
                                } => (format!("{original}\n{message}"), code),
                            };
                            *deferred.borrow_mut() = Some(wiring.defer_settlement_failure(
                                chat_id.clone(),
                                message,
                                code,
                                turn.clone(),
                                failed_attempt.take(),
                                clock.clone(),
                            ));
                        }
                        (
                            Terminal::Finished(exit_code, outcome),
                            WorkingDirectorySettlement::Settled,
                        ) => {
                            wiring
                                .handle_finish(&chat_id, exit_code, outcome, turn.as_ref())
                                .await?;
                        }
                        (
                            Terminal::Failed { message, code },
                            WorkingDirectorySettlement::Settled,
                        ) => {
                            wiring
                                .handle_failure(
                                    &chat_id,
                                    &message,
                                    Some(&code),
                                    turn.as_ref(),
                                    failed_attempt.as_ref(),
                                    clock.as_ref(),
                                    false,
                                )
                                .await?;
                        }
                    }
                    Ok(())
                }
                .await;
                if !released {
                    let released = wiring
                        .release_ownership(
                            &coordinator,
                            &chat_id,
                            turn.as_ref(),
                            AgentTurnSettlementOutcome::Failed,
                        )
                        .await?;
                    if was_finished && let WorkingDirectorySettlement::Failed { message } = released
                    {
                        *deferred.borrow_mut() = Some(wiring.defer_settlement_failure(
                            chat_id.clone(),
                            message,
                            ErrorCode::PROJECT_PATH_DESTINATION_REJECTED.as_str().into(),
                            turn,
                            failed_attempt,
                            clock,
                        ));
                    }
                }
                tokio::task::spawn_local(async move {
                    if let Err(error) = coordinator.check_chat_idle(&chat_id).await {
                        create_logger("server")
                            .warn(&format!("queue: checkChatIdle error: {error}"));
                    }
                });
                result
            });
        ListenerWork::Pending(
            async move {
                task.await;
                // Settlement can itself enqueue a commit. Wait for the failure
                // publication outside the task so that commit can fan out first.
                let failure = settlement_failure.borrow_mut().take();
                if let Some(failure) = failure {
                    failure.await;
                }
                Ok(())
            }
            .boxed_local(),
        )
    }

    async fn release_ownership(
        self: &Rc<Self>,
        coordinator: &ChatExecutionCoordinator,
        chat_id: &ChatId,
        turn: Option<&TurnEventMetadata>,
        outcome: AgentTurnSettlementOutcome,
    ) -> ExecutorResult<WorkingDirectorySettlement> {
        self.lifecycle
            .inline_terminal_releases
            .borrow_mut()
            .insert(chat_id.clone());
        let result = coordinator
            .on_agent_turn_terminal(chat_id, turn, outcome)
            .await;
        self.lifecycle
            .inline_terminal_releases
            .borrow_mut()
            .remove(chat_id);
        let result = result?;
        if self.deps.registry.has_chat(chat_id) {
            if matches!(result, WorkingDirectorySettlement::Failed { .. }) {
                self.schedule_processing(chat_id);
            } else {
                self.publish_processing(chat_id, self.deps.processing.phase(chat_id))?;
            }
        }
        Ok(result)
    }

    fn defer_settlement_failure(
        self: &Rc<Self>,
        chat_id: ChatId,
        message: String,
        code: String,
        turn: Option<TurnEventMetadata>,
        failed_attempt: Option<ActivityOutcomeAttempt>,
        clock: Rc<dyn Clock>,
    ) -> Completion {
        let wiring = self.clone();
        self.queue
            .schedule(chat_id.clone().as_str(), "settlement failure", async move {
                wiring
                    .handle_failure(
                        &chat_id,
                        &message,
                        Some(&code),
                        turn.as_ref(),
                        failed_attempt.as_ref(),
                        clock.as_ref(),
                        false,
                    )
                    .await
            })
    }

    async fn handle_finish(
        &self,
        chat_id: &ChatId,
        exit_code: i32,
        outcome: AgentRunCompletionOutcome,
        turn: Option<&TurnEventMetadata>,
    ) -> ExecutorResult<()> {
        self.settle_command(chat_id, turn, CommandTerminalStatus::Finished, None)
            .await?;
        if !self.deps.registry.has_chat(chat_id) {
            return Ok(());
        }
        let (outcome, interruption) = match outcome {
            AgentRunCompletionOutcome::Finished => (AgentRunFinishedOutcome::Finished, None),
            AgentRunCompletionOutcome::Interrupted => (
                AgentRunFinishedOutcome::Interrupted,
                Some(InterruptionReason::UserStop),
            ),
        };
        (self.deps.publish)(ServerWsMessage::AgentRunFinished(
            AgentRunFinishedMessage::new(
                chat_id.to_string(),
                Some(Number(f64::from(exit_code))),
                turn.and_then(|turn| turn.turn_id.clone()),
                turn.and_then(|turn| turn.client_request_id.clone()),
                turn.and_then(|turn| turn.upstream_request_id.clone()),
                Some(outcome),
            ),
        ))?;
        self.mark_public_terminal(chat_id, turn, interruption).await
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "the failure includes the captured metadata attempt and source"
    )]
    async fn handle_failure(
        &self,
        chat_id: &ChatId,
        message: &str,
        code: Option<&str>,
        turn: Option<&TurnEventMetadata>,
        failed_attempt: Option<&ActivityOutcomeAttempt>,
        clock: &dyn Clock,
        from_queue: bool,
    ) -> ExecutorResult<()> {
        if (!from_queue && !self.deps.registry.has_chat(chat_id))
            || !self
                .lifecycle
                .mark_turn_failure(chat_id, turn, clock.now_ms())
        {
            return Ok(());
        }
        let code = code
            .and_then(|code| is_error_code(&Value::String(code.into())))
            .unwrap_or(ErrorCode::INTERNAL_ERROR);
        self.settle_command(
            chat_id,
            turn,
            CommandTerminalStatus::Failed,
            Some((message, code)),
        )
        .await?;
        if from_queue || self.deps.registry.has_chat(chat_id) {
            if self.deps.processing.phase(chat_id).is_none()
                && self.deps.metadata.record_failed_attempt(failed_attempt)
            {
                self.publish_activity(chat_id)?;
            }
            (self.deps.publish)(ServerWsMessage::AgentRunFailed(AgentRunFailedMessage::new(
                chat_id.to_string(),
                message.into(),
                turn.and_then(|turn| turn.turn_id.clone()),
                turn.and_then(|turn| turn.client_request_id.clone()),
                turn.and_then(|turn| turn.upstream_request_id.clone()),
            )))?;
        }
        self.mark_public_terminal(chat_id, turn, None).await
    }

    async fn settle_command(
        &self,
        chat_id: &ChatId,
        turn: Option<&TurnEventMetadata>,
        status: CommandTerminalStatus,
        error: Option<(&str, ErrorCode)>,
    ) -> ExecutorResult<()> {
        if let Some(turn) = turn
            && let (Some(command_type), Some(request_id)) = (
                turn.command_type,
                turn.client_request_id
                    .as_deref()
                    .filter(|id| !id.is_empty()),
            )
        {
            let command_type = match command_type {
                TurnCommandType::ChatStart => "chat-start",
                TurnCommandType::AgentRun => "agent-run",
                TurnCommandType::ForkRun => "fork-run",
                TurnCommandType::AgentCompact => "agent-compact",
            };
            let patch = error
                .filter(|(message, _)| !message.is_empty())
                .into_iter()
                .flat_map(|(message, code)| {
                    [
                        CommandLedgerChange::Detail(CommandLedgerDetail::Error(Some(
                            message.into(),
                        ))),
                        CommandLedgerChange::Detail(CommandLedgerDetail::ErrorCode(Some(
                            code.as_str().into(),
                        ))),
                    ]
                });
            self.command_ledger()?
                .settle_terminal(
                    &command_ledger_key(command_type, chat_id, request_id),
                    status,
                    patch,
                )
                .await?;
        }
        Ok(())
    }

    async fn mark_public_terminal(
        &self,
        chat_id: &ChatId,
        turn: Option<&TurnEventMetadata>,
        interruption: Option<InterruptionReason>,
    ) -> ExecutorResult<()> {
        if let Some(turn_id) = turn
            .and_then(|turn| turn.turn_id.as_deref())
            .filter(|id| !id.is_empty())
        {
            self.command_ledger()?
                .mark_public_terminal(chat_id, turn_id, interruption)
                .await?;
        }
        Ok(())
    }

    fn command_ledger(&self) -> ExecutorResult<&CommandLedger> {
        self.lifecycle
            .commands
            .get()
            .map(Rc::as_ref)
            .ok_or_else(|| "Execution events are not wired".into())
    }
}

fn chat_id(chat: &str) -> Result<ChatId, garcon_contract::chat_id::InvalidChatIdError> {
    parse_chat_id(&Value::String(chat.into()))
}

impl LifecycleState {
    fn mark_turn_failure(&self, chat: &ChatId, turn: Option<&TurnEventMetadata>, now: i64) -> bool {
        let Some(identity) = turn
            .and_then(|turn| turn.turn_id.as_ref().or(turn.client_request_id.as_ref()))
            .filter(|id| !id.is_empty())
        else {
            return true;
        };
        let mut failures = self.recent_turn_failures.borrow_mut();
        failures.retain(|_, at| *at >= now.saturating_sub(TURN_FAILURE_DEDUPE_MS));
        let key = format!("{chat}:{identity}");
        if let std::collections::hash_map::Entry::Vacant(entry) = failures.entry(key) {
            entry.insert(now);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests;
