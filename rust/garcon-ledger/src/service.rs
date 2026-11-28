use std::{cell::RefCell, collections::HashMap, error::Error, rc::Rc};

use garcon_contract::{
    chat_activity::ChatRunOutcome,
    cli_presentation::{CliBodyDisclosure, CliPresentation, CliRowFormat},
    command_output::CommandWorkingDirectory,
};
use garcon_interface::producer::AgentFinalResponse;
use garcon_js::clock::{Clock, SystemClock, to_iso_string};

use crate::{
    contracts::{
        AppendChatRowRequest, AppendChatRowResult, InputComposition, LedgerCliRowNoticeDetail,
        LedgerRow, TranscriptNativeActivityState, TranscriptView, TranscriptViewId,
        transcript_view_id,
    },
    sqlite_operations::LedgerResult,
    store::TranscriptLedgerStore,
};

mod commit_notifications;
mod input;
mod listeners;
mod permissions;
mod producer;
use commit_notifications::CommitNotifications;
pub use commit_notifications::{TranscriptCommitListener, TranscriptCommitWork};
pub use input::AppendInput;
pub use permissions::{
    PermissionActionability, PermissionActionabilityChange, PermissionResolutionClaim,
    RetiredPermissionControl,
};
use producer::ProducerState;
pub use producer::{
    GarconCommandSink, LedgerSyncListener, RunAbandonedListener, SessionCommitListener,
    TranscriptRunRef, TranscriptSessionCommitEvent,
};

#[derive(Debug, Clone, PartialEq)]
pub enum TranscriptCommitEvent {
    Rows {
        chat_id: String,
        view_id: TranscriptViewId,
        rows: Vec<LedgerRow>,
    },
    Session {
        chat_id: String,
        view_id: TranscriptViewId,
        row: Box<LedgerRow>,
    },
    Permission {
        chat_id: String,
        view_id: TranscriptViewId,
        run_id: Option<String>,
        row: Box<LedgerRow>,
    },
    RunEnded {
        chat_id: String,
        view_id: TranscriptViewId,
        run_id: String,
        row: Box<LedgerRow>,
        final_response: Option<AgentFinalResponse>,
        working_directory: Option<CommandWorkingDirectory>,
    },
    ViewReplaced {
        chat_id: String,
        previous_view_id: TranscriptViewId,
        view: TranscriptView,
    },
}

pub struct AppendChatRowInput<'a> {
    pub view_id: &'a TranscriptViewId,
    pub client_message_id: &'a str,
    pub presentation: &'a CliPresentation,
    pub format: CliRowFormat,
    pub disclosure: CliBodyDisclosure,
    pub title: Option<&'a str>,
    pub content: &'a str,
}

pub type LedgerListenerErrorHandler = dyn Fn(Box<dyn Error>);

#[derive(Default)]
pub struct TranscriptLedgerServiceOptions {
    pub clock: Option<Rc<dyn Clock>>,
    pub on_listener_error: Option<Rc<LedgerListenerErrorHandler>>,
    pub create_run_id: Option<Rc<dyn Fn() -> String>>,
    pub create_claim_id: Option<Rc<dyn Fn() -> String>>,
    pub server_instance_id: Option<String>,
    pub command_sink: Option<Rc<GarconCommandSink>>,
}

/// Commits synchronously on the controller's LocalSet and defers listener delivery.
pub struct TranscriptLedgerService {
    store: Rc<TranscriptLedgerStore>,
    clock: Rc<dyn Clock>,
    notifications: Rc<CommitNotifications>,
    producers: ProducerState,
    prepared_inputs: RefCell<HashMap<(String, String), Rc<InputComposition>>>,
}

impl TranscriptLedgerService {
    pub fn new(
        store: Rc<TranscriptLedgerStore>,
        mut options: TranscriptLedgerServiceOptions,
    ) -> Self {
        let producers = ProducerState::new(&mut options);
        Self {
            store,
            clock: options.clock.unwrap_or_else(|| Rc::new(SystemClock)),
            notifications: Rc::new(CommitNotifications::new(
                options.on_listener_error.unwrap_or_else(|| Rc::new(|_| {})),
            )),
            producers,
            prepared_inputs: RefCell::default(),
        }
    }

