use std::{path::Path, process::Command, rc::Rc, time::Instant};

use garcon_contract::chat_types::{AssistantMessage, ChatMessage, UserMessage};
use garcon_js::json::from_slice;
use garcon_ledger::{
    contracts::{
        AppendInputRequest, LedgerNoticeDetail, LedgerRowData, LedgerRowDraft,
        LedgerUserInputDetail, TranscriptView, transcript_view_id,
    },
    errors::{LedgerError, safe_fence_diagnostic},
    input_submission::input_detail,
    store::{InitializeViewInput, TranscriptLedgerStore, TranscriptLedgerStoreOptions},
};
use serde_json::Value;

const AT: &str = "2026-11-28T09:00:00.000Z";

fn store(root: &Path) -> TranscriptLedgerStore {
    TranscriptLedgerStore::new(
        root.to_str().unwrap(),
        TranscriptLedgerStoreOptions {
            create_view_id: Some(Rc::new(|| transcript_view_id("view-test").unwrap())),
            now: Some(Rc::new(|| Ok(AT.into()))),
            connection_cache_size: Some(1),
            ..Default::default()
        },
    )
    .unwrap()
}

fn initialize(
    store: &TranscriptLedgerStore,
    chat: &str,
    rows: &[LedgerRowDraft],
) -> TranscriptView {
    store
        .initialize_current_view(
            chat,
            InitializeViewInput {
                view_id: None,
                content_start_ordinal: 1,
                rows,
            },
        )
        .unwrap()
}

fn assistant(text: &str) -> LedgerRowDraft {
    LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data: LedgerRowData::ProviderRow {
            message: ChatMessage::Assistant(AssistantMessage {
                timestamp: AT.into(),
                content: text.into(),
                questions: None,
            }),
        },
    }
}

fn input(id: &str, content: &str) -> LedgerUserInputDetail {
    input_detail(
        UserMessage {
            timestamp: AT.into(),
            content: content.into(),
            images: None,
            metadata: None,
            presentation: None,
        },
        Vec::new(),
        Some(id.into()),
        false,
    )
}

fn request<'a>(
    view: &'a TranscriptView,
    detail: &'a LedgerUserInputDetail,
) -> AppendInputRequest<'a> {
    AppendInputRequest {
        view_id: &view.view_id,
        at: AT,
        detail,
        excluded_ordinals: None,
        preamble_boundary: None,
        preambles: &[],
    }
}

// TLV5-L02.01-STORE-UNIT-01
#[test]
fn commits_atomic_batches_with_dense_view_local_ordinals() {
    let temp = tempfile::tempdir().unwrap();
    let store = store(temp.path());
    assert!(store.existing_current_view("ledger").unwrap().is_none());
    assert!(
        !temp.path().join("ledger").exists(),
        "the lookup must not create storage"
    );
    let view = initialize(&store, "ledger", &[]);
    let part = store
        .append(
            "ledger",
            &view.view_id,
            &[assistant("same"), assistant("same")],
        )
        .unwrap();
    assert_eq!(
        part.iter().map(|row| row.ordinal).collect::<Vec<_>>(),
        [1, 2]
    );
    let third = store
        .append("ledger", &view.view_id, &[assistant("later")])
        .unwrap();
    assert_eq!(third[0].ordinal, 3);
    let newest = store.page("ledger", &view.view_id, 2, None).unwrap();
    assert_eq!(newest.next_before, Some(2));
    assert_eq!(newest.rows, [part[1].clone(), third[0].clone()]);
    let oldest = store
        .page("ledger", &view.view_id, 2, newest.next_before)
        .unwrap();
    assert_eq!(oldest.next_before, None);
    assert_eq!(oldest.rows, [part[0].clone()]);
    let other = initialize(&store, "other", &[]);
    assert_eq!(
        store
            .append("other", &other.view_id, &[assistant("other")])
            .unwrap()[0]
            .ordinal,
        1
    );
    assert_eq!(
        store
            .append("ledger", &view.view_id, &[assistant("after LRU reopen")])
            .unwrap()[0]
            .ordinal,
        4
    );
    let checkpoint = store.checkpoint_for_handoff("ledger").unwrap();
    assert_eq!(checkpoint.ordinal, 4);
    assert_eq!(checkpoint.log_frames, checkpoint.checkpointed_frames);
}

