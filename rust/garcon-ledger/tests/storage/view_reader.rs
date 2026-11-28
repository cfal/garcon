use std::{
    error::Error,
    future::{pending, ready},
    path::Path,
    process::Command,
    rc::Rc,
};

use futures::{future::LocalBoxFuture, poll};
use garcon_base::{
    domain_error::as_domain_error,
    errors::{DiagnosticError, ErrorInput},
    http_error::json_error_from_unknown,
};
use garcon_contract::{
    chat_view::ChatHistoryState, error_codes::ErrorCode,
    ticket_source_navigation::TicketSourceResolution, tickets::TicketSource,
};
use garcon_js::Number;
use garcon_ledger::{
    contracts::{
        LedgerRowData, LedgerRowDraft, RunOrigin, RunOutcome, TranscriptView, transcript_view_id,
    },
    errors::LedgerError,
    sqlite_operations::LedgerResult,
    store::{TranscriptLedgerStore, TranscriptReadSignal},
    view_reader::{
        TranscriptHistoryUnavailableError, TranscriptViewAdoption, TranscriptViewReader,
    },
};
use rusqlite::Connection;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::bulk_views::{initialize, notice, store};

const AT: &str = "2026-11-28T09:00:00.000Z";
const CHAT_ID: &str = "1795856400000000";
const VIEW: &str = "reader-view";

struct ExistingView(Rc<TranscriptLedgerStore>);

impl TranscriptViewAdoption for ExistingView {
    fn ensure<'a>(
        &'a self,
        chat_id: &'a str,
        signal: Option<TranscriptReadSignal<'a>>,
    ) -> LocalBoxFuture<'a, LedgerResult<TranscriptView>> {
        Box::pin(ready((|| {
            if let Some(signal) = signal {
                signal.check()?;
            }
            self.0.existing_current_view(chat_id)?.ok_or_else(|| {
                LedgerError::ViewNotInitialized {
                    chat_id: chat_id.into(),
                }
                .into()
            })
        })()))
    }
}

fn reader(store: &Rc<TranscriptLedgerStore>) -> TranscriptViewReader {
    TranscriptViewReader::new(store.clone(), Rc::new(ExistingView(store.clone())))
}

fn terminal() -> LedgerRowDraft {
    LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data: LedgerRowData::RunEnded {
            origin: RunOrigin::Core,
            outcome: RunOutcome::Finished,
            error: None,
        },
    }
}

async fn native_read(root: &Path) -> String {
    let store = store(root);
    let reader = reader(&store);
    let view = transcript_view_id(VIEW).unwrap();
    let newest = reader
        .page(CHAT_ID, Number(1.0), Some(Number(999.0)), Some(VIEW), None)
        .await
        .unwrap();
    assert_eq!(
        (newest.page_oldest_ordinal, newest.page_newest_ordinal),
        (204, 204)
    );
    let hidden = reader
        .page(
            CHAT_ID,
            Number(1.0),
            newest.next_before_ordinal.map(|id| Number(id as f64)),
            Some(VIEW),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        (hidden.page_oldest_ordinal, hidden.page_newest_ordinal),
        (0, 203)
    );
    assert!(hidden.has_more && hidden.messages.is_empty());
    let empty = reader
        .page(CHAT_ID, Number(1.0), Some(Number(1.0)), Some(VIEW), None)
        .await
        .unwrap();
    assert!(!empty.has_more && empty.messages.is_empty());
    assert_eq!(empty.page_newest_ordinal, 0);
    let replay = reader
        .replay(CHAT_ID, &view, Number(1.0), None, None)
        .await
        .unwrap();
    assert!(replay.has_more && replay.append.messages.is_empty());
    assert_eq!(replay.next_after_ordinal.0, 201.0);
    let continued = reader
        .replay(
            CHAT_ID,
            &view,
            replay.next_after_ordinal,
            Some(replay.through_ordinal),
            None,
        )
        .await
        .unwrap();
    assert!(!continued.has_more);
    assert_eq!(continued.append.messages[0].ordinal.0, 204.0);
    let anchor = reader.anchor_page(&anchor_request(), None).await.unwrap();
    assert_eq!((anchor.start_ordinal, anchor.end_ordinal), (1, 205));
    assert_eq!(anchor.messages.len(), 2);
    let snapshot = reader
        .with_stored_snapshot(CHAT_ID, |snapshot| ready(Ok(snapshot)), None)
        .await
        .unwrap();
    assert_eq!(snapshot.rows.len(), 204);
    store.close().unwrap();
    serde_json::to_string(&serde_json::json!({
        "newest": newest, "hidden": hidden, "empty": empty,
        "replay": replay, "continued": continued, "anchor": anchor, "snapshot": snapshot
    }))
    .unwrap()
}

fn anchor_request() -> serde_json::Value {
    json!({ "chatId": CHAT_ID, "direction": "backward", "anchorsRemaining": 1 })
}

fn bun_read(root: &Path, mode: &str) -> String {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/view-reader-oracle.ts"
        ))
        .arg(mode)
        .arg(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim_end().into()
}

// TLV5-PAGE.08, TLV5-PAGE.09 and TLV5-REPLAY.04 use raw, not visible, coverage.
#[tokio::test]
async fn public_page_and_replay_match_bun_on_ledgers_from_both_writers() {
    let original = tempfile::tempdir().unwrap();
    let expected = bun_read(original.path(), "write");
    assert_eq!(native_read(original.path()).await, expected);
    let native = tempfile::tempdir().unwrap();
    let writer = store(native.path());
    let mut rows = vec![notice("First")];
    rows.extend(std::iter::repeat_with(terminal).take(202));
    rows.push(notice("Last"));
    initialize(&writer, CHAT_ID, VIEW, &rows);
    writer.close().unwrap();
    assert_eq!(bun_read(native.path(), "read"), expected);
    assert_eq!(native_read(native.path()).await, expected);
}

