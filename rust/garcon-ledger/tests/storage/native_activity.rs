use std::{path::Path, process::Command, time::Instant};

use garcon_js::{Number, json::from_slice};
use garcon_ledger::{
    codec::{StoredLedgerRow, decode_ledger_row},
    contracts::{
        LedgerNoticeDetail, LedgerRowData, LedgerRowDraft, RunOrigin,
        TranscriptNativeActivityState, transcript_view_id,
    },
    errors::{LedgerError, safe_fence_diagnostic},
    service::{TranscriptLedgerService, TranscriptLedgerServiceOptions},
    store::{InitializeViewInput, StageViewInput, TranscriptLedgerStore},
};
use rusqlite::Connection;
use serde_json::{Value, json};

use super::bulk_views::store;

const AT: &str = "2026-11-28T09:00:00.000Z";
const LATER: &str = "2026-11-28T10:00:00.000Z";
const VIEW: &str = "activity-view";

fn cases() -> Vec<LedgerRowDraft> {
    include_str!("../inputs/native-activity.jsonl")
        .lines()
        .map(|line| {
            let fields: Vec<Value> = from_slice(line.as_bytes()).unwrap();
            let decoded = decode_ledger_row(&StoredLedgerRow {
                view_id: VIEW.into(),
                ordinal: Number(1.0),
                kind: fields[0].as_str().unwrap().into(),
                at: AT.into(),
                client_message_id: fields.get(2).and_then(Value::as_str).map(str::to_owned),
                payload_json: garcon_js::json::stringify(
                    &json!({ "providerMeta": null, "value": fields[1] }),
                ),
            })
            .unwrap_or_else(|error| panic!("{line}: {error}"));
            LedgerRowDraft {
                at: decoded.at,
                provider_meta: decoded.provider_meta,
                data: decoded.data,
            }
        })
        .collect()
}

fn ignored(index: usize) -> LedgerRowDraft {
    LedgerRowDraft {
        at: LATER.into(),
        provider_meta: None,
        data: LedgerRowData::Notice {
            message: format!("Synthetic notice {index}"),
            detail: LedgerNoticeDetail::Other(json!({"type": "ordinary-notice"}).into()),
        },
    }
}

fn bun(root: &Path, mode: &str) -> Value {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/native-activity-oracle.ts"
        ))
        .arg(mode)
        .arg(root)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stderr}");
    eprint!("{stderr}");
    from_slice(&output.stdout).unwrap()
}

fn initialize(
    store: &TranscriptLedgerStore,
    chat_id: &str,
    rows: &[LedgerRowDraft],
    content_start_ordinal: u64,
) {
    store
        .initialize_current_view(
            chat_id,
            InitializeViewInput {
                view_id: Some(transcript_view_id(VIEW).unwrap()),
                rows,
                content_start_ordinal,
            },
        )
        .unwrap();
}

fn native(root: &Path, write: bool) -> Vec<TranscriptNativeActivityState> {
    let store = store(root);
    let drafts = cases();
    let initial = &drafts[0];
    let mut snapshots = Vec::new();
    for (index, candidate) in drafts.iter().enumerate() {
        let id = format!("case-{index}");
        if write {
            initialize(
                &store,
                &id,
                &[initial.clone(), candidate.clone(), ignored(index)],
                1,
            );
        }
        snapshots.push(store.native_activity_state(&id).unwrap());
    }
    if write {
        initialize(&store, "after-switch", &[initial.clone(), ignored(0)], 2);
    }
    let state = store.native_activity_state("after-switch").unwrap();
    assert!(state.session.is_none());
    assert!(state.provider_watermark.is_none());
    snapshots.push(state);
    store.close().unwrap();
    snapshots
}

#[test]
fn tlv5_l09_04_store_unit_01_watermark_matches_bun_for_ledgers_from_both_writers() {
    let original = tempfile::tempdir().unwrap();
    let expected = bun(original.path(), "write");
    let port = tempfile::tempdir().unwrap();
    let expected_cases = expected.as_array().unwrap();
    for (root, write) in [(original.path(), false), (port.path(), true)] {
        let rust_read = native(root, write);
        assert_eq!(rust_read.len(), expected_cases.len());
        for (index, (actual, expected)) in rust_read.into_iter().zip(expected_cases).enumerate() {
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                *expected,
                "case {index}, Rust writer: {write}"
            );
        }
    }
    assert_eq!(bun(port.path(), "read"), expected);
}

#[tokio::test]
async fn staged_evidence_is_invisible_and_malformed_relevant_payload_fences_only_its_chat() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let drafts = cases();
    let core_run_end = drafts
        .iter()
        .find(|draft| {
            matches!(
                draft.data,
                LedgerRowData::RunEnded {
                    origin: RunOrigin::Core,
                    ..
                }
            )
        })
        .unwrap();
    initialize(&store, "chat", std::slice::from_ref(core_run_end), 1);
    let staging = transcript_view_id("staged").unwrap();
    store
        .stage_view(
            "chat",
            StageViewInput {
                view_id: staging,
                content_start_ordinal: 1,
                rows: &drafts[..2],
            },
        )
        .await
        .unwrap();
    let ledger =
        TranscriptLedgerService::new(store.clone(), TranscriptLedgerServiceOptions::default());
    assert!(
        ledger
            .native_activity_state("chat")
            .unwrap()
            .provider_watermark
            .is_none()
    );
    let db = Connection::open(root.path().join("chat/ledger.sqlite")).unwrap();
    db.execute(
        "UPDATE transcript_rows SET payload_json = 'not-json' WHERE view_id = ?",
        [VIEW],
    )
    .unwrap();
    let failure = ledger.native_activity_state("chat").unwrap_err();
    assert!(matches!(
        failure.downcast_ref(),
        Some(LedgerError::Fenced { .. })
    ));
    assert_eq!(
        safe_fence_diagnostic(failure.as_ref()).cause_code,
        "SQLITE_ERROR"
    );
    assert!(store.current_view("chat").unwrap_err().is::<LedgerError>());
    initialize(&store, "unrelated", &drafts[..1], 1);
    assert_eq!(
        ledger
            .native_activity_state("unrelated")
            .unwrap()
            .provider_watermark
            .unwrap()
            .ordinal,
        1
    );
}

#[tokio::test]
async fn native_activity_scans_a_long_excluded_suffix() {
    let original = tempfile::tempdir().unwrap();
    let expected = bun(original.path(), "measure");
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let mut rows = vec![cases().remove(0)];
    rows.extend((0..20_000).map(ignored));
    store
        .seed_current_view(
            "suffix",
            InitializeViewInput {
                view_id: Some(transcript_view_id(VIEW).unwrap()),
                rows: &rows,
                content_start_ordinal: 1,
            },
        )
        .await
        .unwrap();
    let started = Instant::now();
    let actual = store.native_activity_state("suffix").unwrap();
    eprintln!(
        "Rust native activity, 20,000-row excluded suffix: {:.2} ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
    assert_eq!(actual.provider_watermark.as_ref().unwrap().ordinal, 1);
    assert_eq!(serde_json::to_value(actual).unwrap(), expected);
}