// TLV5-L11.05-STORE-UNIT-02
#[test]
fn preserves_a_write_fence_across_lru_eviction() {
    let temp = tempfile::tempdir().unwrap();
    let store = store(temp.path());
    let view = initialize(&store, "ledger", &[]);
    let draft = LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data: LedgerRowData::UserInput {
            detail: input("submission", "first"),
        },
    };
    store
        .append("ledger", &view.view_id, std::slice::from_ref(&draft))
        .unwrap();
    let error = store
        .append("ledger", &view.view_id, &[assistant("rolled back"), draft])
        .unwrap_err();
    assert_eq!(
        safe_fence_diagnostic(error.as_ref()).cause_code,
        "SQLITE_CONSTRAINT_UNIQUE"
    );
    initialize(&store, "other", &[]);
    assert_eq!(
        store
            .page("ledger", &view.view_id, 10, None)
            .unwrap()
            .rows
            .len(),
        1
    );
    assert!(matches!(
        store
            .append("ledger", &view.view_id, &[assistant("must never append")])
            .unwrap_err()
            .downcast_ref::<LedgerError>(),
        Some(LedgerError::Fenced { .. })
    ));
    assert!(store.checkpoint_for_handoff("ledger").is_err());
}

// TLV5-L04.04-CORE-UNIT-01
#[test]
fn deduplicates_a_committed_submission_without_redispatching_it() {
    let temp = tempfile::tempdir().unwrap();
    let store = store(temp.path());
    let view = initialize(&store, "ledger", &[]);
    let detail = input("submission", "first");
    let first = store
        .append_input_and_compose("ledger", request(&view, &detail))
        .unwrap();
    assert!(first.inserted);
    assert_eq!(first.prompt, std::slice::from_ref(&first.input));
    let retry = store
        .append_input_and_compose("ledger", request(&view, &detail))
        .unwrap();
    assert_eq!(retry.input, first.input);
    assert!(!retry.inserted);
    assert!(retry.prompt.is_empty());
    assert!(retry.committed_rows.is_empty());
    let other = input("submission", "changed");
    let error = store
        .append_input_and_compose("ledger", request(&view, &other))
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<LedgerError>(),
        Some(LedgerError::SubmissionConflict { .. })
    ));
    let second = store
        .append_input_and_compose("ledger", request(&view, &input("second", "second")))
        .unwrap();
    assert_eq!(second.input.ordinal, 2);
    assert_eq!(second.prompt, [first.input, second.input.clone()]);
}

#[test]
fn native_store_can_append_to_a_bun_created_view_and_bun_reads_the_result() {
    let temp = tempfile::tempdir().unwrap();
    let bun = |action| {
        let output = Command::new("bun")
            .args([
                concat!(env!("CARGO_MANIFEST_DIR"), "/tests/codec_store_oracle.ts"),
                action,
            ])
            .arg(temp.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        from_slice::<Value>(&output.stdout).unwrap()
    };
    let before = bun("write");
    let rust = store(temp.path());
    let view = rust.current_view("synthetic-chat").unwrap().unwrap();
    let page = rust
        .page("synthetic-chat", &view.view_id, 10, None)
        .unwrap();
    assert_eq!(
        from_slice::<Value>(&serde_json::to_vec(&page.rows).unwrap()).unwrap(),
        before
    );
    let added = rust
        .append("synthetic-chat", &view.view_id, &[assistant("Rust append")])
        .unwrap();
    assert_eq!(added[0].ordinal, 4);
    rust.close().unwrap();
    let mut expected = page.rows;
    expected.extend(added);
    assert_eq!(
        bun("read"),
        from_slice::<Value>(&serde_json::to_vec(&expected).unwrap()).unwrap()
    );
}

#[test]
fn append_and_compose_scans_past_a_long_transparent_suffix_in_one_call() {
    let temp = tempfile::tempdir().unwrap();
    let store = store(temp.path());
    let notice = LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data: LedgerRowData::Notice {
            message: "Synthetic notice".into(),
            detail: LedgerNoticeDetail::Other(
                serde_json::json!({ "type": "chat-id-request" }).into(),
            ),
        },
    };
    let drafts = vec![notice; 20_000];
    let view = initialize(&store, "ledger", &drafts);
    initialize(&store, "bun", &drafts);
    store.current_view("ledger").unwrap();
    let detail = input("next", "next input");
    let started = Instant::now();
    let result = store
        .append_input_and_compose("ledger", request(&view, &detail))
        .unwrap();
    eprintln!(
        "Rust append-and-compose with 20,000 transparent rows: {:.2} ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
    assert_eq!(result.input.ordinal, 20_001);
    assert_eq!(result.prompt, std::slice::from_ref(&result.input));
    store.close().unwrap();
    let original = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/store_append_oracle.ts"
        ))
        .arg(temp.path())
        .arg("bun")
        .output()
        .unwrap();
    assert!(
        original.status.success(),
        "{}",
        String::from_utf8_lossy(&original.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&original.stderr));
    assert_eq!(
        from_slice::<Value>(&original.stdout).unwrap(),
        from_slice::<Value>(&serde_json::to_vec(&result).unwrap()).unwrap()
    );
}
