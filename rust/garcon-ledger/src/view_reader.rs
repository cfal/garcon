use std::{cell::Cell, error::Error, fmt, future::Future, rc::Rc};

use futures::future::LocalBoxFuture;
use garcon_base::{
    domain_error::DomainError,
    errors::{DiagnosticError, ErrorMetadata, NamedError},
};
use garcon_contract::{
    chat_view::{
        CHAT_MESSAGES_MAX_LIMIT, ChatHistoryState, TranscriptAppend, TranscriptMessage,
        TranscriptPage, TranscriptReplayResult,
    },
    error_codes::ErrorCode,
    ticket_source_navigation::TicketSourceResolution,
    tickets::TicketSource,
    transcript_anchor_page::{
        TranscriptAnchorDirection, TranscriptAnchorPageStatus, parse_transcript_anchor_request,
    },
};
use garcon_js::{Number, is_safe_integer};
use serde::Serialize;
use serde_json::Value;

use crate::{
    anchor_page::{AnchorScanInput, AnchorScanResult},
    codec::StoredLedgerRow,
    contracts::{TranscriptView, TranscriptViewId},
    errors::LedgerError,
    presentation::ledger_rows_to_transcript_messages,
    sqlite_operations::LedgerResult,
    store::{TranscriptLedgerStore, TranscriptReadSignal},
};

mod shutdown;
use shutdown::ReadShutdown;

const MAX_STORED_SNAPSHOTS: usize = 4;

/// Creates a current view only for a registered chat and repairs its session cache.
pub trait TranscriptViewAdoption {
    fn ensure<'a>(
        &'a self,
        chat_id: &'a str,
        signal: Option<TranscriptReadSignal<'a>>,
    ) -> LocalBoxFuture<'a, LedgerResult<TranscriptView>>;
}

