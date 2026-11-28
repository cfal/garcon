//! Ports `server/controller/chats/chat-transient-feed.ts`.

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
};

use garcon_base::errors::{DiagnosticError, ErrorMetadata, NamedError};
use garcon_contract::{
    chat_transient_feed::{
        ChatTransientControlAction, ChatTransientFeedMutation, ChatTransientFeedMutationBody,
        ChatTransientFeedSnapshot, TransientFeedRow, TransientFeedRowPosition,
    },
    chat_types::{ChatMessage, PermissionRequestMessage},
};
use garcon_js::collation::Collation;
use garcon_ledger::{
    contracts::{LedgerPermissionLifecycle, LedgerRowData},
    presentation::ledger_row_to_message,
    service::TranscriptCommitEvent,
};
use indexmap::IndexMap;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TransientControlActionError {
    #[error("The server restarted; this permission control is no longer actionable")]
    ServerRestarted,
    #[error("This permission control is no longer actionable")]
    Stale,
}

impl TransientControlActionError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ServerRestarted => "TRANSIENT_CONTROL_SERVER_RESTARTED",
            Self::Stale => "TRANSIENT_CONTROL_STALE",
        }
    }
}

impl DiagnosticError for TransientControlActionError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "TransientControlActionError",
            code: Some(self.code()),
        }
    }
}

pub struct PermissionControl<'a> {
    pub chat_id: &'a str,
    pub view_id: &'a str,
    pub run_id: &'a str,
    pub occurrence_id: &'a str,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PermissionActionability {
    Claimed,
    Actionable,
}

struct Feed {
    view_id: String,
    revision: u64,
    rows: IndexMap<String, TransientFeedRow>,
    claimed: HashSet<String>,
}

impl Feed {
    fn new(view_id: &str) -> Self {
        Self {
            view_id: view_id.into(),
            revision: 0,
            rows: IndexMap::new(),
            claimed: HashSet::new(),
        }
    }

    fn set_view(&mut self, view_id: &str, error: &str) -> Result<(), NamedError> {
        if self.view_id != view_id {
            if !self.rows.is_empty() {
                return Err(type_error(error));
            }
            view_id.clone_into(&mut self.view_id);
            self.revision = 0;
        }
        Ok(())
    }

    fn has_control(&self, control: &PermissionControl<'_>) -> bool {
        self.view_id == control.view_id
            && self
                .rows
                .get(control.occurrence_id)
                .is_some_and(|row| row.run_id == control.run_id)
    }

    fn remove(&mut self, occurrence_id: &str) -> Option<ChatTransientFeedMutationBody> {
        self.claimed.remove(occurrence_id);
        self.rows.shift_remove(occurrence_id)?;
        Some(ChatTransientFeedMutationBody::Remove {
            permission_occurrence_id: occurrence_id.into(),
        })
    }
}

pub struct ChatTransientFeedStore {
    server_instance_id: String,
    feeds: RefCell<HashMap<String, Feed>>,
}

impl ChatTransientFeedStore {
    pub fn new(server_instance_id: String) -> Result<Self, NamedError> {
        if server_instance_id.is_empty() {
            return Err(type_error("Transient feed requires a server instance ID"));
        }
        Ok(Self {
            server_instance_id,
            feeds: RefCell::new(HashMap::new()),
        })
    }

    pub fn replace_view(&self, chat_id: &str, view_id: &str) {
        self.feeds
            .borrow_mut()
            .insert(chat_id.into(), Feed::new(view_id));
    }

