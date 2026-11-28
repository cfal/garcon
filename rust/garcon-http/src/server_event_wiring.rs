//! Transcript publication and ordered browser events from `server-event-wiring.ts`.

mod lifecycle;
mod task_queue;

use std::rc::Rc;

use futures::future::{FutureExt, LocalBoxFuture};
use garcon_base::event_loop_stalls::ActivityTracker;
use garcon_chats::{
    chat_activity_status::project_chat_activity_status,
    chat_message_reader::ResendCandidates,
    chat_processing_activity::ChatProcessingActivity,
    chat_transient_feed::{ChatTransientFeedStore, PermissionActionability, PermissionControl},
    metadata_store::MetadataIndex,
    store::ChatRegistry,
};
use garcon_contract::{
    chat_activity::ChatRunOutcome,
    chat_id::{ChatId, parse_chat_id},
    chat_transient_feed::ChatTransientFeedMutation,
    chat_types::{ChatMessage, ChatProcessingPhase},
    ws_events::{
        ChatActivityUpdatedMessage, ChatMessagesMessage, ChatPreamblesInvalidatedMessage,
        ChatTranscriptReplacedMessage, ChatTransientFeedMutationMessage, ServerWsMessage,
    },
};
use garcon_execution::command_ledger::CommandLedger;
use garcon_interface::resources::ExecutorResult;
use garcon_ledger::{
    contracts::{
        LedgerNoticeDetail, LedgerRow, LedgerRowData, RunOutcome, is_conversational_ledger_row,
    },
    presentation::{ledger_row_to_message, ledger_rows_to_transcript_messages},
    service::{TranscriptCommitEvent, TranscriptCommitWork, TranscriptLedgerService},
};
use serde_json::Value;

use task_queue::ChatTaskQueue;

pub type ChatEventPublisher = dyn Fn(ServerWsMessage) -> ExecutorResult<()>;
pub type ReplaceChatMetadata =
    dyn Fn(ChatId, String) -> LocalBoxFuture<'static, ExecutorResult<()>>;

pub struct ServerEventWiringDeps {
    pub registry: Rc<ChatRegistry>,
    pub metadata: Rc<MetadataIndex>,
    pub processing: Rc<ChatProcessingActivity>,
    pub feeds: Rc<ChatTransientFeedStore>,
    pub command_ledger: Rc<CommandLedger>,
    pub activities: Rc<ActivityTracker>,
    pub replace_metadata: Rc<ReplaceChatMetadata>,
    pub resend_candidates: Rc<ResendCandidates>,
    pub publish: Rc<ChatEventPublisher>,
}

pub struct ServerEventWiring {
    deps: ServerEventWiringDeps,
    queue: Rc<ChatTaskQueue>,
    lifecycle: lifecycle::LifecycleState,
}

impl ServerEventWiring {
    pub fn new(deps: ServerEventWiringDeps) -> Rc<Self> {
        let queue = ChatTaskQueue::new(deps.activities.clone());
        Rc::new(Self {
            deps,
            queue,
            lifecycle: lifecycle::LifecycleState::default(),
        })
    }

    pub fn subscribe(self: &Rc<Self>, ledger: &TranscriptLedgerService) -> Box<dyn Fn()> {
        let events = Rc::downgrade(self);
        ledger.subscribe(Rc::new(move |event| {
            let Some(events) = events.upgrade() else {
                return TranscriptCommitWork::Complete(Ok(()));
            };
            events.on_commit(event)
        }))
    }

    pub fn schedule_chat_event(
        self: &Rc<Self>,
        chat_id: &ChatId,
        activity: &'static str,
        event: ServerWsMessage,
    ) {
        let wiring = Rc::clone(self);
        let chat = chat_id.clone();
        drop(self.queue.schedule(chat_id, activity, async move {
            if wiring.deps.registry.has_chat(&chat) {
                (wiring.deps.publish)(event)?;
            }
            Ok(())
        }));
    }

    pub fn retire_permission(
        self: &Rc<Self>,
        control: &PermissionControl<'_>,
    ) -> ExecutorResult<()> {
        if let Some(mutation) = self.deps.feeds.retire_permission(control) {
            let chat_id = parse_chat_id(&Value::String(mutation.chat_id.clone()))?;
            self.schedule_transient_mutation(chat_id, mutation);
        }
        Ok(())
    }

    pub fn permission_actionability_changed(
        self: &Rc<Self>,
        control: &PermissionControl<'_>,
        actionability: PermissionActionability,
    ) -> ExecutorResult<()> {
        if self
            .deps
            .feeds
            .apply_permission_actionability(control, actionability)
        {
            let chat_id = parse_chat_id(&Value::String(control.chat_id.into()))?;
            let wiring = Rc::clone(self);
            drop(self.queue.schedule(
                chat_id.as_str(),
                "permission actionability activity publication",
                {
                    let chat = chat_id.clone();
                    async move { wiring.publish_activity(&chat) }
                },
            ));
        }
        Ok(())
    }

