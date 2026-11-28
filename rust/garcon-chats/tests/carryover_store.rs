use std::{fs, path::Path, process::Command, rc::Rc, time::Duration};

use garcon_base::{errors::error_metadata, keyed_lock::LockAborted};
use garcon_chats::{
    carryover::{
        garbage_collector::{CarryOverGarbageCollector, CarryOverGarbageCollectorDeps},
        segment_types::SeedSanitationOutcome,
        transcript_store::{
            CarryOverStoreError, CarryOverTranscriptStore, PrepareCarryOverSegmentRequest,
            PreparedCarryOverSegment, as_carry_over_domain_error,
        },
    },
    registry_contracts::CarryOverSegmentRef,
    registry_entry_codec::parse_carry_over_segment_refs,
};
use garcon_contract::{
    chat_types::{
        AssistantMessage, ChatMessage, TranscriptNoticeMessage, UserMessage, parse_chat_messages,
    },
    error_codes::ErrorCode,
    transcript_notice_details::TranscriptNoticeDetail,
};
use garcon_js::json;
use garcon_ledger::adoption::{CarryoverQuarantine, TranscriptFrozenHistory};
use indexmap::IndexSet;
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio::task::LocalSet;
use tokio_util::sync::CancellationToken;

const FIRST: &str = "11111111-1111-4111-8111-111111111111";
const SECOND: &str = "22222222-2222-4222-8222-222222222222";
const TIME: &str = "2026-01-01T00:00:00.000Z";

#[tokio::test]
async fn adoption_reads_the_captured_archive_and_preserves_errors_across_erasure() {
    let dir = tempdir().unwrap();
    let original = bun("write", dir.path());
    let store = CarryOverTranscriptStore::new(dir.path(), Default::default());
    let adapter: &dyn TranscriptFrozenHistory<Vec<CarryOverSegmentRef>> = &store;
    let refs = parse_carry_over_segment_refs(&original["refs"]).unwrap();
    let revision = adapter.revision(&refs, None);
    assert_eq!(revision, original["page"]["revision"]);
    let quarantine = CarryoverQuarantine {
        artifact_id: original["quarantine"]["artifactId"]
            .as_str()
            .unwrap()
            .into(),
        error_code: original["quarantine"]["errorCode"].as_str().unwrap().into(),
    };
    assert_eq!(
        adapter.revision(&refs, Some(&quarantine)),
        original["quarantinedRevision"]
    );
    let captured_cutoff = parse_carry_over_segment_refs(&original["cutoff"]).unwrap();
    let loaded = adapter
        .load_all(&captured_cutoff, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(loaded, [user("Synthetic question")]);

    let signal = CancellationToken::new();
    signal.cancel();
    let error = adapter
        .load_all(&captured_cutoff, signal)
        .await
        .unwrap_err();
    assert!(error.is::<LockAborted>());

    let missing = vec![reference("33333333-3333-4333-8333-333333333333", 1)];
    let error = adapter
        .load_all(&missing, CancellationToken::new())
        .await
        .unwrap_err();
    let metadata = error_metadata(error.as_ref());
    assert_eq!(
        metadata.code,
        Some(ErrorCode::CARRYOVER_HISTORY_UNAVAILABLE.as_str())
    );
    assert_eq!(metadata.name, "CarryOverHistoryUnavailableError");
    assert_eq!(error.to_string(), "Archived chat history is unavailable.");
}

fn bun(mode: &str, workspace: &Path) -> Value {
    let output = Command::new("bun")
        .args([
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/oracles/carryover-store.ts"
            ),
            mode,
        ])
        .arg(workspace)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    json::from_slice(&output.stdout).unwrap()
}

fn user(content: &str) -> ChatMessage {
    ChatMessage::User(UserMessage {
        timestamp: TIME.into(),
        content: content.into(),
        images: None,
        metadata: None,
        presentation: None,
    })
}

fn reference(id: &str, count: u64) -> CarryOverSegmentRef {
    CarryOverSegmentRef {
        id: id.into(),
        agent_id: "a".into(),
        model: "alpha".into(),
        captured_at: TIME.into(),
        stored_message_count: count,
        visible_message_count: count,
        trailing_handoff: None,
    }
}