    pub fn apply_commit(
        &self,
        event: &TranscriptCommitEvent,
    ) -> Result<Option<ChatTransientFeedMutation>, NamedError> {
        use LedgerPermissionLifecycle::{Cancelled, Expired, Resolved};
        use LedgerRowData::{PermissionCancelled, PermissionExpired, PermissionResolved};
        match event {
            TranscriptCommitEvent::Rows { .. } | TranscriptCommitEvent::Session { .. } => Ok(None),
            TranscriptCommitEvent::ViewReplaced { chat_id, view, .. } => {
                self.replace_view(chat_id, view.view_id.as_str());
                Ok(None)
            }
            TranscriptCommitEvent::RunEnded {
                chat_id,
                view_id,
                run_id,
                ..
            } => self.run_ended(chat_id, view_id.as_str(), run_id),
            TranscriptCommitEvent::Permission {
                chat_id,
                view_id,
                run_id,
                row,
            } => match &row.data {
                PermissionCancelled {
                    lifecycle:
                        Cancelled {
                            permission_occurrence_id,
                            ..
                        },
                }
                | PermissionResolved {
                    lifecycle:
                        Resolved {
                            permission_occurrence_id,
                            ..
                        },
                }
                | PermissionExpired {
                    lifecycle:
                        Expired {
                            permission_occurrence_id,
                        },
                } => self.permission_settled(chat_id, view_id.as_str(), permission_occurrence_id),
                LedgerRowData::PermissionRequested { .. } => {
                    if let Some(ChatMessage::PermissionRequest(message)) =
                        ledger_row_to_message(chat_id, row)
                    {
                        self.permission_requested(
                            chat_id,
                            view_id.as_str(),
                            run_id.as_deref(),
                            row.ordinal,
                            message,
                        )
                    } else {
                        Ok(None)
                    }
                }
                _ => Ok(None),
            },
        }
    }

    pub fn permission_requested(
        &self,
        chat_id: &str,
        view_id: &str,
        run_id: Option<&str>,
        ordinal: u64,
        message: PermissionRequestMessage,
    ) -> Result<Option<ChatTransientFeedMutation>, NamedError> {
        self.apply(chat_id, view_id, |feed| {
            let run_id = run_id.filter(|id| !id.is_empty())?;
            let row = TransientFeedRow {
                permission_occurrence_id: message.permission_occurrence_id.clone(),
                run_id: run_id.into(),
                transcript: TransientFeedRowPosition {
                    transcript_view_id: view_id.into(),
                    after_ordinal: ordinal,
                },
                display_order: ordinal,
                message,
            };
            feed.rows
                .insert(row.permission_occurrence_id.clone(), row.clone());
            Some(ChatTransientFeedMutationBody::Upsert { row: Box::new(row) })
        })
    }

    pub fn permission_settled(
        &self,
        chat_id: &str,
        view_id: &str,
        occurrence_id: &str,
    ) -> Result<Option<ChatTransientFeedMutation>, NamedError> {
        self.apply(chat_id, view_id, |feed| feed.remove(occurrence_id))
    }

    pub fn run_ended(
        &self,
        chat_id: &str,
        view_id: &str,
        run_id: &str,
    ) -> Result<Option<ChatTransientFeedMutation>, NamedError> {
        self.apply(chat_id, view_id, |feed| {
            let before = feed.rows.len();
            feed.rows.retain(|id, row| {
                if row.run_id == run_id {
                    feed.claimed.remove(id);
                    false
                } else {
                    true
                }
            });
            (feed.rows.len() != before).then(|| ChatTransientFeedMutationBody::ClearRun {
                run_id: run_id.into(),
            })
        })
    }

    pub fn retire_permission(
        &self,
        control: &PermissionControl<'_>,
    ) -> Option<ChatTransientFeedMutation> {
        let mut feeds = self.feeds.borrow_mut();
        let feed = feeds.get_mut(control.chat_id)?;
        if !feed.has_control(control) {
            return None;
        }
        let mutation = feed.remove(control.occurrence_id)?;
        Some(self.mutation(control.chat_id, feed, mutation))
    }

