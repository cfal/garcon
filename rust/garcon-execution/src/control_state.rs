//! Ports `server/controller/chat-execution/control-state.ts`.

use garcon_contract::attachments::MAX_CHAT_ATTACHMENT_TOTAL_BYTES;
use garcon_contract::chat_execution_control::ChatExecutionControlState;
pub use garcon_contract::queue_state::MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES;
use garcon_contract::queue_state::{
    ChatQueueState, QueueEntry, QueueEntryAttachment, QueueEntryKind, QueuePause,
    RecentlyDispatchedQueueEntry,
};
use garcon_contract::transcript_notice_details::TranscriptNoticeDetail;
use garcon_contract::ws_requests::AgentCommandImage;
use garcon_js::{Number, utf16};
use serde::Serialize;

use crate::control_projection::{ClientChatExecutionControlState, ClientQueueEntry};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredQueueSubmissionIdentity {
    pub client_message_id: String,
    pub transcript_view_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excluded_resend_ordinals: Option<Vec<Number>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StoredQueueEntryStatus {
    Queued,
    Steering,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredQueueEntry {
    pub id: String,
    pub content: String,
    pub kind: QueueEntryKind,
    pub images: Vec<AgentCommandImage>,
    pub revision: u64,
    pub status: StoredQueueEntryStatus,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submission: Option<StoredQueueSubmissionIdentity>,
}

pub const MAX_QUEUED_ATTACHMENT_BYTES: u64 = 2 * MAX_CHAT_ATTACHMENT_TOTAL_BYTES;

pub fn queued_attachment_bytes(images: &[AgentCommandImage]) -> i64 {
    images
        .iter()
        .map(|image| {
            let base64 = image
                .data
                .split_once(',')
                .map_or(image.data.as_str(), |(_, rest)| rest);
            let padding = if base64.ends_with("==") {
                2
            } else {
                i64::from(base64.ends_with('='))
            };
            (utf16::len(base64) as i64 * 3) / 4 - padding
        })
        .sum()
}

pub fn queue_entry_attachments(images: &[AgentCommandImage]) -> Vec<QueueEntryAttachment> {
    images
        .iter()
        .enumerate()
        .map(|(index, image)| QueueEntryAttachment {
            name: image
                .name
                .as_ref()
                .filter(|name| !name.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("image-{}", index + 1)),
            mime_type: image
                .mime_type
                .as_ref()
                .filter(|kind| !kind.is_empty())
                .cloned()
                .unwrap_or_else(|| "application/octet-stream".into()),
        })
        .collect()
}

pub fn to_client_queue_entry(entry: &StoredQueueEntry) -> ClientQueueEntry {
    ClientQueueEntry(QueueEntry {
        id: entry.id.clone(),
        content: entry.content.clone(),
        kind: entry.kind,
        attachments: queue_entry_attachments(&entry.images),
        revision: entry.revision,
        created_at: entry.created_at.clone(),
        updated_at: entry.updated_at.clone(),
    })
}

pub fn clone_stored_queue_entry(entry: &StoredQueueEntry) -> StoredQueueEntry {
    entry.clone()
}

pub const MAX_CONTROL_INPUT_ENTRIES: usize = 64;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoredControlReceipt {
    pub title: String,
    pub content: String,
    pub detail: Box<TranscriptNoticeDetail>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredControlInput {
    pub content: String,
    pub transcript_view_id: String,
    pub created_at: String,
    pub receipt: Option<StoredControlReceipt>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoredControlInputEntry {
    pub id: String,
    #[serde(flatten)]
    pub input: StoredControlInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StoredQueueCommandOperation {
    Create,
    Replace,
    Delete,
    Move,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAppliedQueueCommand {
    pub key: String,
    pub operation: StoredQueueCommandOperation,
    pub entry_id: String,
    pub applied_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredChatExecutionControlState {
    pub server_instance_id: String,
    pub entries: Vec<StoredQueueEntry>,
    pub control_entries: Vec<StoredControlInputEntry>,
    pub recently_dispatched: Vec<RecentlyDispatchedQueueEntry>,
    pub applied_commands: Vec<StoredAppliedQueueCommand>,
    pub pause: Option<QueuePause>,
    pub reorder_revision: u64,
    pub version: u64,
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_pauses: Option<Vec<QueuePause>>,
}

pub const MAX_STORED_APPLIED_QUEUE_COMMANDS: usize = 1000;

pub fn empty_stored_chat_execution_control(
    server_instance_id: &str,
) -> StoredChatExecutionControlState {
    StoredChatExecutionControlState {
        server_instance_id: server_instance_id.to_owned(),
        entries: Vec::new(),
        control_entries: Vec::new(),
        recently_dispatched: Vec::new(),
        applied_commands: Vec::new(),
        pause: None,
        reorder_revision: 0,
        version: 0,
        updated_at: None,
        resume_pauses: None,
    }
}

pub fn clone_stored_chat_execution_control(
    control: &StoredChatExecutionControlState,
) -> StoredChatExecutionControlState {
    let mut cloned = control.clone();
    if cloned.resume_pauses.as_ref().is_some_and(Vec::is_empty) {
        cloned.resume_pauses = None;
    }
    cloned
}

pub fn has_pending_turn_input(control: &StoredChatExecutionControlState) -> bool {
    !control.control_entries.is_empty() || !control.entries.is_empty()
}

pub fn to_client_chat_execution_control_state(
    control: &StoredChatExecutionControlState,
) -> ClientChatExecutionControlState {
    let first_retained = control
        .recently_dispatched
        .len()
        .saturating_sub(MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES);
    ClientChatExecutionControlState(ChatExecutionControlState {
        server_instance_id: control.server_instance_id.clone(),
        queue: ChatQueueState {
            entries: control
                .entries
                .iter()
                .map(|entry| to_client_queue_entry(entry).into())
                .collect(),
            steering_entry_id: control
                .entries
                .iter()
                .find(|entry| entry.status == StoredQueueEntryStatus::Steering)
                .map(|entry| entry.id.clone()),
            recently_dispatched: control.recently_dispatched[first_retained..].to_vec(),
            pause: control.pause.clone(),
            reorder_revision: control.reorder_revision,
        },
        version: control.version,
        updated_at: control.updated_at.clone(),
    })
}
