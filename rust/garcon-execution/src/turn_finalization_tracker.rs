//! Ports retained queued-turn finalization outcomes and their multi-waiter handles.

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueuedTurnFinalizationOutcome {
    Committed,
    NotCommitted,
}

type Record = watch::Sender<Option<QueuedTurnFinalizationOutcome>>;
type ChatFinalizations = IndexMap<String, Rc<Record>>;

#[derive(Clone)]
pub struct QueuedTurnFinalizationHandle {
    record: Rc<Record>,
}

impl QueuedTurnFinalizationHandle {
    pub fn settle(&self, outcome: QueuedTurnFinalizationOutcome) {
        settle(&self.record, outcome);
    }
}

#[derive(Clone)]
pub struct QueuedTurnFinalization {
    record: Rc<Record>,
}

impl QueuedTurnFinalization {
    pub async fn wait(&self) -> QueuedTurnFinalizationOutcome {
        let mut receiver = self.record.subscribe();
        // INFALLIBLE: the handle owns the sender, and wait_for only returns a settled record.
        receiver
            .wait_for(Option::is_some)
            .await
            .ok()
            .and_then(|value| *value)
            .expect("finalization wait returned a settled record")
    }
}

const MAX_RETAINED_FINALIZATIONS_PER_CHAT: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Queued turn finalization already exists: {chat_id}/{execution_attempt_id}")]
pub struct FinalizationAlreadyExists {
    pub chat_id: String,
    pub execution_attempt_id: String,
}

#[derive(Default)]
pub struct QueuedTurnFinalizationTracker {
    records_by_chat_id: RefCell<HashMap<String, ChatFinalizations>>,
}

impl QueuedTurnFinalizationTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn begin(
        &self,
        chat_id: &str,
        execution_attempt_id: &str,
    ) -> Result<QueuedTurnFinalizationHandle, FinalizationAlreadyExists> {
        let mut chats = self.records_by_chat_id.borrow_mut();
        let records = chats.entry(chat_id.to_owned()).or_default();
        if records
            .get(execution_attempt_id)
            .is_some_and(|record| record.borrow().is_none())
        {
            return Err(FinalizationAlreadyExists {
                chat_id: chat_id.to_owned(),
                execution_attempt_id: execution_attempt_id.to_owned(),
            });
        }
        records.shift_remove(execution_attempt_id);
        let record = Rc::new(watch::Sender::new(None));
        records.insert(execution_attempt_id.to_owned(), Rc::clone(&record));
        while records.len() > MAX_RETAINED_FINALIZATIONS_PER_CHAT
            && records
                .first()
                .is_some_and(|(_, record)| record.borrow().is_some())
        {
            records.shift_remove_index(0);
        }
        Ok(QueuedTurnFinalizationHandle { record })
    }

    pub fn get(
        &self,
        chat_id: &str,
        execution_attempt_id: Option<&str>,
    ) -> Option<QueuedTurnFinalization> {
        let id = execution_attempt_id.filter(|id| !id.is_empty())?;
        self.records_by_chat_id
            .borrow()
            .get(chat_id)?
            .get(id)
            .map(|record| QueuedTurnFinalization {
                record: Rc::clone(record),
            })
    }

    pub fn clear_chat(&self, chat_id: &str) {
        if let Some(records) = self.records_by_chat_id.borrow_mut().remove(chat_id) {
            for record in records.values() {
                settle(record, QueuedTurnFinalizationOutcome::NotCommitted);
            }
        }
    }
}

fn settle(record: &Record, outcome: QueuedTurnFinalizationOutcome) {
    record.send_if_modified(|state| {
        if state.is_some() {
            false
        } else {
            *state = Some(outcome);
            true
        }
    });
}
