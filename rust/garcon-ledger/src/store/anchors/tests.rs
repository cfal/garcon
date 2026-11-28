use std::{
    cell::Cell,
    path::Path,
    rc::Rc,
    task::{Context, Waker},
};

use garcon_contract::{
    chat_types::{AssistantMessage, ChatMessage},
    transcript_anchor_page::{TranscriptAnchorDirection, TranscriptAnchorPageStatus},
};
use rusqlite::Connection;

use super::*;
use crate::{
    contracts::{LedgerRowData, LedgerRowDraft, RunOrigin, RunOutcome, transcript_view_id},
    store::{InitializeViewInput, StageViewInput, TranscriptLedgerStoreOptions},
};

const AT: &str = "2026-11-28T09:00:00.000Z";

fn open(root: &Path, rows: &[LedgerRowDraft]) -> Rc<TranscriptLedgerStore> {
    let store = Rc::new(
        TranscriptLedgerStore::new(
            root.to_str().unwrap(),
            TranscriptLedgerStoreOptions {
                connection_cache_size: Some(1),
                ..Default::default()
            },
        )
        .unwrap(),
    );
    store
        .initialize_current_view(
            "ledger",
            InitializeViewInput {
                view_id: Some(transcript_view_id("initial").unwrap()),
                content_start_ordinal: 1,
                rows,
            },
        )
        .unwrap();
    store
}

fn hidden() -> LedgerRowDraft {
    LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data: LedgerRowData::RunEnded {
            outcome: RunOutcome::Finished,
            origin: RunOrigin::Core,
            error: None,
        },
    }
}

fn assistant() -> LedgerRowDraft {
    LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data: LedgerRowData::ProviderRow {
            message: ChatMessage::Assistant(AssistantMessage {
                timestamp: AT.into(),
                content: "synthetic anchor".into(),
                questions: None,
            }),
        },
    }
}

fn held_first_turn() -> (EventLoopSteps, Rc<Cell<bool>>) {
    let hold = Rc::new(Cell::new(true));
    let advancing = hold.clone();
    let now = Cell::new(0.0);
    let steps = EventLoopSteps::with_clock("synthetic anchor scan", move || {
        let time = now.get();
        if advancing.get() {
            now.set(time + 10.0);
        }
        time
    });
    (steps, hold)
}

#[derive(Clone, Copy, Debug)]
enum Change {
    Append,
    Evict,
    Replace,
    Delete,
    CloseChat,
    CloseStore,
    Abort,
    Corrupt,
    QueryFailure,
}