async fn prepare(
    store: &CarryOverTranscriptStore,
    operation: &str,
    id: &str,
    messages: Vec<ChatMessage>,
) -> PreparedCarryOverSegment {
    store
        .prepare_segment(PrepareCarryOverSegmentRequest {
            operation_id: operation,
            id,
            seed_sanitation: SeedSanitationOutcome::StrippedExact,
            messages,
            signal: None,
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn archived_segments_round_trip_the_real_writers_and_cutoffs() {
    let bun_dir = tempdir().unwrap();
    let original = bun("write", bun_dir.path());
    let original_store = CarryOverTranscriptStore::new(bun_dir.path(), Default::default());
    original_store.initialize().await.unwrap();
    let references = parse_carry_over_segment_refs(&original["refs"]).unwrap();
    let messages = parse_chat_messages(&original["messages"]).unwrap();
    original_store
        .assert_available(&references, None)
        .await
        .unwrap();
    original_store
        .verify_segment(&references[0], None)
        .await
        .unwrap();
    let full = original_store.load_all(&references, None).await.unwrap();
    let page = original_store
        .load_page(&references, 1, 2, None)
        .await
        .unwrap();
    let cutoff = original_store.resolve_cutoff(&references, 1);
    let index = original_store.read_index(FIRST).await.unwrap();
    assert_eq!(
        serde_json::to_vec(&full).unwrap(),
        serde_json::to_vec(&original["full"]).unwrap()
    );
    assert_eq!(
        serde_json::to_vec(&page.messages).unwrap(),
        serde_json::to_vec(&original["page"]["messages"]).unwrap()
    );
    assert_eq!(
        json!({
            "total": page.total, "offset": page.offset, "limit": page.limit,
            "hasMore": page.has_more, "revision": page.revision,
        }),
        json!({
            "total": original["page"]["total"], "offset": original["page"]["offset"],
            "limit": original["page"]["limit"], "hasMore": original["page"]["hasMore"],
            "revision": original["page"]["revision"],
        })
    );
    assert_eq!(
        serde_json::to_vec(&cutoff).unwrap(),
        serde_json::to_vec(&original["cutoff"]).unwrap()
    );
    assert_eq!(original_store.resolve_cutoff(&references, 4), references);
    assert_eq!(
        serde_json::to_vec(&*index).unwrap(),
        serde_json::to_vec(&original["index"]).unwrap()
    );

    let rust_dir = tempdir().unwrap();
    let rust_store = CarryOverTranscriptStore::new(rust_dir.path(), Default::default());
    rust_store.initialize().await.unwrap();
    let staged = prepare(&rust_store, "synthetic-op", FIRST, messages).await;
    staged.commit().await.unwrap();
    staged.release_root();
    let readback = bun("read", rust_dir.path());
    assert_eq!(original["full"], readback["full"]);
    assert_eq!(original["page"], readback["page"]);
    assert_eq!(
        original["index"]["canonicalMessagesSha256"],
        readback["index"]["canonicalMessagesSha256"]
    );
}

#[tokio::test]
async fn staged_failures_retain_writer_ownership_and_identical_reuse_does_not_remove_the_artifact()
{
    let dir = tempdir().unwrap();
    let store = CarryOverTranscriptStore::new(dir.path(), Default::default());
    store.initialize().await.unwrap();
    let first = prepare(&store, "first", FIRST, vec![user("same")]).await;
    let segments = dir.path().join("carryover-transcripts/segments");
    let parked = dir.path().join("parked-segments");
    fs::rename(&segments, &parked).unwrap();
    assert!(matches!(
        first.commit().await,
        Err(CarryOverStoreError::Io(_))
    ));
    assert!(store.writer_roots().contains(FIRST));
    fs::rename(&parked, &segments).unwrap();
    first.commit().await.unwrap();
    first.release_root();
    let reused = prepare(&store, "idempotent", FIRST, vec![user("same")]).await;
    reused.commit().await.unwrap();
    reused.discard().await.unwrap();
    assert_eq!(
        store.load_all(&[reference(FIRST, 1)], None).await.unwrap(),
        [user("same")]
    );
    let conflict = prepare(&store, "conflict", FIRST, vec![user("different")]).await;
    assert!(matches!(
        conflict.commit().await,
        Err(CarryOverStoreError::Collision(_))
    ));
    conflict.discard().await.unwrap();
    assert!(segments.join(FIRST).exists());
}

#[tokio::test]
async fn preserves_one_gap_and_asks_when_projection_eviction_leaves_the_lossless_archive_unchanged()
{
    let dir = tempdir().unwrap();
    let store = CarryOverTranscriptStore::new(dir.path(), Default::default());
    store.initialize().await.unwrap();
    let gap = ChatMessage::Notice(TranscriptNoticeMessage {
        timestamp: TIME.into(),
        content: "Some synthetic output was lost".into(),
        detail: Some(TranscriptNoticeDetail::PublicationGap),
        title: None,
    });
    let history = vec![
        gap.clone(),
        user("old ask"),
        ChatMessage::Assistant(AssistantMessage {
            timestamp: TIME.into(),
            content: "x".repeat(8000),
            questions: None,
        }),
        gap.clone(),
        user("new ask"),
    ];
    let staged = prepare(&store, "projection", FIRST, history.clone()).await;
    staged.commit().await.unwrap();
    staged.release_root();
    let refs = [reference(FIRST, history.len() as u64)];
    assert_eq!(
        store
            .load_projection_source(&refs, Some(200), None)
            .await
            .unwrap(),
        [gap, user("old ask"), user("new ask")],
    );
    assert_eq!(store.load_all(&refs, None).await.unwrap(), history);
    let abort = CancellationToken::new();
    abort.cancel();
    assert!(matches!(
        store.load_all(&refs, Some(&abort)).await,
        Err(CarryOverStoreError::Aborted(_))
    ));

    let index = store.read_index(FIRST).await.unwrap();
    let path = dir
        .path()
        .join("carryover-transcripts/segments")
        .join(FIRST)
        .join(&index.pages[0].file);
    fs::write(path, b"corrupt").unwrap();
    let error = store.load_all(&refs, None).await.unwrap_err();
    assert_eq!(
        as_carry_over_domain_error(&error).unwrap().code,
        ErrorCode::CARRYOVER_HISTORY_UNAVAILABLE
    );
    assert!(matches!(
        store.assert_available(&refs, None).await,
        Err(CarryOverStoreError::Unavailable(_))
    ));
}

#[tokio::test(start_paused = true)]
async fn sweep_keeps_shared_and_journal_roots_and_coalesces_delayed_work() {
    LocalSet::new()
        .run_until(async {
            use std::cell::{Cell, RefCell};
            let dir = tempdir().unwrap();
            let store = CarryOverTranscriptStore::new(dir.path(), Default::default());
            store.initialize().await.unwrap();
            for id in [FIRST, SECOND] {
                let prepared = prepare(&store, "sweep", id, vec![user(id)]).await;
                prepared.commit().await.unwrap();
                prepared.release_root();
            }
            let refs = Rc::new(RefCell::new(vec![reference(FIRST, 1), reference(FIRST, 1)]));
            let roots = Rc::new(RefCell::new(IndexSet::from([SECOND.into()])));
            let sweeps = Rc::new(Cell::new(0));
            let collector = CarryOverGarbageCollector::new(CarryOverGarbageCollectorDeps {
                store: store.clone(),
                registry_segments: {
                    let refs = refs.clone();
                    Rc::new(move || refs.borrow().clone())
                },
                journal_roots: {
                    let (roots, sweeps) = (roots.clone(), sweeps.clone());
                    Rc::new(move || {
                        sweeps.set(sweeps.get() + 1);
                        roots.borrow().clone()
                    })
                },
            });
            collector.initialize().await.unwrap();
            assert_eq!(sweeps.get(), 2);
            refs.borrow_mut().pop();
            collector.sweep().await.unwrap();
            assert_eq!(
                store
                    .load_all(&[reference(FIRST, 1)], None)
                    .await
                    .unwrap()
                    .len(),
                1
            );
            refs.borrow_mut().clear();
            collector.schedule();
            collector.schedule();
            tokio::time::advance(Duration::from_millis(999)).await;
            assert_eq!(sweeps.get(), 3);
            tokio::time::advance(Duration::from_millis(1)).await;
            tokio::task::yield_now().await;
            collector.sweep().await.unwrap();
            assert_eq!(sweeps.get(), 5);
            let segments = dir.path().join("carryover-transcripts/segments");
            assert!(!segments.join(FIRST).exists());
            assert!(segments.join(SECOND).exists());
            roots.borrow_mut().clear();
            collector.schedule();
            collector.shutdown();
            tokio::time::advance(Duration::from_secs(1)).await;
            assert_eq!(sweeps.get(), 5);
            assert!(segments.join(SECOND).exists());
        })
        .await;
}
