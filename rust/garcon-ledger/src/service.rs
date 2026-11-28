use std::{error::Error, rc::Rc};

use garcon_contract::{
    cli_presentation::{CliBodyDisclosure, CliPresentation, CliRowFormat},
    command_output::CommandWorkingDirectory,
};
use garcon_interface::producer::AgentFinalResponse;
use garcon_js::clock::{Clock, SystemClock, to_iso_string};

use crate::{
    contracts::{
        AppendChatRowRequest, AppendChatRowResult, LedgerCliRowNoticeDetail, LedgerRow,
        TranscriptView, TranscriptViewId,
    },
    sqlite_operations::LedgerResult,
    store::TranscriptLedgerStore,
};

mod commit_notifications;
use commit_notifications::CommitNotifications;
pub use commit_notifications::{TranscriptCommitListener, TranscriptCommitWork};

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
}

/// Commits synchronously on the controller's LocalSet and defers listener delivery.
pub struct TranscriptLedgerService {
    store: Rc<TranscriptLedgerStore>,
    clock: Rc<dyn Clock>,
    notifications: Rc<CommitNotifications>,
}

impl TranscriptLedgerService {
    pub fn new(store: Rc<TranscriptLedgerStore>, options: TranscriptLedgerServiceOptions) -> Self {
        Self {
            store,
            clock: options.clock.unwrap_or_else(|| Rc::new(SystemClock)),
            notifications: Rc::new(CommitNotifications::new(
                options.on_listener_error.unwrap_or_else(|| Rc::new(|_| {})),
            )),
        }
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
        self.notifications
            .notify(TranscriptCommitEvent::ViewReplaced {
                chat_id: chat_id.into(),
                previous_view_id: expected_view_id.clone(),
                view: view.clone(),
            });
        Ok(view)
    }
}
