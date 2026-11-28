//! Fires agent events for the exact turn whose terminal was committed.
//! Ledger wiring supplies the committed outcome; this bus does not append rows.

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_contract::command_output::CommandWorkingDirectory;
use garcon_interface::producer::AgentRunFailureDetail;

use crate::{
    listener_dispatch::{ListenerWork, dispatch_listeners_sequentially},
    turn_identity::matches_turn_identity,
};

pub use crate::turn_terminal_settlement::{TurnEventMetadata, TurnExecutionSnapshot};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentRunCompletionOutcome {
    Finished,
    Interrupted,
}

pub enum CommittedRunOutcome {
    Completed(AgentRunCompletionOutcome),
    Failed(Option<AgentRunFailureDetail>),
}

#[derive(Debug, thiserror::Error)]
#[error("Cannot track a new turn while chat {chat_id} has an active turn")]
pub struct ActiveTurnConflict {
    chat_id: String,
}

type ChatListener = dyn for<'a> Fn(&'a str) -> ListenerWork<'a>;
type FinishedListener = dyn for<'a> Fn(
    &'a str,
    i32,
    Option<&'a TurnEventMetadata>,
    AgentRunCompletionOutcome,
) -> ListenerWork<'a>;
type FailedListener =
    dyn for<'a> Fn(&'a str, &'a str, &'a str, Option<&'a TurnEventMetadata>) -> ListenerWork<'a>;

struct Listeners<T: ?Sized>(RefCell<Vec<Rc<T>>>);

impl<T: ?Sized> Default for Listeners<T> {
    fn default() -> Self {
        Self(RefCell::default())
    }
}

impl<T: ?Sized> Listeners<T> {
    fn add(&self, listener: Rc<T>) {
        let mut listeners = self.0.borrow_mut();
        if !listeners
            .iter()
            .any(|existing| Rc::ptr_eq(existing, &listener))
        {
            listeners.push(listener);
        }
    }

    fn iter(&self) -> impl Iterator<Item = Rc<T>> {
        let mut index = 0;
        // Set iteration observes listeners added during dispatch, without borrowing across await.
        std::iter::from_fn(move || {
            let listener = self.0.borrow().get(index).cloned()?;
            index += 1;
            Some(listener)
        })
    }
}

pub struct AgentEventBus {
    active: RefCell<HashMap<String, TurnEventMetadata>>,
    settled: RefCell<HashMap<String, TurnEventMetadata>>,
    sessions: Listeners<ChatListener>,
    steerable: Listeners<ChatListener>,
    finished: Listeners<FinishedListener>,
    failed: Listeners<FailedListener>,
    logger: ScopedLogger,
}

impl Default for AgentEventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentEventBus {
    pub fn new() -> Self {
        Self {
            active: RefCell::default(),
            settled: RefCell::default(),
            sessions: Listeners::default(),
            steerable: Listeners::default(),
            finished: Listeners::default(),
            failed: Listeners::default(),
            logger: create_logger("agents:event-bus"),
        }
    }

    pub fn track_turn(
        &self,
        chat_id: &str,
        opts: &TurnEventMetadata,
    ) -> Result<(), ActiveTurnConflict> {
        if opts.client_request_id.as_deref().is_none_or(str::is_empty)
            && opts.command_type.is_none()
            && opts.turn_id.as_deref().is_none_or(str::is_empty)
        {
            self.clear_turn(chat_id);
            return Ok(());
        }
        let turn = tracked_metadata(opts);
        let mut active = self.active.borrow_mut();
        if let Some(active) = active.get(chat_id)
            && !matches_turn_identity(Some(&active.identity()), Some(&turn.identity()))
        {
            return Err(ActiveTurnConflict {
                chat_id: chat_id.into(),
            });
        }
        self.settled.borrow_mut().remove(chat_id);
        active.insert(chat_id.into(), turn);
        Ok(())
    }

    pub fn clear_turn(&self, chat_id: &str) {
        self.active.borrow_mut().remove(chat_id);
        self.settled.borrow_mut().remove(chat_id);
    }

    pub fn settle_turn(&self, chat_id: &str, turn: &TurnEventMetadata) {
        let mut active = self.active.borrow_mut();
        if active.get(chat_id).is_some_and(|active| {
            matches_turn_identity(Some(&active.identity()), Some(&turn.identity()))
        }) && let Some(turn) = active.remove(chat_id)
        {
            self.settled.borrow_mut().insert(chat_id.into(), turn);
        }
    }

    pub fn get_active_turn(&self, chat_id: &str) -> Option<TurnEventMetadata> {
        self.active.borrow().get(chat_id).cloned()
    }

