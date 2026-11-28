use std::{path::Path, process::Command, time::Instant};

use garcon_contract::{
    chat_types::{AssistantMessage, ChatMessage, UserMessage},
    chat_view::{TranscriptPageRelations, is_relationally_valid_bounded_transcript_page},
    transcript_anchor_page::{TranscriptAnchorDirection, TranscriptAnchorPageStatus},
    transcript_entry_categories::TranscriptEntryOptionalCategory,
};
use garcon_interface::producer::AgentRunFailureDetail;
use garcon_ledger::{
    anchor_page::AnchorScanInput,
    codec::encode_ledger_draft,
    contracts::{
        LedgerPermissionLifecycle, LedgerPermissionTool, LedgerRowData, LedgerRowDraft, RunOrigin,
        RunOutcome, transcript_view_id,
    },
    export_fold::{filter_transcript_export_entries, fold_rows_for_export},
    presentation::{ledger_rows_to_messages, ledger_rows_to_transcript_messages},
    projection::{frozen_conversation_drafts, preview_messages},
};
use rusqlite::Connection;

use super::bulk_views::{initialize, notice, store};

const AT: &str = "2026-11-28T09:00:00.000Z";

// TLV5-REPLAY.04: Presentation can hide rows without changing raw coverage.
#[tokio::test]
async fn a_stored_non_tool_use_permission_preserves_raw_page_and_replay_progress() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let view = transcript_view_id("malformed-stored-permission").unwrap();
    initialize(
        &store,
        "ledger",
        view.as_str(),
        &[notice("Before"), notice("placeholder"), notice("After")],
    );
    let writer = Connection::open(root.path().join("ledger/ledger.sqlite")).unwrap();
    let payload = r#"{"providerMeta":null,"value":{"kind":"requested","incarnation":"11111111-1111-4111-8111-111111111111","requestedTool":{"type":"tool-result","timestamp":"2026-11-28T09:00:00.000Z","toolId":"synthetic-tool","content":"synthetic result"},"options":[{"id":"allow","label":"Allow"}]}}"#;
    writer.execute("UPDATE transcript_rows SET kind = 'permission-requested', payload_json = ? WHERE ordinal = 2", [payload]).unwrap();

    let raw = store.page("ledger", &view, 1, Some(3)).unwrap();
    assert_eq!(raw.view_id, view);
    assert_eq!(raw.rows[0].ordinal, 2);
    assert!(matches!(
        &raw.rows[0].data,
        LedgerRowData::PermissionRequested {
            lifecycle: LedgerPermissionLifecycle::Requested {
                requested_tool: LedgerPermissionTool::ToolResult(_),
                ..
            }
        }
    ));
    assert_eq!(raw.next_before, Some(2));
    let messages = ledger_rows_to_transcript_messages("ledger", &raw.rows);
    assert!(messages.is_empty());
    assert!(is_relationally_valid_bounded_transcript_page(
        TranscriptPageRelations {
            messages: &messages,
            last_ordinal: 3.0,
            page_oldest_ordinal: 0.0,
            page_newest_ordinal: 2.0,
            next_before_ordinal: raw.next_before.map(|ordinal| ordinal as f64),
            has_more: true,
        },
        1.0
    ));
    let earlier = store.page("ledger", &view, 1, raw.next_before).unwrap();
    assert_eq!(earlier.rows[0].ordinal, 1);
    assert_eq!(earlier.next_before, None);

    let watermark = store.high_watermark("ledger").unwrap().ordinal;
    assert_eq!(watermark, 3);
    let replay = store.replay_rows("ledger", &view, 0, watermark, 2).unwrap();
    assert_eq!(replay.len(), 2);
    let rendered = ledger_rows_to_transcript_messages("ledger", &replay);
    assert_eq!(rendered.len(), 1);
    assert_eq!(rendered[0].ordinal.0, 1.0);
    let after = replay.last().unwrap().ordinal;
    assert_eq!(after, 2);
    let continuation = store
        .replay_rows("ledger", &view, after, watermark, 2)
        .unwrap();
    assert_eq!(continuation[0].ordinal, 3);
    assert_eq!(
        ledger_rows_to_transcript_messages("ledger", &continuation)[0]
            .ordinal
            .0,
        3.0
    );

    let anchor = store
        .anchor_page(
            "ledger",
            &view,
            AnchorScanInput {
                direction: TranscriptAnchorDirection::Forward,
                cursor_ordinal: 0,
                watermark_ordinal: watermark,
                anchors_remaining: 1,
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!((anchor.start_ordinal, anchor.end_ordinal), (1, 4));
    assert_eq!(anchor.anchors_remaining, 1);
    assert_eq!(anchor.page_status, TranscriptAnchorPageStatus::Exhausted);
    assert_eq!(anchor.rows.len(), 3);
    assert_eq!(ledger_rows_to_messages("ledger", &anchor.rows).len(), 2);
    let exported = filter_transcript_export_entries(
        fold_rows_for_export("ledger", &anchor.rows),
        &[TranscriptEntryOptionalCategory::Permissions],
    );
    assert_eq!(exported.entries.len(), 2);
    assert_eq!(exported.omitted[0].count, 0);
    assert_eq!(store.high_watermark("ledger").unwrap().ordinal, watermark);
}

fn fold_oracle(root: &Path, mode: &str) -> serde_json::Value {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fold-store-oracle.ts"
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
    garcon_js::json::from_slice(&output.stdout).unwrap()
}

fn native_folds(root: &Path) -> serde_json::Value {
    let store = store(root);
    let view_id = transcript_view_id("fold-view").unwrap();
    let edges = store.preview_edges("ledger", &view_id).unwrap();
    assert_eq!(edges.first_omitted_head_ordinal, Some(3));
    let preview = preview_messages(&edges).unwrap();
    assert!(matches!(&preview.first, ChatMessage::User(user) if user.content == "first"));
    assert!(
        matches!(&preview.last, ChatMessage::Assistant(assistant) if assistant.content == "last bounded")
    );
    let mut rows = store.replay_rows("ledger", &view_id, 0, 2, 2).unwrap();
    rows.extend(store.replay_rows("ledger", &view_id, 69, 70, 1).unwrap());
    let frozen = frozen_conversation_drafts(&rows)
        .iter()
        .map(encode_ledger_draft)
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let exported = filter_transcript_export_entries(
        fold_rows_for_export("ledger", &rows),
        &[TranscriptEntryOptionalCategory::Diagnostics],
    );
    assert_eq!(exported.entries.len(), 1);
    assert_eq!(exported.omitted[0].count, 2);
    let wide_rows: Vec<_> = (1..=20_000)
        .map(|ordinal| {
            let mut row = rows[1].clone();
            row.ordinal = ordinal;
            row
        })
        .collect();
    let start = Instant::now();
    let wide =
        serde_json::to_vec(&ledger_rows_to_transcript_messages("ledger", &wide_rows)).unwrap();
    eprintln!(
        "Rust presentation plus JSON (20,000 notices): {:.2} ms",
        start.elapsed().as_secs_f64() * 1000.0
    );
    store.close().unwrap();
    serde_json::json!({"edges":edges,"preview":preview,"frozen":frozen,"exported":exported,"wideBytes":wide.len()})
}

// Store-level evidence for TLV5-L01.02-CORE-EXPORT-01 (bounded fixture).
#[test]
fn read_folds_match_bun_on_ledgers_from_both_writers() {
    let original = tempfile::tempdir().unwrap();
    let expected = fold_oracle(original.path(), "write");
    assert_eq!(native_folds(original.path()), expected);

    let native = tempfile::tempdir().unwrap();
    let writer = store(native.path());
    let mut rows: Vec<_> = (0..70).map(|i| notice(&format!("Synthetic {i}"))).collect();
    let provider = |message| LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data: LedgerRowData::ProviderRow { message },
    };
    let user = |content: String| {
        ChatMessage::User(UserMessage {
            timestamp: AT.into(),
            content,
            images: None,
            metadata: None,
            presentation: None,
        })
    };
    let assistant = |content: String| {
        ChatMessage::Assistant(AssistantMessage {
            timestamp: AT.into(),
            content,
            questions: None,
        })
    };
    let omitted = "\u{754c}".repeat(24_000);
    rows[0] = provider(user("first".into()));
    rows[2] = provider(user(omitted.clone()));
    rows[67] = provider(assistant("last bounded".into()));
    rows[68] = provider(assistant(omitted));
    rows[69] = LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data: LedgerRowData::RunEnded {
            origin: RunOrigin::Core,
            outcome: RunOutcome::Failed,
            error: Some(AgentRunFailureDetail {
                code: "SYNTHETIC".into(),
                message: Some("failure".into()),
            }),
        },
    };
    initialize(&writer, "ledger", "fold-view", &rows);
    writer.close().unwrap();
    assert_eq!(fold_oracle(native.path(), "read"), expected);
    assert_eq!(native_folds(native.path()), expected);
}
