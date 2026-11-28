use std::{path::Path, process::Command, time::Instant};

use futures::TryStreamExt;
use garcon_contract::{
    chat_types::{AssistantMessage, ChatMessage},
    transcript_anchor_page::TranscriptAnchorDirection::{Backward, Forward},
};
use garcon_js::json::from_slice;
use garcon_ledger::{
    anchor_page::{AnchorScanInput, AnchorScanProgress, read_anchor_batch},
    codec::decode_stored_ledger_row,
    contracts::{LedgerRowData, LedgerRowDraft, RunOrigin, RunOutcome, transcript_view_id},
    errors::{LedgerError, safe_fence_diagnostic},
    store::{InitializeViewInput, StageViewInput, TranscriptLedgerStore, TranscriptWatermark},
};
use rusqlite::Connection;
use serde_json::{Value, json};

use super::bulk_views::{initialize, notice, store};

const AT: &str = "2026-11-28T09:00:00.000Z";

fn oracle(mode: &str, root: &Path) -> Value {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/read-store-oracle.ts"
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
    eprint!("{}", String::from_utf8_lossy(&output.stderr));
    from_slice(&output.stdout).unwrap()
}

fn interop_drafts() -> Vec<LedgerRowDraft> {
    (0..1207)
        .map(|i| LedgerRowDraft {
            at: AT.into(),
            provider_meta: None,
            data: if i % 113 == 0 {
                LedgerRowData::ProviderRow {
                    message: ChatMessage::Assistant(AssistantMessage {
                        timestamp: AT.into(),
                        content: format!("assistant {i}"),
                        questions: None,
                    }),
                }
            } else if i % 3 == 0 {
                LedgerRowData::RunEnded {
                    origin: RunOrigin::Core,
                    outcome: RunOutcome::Finished,
                    error: None,
                }
            } else {
                return notice(&format!("notice {i}"));
            },
        })
        .collect()
}

async fn native_snapshot(store: &TranscriptLedgerStore, root: &Path) -> Value {
    let watermark = store.high_watermark("ledger").unwrap();
    let view_id = &watermark.view_id;
    let head = watermark.ordinal;
    let newest = store
        .anchor_page(
            "ledger",
            view_id,
            AnchorScanInput {
                direction: Backward,
                cursor_ordinal: head + 1,
                watermark_ordinal: head,
                anchors_remaining: 3,
            },
            None,
        )
        .await
        .unwrap();
    let oldest = store
        .anchor_page(
            "ledger",
            view_id,
            AnchorScanInput {
                direction: Forward,
                cursor_ordinal: 1,
                watermark_ordinal: head - 30,
                anchors_remaining: 2,
            },
            None,
        )
        .await
        .unwrap();
    let batch = {
        let db = Connection::open(root.join("ledger/ledger.sqlite")).unwrap();
        let inputs = AnchorScanInput {
            direction: Forward,
            cursor_ordinal: 0,
            watermark_ordinal: head,
            anchors_remaining: 200,
        };
        let start = Instant::now();
        let result = read_anchor_batch(
            &db,
            view_id,
            &inputs,
            AnchorScanProgress {
                cursor_ordinal: 0,
                anchors_remaining: 200,
            },
            || false,
        )
        .unwrap();
        eprintln!(
            "Rust single anchor batch (200 rows): {:.2} ms",
            start.elapsed().as_secs_f64() * 1000.0
        );
        assert_eq!(result.rows.len(), 200);
        result
    };
    let start = Instant::now();
    let replay = store
        .replay_rows("ledger", view_id, 15, head - 20, 1000)
        .unwrap();
    eprintln!(
        "Rust replay of 1000 raw rows: {:.2} ms",
        start.elapsed().as_secs_f64() * 1000.0
    );
    assert_eq!(replay.len(), 1000);
    let start = Instant::now();
    let current_count = store.current_rows("ledger").unwrap().len();
    eprintln!(
        "Rust current_rows of {current_count} rows: {:.2} ms",
        start.elapsed().as_secs_f64() * 1000.0
    );
    let through = TranscriptWatermark {
        view_id: view_id.clone(),
        ordinal: 1101,
    };
    let pages: Vec<Vec<u64>> = store
        .row_pages_through("ledger", &through, 7, None)
        .map_ok(|page| page.into_iter().map(|row| row.ordinal).collect())
        .try_collect()
        .await
        .unwrap();
    let stored = store
        .with_stored_rows_through(
            "ledger",
            &TranscriptWatermark {
                view_id: view_id.clone(),
                ordinal: 4,
            },
            |rows| async move { Ok(rows) },
            None,
        )
        .await
        .unwrap();
    json!({"watermark": watermark, "newest": newest, "oldest": oldest, "batch": batch,
        "replay": replay, "currentCount": current_count, "pages": pages, "stored": stored})
}