pub struct TranscriptViewReader {
    store: Rc<TranscriptLedgerStore>,
    adoption: Rc<dyn TranscriptViewAdoption>,
    shutdown: ReadShutdown,
    stored_snapshots: Cell<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptAnchorRead {
    pub start_ordinal: u64,
    pub end_ordinal: u64,
    pub anchors_remaining: u64,
    pub page_status: TranscriptAnchorPageStatus,
    pub direction: TranscriptAnchorDirection,
    pub transcript_view_id: TranscriptViewId,
    pub watermark_ordinal: u64,
    pub last_ordinal: u64,
    pub messages: Vec<TranscriptMessage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTranscriptSnapshot {
    pub transcript_view_id: TranscriptViewId,
    pub last_ordinal: u64,
    pub content_start_ordinal: u64,
    pub rows: Vec<StoredLedgerRow>,
}

impl TranscriptViewReader {
    pub fn new(store: Rc<TranscriptLedgerStore>, adoption: Rc<dyn TranscriptViewAdoption>) -> Self {
        Self {
            store,
            adoption,
            shutdown: ReadShutdown::default(),
            stored_snapshots: Cell::new(0),
        }
    }

    pub fn close(&self) {
        self.shutdown.close();
    }

    pub async fn page(
        &self,
        chat_id: &str,
        limit: Number,
        before_ordinal: Option<Number>,
        expected_view_id: Option<&str>,
        signal: Option<TranscriptReadSignal<'_>>,
    ) -> LedgerResult<TranscriptPage> {
        let limit = limit.0;
        let before = before_ordinal.map(|ordinal| ordinal.0);
        if !is_safe_integer(limit) || !(1.0..=1000.0).contains(&limit) {
            return Err(type_error(
                "Transcript page limit must be between 1 and 1000",
            ));
        }
        if before.is_some_and(|ordinal| !is_safe_integer(ordinal) || ordinal < 1.0) {
            return Err(type_error(
                "Transcript page cursor must be a positive integer",
            ));
        }
        let result = async {
            let view = self.adoption.ensure(chat_id, signal).await?;
            if let Some(expected) = expected_view_id.filter(|expected| !expected.is_empty()) {
                assert_expected_view(chat_id, expected, &view.view_id)?;
            }
            let high = self.store.high_watermark(chat_id)?.ordinal;
            let before = before.map_or(high + 1, |ordinal| (ordinal as u64).min(high + 1));
            check_signal(signal)?;
            let raw = self
                .store
                .page(chat_id, &view.view_id, limit as u64, Some(before))?;
            let messages = ledger_rows_to_transcript_messages(chat_id, &raw.rows);
            Ok(TranscriptPage {
                transcript_view_id: view.view_id.to_string(),
                page_oldest_ordinal: messages.first().map_or(0, |entry| entry.ordinal.0 as u64),
                messages,
                last_ordinal: high,
                page_newest_ordinal: before - 1,
                next_before_ordinal: raw.next_before,
                has_more: raw.next_before.is_some(),
            })
        }
        .await;
        result.map_err(translate_read_fence)
    }

    pub async fn replay(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        after_ordinal: Number,
        through_ordinal: Option<Number>,
        signal: Option<TranscriptReadSignal<'_>>,
    ) -> LedgerResult<TranscriptReplayResult> {
        let result = async {
            check_signal(signal)?;
            let view = self.adoption.ensure(chat_id, signal).await?;
            assert_expected_view(chat_id, view_id.as_str(), &view.view_id)?;
            let after = after_ordinal.0;
            if !is_safe_integer(after) || after < 0.0 {
                return Err(invalid_replay(
                    "Transcript replay cursor must be a non-negative safe integer",
                ));
            }
            let high = self.store.high_watermark(chat_id)?.ordinal;
            let through = through_ordinal.map_or(high as f64, |ordinal| ordinal.0);
            if !is_safe_integer(through) || through < after {
                return Err(invalid_replay(
                    "Transcript replay watermark must not precede its cursor",
                ));
            }
            if through > high as f64 {
                return Err(invalid_replay(
                    "Transcript replay watermark is ahead of the current view",
                ));
            }
            let after = after as u64;
            let through = through as u64;
            let rows = self.store.replay_rows(
                chat_id,
                view_id,
                after,
                through,
                CHAT_MESSAGES_MAX_LIMIT,
            )?;
            let next = rows.last().map_or(after, |row| row.ordinal);
            if next == after && after < through {
                return Err(named_error(
                    "Error",
                    "Transcript replay page did not advance its cursor",
                ));
            }
            Ok(TranscriptReplayResult {
                append: TranscriptAppend {
                    transcript_view_id: view_id.to_string(),
                    first_ordinal: Number((after + 1) as f64),
                    last_ordinal: Number(next as f64),
                    messages: ledger_rows_to_transcript_messages(chat_id, &rows),
                },
                next_after_ordinal: Number(next as f64),
                through_ordinal: Number(through as f64),
                has_more: next < through,
            })
        }
        .await;
        result.map_err(translate_read_fence)
    }

    pub async fn anchor_page(
        &self,
        request: &Value,
        caller: Option<TranscriptReadSignal<'_>>,
    ) -> LedgerResult<TranscriptAnchorRead> {
        let request = parse_transcript_anchor_request(request)
            .map_err(|error| DomainError::new_validation(error.to_string()))?;
        let read = self.shutdown.begin(caller);
        let abort_reason = || read.reason(caller);
        let signal = TranscriptReadSignal::with_reason(read.token(), &abort_reason);
        let result = async {
            let chat_id = &request.chat_id;
            signal.check()?;
            let view = self.adoption.ensure(chat_id, Some(signal)).await?;
            let assert_current = || -> LedgerResult<()> {
                signal.check()?;
                let current = self.store.existing_current_view(chat_id)?.ok_or_else(|| {
                    LedgerError::ViewNotInitialized {
                        chat_id: chat_id.clone(),
                    }
                })?;
                assert_expected_view(chat_id, view.view_id.as_str(), &current.view_id)
            };
            assert_current()?;
            if let Some(expected) = request.transcript_view_id.as_deref() {
                assert_expected_view(chat_id, expected, &view.view_id)?;
            }
            let head = self.store.high_watermark(chat_id)?;
            assert_expected_view(chat_id, view.view_id.as_str(), &head.view_id)?;
            let watermark = request.watermark_ordinal.unwrap_or(head.ordinal);
            let backward = request.direction == TranscriptAnchorDirection::Backward;
            let cursor = request
                .cursor_ordinal
                .unwrap_or(if backward { watermark + 1 } else { 0 });
            if watermark > head.ordinal || cursor > head.ordinal + u64::from(backward) {
                return Err(DomainError::new(
                    ErrorCode::TRANSCRIPT_CURSOR_AHEAD,
                    "Transcript cursor is ahead of the current view",
                    409,
                    false,
                )
                .into());
            }
            let AnchorScanResult {
                rows,
                start_ordinal,
                end_ordinal,
                anchors_remaining,
                page_status,
            } = self
                .store
                .anchor_page(
                    chat_id,
                    &view.view_id,
                    AnchorScanInput {
                        direction: request.direction,
                        cursor_ordinal: cursor,
                        watermark_ordinal: watermark,
                        anchors_remaining: request.anchors_remaining,
                    },
                    Some(signal),
                )
                .await?;
            assert_current()?;
            Ok(TranscriptAnchorRead {
                start_ordinal,
                end_ordinal,
                anchors_remaining,
                page_status,
                direction: request.direction,
                transcript_view_id: view.view_id,
                watermark_ordinal: watermark,
                last_ordinal: head.ordinal,
                messages: ledger_rows_to_transcript_messages(chat_id, &rows),
            })
        }
        .await;
        result.map_err(translate_read_fence)
    }

    pub async fn with_stored_snapshot<T, Work>(
        &self,
        chat_id: &str,
        work: impl FnOnce(StoredTranscriptSnapshot) -> Work,
        caller: Option<TranscriptReadSignal<'_>>,
    ) -> LedgerResult<T>
    where
        Work: Future<Output = LedgerResult<T>>,
    {
        let read = self.shutdown.begin(caller);
        let abort_reason = || read.reason(caller);
        let signal = TranscriptReadSignal::with_reason(read.token(), &abort_reason);
        signal.check()?;
        let count = self.stored_snapshots.get();
        if count >= MAX_STORED_SNAPSHOTS {
            return Err(DomainError::new(
                ErrorCode::TRANSCRIPT_WORK_BUSY,
                "Transcript snapshot capacity is full. Try again later.",
                503,
                true,
            )
            .into());
        }
        self.stored_snapshots.set(count + 1);
        let _slot = SnapshotSlot(&self.stored_snapshots);
        let result = async {
            let view = self.adoption.ensure(chat_id, Some(signal)).await?;
            signal.check()?;
            let head = self.store.high_watermark(chat_id)?;
            let current = self.store.existing_current_view(chat_id)?;
            let Some(current) = current
                .filter(|current| current.view_id == view.view_id && head.view_id == view.view_id)
            else {
                return Err(DomainError::new(
                    ErrorCode::SOURCE_REVISION_CHANGED,
                    "Transcript view changed while capturing the snapshot",
                    409,
                    true,
                )
                .into());
            };
            self.store
                .with_stored_rows_through(
                    chat_id,
                    &head,
                    |rows| {
                        work(StoredTranscriptSnapshot {
                            transcript_view_id: view.view_id,
                            last_ordinal: head.ordinal,
                            content_start_ordinal: current.content_start_ordinal,
                            rows,
                        })
                    },
                    Some(signal),
                )
                .await
        }
        .await;
        result.map_err(translate_read_fence)
    }

    pub fn resolve_ticket_source(
        &self,
        source: &TicketSource,
        signal: Option<TranscriptReadSignal<'_>>,
    ) -> LedgerResult<TicketSourceResolution> {
        use TicketSourceResolution::*;
        let read = || {
            check_signal(signal)?;
            let chat_id = &source.chat_id;
            let Some(current) = self.store.existing_current_view(chat_id)? else {
                return Ok(OutcomeUnavailable {
                    chat_id: chat_id.clone(),
                });
            };
            if current.view_id.as_str() != source.transcript_view_id {
                return Ok(TranscriptReloaded {
                    chat_id: chat_id.clone(),
                });
            }
            let outcome =
                self.store
                    .ticket_outcome_ordinal(chat_id, &current.view_id, source.ordinal)?;
            Ok(match outcome {
                Some(ordinal) => Found {
                    target: TicketSource {
                        ordinal,
                        ..source.clone()
                    },
                },
                None => OutcomeUnavailable {
                    chat_id: chat_id.clone(),
                },
            })
        };
        read().map_err(translate_read_fence)
    }
}

struct SnapshotSlot<'a>(&'a Cell<usize>);

impl Drop for SnapshotSlot<'_> {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}

#[derive(Debug)]
pub struct TranscriptHistoryUnavailableError {
    domain: DomainError,
    pub history_state: ChatHistoryState,
}

impl TranscriptHistoryUnavailableError {
    pub fn domain_error(&self) -> &DomainError {
        &self.domain
    }
}

impl DiagnosticError for TranscriptHistoryUnavailableError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: self.domain.kind.name(),
            code: Some(self.domain.code.as_str()),
        }
    }
}

