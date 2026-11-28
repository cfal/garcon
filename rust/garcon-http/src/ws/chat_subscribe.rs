//! Replay and frame sizing for the browser's view-qualified subscription.

use std::{error::Error, rc::Rc};

use bytes::Bytes;
use garcon_base::{
    domain_error::as_domain_error,
    errors::{DiagnosticError, ErrorMetadata},
};
use garcon_chats::{
    chat_message_reader::ResendCandidates, chat_processing_activity::ChatProcessingActivity,
    chat_transient_feed::ChatTransientFeedStore, store::ChatRegistry,
};
use garcon_contract::{
    chat_transient_feed::ChatTransientFeedSnapshot,
    chat_view::{ResendCandidate, TranscriptReplayResult},
    ws_events::{ChatSubscribedMessage, ClientRequestErrorCode, ClientRequestErrorMessage},
    ws_requests::ChatSubscribeRequest,
};
use garcon_js::Number;
use garcon_ledger::{
    contracts::transcript_view_id, errors::LedgerError, view_reader::TranscriptViewReader,
};

const MAX_TRANSCRIPT_REPLAY_FRAME_BYTES: usize = 1024 * 1024;

#[async_trait::async_trait(?Send)]
pub trait ChatSubscriptions {
    async fn subscribe(
        &self,
        request: &ChatSubscribeRequest,
        client_request_id: &str,
        chat_id: &str,
    ) -> Result<Bytes, ClientRequestErrorMessage>;
}

pub struct ChatSubscribeHandler {
    pub registry: Rc<ChatRegistry>,
    pub reader: Rc<TranscriptViewReader>,
    pub processing: Rc<ChatProcessingActivity>,
    pub feeds: Rc<ChatTransientFeedStore>,
    pub resend_candidates: Rc<ResendCandidates>,
}

#[async_trait::async_trait(?Send)]
impl ChatSubscriptions for ChatSubscribeHandler {
    async fn subscribe(
        &self,
        request: &ChatSubscribeRequest,
        client_request_id: &str,
        chat_id: &str,
    ) -> Result<Bytes, ClientRequestErrorMessage> {
        let request_error = |code, message, retryable| {
            ClientRequestErrorMessage::new(
                client_request_id.into(),
                ChatSubscribeRequest::TYPE.into(),
                code,
                message,
                retryable,
                Some(chat_id.into()),
            )
        };
        if !self.registry.has_chat(chat_id) {
            return Err(request_error(
                ClientRequestErrorCode::SessionNotFound,
                format!("Chat not found: {chat_id}"),
                false,
            ));
        }
        let result = async {
            let view = transcript_view_id(&request.transcript_view_id)?;
            let replay = self
                .reader
                .replay(
                    chat_id,
                    &view,
                    Number(request.after_ordinal as f64),
                    request
                        .through_ordinal
                        .map(|ordinal| Number(ordinal as f64)),
                    None,
                )
                .await?;
            let candidates = if self.processing.phase(chat_id).is_none() {
                (self.resend_candidates)(chat_id)?
            } else {
                vec![]
            };
            let feed = self
                .feeds
                .snapshot(chat_id, &replay.append.transcript_view_id)?;
            fit_chat_subscribed_page(client_request_id, chat_id, replay, candidates, feed)
        }
        .await;
        result.map_err(|error| {
            let (code, ordinarily_retryable) = match error.downcast_ref::<LedgerError>() {
                Some(LedgerError::StaleView { .. }) => {
                    (ClientRequestErrorCode::StaleTranscriptView, false)
                }
                Some(LedgerError::InvalidReplayRequest(_)) => {
                    (ClientRequestErrorCode::RequestValidationFailed, false)
                }
                _ => (
                    ClientRequestErrorCode::HistoryLoadFailed,
                    !error.is::<TranscriptReplayFrameLimitError>(),
                ),
            };
            let retryable = as_domain_error(error.as_ref())
                .map_or(ordinarily_retryable, |domain| domain.retryable);
            let mut message = error.to_string();
            if message.is_empty() {
                message = "Failed to replay chat messages".into();
            }
            request_error(code, message, retryable)
        })
    }
}

#[derive(Debug, thiserror::Error)]
#[error("A transcript replay row exceeds the WebSocket response limit")]
struct TranscriptReplayFrameLimitError;

impl DiagnosticError for TranscriptReplayFrameLimitError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "TranscriptReplayFrameLimitError",
            code: None,
        }
    }
}

