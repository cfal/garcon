use std::{cell::RefCell, future::ready, path::Path, process::Command, rc::Rc, time::Duration};

use garcon_base::keyed_lock::KeyedLock;
use garcon_contract::cli_presentation::{
    CliBodyDisclosure, CliPresentation, CliRowFormat, is_cli_presentation,
};
use garcon_js::{clock::ManualClock, date_parse::date_parse};
use garcon_ledger::{
    codec::StoredLedgerRow,
    contracts::{TranscriptView, TranscriptViewId, transcript_view_id},
    errors::LedgerError,
    service::{
        AppendChatRowInput, TranscriptCommitEvent, TranscriptCommitWork, TranscriptLedgerService,
        TranscriptLedgerServiceOptions,
    },
    store::{StageViewInput, TranscriptWatermark},
};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    sync::{mpsc, oneshot},
    task::LocalSet,
};

use super::bulk_views::{initialize, store};

const AT: &str = "2026-11-28T09:00:00.000Z";
const ROW_VIEW: &str = "row-view";
const OLD_VIEW: &str = "before";
const NEW_VIEW: &str = "after";

fn append_input<'a>(
    view: &'a TranscriptViewId,
    presentation: &'a CliPresentation,
) -> AppendChatRowInput<'a> {
    AppendChatRowInput {
        view_id: view,
        client_message_id: "synthetic-submission",
        presentation,
        format: CliRowFormat::Markdown,
        disclosure: CliBodyDisclosure::Collapsed,
        title: Some("  Release validation  "),
        content: "  Synthetic release notes\n",
    }
}

fn cli_presentation() -> CliPresentation {
    is_cli_presentation(&json!({
        "style": "custom",
        "customStyle": {"lightAccent":"#112233","darkAccent":"#445566"},
    }))
    .unwrap()
}

fn commit_summary(event: &TranscriptCommitEvent) -> Value {
    match event {
        TranscriptCommitEvent::Rows {
            chat_id,
            view_id,
            rows,
        } => json!({
            "type": "rows", "chatId": chat_id, "viewId": view_id,
            "ordinals": rows.iter().map(|row| row.ordinal).collect::<Vec<_>>(),
        }),
        TranscriptCommitEvent::ViewReplaced {
            chat_id,
            previous_view_id,
            view,
        } => json!({
            "type": "view-replaced", "chatId": chat_id, "previousViewId": previous_view_id,
            "viewId": view.view_id,
        }),
        unexpected => panic!("Unexpected commit: {unexpected:?}"),
    }
}

async fn native_fixture(root: &Path, write: bool) -> Value {
    LocalSet::new()
        .run_until(async {
            let store = store(root);
            let mut events = Vec::new();
            if write {
                let first_view = transcript_view_id(ROW_VIEW).unwrap();
                let old = transcript_view_id(OLD_VIEW).unwrap();
                let next = transcript_view_id(NEW_VIEW).unwrap();
                initialize(&store, "rows", ROW_VIEW, &[]);
                initialize(&store, "replace", OLD_VIEW, &[]);
                store
                    .stage_view(
                        "replace",
                        StageViewInput {
                            view_id: next.clone(),
                            content_start_ordinal: 1,
                            rows: &[],
                        },
                    )
                    .await
                    .unwrap();
                let clock = Rc::new(ManualClock::new(date_parse(AT).unwrap()));
                let service = TranscriptLedgerService::new(
                    store.clone(),
                    TranscriptLedgerServiceOptions {
                        clock: Some(clock.clone()),
                        ..Default::default()
                    },
                );
                let (send, mut receive) = mpsc::unbounded_channel();
                let _unsubscribe = service.subscribe(Rc::new(move |event| {
                    send.send(commit_summary(&event)).unwrap();
                    TranscriptCommitWork::Complete(Ok(()))
                }));
                let presentation = cli_presentation();
                let mutation_lock = KeyedLock::new();
                mutation_lock
                    .run_exclusive(
                        "chat:rows",
                        || async {
                            let first = service
                                .append_chat_row("rows", append_input(&first_view, &presentation))
                                .unwrap();
                            assert!(first.inserted);
                            assert_eq!(store.high_watermark("rows").unwrap().ordinal, 1);
                            clock.advance(1000);
                            let retry = service
                                .append_chat_row("rows", append_input(&first_view, &presentation))
                                .unwrap();
                            assert!(!retry.inserted);
                            assert_eq!(first.row, retry.row);
                            let conflict = service
                                .append_chat_row(
                                    "rows",
                                    AppendChatRowInput {
                                        content: "changed",
                                        ..append_input(&first_view, &presentation)
                                    },
                                )
                                .unwrap_err();
                            assert!(matches!(
                                conflict.downcast_ref(),
                                Some(LedgerError::SubmissionConflict { .. })
                            ));
                        },
                        None,
                    )
                    .await
                    .unwrap();
                mutation_lock
                    .run_exclusive(
                        "chat:replace",
                        || async {
                            let replaced = service
                                .replace_current_view("replace", &old, &next)
                                .unwrap();
                            assert_eq!(replaced.view_id, next);
                            let stale = service
                                .append_chat_row("replace", append_input(&old, &presentation))
                                .unwrap_err();
                            assert!(matches!(
                                stale.downcast_ref(),
                                Some(LedgerError::StaleView { .. })
                            ));
                        },
                        None,
                    )
                    .await
                    .unwrap();
                assert!(receive.try_recv().is_err());
                for _ in 0..2 {
                    events.push(
                        tokio::time::timeout(Duration::from_secs(4), receive.recv())
                            .await
                            .unwrap()
                            .unwrap(),
                    );
                }
                garcon_base::event_loop::yield_to_event_loop().await;
                assert!(
                    receive.try_recv().is_err(),
                    "a retry or rejection incorrectly notified"
                );
            }
            let head = store.high_watermark("rows").unwrap();
            let rows = store
                .with_stored_rows_through("rows", &head, |rows| ready(Ok(rows)), None)
                .await
                .unwrap();
            let replacement = store.current_view("replace").unwrap().unwrap();
            store.close().unwrap();
            #[derive(Serialize)]
            struct Durable {
                head: TranscriptWatermark,
                rows: Vec<StoredLedgerRow>,
                replacement: TranscriptView,
            }
            let durable = serde_json::to_string(&Durable {
                head,
                rows,
                replacement,
            })
            .unwrap();
            json!({ "durable": durable, "events": events })
        })
        .await
}