    pub fn on_session_created(&self, listener: Rc<ChatListener>) {
        self.sessions.add(listener);
    }

    pub fn on_run_steerable(&self, listener: Rc<ChatListener>) {
        self.steerable.add(listener);
    }

    pub fn on_finished(&self, listener: Rc<FinishedListener>) {
        self.finished.add(listener);
    }

    pub fn on_failed(&self, listener: Rc<FailedListener>) {
        self.failed.add(listener);
    }

    pub async fn publish_session(&self, chat_id: &str) {
        self.dispatch("session", chat_id, &self.sessions, |listener| {
            listener(chat_id)
        })
        .await;
    }

    pub async fn publish_run_steerable(&self, chat_id: &str) {
        self.dispatch("run steerable", chat_id, &self.steerable, |listener| {
            listener(chat_id)
        })
        .await;
    }

    pub async fn publish_run_ended(
        &self,
        chat_id: &str,
        run_id: &str,
        outcome: CommittedRunOutcome,
        working_directory: Option<CommandWorkingDirectory>,
    ) {
        let outcome = match outcome {
            CommittedRunOutcome::Completed(outcome) => outcome,
            CommittedRunOutcome::Failed(error) => {
                self.publish_run_failed(
                    chat_id,
                    run_id,
                    &error.unwrap_or_else(|| AgentRunFailureDetail {
                        code: "INTERNAL_ERROR".into(),
                        message: Some("Agent run failed".into()),
                    }),
                    working_directory,
                )
                .await;
                return;
            }
        };
        let Some(metadata) = self.take_terminal(chat_id, run_id, working_directory) else {
            return;
        };
        self.dispatch("finished terminal", chat_id, &self.finished, |listener| {
            listener(chat_id, 0, Some(&metadata), outcome)
        })
        .await;
    }

    pub async fn publish_run_failed(
        &self,
        chat_id: &str,
        run_id: &str,
        error: &AgentRunFailureDetail,
        working_directory: Option<CommandWorkingDirectory>,
    ) {
        let Some(metadata) = self.take_terminal(chat_id, run_id, working_directory) else {
            return;
        };
        self.dispatch("failed terminal", chat_id, &self.failed, |listener| {
            listener(
                chat_id,
                error.message.as_deref().unwrap_or(&error.code),
                &error.code,
                Some(&metadata),
            )
        })
        .await;
    }

    fn take_terminal(
        &self,
        chat_id: &str,
        run_id: &str,
        working_directory: Option<CommandWorkingDirectory>,
    ) -> Option<TurnEventMetadata> {
        let captured = matching_run(&self.active, chat_id, run_id)
            .or_else(|| matching_run(&self.settled, chat_id, run_id));
        let Some(mut metadata) = captured else {
            self.logger.warn(&format!(
                "Ignored ledger terminal for a non-active turn ({chat_id}, {run_id})"
            ));
            return None;
        };
        if working_directory.is_some() {
            metadata.working_directory = working_directory;
        }
        self.clear_turn(chat_id);
        Some(metadata)
    }

    async fn dispatch<'a, T: ?Sized>(
        &self,
        event: &str,
        chat_id: &str,
        listeners: &Listeners<T>,
        invoke: impl FnMut(Rc<T>) -> ListenerWork<'a>,
    ) {
        dispatch_listeners_sequentially(listeners.iter(), invoke, |error| {
            self.logger.error(&format!(
                "Agent event listener failed ({chat_id}, {event}): {error}"
            ));
        })
        .await;
    }
}

fn matching_run(
    turns: &RefCell<HashMap<String, TurnEventMetadata>>,
    chat_id: &str,
    run_id: &str,
) -> Option<TurnEventMetadata> {
    turns
        .borrow()
        .get(chat_id)
        .filter(|metadata| metadata.turn_id.as_deref() == Some(run_id))
        .cloned()
}

fn tracked_metadata(opts: &TurnEventMetadata) -> TurnEventMetadata {
    fn nonempty(value: &Option<String>) -> Option<String> {
        value.as_ref().filter(|value| !value.is_empty()).cloned()
    }
    TurnEventMetadata {
        client_request_id: nonempty(&opts.client_request_id),
        command_type: opts.command_type,
        turn_id: nonempty(&opts.turn_id),
        client_message_id: nonempty(&opts.client_message_id),
        upstream_request_id: nonempty(&opts.upstream_request_id),
        agent_ownership_epoch: nonempty(&opts.agent_ownership_epoch),
        turn_owner: opts.turn_owner.clone(),
        execution_snapshot: opts.execution_snapshot.clone(),
        ..TurnEventMetadata::default()
    }
}