#[tokio::test]
async fn tlv5_l11_01_view_reader_unit_01_presents_fenced_reads_as_non_retryable_degraded_history() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    initialize(&store, CHAT_ID, VIEW, &[notice("synthetic")]);
    let reader = reader(&store);
    let db = Connection::open(root.path().join(CHAT_ID).join("ledger.sqlite")).unwrap();
    db.execute("UPDATE transcript_rows SET payload_json = '{}'", [])
        .unwrap();
    let error = reader
        .page(CHAT_ID, Number(1.0), None, Some("replaced"), None)
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref(),
        Some(LedgerError::StaleView { .. })
    ));
    let view = transcript_view_id(VIEW).unwrap();
    let error = reader
        .replay(CHAT_ID, &view, Number(0.0), Some(Number(2.0)), None)
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref(),
        Some(LedgerError::InvalidReplayRequest(_))
    ));
    let error = reader
        .page(CHAT_ID, Number(1.0), None, Some(VIEW), None)
        .await
        .unwrap_err();
    let response =
        json_error_from_unknown(ErrorInput::Error(error.as_ref()), None, None, None).unwrap();
    assert_eq!(response.status().as_u16(), 422);
    assert_eq!(
        garcon_js::json::from_slice::<serde_json::Value>(response.body()).unwrap(),
        json!({
            "success": false,
            "error": "The transcript ledger is unavailable",
            "errorCode": "TRANSCRIPT_UNAVAILABLE",
            "retryable": false,
        }),
    );
    let domain = as_domain_error(error.as_ref()).expect("erased transcript error is a DomainError");
    assert_eq!(domain.code, ErrorCode::TRANSCRIPT_UNAVAILABLE);
    assert_eq!(domain.status, 422);
    assert!(!domain.retryable);
    let error = error
        .downcast::<TranscriptHistoryUnavailableError>()
        .unwrap();
    assert_eq!(error.diagnostic_metadata().name, "DomainError");
    assert_eq!(error.domain_error().code, ErrorCode::TRANSCRIPT_UNAVAILABLE);
    assert_eq!(error.domain_error().status, 422);
    assert!(matches!(
        error.source().and_then(|source| source.downcast_ref()),
        Some(LedgerError::Fenced { .. })
    ));
    assert_eq!(
        error.history_state,
        ChatHistoryState::Degraded {
            error_code: "LEDGER_FENCED".into(),
            retryable: false
        }
    );
}

#[tokio::test]
async fn rejects_excess_captures_before_adoption_and_releases_admission_when_a_consumer_drops() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    initialize(&store, CHAT_ID, VIEW, &[notice("synthetic")]);
    let reader = reader(&store);
    let mut captures = (0..4)
        .map(|_| {
            Box::pin(reader.with_stored_snapshot(CHAT_ID, |_| pending::<LedgerResult<()>>(), None))
        })
        .collect::<Vec<_>>();
    for capture in &mut captures {
        assert!(poll!(capture.as_mut()).is_pending());
    }
    let error = reader
        .with_stored_snapshot("unregistered", |_| ready(Ok(())), None)
        .await
        .unwrap_err();
    assert_eq!(
        as_domain_error(error.as_ref()).unwrap().code,
        ErrorCode::TRANSCRIPT_WORK_BUSY
    );
    drop(captures.pop());
    let count = reader
        .with_stored_snapshot(CHAT_ID, |snapshot| ready(Ok(snapshot.rows.len())), None)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn anchor_validation_and_shutdown_do_not_adopt_a_view() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let reader = reader(&store);
    reader.close();
    let error = reader.anchor_page(&json!({}), None).await.unwrap_err();
    assert_eq!(
        as_domain_error(error.as_ref()).unwrap().code,
        ErrorCode::VALIDATION_FAILED
    );
    let error = reader
        .anchor_page(&anchor_request(), None)
        .await
        .unwrap_err();
    assert_eq!(
        as_domain_error(error.as_ref()).unwrap().code,
        ErrorCode::SERVER_SHUTTING_DOWN
    );
    let caller = CancellationToken::new();
    caller.cancel();
    let abort = || std::io::Error::other("synthetic abort").into();
    let error = reader
        .anchor_page(
            &anchor_request(),
            Some(TranscriptReadSignal::with_reason(&caller, &abort)),
        )
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "synthetic abort");
    assert!(!root.path().join(CHAT_ID).exists());
}

#[tokio::test]
async fn ticket_source_resolution_does_not_adopt_a_missing_or_replaced_view() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let reader = reader(&store);
    let source = TicketSource {
        chat_id: CHAT_ID.into(),
        transcript_view_id: "old-view".into(),
        ordinal: 1,
    };
    assert_eq!(
        reader.resolve_ticket_source(&source, None).unwrap(),
        TicketSourceResolution::OutcomeUnavailable {
            chat_id: CHAT_ID.into()
        }
    );
    assert!(!root.path().join(CHAT_ID).exists());
    initialize(&store, CHAT_ID, VIEW, &[notice("synthetic")]);
    assert_eq!(
        reader.resolve_ticket_source(&source, None).unwrap(),
        TicketSourceResolution::TranscriptReloaded {
            chat_id: CHAT_ID.into()
        }
    );
}
