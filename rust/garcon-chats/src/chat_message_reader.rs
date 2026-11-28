//! Ports the transcript read ports in `server/controller/chats/chat-message-reader.ts`.

use async_trait::async_trait;
use garcon_contract::{
    chat_view::{ResendCandidate, TranscriptPage, TranscriptReadPurpose},
    ticket_source_navigation::TicketSourceResolution,
    tickets::TicketSource,
    transcript_anchor_page::TranscriptAnchorRequest,
};
use garcon_interface::resources::ExecutorResult;
use garcon_js::Number;
use garcon_ledger::{
    store::TranscriptReadSignal,
    view_reader::{TranscriptAnchorRead, TranscriptViewReader},
};
use tokio_util::sync::CancellationToken;

pub type ResendCandidates = dyn Fn(&str) -> ExecutorResult<Vec<ResendCandidate>>;

#[async_trait(?Send)]
pub trait TranscriptPageReader {
    async fn page(
        &self,
        chat_id: &str,
        limit: u64,
        before_ordinal: Option<u64>,
        expected_transcript_view_id: Option<&str>,
        signal: &CancellationToken,
        purpose: Option<TranscriptReadPurpose>,
    ) -> ExecutorResult<TranscriptPage>;
}

#[async_trait(?Send)]
pub trait TicketSourceReader {
    async fn resolve_ticket_source(
        &self,
        source: &TicketSource,
        signal: &CancellationToken,
    ) -> ExecutorResult<TicketSourceResolution>;
}

#[async_trait(?Send)]
pub trait TranscriptAnchorPageReader {
    async fn anchor_page(
        &self,
        request: &TranscriptAnchorRequest,
        signal: &CancellationToken,
    ) -> ExecutorResult<TranscriptAnchorRead>;
}

#[async_trait(?Send)]
impl TranscriptPageReader for TranscriptViewReader {
    async fn page(
        &self,
        chat_id: &str,
        limit: u64,
        before_ordinal: Option<u64>,
        expected_transcript_view_id: Option<&str>,
        signal: &CancellationToken,
        _purpose: Option<TranscriptReadPurpose>,
    ) -> ExecutorResult<TranscriptPage> {
        self.page(
            chat_id,
            Number(limit as f64),
            before_ordinal.map(|ordinal| Number(ordinal as f64)),
            expected_transcript_view_id,
            Some(TranscriptReadSignal::new(signal)),
        )
        .await
    }
}

#[async_trait(?Send)]
impl TranscriptAnchorPageReader for TranscriptViewReader {
    async fn anchor_page(
        &self,
        request: &TranscriptAnchorRequest,
        signal: &CancellationToken,
    ) -> ExecutorResult<TranscriptAnchorRead> {
        let request = serde_json::to_value(request)?;
        self.anchor_page(&request, Some(TranscriptReadSignal::new(signal)))
            .await
    }
}

#[async_trait(?Send)]
impl TicketSourceReader for TranscriptViewReader {
    async fn resolve_ticket_source(
        &self,
        source: &TicketSource,
        signal: &CancellationToken,
    ) -> ExecutorResult<TicketSourceResolution> {
        self.resolve_ticket_source(source, Some(TranscriptReadSignal::new(signal)))
    }
}