fn fit_chat_subscribed_page(
    client_request_id: &str,
    chat_id: &str,
    replay: TranscriptReplayResult,
    resend_candidates: Vec<ResendCandidate>,
    transient_feed: ChatTransientFeedSnapshot,
) -> Result<Bytes, Box<dyn Error>> {
    let first_ordinal = replay.append.first_ordinal.0 as u64;
    let next_after_ordinal = replay.next_after_ordinal.0 as u64;
    let through_ordinal = replay.through_ordinal.0 as u64;
    let mut page = ChatSubscribedMessage::new(
        client_request_id.into(),
        chat_id.into(),
        replay.append.transcript_view_id,
        replay.append.messages,
        first_ordinal,
        next_after_ordinal,
        next_after_ordinal,
        through_ordinal,
        next_after_ordinal < through_ordinal,
        resend_candidates,
        transient_feed,
    );
    let full = serde_json::to_vec(&page)?;
    if full.len() <= MAX_TRANSCRIPT_REPLAY_FRAME_BYTES {
        return Ok(Bytes::from(full));
    }
    drop(full);

    let after_ordinal = first_ordinal - 1;
    let mut fitted = None;
    let mut suffix = std::collections::VecDeque::new();
    let mut lower = 0;
    let mut upper = page.messages.len(); // The complete page was too large.
    while lower < upper {
        let count = lower + (upper - lower) / 2;
        // Move rows between the candidate and the excluded suffix instead of
        // cloning large messages at each probe.
        while count > page.messages.len() {
            // INFALLIBLE: the probe is within the original message count.
            page.messages
                .push(suffix.pop_front().expect("row in excluded suffix"));
        }
        while count < page.messages.len() {
            // INFALLIBLE: the candidate has more than count rows.
            suffix.push_front(page.messages.pop().expect("row in candidate"));
        }
        // INFALLIBLE: every probe excludes at least one row.
        let next = suffix.front().expect("excluded row").ordinal.0 as u64 - 1;
        page.last_ordinal = next;
        page.next_after_ordinal = next;
        page.has_more = next < through_ordinal;
        if next <= after_ordinal && page.has_more {
            lower = count + 1;
            continue;
        }
        let bytes = serde_json::to_vec(&page)?;
        if bytes.len() <= MAX_TRANSCRIPT_REPLAY_FRAME_BYTES {
            fitted = Some(Bytes::from(bytes));
            lower = count + 1;
        } else {
            upper = count;
        }
    }
    fitted.ok_or_else(|| TranscriptReplayFrameLimitError.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_contract::{
        chat_types::{AssistantMessage, ChatMessage},
        chat_view::{TranscriptAppend, TranscriptMessage},
    };
    use serde_json::Value;

    fn message(ordinal: u64, content: String) -> TranscriptMessage {
        TranscriptMessage {
            ordinal: Number(ordinal as f64),
            message: ChatMessage::Assistant(AssistantMessage {
                timestamp: "2001-09-09T01:46:40.000Z".into(),
                content,
                questions: None,
            }),
        }
    }

    fn encode_replay(
        messages: Vec<TranscriptMessage>,
        after: u64,
        next: u64,
        through: u64,
    ) -> Result<Bytes, Box<dyn Error>> {
        fit_chat_subscribed_page(
            "request",
            "chat",
            TranscriptReplayResult {
                append: TranscriptAppend {
                    transcript_view_id: "view".into(),
                    first_ordinal: Number((after + 1) as f64),
                    last_ordinal: Number(next as f64),
                    messages,
                },
                next_after_ordinal: Number(next as f64),
                through_ordinal: Number(through as f64),
                has_more: next < through,
            },
            vec![],
            ChatTransientFeedSnapshot {
                server_instance_id: "server".into(),
                chat_id: "chat".into(),
                transcript_view_id: "view".into(),
                transient_revision: 0,
                rows: vec![],
            },
        )
    }

    #[test]
    fn frame_limit_counts_utf8_bytes_and_keeps_the_watermark_and_raw_cursor() {
        let text = "\u{1f680}".repeat(150_000);
        let frame = encode_replay(
            vec![message(11, text.clone()), message(13, text)],
            10,
            200,
            600,
        )
        .unwrap();
        assert!(frame.len() <= MAX_TRANSCRIPT_REPLAY_FRAME_BYTES);
        let body: Value = garcon_js::json::from_slice(&frame).unwrap();
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["ordinal"], 11);
        assert_eq!(body["firstOrdinal"], 11);
        assert_eq!(body["lastOrdinal"], 12);
        assert_eq!(body["nextAfterOrdinal"], 12);
        assert_eq!(body["throughOrdinal"], 600);
        assert_eq!(body["hasMore"], true);
    }

    #[test]
    fn rejects_a_replay_row_that_cannot_fit_in_one_bounded_response_frame() {
        let error = encode_replay(
            vec![message(2, "x".repeat(MAX_TRANSCRIPT_REPLAY_FRAME_BYTES))],
            1,
            2,
            2,
        )
        .unwrap_err();
        assert!(error.is::<TranscriptReplayFrameLimitError>());
        assert_eq!(
            error.to_string(),
            "A transcript replay row exceeds the WebSocket response limit"
        );
    }

    #[test]
    fn a_frame_without_visible_messages_can_consume_hidden_rows() {
        let frame = encode_replay(
            vec![message(5, "x".repeat(MAX_TRANSCRIPT_REPLAY_FRAME_BYTES))],
            1,
            5,
            5,
        )
        .unwrap();
        let body: Value = garcon_js::json::from_slice(&frame).unwrap();
        assert!(body["messages"].as_array().unwrap().is_empty());
        assert_eq!(body["nextAfterOrdinal"], 4);
        assert_eq!(body["hasMore"], true);
    }
}