    pub async fn wait_for_idle(&self) -> ExecutorResult<()> {
        self.queue.wait_for_idle().await
    }

    fn on_commit(self: &Rc<Self>, event: Rc<TranscriptCommitEvent>) -> TranscriptCommitWork {
        let chat_id = match event.as_ref() {
            TranscriptCommitEvent::Rows { chat_id, .. }
            | TranscriptCommitEvent::Session { chat_id, .. }
            | TranscriptCommitEvent::Permission { chat_id, .. }
            | TranscriptCommitEvent::RunEnded { chat_id, .. }
            | TranscriptCommitEvent::ViewReplaced { chat_id, .. } => chat_id,
        };
        let chat_id = match parse_chat_id(&Value::String(chat_id.clone())) {
            Ok(chat_id) => chat_id,
            Err(error) => return TranscriptCommitWork::Complete(Err(error.into())),
        };
        if let TranscriptCommitEvent::Rows { rows, .. } = event.as_ref()
            && rows.iter().any(|row| {
                matches!(
                    &row.data,
                    LedgerRowData::UserInput { .. }
                        | LedgerRowData::ProviderRow {
                            message: ChatMessage::User(_)
                        }
                )
            })
        {
            self.deps.metadata.clear_run_outcome(&chat_id, None);
        }
        let terminal_attempt = if let TranscriptCommitEvent::RunEnded {
            view_id, run_id, ..
        } = event.as_ref()
        {
            self.deps
                .metadata
                .capture_committed_outcome(&chat_id, view_id.as_str(), run_id)
        } else {
            None
        };
        if matches!(event.as_ref(), TranscriptCommitEvent::ViewReplaced { .. }) {
            self.deps.metadata.invalidate_transcript_view(&chat_id);
        }
        if self.deps.registry.has_chat(&chat_id) {
            let wiring = Rc::clone(self);
            let commit = Rc::clone(&event);
            let chat = chat_id.clone();
            drop(
                self.queue
                    .schedule(&chat_id, "transcript commit fanout", async move {
                        wiring.fanout(&chat, &commit).await
                    }),
            );
        }
        match event.as_ref() {
            TranscriptCommitEvent::RunEnded { row, .. } => {
                let outcome = match &row.data {
                    LedgerRowData::RunEnded {
                        outcome: RunOutcome::Finished,
                        ..
                    } => Some(ChatRunOutcome::Finished),
                    LedgerRowData::RunEnded {
                        outcome: RunOutcome::Failed,
                        ..
                    } => Some(ChatRunOutcome::Failed),
                    LedgerRowData::RunEnded {
                        outcome: RunOutcome::Interrupted,
                        ..
                    } => Some(ChatRunOutcome::Interrupted),
                    _ => None,
                };
                let wiring = Rc::clone(self);
                let chat = chat_id.clone();
                drop(
                    self.queue
                        .schedule(&chat_id, "chat activity publication", async move {
                            if wiring.deps.registry.has_chat(&chat)
                                && let Some(outcome) = outcome
                            {
                                wiring
                                    .deps
                                    .metadata
                                    .record_committed_outcome(terminal_attempt.as_ref(), outcome);
                            }
                            wiring.publish_activity(&chat)
                        }),
                );
            }
            TranscriptCommitEvent::ViewReplaced { .. } => {
                let wiring = Rc::clone(self);
                let chat = chat_id.clone();
                drop(
                    self.queue
                        .schedule(&chat_id, "chat activity publication", async move {
                            wiring.publish_activity(&chat)
                        }),
                );
                let wiring = Rc::clone(self);
                let chat = chat_id.clone();
                drop(self.queue.track("chat activity recovery", async move {
                    if let Some(apply) =
                        wiring.deps.metadata.prepare_run_outcome_repair(&chat).await
                    {
                        let event_owner = wiring.clone();
                        wiring
                            .queue
                            .schedule(&chat, "chat activity repair publication", {
                                let chat = chat.clone();
                                async move {
                                    if event_owner.deps.registry.has_chat(&chat) && apply() {
                                        event_owner.publish_activity(&chat)?;
                                    }
                                    Ok(())
                                }
                            })
                            .await;
                    }
                    Ok(())
                }));
            }
            TranscriptCommitEvent::Rows { rows, .. } => {
                for row in rows {
                    if let LedgerRowData::Notice {
                        detail: LedgerNoticeDetail::PreambleSelectionChanged(detail),
                        ..
                    } = &row.data
                    {
                        self.schedule_chat_event(
                            &chat_id,
                            "chat preambles invalidation",
                            ServerWsMessage::ChatPreamblesInvalidated(
                                ChatPreamblesInvalidatedMessage::new(
                                    chat_id.to_string(),
                                    detail.selection_revision,
                                ),
                            ),
                        );
                    }
                }
            }
            _ => {}
        }
        match self.deps.feeds.apply_commit(&event) {
            Ok(Some(mutation)) => self.schedule_transient_mutation(chat_id, mutation),
            Ok(None) => {}
            Err(error) => return TranscriptCommitWork::Complete(Err(error.into())),
        }
        if matches!(event.as_ref(), TranscriptCommitEvent::RunEnded { .. }) {
            let commands = self.deps.command_ledger.clone();
            return TranscriptCommitWork::Pending(
                async move {
                    if let TranscriptCommitEvent::RunEnded {
                        chat_id,
                        run_id,
                        final_response,
                        ..
                    } = event.as_ref()
                    {
                        commands
                            .set_turn_result(chat_id, run_id, final_response.as_ref())
                            .await?;
                    }
                    Ok(())
                }
                .boxed_local(),
            );
        }
        TranscriptCommitWork::Complete(Ok(()))
    }