    pub fn apply_permission_actionability(
        &self,
        control: &PermissionControl<'_>,
        actionability: PermissionActionability,
    ) -> bool {
        let mut feeds = self.feeds.borrow_mut();
        let Some(feed) = feeds
            .get_mut(control.chat_id)
            .filter(|feed| feed.has_control(control))
        else {
            return false;
        };
        match actionability {
            PermissionActionability::Claimed => feed.claimed.insert(control.occurrence_id.into()),
            PermissionActionability::Actionable => feed.claimed.remove(control.occurrence_id),
        }
    }

    pub fn snapshot(
        &self,
        chat_id: &str,
        view_id: &str,
    ) -> Result<ChatTransientFeedSnapshot, NamedError> {
        let mut feeds = self.feeds.borrow_mut();
        let Some(feed) = feeds.get_mut(chat_id) else {
            return Ok(self.snapshot_of(chat_id, &Feed::new(view_id)));
        };
        feed.set_view(
            view_id,
            "Transient feed snapshot does not match the current transcript view",
        )?;
        Ok(self.snapshot_of(chat_id, feed))
    }

    pub fn current_snapshot(&self, chat_id: &str) -> Option<ChatTransientFeedSnapshot> {
        self.feeds
            .borrow()
            .get(chat_id)
            .map(|feed| self.snapshot_of(chat_id, feed))
    }

    pub fn has_pending_user_action(&self, chat_id: &str) -> bool {
        self.feeds
            .borrow()
            .get(chat_id)
            .is_some_and(|feed| feed.rows.len() > feed.claimed.len())
    }

    pub fn validate_action(
        &self,
        action: &ChatTransientControlAction,
    ) -> Result<TransientFeedRow, TransientControlActionError> {
        if action.server_instance_id != self.server_instance_id {
            return Err(TransientControlActionError::ServerRestarted);
        }
        self.feeds
            .borrow()
            .get(&action.chat_id)
            .and_then(|feed| feed.rows.get(&action.permission_occurrence_id))
            .filter(|row| row.run_id == action.run_id)
            .cloned()
            .ok_or(TransientControlActionError::Stale)
    }

    pub fn delete_chat(&self, chat_id: &str) {
        self.feeds.borrow_mut().remove(chat_id);
    }

    fn apply(
        &self,
        chat_id: &str,
        view_id: &str,
        update: impl FnOnce(&mut Feed) -> Option<ChatTransientFeedMutationBody>,
    ) -> Result<Option<ChatTransientFeedMutation>, NamedError> {
        let mut feeds = self.feeds.borrow_mut();
        let feed = feeds
            .entry(chat_id.into())
            .or_insert_with(|| Feed::new(view_id));
        feed.set_view(
            view_id,
            "Cannot replace a transient feed with active controls",
        )?;
        Ok(update(feed).map(|mutation| self.mutation(chat_id, feed, mutation)))
    }

    fn snapshot_of(&self, chat_id: &str, feed: &Feed) -> ChatTransientFeedSnapshot {
        let mut rows: Vec<_> = feed.rows.values().cloned().collect();
        rows.sort_by(|left, right| {
            left.display_order.cmp(&right.display_order).then_with(|| {
                Collation::english().compare(
                    &left.permission_occurrence_id,
                    &right.permission_occurrence_id,
                )
            })
        });
        ChatTransientFeedSnapshot {
            server_instance_id: self.server_instance_id.clone(),
            chat_id: chat_id.into(),
            transcript_view_id: feed.view_id.clone(),
            transient_revision: feed.revision,
            rows,
        }
    }

    fn mutation(
        &self,
        chat_id: &str,
        feed: &mut Feed,
        mutation: ChatTransientFeedMutationBody,
    ) -> ChatTransientFeedMutation {
        feed.revision += 1;
        ChatTransientFeedMutation {
            server_instance_id: self.server_instance_id.clone(),
            chat_id: chat_id.into(),
            transcript_view_id: feed.view_id.clone(),
            transient_revision: feed.revision,
            mutation,
        }
    }
}

fn type_error(message: &str) -> NamedError {
    NamedError {
        name: "TypeError".into(),
        message: message.into(),
        code: None,
    }
}
