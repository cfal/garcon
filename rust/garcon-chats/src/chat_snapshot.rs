//! The snapshot reply in the order written by the controller.

use garcon_contract::{
    chat_execution_control::ChatExecutionControlState, chat_snapshot::ChatSnapshotTranscript,
    chat_transient_feed::ChatTransientFeedSnapshot, chat_types::ChatProcessingPhase,
};
use serde::Serialize;

use crate::chat_list_projector::{ChatSummaryProjection, ProjectedChatSnapshot};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSnapshot {
    pub observed_at: String,
    pub message_limit: u64,
    pub chat: ProjectedChatSnapshot,
    pub processing_phase: Option<ChatProcessingPhase>,
    pub control: ChatExecutionControlState,
    pub transient_feed: ChatTransientFeedSnapshot,
    pub transcript: ChatSnapshotTranscript,
}

impl ChatSnapshot {
    pub fn new(
        observed_at: String,
        message_limit: u64,
        summary: ChatSummaryProjection,
        control: ChatExecutionControlState,
        transient_feed: ChatTransientFeedSnapshot,
        transcript: ChatSnapshotTranscript,
    ) -> Self {
        let ChatSummaryProjection {
            chat,
            processing_phase,
        } = summary;
        Self {
            observed_at,
            message_limit,
            chat,
            processing_phase,
            control,
            transient_feed,
            transcript,
        }
    }
}

pub fn snapshot_transcript_view(
    transcript: &ChatSnapshotTranscript,
    ownership_epoch: &str,
    current_feed_view: impl FnOnce() -> Option<String>,
) -> String {
    match transcript {
        ChatSnapshotTranscript::Available(page) => page.transcript_view_id.clone(),
        _ => current_feed_view().unwrap_or_else(|| format!("pending:{ownership_epoch}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_contract::chat_view::TranscriptPage;

    #[test]
    fn uses_the_page_view_without_reading_the_current_feed() {
        let transcript = ChatSnapshotTranscript::Available(TranscriptPage {
            transcript_view_id: "fixture-view".into(),
            messages: vec![],
            last_ordinal: 0,
            page_oldest_ordinal: 0,
            page_newest_ordinal: 0,
            next_before_ordinal: None,
            has_more: false,
        });
        assert_eq!(
            snapshot_transcript_view(&transcript, "epoch", || panic!(
                "must not read current feed"
            )),
            "fixture-view"
        );
    }

    #[test]
    fn uses_the_existing_feed_or_the_ownership_epoch_when_no_page_was_read() {
        let transcript = ChatSnapshotTranscript::NotRequested;
        assert_eq!(
            snapshot_transcript_view(&transcript, "epoch", || Some("feed-view".into())),
            "feed-view"
        );
        assert_eq!(
            snapshot_transcript_view(&transcript, "epoch", || None),
            "pending:epoch"
        );
    }
}