// TLV5-PAGE.05: A held old-view scan cannot enter a replacement or reopen deleted storage.
#[tokio::test]
async fn revalidates_ownership_and_data_after_a_held_anchor_batch() {
    use Change::*;
    for change in [
        Append,
        Evict,
        Replace,
        Delete,
        CloseChat,
        CloseStore,
        Abort,
        Corrupt,
        QueryFailure,
    ] {
        let root = tempfile::tempdir().unwrap();
        let store = open(root.path(), &vec![hidden(); 650]);
        let initial = transcript_view_id("initial").unwrap();
        let replacement = transcript_view_id("replacement").unwrap();
        if matches!(change, Replace) {
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
        }
        let token = CancellationToken::new();
        let reason =
            || -> Box<dyn Error> { std::io::Error::other("synthetic cancellation").into() };
        let (steps, hold) = held_first_turn();
        let mut scan = std::pin::pin!(store.anchor_page_in_steps(
            "ledger",
            &initial,
            AnchorScanInput {
                direction: TranscriptAnchorDirection::Forward,
                cursor_ordinal: 0,
                watermark_ordinal: 650,
                anchors_remaining: 1,
            },
            Some(TranscriptReadSignal::with_reason(&token, &reason)),
            steps
        ));
        assert!(
            scan.as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending(),
            "{change:?}"
        );
        match change {
            Append => {
                store.append("ledger", &initial, &[assistant()]).unwrap();
            }
            Evict => {
                store.current_view("other").unwrap();
            }
            Replace => {
                store
                    .replace_current_view("ledger", &initial, &replacement)
                    .unwrap();
            }
            Delete => {
                store.close_chat("ledger").unwrap();
                std::fs::rename(root.path().join("ledger"), root.path().join("retired")).unwrap();
            }
            CloseChat => store.close_chat("ledger").unwrap(),
            CloseStore => store.close().unwrap(),
            Abort => token.cancel(),
            Corrupt | QueryFailure => {
                let db = Connection::open(root.path().join("ledger/ledger.sqlite")).unwrap();
                db.execute_batch(if matches!(change, Corrupt) {
                    "UPDATE transcript_rows SET payload_json = 'invalid' WHERE ordinal = 350"
                } else {
                    "DROP TABLE transcript_rows"
                })
                .unwrap();
            }
        }
        hold.set(false);
        let result = scan.await;
        match change {
            Append | Evict => {
                let result = result.unwrap();
                assert!(result.rows.iter().map(|row| row.ordinal).eq(1..=650));
                assert_eq!(result.page_status, TranscriptAnchorPageStatus::Exhausted);
                assert_eq!(result.anchors_remaining, 1);
            }
            Replace => assert!(matches!(
                result.unwrap_err().downcast_ref::<LedgerError>(),
                Some(LedgerError::StaleView { .. })
            )),
            Delete | CloseChat | CloseStore => assert!(matches!(
                result.unwrap_err().downcast_ref::<LedgerError>(),
                Some(LedgerError::BulkOperationAbandoned { .. })
            )),
            Abort => {
                assert_eq!(result.unwrap_err().to_string(), "synthetic cancellation");
                assert!(store.current_view("ledger").unwrap().is_some());
            }
            Corrupt | QueryFailure => {
                assert!(matches!(
                    result.unwrap_err().downcast_ref::<LedgerError>(),
                    Some(LedgerError::Fenced { .. })
                ));
                assert!(store.current_view("ledger").is_err());
                assert!(store.current_view("healthy").unwrap().is_none());
            }
        }
        if matches!(change, Delete) {
            assert!(!root.path().join("ledger").exists());
        }
        store.close().unwrap();
    }
}

#[tokio::test]
async fn revalidates_ownership_after_the_final_anchor_batch() {
    for (cursor_ordinal, anchors_remaining) in [(0, 0), (1, 1)] {
        let root = tempfile::tempdir().unwrap();
        let store = open(root.path(), &[assistant()]);
        let view = transcript_view_id("initial").unwrap();
        let (steps, hold) = held_first_turn();
        let mut scan = std::pin::pin!(store.anchor_page_in_steps(
            "ledger",
            &view,
            AnchorScanInput {
                direction: TranscriptAnchorDirection::Forward,
                cursor_ordinal,
                watermark_ordinal: 1,
                anchors_remaining,
            },
            None,
            steps
        ));
        assert!(
            scan.as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        store.close_chat("ledger").unwrap();
        hold.set(false);
        assert!(matches!(
            scan.await.unwrap_err().downcast_ref::<LedgerError>(),
            Some(LedgerError::BulkOperationAbandoned { .. })
        ));
    }
}

#[tokio::test]
async fn an_anchor_read_does_not_create_a_ledger_for_a_missing_chat() {
    let root = tempfile::tempdir().unwrap();
    let store = open(root.path(), &[]);
    let result = store
        .anchor_page(
            "missing",
            &transcript_view_id("initial").unwrap(),
            AnchorScanInput {
                direction: TranscriptAnchorDirection::Forward,
                cursor_ordinal: 0,
                watermark_ordinal: 0,
                anchors_remaining: 1,
            },
            None,
        )
        .await;
    assert!(matches!(
        result.unwrap_err().downcast_ref::<LedgerError>(),
        Some(LedgerError::ViewNotInitialized { .. })
    ));
    assert!(!root.path().join("missing").exists());
}