fn bun_fixture(root: &Path, mode: &str) -> Value {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/chat-row-service-oracle.ts"
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
    garcon_js::json::from_slice(&output.stdout).unwrap()
}

// TLV5-CHAT-ROW.02: notify only for a fresh commit and qualify the view replacement.
#[tokio::test]
async fn notifies_once_for_a_fresh_chat_row_and_not_for_its_exact_retry() {
    let original = tempfile::tempdir().unwrap();
    let expected = bun_fixture(original.path(), "write");
    assert_eq!(
        native_fixture(original.path(), false).await["durable"],
        expected["durable"]
    );
    let native = tempfile::tempdir().unwrap();
    assert_eq!(native_fixture(native.path(), true).await, expected);
    assert_eq!(
        bun_fixture(native.path(), "read")["durable"],
        expected["durable"]
    );
}

#[tokio::test]
async fn a_failing_listener_does_not_block_commit_delivery_or_pending_work() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let store = store(root.path());
            initialize(&store, "rows", ROW_VIEW, &[]);
            let (errors, mut received_errors) = mpsc::unbounded_channel();
            let service = TranscriptLedgerService::new(
                store.clone(),
                TranscriptLedgerServiceOptions {
                    clock: Some(Rc::new(ManualClock::new(date_parse(AT).unwrap()))),
                    on_listener_error: Some(Rc::new(move |error| {
                        errors.send(error.to_string()).unwrap()
                    })),
                    ..Default::default()
                },
            );
            let (settle, wait) = oneshot::channel();
            let wait = RefCell::new(Some(wait));
            let _pending = service.subscribe(Rc::new(move |_| {
                let wait = wait.borrow_mut().take().unwrap();
                TranscriptCommitWork::Pending(Box::pin(async move {
                    wait.await.unwrap();
                    Err(std::io::Error::other("pending listener failure").into())
                }))
            }));
            let _failing = service.subscribe(Rc::new(|_| {
                TranscriptCommitWork::Complete(Err(
                    std::io::Error::other("sync listener failure").into()
                ))
            }));
            let remove = service.subscribe(Rc::new(|_| panic!("unsubscribed listener was called")));
            let view = transcript_view_id(ROW_VIEW).unwrap();
            let presentation = cli_presentation();
            service
                .append_chat_row("rows", append_input(&view, &presentation))
                .unwrap();
            remove();
            let (delivered, mut delivery) = mpsc::unbounded_channel();
            let _late = service.subscribe(Rc::new(move |event| {
                delivered.send(commit_summary(&event)).unwrap();
                TranscriptCommitWork::Complete(Ok(()))
            }));
            let event = tokio::time::timeout(Duration::from_secs(4), delivery.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(event["ordinals"], json!([1]));
            assert_eq!(received_errors.try_recv().unwrap(), "sync listener failure");
            settle.send(()).unwrap();
            let pending = tokio::time::timeout(Duration::from_secs(4), received_errors.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(pending, "pending listener failure");
            assert_eq!(store.high_watermark("rows").unwrap().ordinal, 1);
            store.close().unwrap();
        })
        .await;
}