    async fn fanout(&self, chat_id: &ChatId, event: &TranscriptCommitEvent) -> ExecutorResult<()> {
        if !self.deps.registry.has_chat(chat_id) {
            return Ok(());
        }
        let (view_id, rows, run_id): (_, &[LedgerRow], _) = match event {
            TranscriptCommitEvent::Rows { view_id, rows, .. } => (view_id, rows, None),
            TranscriptCommitEvent::Session { view_id, row, .. }
            | TranscriptCommitEvent::Permission { view_id, row, .. } => {
                (view_id, std::slice::from_ref(row.as_ref()), None)
            }
            TranscriptCommitEvent::RunEnded {
                view_id,
                row,
                run_id,
                ..
            } => (
                view_id,
                std::slice::from_ref(row.as_ref()),
                Some(run_id.clone()),
            ),
            TranscriptCommitEvent::ViewReplaced {
                view,
                previous_view_id,
                ..
            } => {
                (self.deps.replace_metadata)(chat_id.clone(), view.view_id.to_string()).await?;
                if self.deps.registry.has_chat(chat_id) {
                    (self.deps.publish)(ServerWsMessage::ChatTranscriptReplaced(
                        ChatTranscriptReplacedMessage::new(
                            chat_id.to_string(),
                            previous_view_id.to_string(),
                            view.view_id.to_string(),
                            0,
                        ),
                    ))?;
                }
                return Ok(());
            }
        };
        let Some((first, last)) = rows.first().zip(rows.last()) else {
            return Err("Transcript commit has no rows".into());
        };
        let messages = ledger_rows_to_transcript_messages(chat_id, rows);
        let conversational: Vec<_> = rows
            .iter()
            .filter(|row| is_conversational_ledger_row(row))
            .filter_map(|row| ledger_row_to_message(chat_id, row))
            .collect();
        if !conversational.is_empty() {
            self.deps.metadata.update_from_appended_messages(
                chat_id,
                view_id.as_str(),
                &conversational,
                None,
            )?;
        }
        let candidates = if self.deps.processing.phase(chat_id).is_none() {
            (self.deps.resend_candidates)(chat_id)?
        } else {
            vec![]
        };
        (self.deps.publish)(ServerWsMessage::ChatMessages(ChatMessagesMessage::new(
            chat_id.to_string(),
            view_id.to_string(),
            messages,
            first.ordinal,
            last.ordinal,
            candidates,
            run_id,
            None,
            None,
        )))
    }

    fn schedule_transient_mutation(
        self: &Rc<Self>,
        chat_id: ChatId,
        mutation: ChatTransientFeedMutation,
    ) {
        let wiring = Rc::clone(self);
        let chat = chat_id.clone();
        drop(
            self.queue
                .schedule(&chat_id, "transient feed mutation", async move {
                    (wiring.deps.publish)(ServerWsMessage::ChatTransientFeedMutation(
                        ChatTransientFeedMutationMessage::new(
                            mutation.server_instance_id,
                            mutation.chat_id,
                            mutation.transcript_view_id,
                            mutation.transient_revision,
                            mutation.mutation,
                        ),
                    ))?;
                    wiring.publish_activity(&chat)
                }),
        );
    }

    fn publish_activity(&self, chat_id: &ChatId) -> ExecutorResult<()> {
        self.publish_activity_at(chat_id, self.deps.processing.phase(chat_id))
    }

    fn publish_activity_at(
        &self,
        chat_id: &ChatId,
        phase: Option<ChatProcessingPhase>,
    ) -> ExecutorResult<()> {
        if !self.deps.registry.has_chat(chat_id) {
            return Ok(());
        }
        let status = project_chat_activity_status(
            phase,
            self.deps.feeds.has_pending_user_action(chat_id),
            self.deps.metadata.get_run_outcome(chat_id),
        );
        (self.deps.publish)(ServerWsMessage::ChatActivityUpdated(
            ChatActivityUpdatedMessage::new(chat_id.to_string(), status),
        ))
    }
}