#[tokio::test]
async fn anchor_replay_and_prefix_pages_match_bun_on_both_writers() {
    let bun_root = tempfile::tempdir().unwrap();
    let expected = oracle("write", bun_root.path());
    let reader = store(bun_root.path());
    assert_eq!(native_snapshot(&reader, bun_root.path()).await, expected);
    reader.close().unwrap();

    let native_root = tempfile::tempdir().unwrap();
    let native = store(native_root.path());
    native
        .seed_current_view(
            "ledger",
            InitializeViewInput {
                view_id: Some(transcript_view_id("read-interop").unwrap()),
                content_start_ordinal: 1,
                rows: &interop_drafts(),
            },
        )
        .await
        .unwrap();
    let native_result = native_snapshot(&native, native_root.path()).await;
    native.close().unwrap();
    assert_eq!(oracle("read", native_root.path()), native_result);
    assert_eq!(native_result, expected);
}

// TLV5-REPLAY.01, .02, .05, .07: fixed-watermark raw storage continuations.
#[tokio::test]
async fn replay_keeps_its_fixed_watermark_and_rejects_a_replaced_view() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let initial = transcript_view_id("initial").unwrap();
    initialize(
        &store,
        "ledger",
        initial.as_str(),
        &vec![notice("synthetic"); 8],
    );
    let fixed = store.high_watermark("ledger").unwrap();
    let first = store
        .replay_rows("ledger", &initial, 0, fixed.ordinal, 5)
        .unwrap();
    assert!(first.iter().map(|row| row.ordinal).eq(1..=5));
    store
        .append("ledger", &initial, &[notice("after watermark")])
        .unwrap();
    let next = store
        .replay_rows("ledger", &initial, 5, fixed.ordinal, 5)
        .unwrap();
    assert!(next.iter().map(|row| row.ordinal).eq(6..=8));
    assert!(
        store
            .replay_rows("ledger", &initial, 8, 7, 0)
            .unwrap_err()
            .to_string()
            .contains("watermark must not precede")
    );
    assert_eq!(
        store
            .rows_after("ledger", &initial, 8, Some("notice"))
            .unwrap()[0]
            .ordinal,
        9
    );

    let replacement = transcript_view_id("replacement").unwrap();
    store
        .stage_view(
            "ledger",
            StageViewInput {
                view_id: replacement.clone(),
                content_start_ordinal: 1,
                rows: &[],
            },
        )
        .await
        .unwrap();
    store
        .replace_current_view("ledger", &initial, &replacement)
        .unwrap();
    assert!(matches!(
        store
            .replay_rows("ledger", &initial, 5, fixed.ordinal, 5)
            .unwrap_err()
            .downcast_ref::<LedgerError>(),
        Some(LedgerError::StaleView { .. })
    ));
}

#[tokio::test]
async fn a_pinned_prefix_uses_bounded_pages_and_rechecks_after_the_last_page() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    initialize(
        &store,
        "ledger",
        "initial",
        &vec![notice("synthetic"); 1100],
    );
    let watermark = store.high_watermark("ledger").unwrap();
    let mut pages = std::pin::pin!(store.row_pages_through("ledger", &watermark, 1, None));
    let first = pages.try_next().await.unwrap().unwrap();
    assert!(first.iter().map(|row| row.ordinal).eq(1..=1000));
    store
        .append("ledger", &watermark.view_id, &[notice("after watermark")])
        .unwrap();
    let last = pages.try_next().await.unwrap().unwrap();
    assert!(last.iter().map(|row| row.ordinal).eq(1001..=1100));
    let replacement = transcript_view_id("replacement").unwrap();
    store
        .stage_view(
            "ledger",
            StageViewInput {
                view_id: replacement.clone(),
                content_start_ordinal: 1,
                rows: &[],
            },
        )
        .await
        .unwrap();
    store
        .replace_current_view("ledger", &watermark.view_id, &replacement)
        .unwrap();
    assert!(matches!(
        pages
            .try_next()
            .await
            .unwrap_err()
            .downcast_ref::<LedgerError>(),
        Some(LedgerError::StaleView { .. })
    ));
}

#[tokio::test]
async fn a_corrupt_row_decoded_by_a_stored_rows_consumer_fences_only_its_current_chat() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let terminal = LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data: LedgerRowData::RunEnded {
            origin: RunOrigin::Core,
            outcome: RunOutcome::Finished,
            error: None,
        },
    };
    initialize(&store, "ledger", "initial", &[terminal]);
    let watermark = store.high_watermark("ledger").unwrap();
    let db = Connection::open(root.path().join("ledger/ledger.sqlite")).unwrap();
    db.execute_batch("UPDATE transcript_rows SET payload_json = 'invalid' WHERE ordinal = 1")
        .unwrap();
    let error = store
        .with_stored_rows_through(
            "ledger",
            &watermark,
            |rows| async move { Ok(decode_stored_ledger_row(&rows[0])?) },
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(
        safe_fence_diagnostic(error.as_ref()).cause_code,
        "UNDECODABLE_LEDGER_ROW"
    );
    assert!(store.current_view("ledger").is_err());
    initialize(&store, "healthy", "other-view", &[notice("healthy")]);
    assert_eq!(store.high_watermark("healthy").unwrap().ordinal, 1);
}
