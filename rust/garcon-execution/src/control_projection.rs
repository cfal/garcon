//! Browser response assembly (wave 2) must serialize these projections, never
//! their converted shared values. The controller projection appends
//! `attachments`; the shared browser parser reconstructs it before `revision`.

use garcon_contract::chat_execution_control::ChatExecutionControlState;
use garcon_contract::queue_state::{
    ChatQueueState, QueueEntry, QueueEntryAttachment, QueueEntryKind, QueuePause,
    RecentlyDispatchedQueueEntry,
};
use serde::{Serialize, Serializer};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientQueueEntry(pub QueueEntry);

impl From<ClientQueueEntry> for QueueEntry {
    fn from(value: ClientQueueEntry) -> Self {
        value.0
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueEntryWire<'a> {
    id: &'a str,
    content: &'a str,
    kind: QueueEntryKind,
    revision: u64,
    created_at: &'a str,
    updated_at: &'a str,
    attachments: &'a [QueueEntryAttachment],
}

impl<'a> From<&'a QueueEntry> for QueueEntryWire<'a> {
    fn from(entry: &'a QueueEntry) -> Self {
        Self {
            id: &entry.id,
            content: &entry.content,
            kind: entry.kind,
            revision: entry.revision,
            created_at: &entry.created_at,
            updated_at: &entry.updated_at,
            attachments: &entry.attachments,
        }
    }
}

impl Serialize for ClientQueueEntry {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        QueueEntryWire::from(&self.0).serialize(serializer)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientChatExecutionControlState(pub ChatExecutionControlState);

impl From<ClientChatExecutionControlState> for ChatExecutionControlState {
    fn from(value: ClientChatExecutionControlState) -> Self {
        value.0
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlWire<'a> {
    server_instance_id: &'a str,
    queue: QueueWire<'a>,
    version: u64,
    updated_at: &'a Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueWire<'a> {
    entries: Vec<QueueEntryWire<'a>>,
    steering_entry_id: &'a Option<String>,
    recently_dispatched: &'a [RecentlyDispatchedQueueEntry],
    pause: &'a Option<QueuePause>,
    reorder_revision: u64,
}

impl Serialize for ClientChatExecutionControlState {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let control = &self.0;
        let ChatQueueState {
            entries,
            steering_entry_id,
            recently_dispatched,
            pause,
            reorder_revision,
        } = &control.queue;
        ControlWire {
            server_instance_id: &control.server_instance_id,
            queue: QueueWire {
                entries: entries.iter().map(QueueEntryWire::from).collect(),
                steering_entry_id,
                recently_dispatched,
                pause,
                reorder_revision: *reorder_revision,
            },
            version: control.version,
            updated_at: &control.updated_at,
        }
        .serialize(serializer)
    }
}