impl fmt::Display for TranscriptHistoryUnavailableError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.domain, formatter)
    }
}

impl Error for TranscriptHistoryUnavailableError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.domain.source()
    }
}

fn translate_read_fence(error: Box<dyn Error>) -> Box<dyn Error> {
    if !matches!(error.downcast_ref(), Some(LedgerError::Fenced { .. })) {
        return error;
    }
    TranscriptHistoryUnavailableError {
        domain: DomainError::new(
            ErrorCode::TRANSCRIPT_UNAVAILABLE,
            "The transcript ledger is unavailable",
            422,
            false,
        )
        .with_cause(error),
        history_state: ChatHistoryState::Degraded {
            error_code: "LEDGER_FENCED".into(),
            retryable: false,
        },
    }
    .into()
}

fn assert_expected_view(
    chat_id: &str,
    expected: &str,
    actual: &TranscriptViewId,
) -> LedgerResult<()> {
    if expected != actual.as_str() {
        return Err(LedgerError::StaleView {
            chat_id: chat_id.into(),
            requested_view_id: expected.into(),
            current_view_id: actual.to_string(),
        }
        .into());
    }
    Ok(())
}

fn check_signal(signal: Option<TranscriptReadSignal<'_>>) -> LedgerResult<()> {
    signal.map_or(Ok(()), TranscriptReadSignal::check)
}

fn invalid_replay(message: &str) -> Box<dyn Error> {
    LedgerError::InvalidReplayRequest(message.into()).into()
}

fn type_error(message: &str) -> Box<dyn Error> {
    named_error("TypeError", message)
}

fn named_error(name: &str, message: &str) -> Box<dyn Error> {
    NamedError {
        name: name.into(),
        message: message.into(),
        code: None,
    }
    .into()
}