    pub fn native_activity_state(
        &self,
        chat_id: &str,
    ) -> LedgerResult<TranscriptNativeActivityState> {
        self.store.native_activity_state(chat_id)
    }

    pub async fn last_run_outcome(
        &self,
        chat_id: &str,
        view_id: &str,
    ) -> LedgerResult<Option<ChatRunOutcome>> {
        self.store
            .last_run_outcome(chat_id, &transcript_view_id(view_id)?)
            .await
    }

    /// Subscribes to committed rows and view replacements; the returned function unsubscribes.
    pub fn subscribe(&self, listener: Rc<TranscriptCommitListener>) -> Box<dyn Fn()> {
        self.notifications.subscribe(listener)
    }

    /// The caller checks ownership under the shared chat mutation lock before calling.
    pub fn append_chat_row(
        &self,
        chat_id: &str,
        input: AppendChatRowInput<'_>,
    ) -> LedgerResult<AppendChatRowResult> {
        let at = to_iso_string(self.clock.now_ms())?;
        let detail = LedgerCliRowNoticeDetail {
            client_message_id: input.client_message_id.into(),
            presentation: serde_json::to_value(input.presentation)?.into(),
            format: input.format,
            disclosure: input.disclosure,
            title: input.title.map(str::to_owned),
        };
        let result = self.store.append_chat_row(
            chat_id,
            AppendChatRowRequest {
                view_id: input.view_id,
                at: &at,
                message: input.content,
                detail: &detail,
            },
        )?;
        if result.inserted {
            self.notifications.notify(TranscriptCommitEvent::Rows {
                chat_id: chat_id.into(),
                view_id: input.view_id.clone(),
                rows: vec![result.row.clone()],
            });
        }
        Ok(result)
    }

    pub fn replace_current_view(
        &self,
        chat_id: &str,
        expected_view_id: &TranscriptViewId,
        staging_view_id: &TranscriptViewId,
    ) -> LedgerResult<TranscriptView> {
        self.close_producer(chat_id)?;
        let view = match self
            .store
            .replace_current_view(chat_id, expected_view_id, staging_view_id)
        {
            Ok(view) => view,
            Err(failure) => match self.store.current_view(chat_id)? {
                Some(current) if &current.view_id == staging_view_id => current,
                _ => return Err(failure),
            },
        };
        self.producers.permissions.borrow_mut().clear_chat(chat_id);
        self.clear_prepared_inputs(chat_id);
        self.notifications
            .notify(TranscriptCommitEvent::ViewReplaced {
                chat_id: chat_id.into(),
                previous_view_id: expected_view_id.clone(),
                view: view.clone(),
            });
        Ok(view)
    }

    pub fn close_chat(&self, chat_id: &str) -> LedgerResult<()> {
        self.close_producer(chat_id)?;
        self.producers
            .active_runs
            .borrow_mut()
            .shift_remove(chat_id);
        self.producers.permissions.borrow_mut().clear_chat(chat_id);
        self.clear_prepared_inputs(chat_id);
        self.store.close_chat(chat_id)
    }

    pub fn close(&self) -> LedgerResult<()> {
        loop {
            let next = self.producers.leases.borrow().values().next().cloned();
            let Some(lease) = next else { break };
            lease.close()?;
        }
        self.producers.active_runs.borrow_mut().clear();
        drop(self.producers.permissions.replace(Default::default()));
        self.prepared_inputs.borrow_mut().clear();
        self.producers.session_listeners.clear();
        self.producers.run_ended.clear();
        self.producers.run_abandoned.clear();
        self.producers.retired.clear();
        self.producers.actionability.clear();
        self.store.close()
    }

    fn clear_prepared_inputs(&self, chat_id: &str) {
        self.prepared_inputs
            .borrow_mut()
            .retain(|(id, _), _| id != chat_id);
    }
}
