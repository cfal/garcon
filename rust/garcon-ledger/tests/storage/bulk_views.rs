use std::{
    future::Future,
    path::Path,
    process::Command,
    rc::Rc,
    task::{Context, Poll, Waker},
    time::Instant,
};

use garcon_contract::chat_types::UserMessage;
use garcon_ledger::{
    contracts::{
        LedgerNoticeDetail, LedgerRowData, LedgerRowDraft, TranscriptViewStatus, transcript_view_id,
    },
    errors::{LedgerError, safe_fence_diagnostic},
    input_submission::input_detail,
    sqlite_operations::read_stored_row,
    store::{
        InitializeViewInput, StageViewInput, TranscriptLedgerStore, TranscriptLedgerStoreOptions,
    },
};
use rusqlite::Connection;
use serde_json::{Value, json};
use tokio::task::LocalSet;

const AT: &str = "2026-11-28T09:00:00.000Z";

pub(super) fn store(root: &Path) -> Rc<TranscriptLedgerStore> {
    Rc::new(
        TranscriptLedgerStore::new(
            root.to_str().unwrap(),
            TranscriptLedgerStoreOptions {
                connection_cache_size: Some(1),
                now: Some(Rc::new(|| Ok(AT.into()))),
                ..Default::default()
            },
        )
        .unwrap(),
    )
}

pub(super) fn notice(message: &str) -> LedgerRowDraft {
    LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data: LedgerRowData::Notice {
            message: message.into(),
            detail: LedgerNoticeDetail::Other(serde_json::json!({}).into()),
        },
    }
}

pub(super) fn initialize(
    store: &TranscriptLedgerStore,
    chat_id: &str,
    id: &str,
    rows: &[LedgerRowDraft],
) {
    store
        .initialize_current_view(
            chat_id,
            InitializeViewInput {
                view_id: Some(transcript_view_id(id).unwrap()),
                content_start_ordinal: 1,
                rows,
            },
        )
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn staging_batches_count_utf16_units_and_survive_connection_eviction() {
    let original_root = tempfile::tempdir().unwrap();
    let original = oracle("unicode-batch", original_root.path());
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    initialize(&store, "ledger", "current", &[]);
    let staging = transcript_view_id("staged").unwrap();
    let rows = vec![notice(&"\u{754c}".repeat(400_000)); 8];
    let mut stage = std::pin::pin!(store.stage_view(
        "ledger",
        StageViewInput {
            view_id: staging.clone(),
            content_start_ordinal: 1,
            rows: &rows,
        }
    ));
    let start = Instant::now();
    assert!(matches!(
        stage.as_mut().poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    eprintln!(
        "Rust first staging batch (UTF-16 cap): {:.2} ms",
        start.elapsed().as_secs_f64() * 1000.0
    );
    let database = Connection::open(root.path().join("ledger/ledger.sqlite")).unwrap();
    let stored: i64 = database
        .query_row(
            "SELECT count(*) FROM transcript_rows WHERE view_id = 'staged'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        stored, 6,
        "the first batch crosses the cap in UTF-16 units, not UTF-8 bytes"
    );
    assert_eq!(json!({"firstBatchRows": stored}), original);
    database.close().unwrap();
    initialize(&store, "other", "other-view", &[]);
    assert_eq!(stage.await.unwrap().status, TranscriptViewStatus::Staging);
    let current = transcript_view_id("current").unwrap();
    assert!(
        store
            .page("ledger", &current, 10, None)
            .unwrap()
            .rows
            .is_empty()
    );
    let promoted = store
        .replace_current_view("ledger", &current, &staging)
        .unwrap();
    assert_eq!(promoted.status, TranscriptViewStatus::Current);
    assert_eq!(
        store.page("ledger", &staging, 10, None).unwrap().rows.len(),
        8
    );
    assert!(matches!(
        store
            .page("ledger", &current, 1, None)
            .unwrap_err()
            .downcast_ref::<LedgerError>(),
        Some(LedgerError::StaleView { .. })
    ));
}

#[tokio::test(start_paused = true)]
async fn closing_a_chat_abandons_a_suspended_stage() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    initialize(&store, "ledger", "current", &[]);
    let rows = vec![notice("synthetic"); 501];
    let mut stage = std::pin::pin!(store.stage_view(
        "ledger",
        StageViewInput {
            view_id: transcript_view_id("staged").unwrap(),
            content_start_ordinal: 1,
            rows: &rows,
        }
    ));
    assert!(matches!(
        stage.as_mut().poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    store.close_chat("ledger").unwrap();
    assert!(matches!(
        stage.await.unwrap_err().downcast_ref::<LedgerError>(),
        Some(LedgerError::BulkOperationAbandoned { .. })
    ));
    let current = transcript_view_id("current").unwrap();
    assert!(
        store
            .page("ledger", &current, 10, None)
            .unwrap()
            .rows
            .is_empty()
    );
}

fn oracle(mode: &str, root: &Path) -> Value {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/staging-store-oracle.ts"
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

fn notices(count: usize, label: &str) -> Vec<LedgerRowDraft> {
    (0..count)
        .map(|index| notice(&format!("{label} {index}")))
        .collect()
}

fn read_current(root: &Path) -> Value {
    let store = store(root);
    let view = store.existing_current_view("ledger").unwrap().unwrap();
    let page = store.page("ledger", &view.view_id, 4, None).unwrap();
    let db = Connection::open(root.join("ledger/ledger.sqlite")).unwrap();
    let mut statement = db
        .prepare(
            "SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows WHERE view_id = ? ORDER BY ordinal",
        )
        .unwrap();
    let stored = statement
        .query_map([view.view_id.as_str()], read_stored_row)
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    store.close().unwrap();
    json!({"view": view, "page": page, "stored": stored})
}

fn row_count(root: &Path, view_id: &str) -> i64 {
    Connection::open(root.join("ledger/ledger.sqlite"))
        .unwrap()
        .query_row(
            "SELECT count(*) FROM transcript_rows WHERE view_id = ?",
            [view_id],
            |row| row.get(0),
        )
        .unwrap()
}

#[tokio::test]
async fn staged_cutover_and_storage_match_bun_in_both_directions() {
    let original_root = tempfile::tempdir().unwrap();
    let original = oracle("write", original_root.path());
    assert_eq!(read_current(original_root.path()), original);

    let native_root = tempfile::tempdir().unwrap();
    let root = native_root.path();
    let store = store(root);
    LocalSet::new()
        .run_until(async {
            let old = transcript_view_id("old").unwrap();
            let replacement = transcript_view_id("replacement").unwrap();
            let old_rows = notices(4501, "old");
            let mut seed = std::pin::pin!(store.seed_current_view(
                "ledger",
                InitializeViewInput {
                    view_id: Some(old.clone()),
                    content_start_ordinal: 1,
                    rows: &old_rows,
                }
            ));
            assert!(
                seed.as_mut()
                    .poll(&mut Context::from_waker(Waker::noop()))
                    .is_pending()
            );
            assert!(store.current_view("ledger").unwrap().is_none());
            assert_eq!(row_count(root, old.as_str()), 500);
            assert_eq!(seed.await.unwrap().view_id, old);
            let new_rows = notices(505, "new");
            let mut stage = std::pin::pin!(store.stage_view(
                "ledger",
                StageViewInput {
                    view_id: replacement.clone(),
                    content_start_ordinal: 3,
                    rows: &new_rows,
                }
            ));
            let start = Instant::now();
            assert!(
                stage
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop()))
                    .is_pending()
            );
            eprintln!(
                "Rust first staging batch (500 rows): {:.2} ms",
                start.elapsed().as_secs_f64() * 1000.0
            );
            assert_eq!(store.current_view("ledger").unwrap().unwrap().view_id, old);
            assert_eq!(row_count(root, replacement.as_str()), 500);
            stage.await.unwrap();
            let start = Instant::now();
            assert_eq!(
                store
                    .replace_current_view("ledger", &old, &replacement)
                    .unwrap()
                    .view_id,
                replacement
            );
            eprintln!(
                "Rust promotion and first discard batch (2000 rows): {:.2} ms",
                start.elapsed().as_secs_f64() * 1000.0
            );
            assert_eq!(row_count(root, old.as_str()), 2501);
            assert!(matches!(
                store
                    .page("ledger", &old, 1, None)
                    .unwrap_err()
                    .downcast_ref::<LedgerError>(),
                Some(LedgerError::StaleView { .. })
            ));
            for _ in 0..20 {
                if row_count(root, old.as_str()) == 0 {
                    break;
                }
                garcon_base::event_loop::yield_to_event_loop().await;
            }
            assert_eq!(row_count(root, old.as_str()), 0);
            let db = Connection::open(root.join("ledger/ledger.sqlite")).unwrap();
            let view_count: i64 = db
                .query_row("SELECT count(*) FROM transcript_views", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(view_count, 1);
        })
        .await;
    store.close().unwrap();
    assert_eq!(oracle("read", root), read_current(root));
    assert_eq!(read_current(root), original);
}

// The Bun test names this case TLV5-L02.05-STORE-UNIT-01; the CTS catalogs it under L08.02.
#[tokio::test]
async fn tlv5_l08_02_store_unit_01_atomically_deletes_the_replaced_view_when_promoting_staging() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let store = store(root);
    let old = transcript_view_id("old").unwrap();
    let new = transcript_view_id("new").unwrap();
    initialize(&store, "ledger", old.as_str(), &[notice("old")]);
    store
        .stage_view(
            "ledger",
            StageViewInput {
                view_id: new.clone(),
                content_start_ordinal: 1,
                rows: &[notice("new")],
            },
        )
        .await
        .unwrap();
    let promoted = store.replace_current_view("ledger", &old, &new).unwrap();
    assert_eq!(promoted.status, TranscriptViewStatus::Current);
    assert_eq!(promoted.view_id, new);
    let page = store.page("ledger", &new, 10, None).unwrap();
    assert!(
        matches!(&page.rows[0].data, LedgerRowData::Notice { message, .. } if message == "new")
    );
    assert!(matches!(
        store
            .page("ledger", &old, 10, None)
            .unwrap_err()
            .downcast_ref::<LedgerError>(),
        Some(LedgerError::StaleView { .. })
    ));
    store.close().unwrap();
    assert_eq!(row_count(root, "old"), 0);
    let db = Connection::open(root.join("ledger/ledger.sqlite")).unwrap();
    let view_count: i64 = db
        .query_row("SELECT count(*) FROM transcript_views", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(view_count, 1);
}

#[tokio::test]
async fn closing_during_seed_leaves_a_clean_uninitialized_ledger_on_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let before_close = store(root);
    let abandoned = transcript_view_id("abandoned").unwrap();
    let rows = notices(501, "seed");
    let mut seed = std::pin::pin!(before_close.seed_current_view(
        "ledger",
        InitializeViewInput {
            view_id: Some(abandoned),
            content_start_ordinal: 1,
            rows: &rows,
        }
    ));
    assert!(
        seed.as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    before_close.close().unwrap();
    assert!(matches!(
        seed.await.unwrap_err().downcast_ref::<LedgerError>(),
        Some(LedgerError::BulkOperationAbandoned { .. })
    ));
    assert_eq!(row_count(root, "abandoned"), 500);
    let reopened = store(root);
    assert!(reopened.existing_current_view("ledger").unwrap().is_none());
    assert_eq!(row_count(root, "abandoned"), 0);
    initialize(&reopened, "ledger", "fresh", &[notice("fresh")]);
    assert_eq!(row_count(root, "fresh"), 1);
}

#[tokio::test]
async fn dropping_a_suspended_seed_or_stage_allows_eviction_to_reclaim_its_rows() {
    for seeding in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let store = store(root);
        if !seeding {
            initialize(&store, "ledger", "current", &[notice("authoritative")]);
        }
        let abandoned = transcript_view_id("abandoned").unwrap();
        let rows = notices(501, "synthetic");
        {
            let mut operation = std::pin::pin!(async {
                if seeding {
                    store
                        .seed_current_view(
                            "ledger",
                            InitializeViewInput {
                                view_id: Some(abandoned.clone()),
                                content_start_ordinal: 1,
                                rows: &rows,
                            },
                        )
                        .await
                } else {
                    store
                        .stage_view(
                            "ledger",
                            StageViewInput {
                                view_id: abandoned.clone(),
                                content_start_ordinal: 1,
                                rows: &rows,
                            },
                        )
                        .await
                }
            });
            assert!(
                operation
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop()))
                    .is_pending()
            );
            assert_eq!(row_count(root, abandoned.as_str()), 500);
        }
        assert_eq!(
            row_count(root, abandoned.as_str()),
            500,
            "drop does not run a deletion transaction"
        );
        initialize(&store, "other", "other-view", &[]);
        let current = store.current_view("ledger").unwrap();
        assert_eq!(
            current.as_ref().map(|view| view.view_id.as_str()),
            (!seeding).then_some("current")
        );
        assert_eq!(
            row_count(root, abandoned.as_str()),
            0,
            "abandoned staged rows survived eviction and reopen (seeding={seeding})"
        );
    }
}

#[tokio::test]
async fn dropping_a_suspended_discard_allows_reopen_to_finish_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let store = store(root);
    initialize(&store, "ledger", "current", &[]);
    let abandoned = transcript_view_id("abandoned").unwrap();
    store
        .stage_view(
            "ledger",
            StageViewInput {
                view_id: abandoned.clone(),
                content_start_ordinal: 1,
                rows: &notices(2001, "synthetic"),
            },
        )
        .await
        .unwrap();
    {
        let mut discard = std::pin::pin!(store.discard_staging_view("ledger", &abandoned));
        assert!(
            discard
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        assert_eq!(row_count(root, abandoned.as_str()), 1);
    }
    initialize(&store, "other", "other-view", &[]);
    assert_eq!(
        store
            .current_view("ledger")
            .unwrap()
            .unwrap()
            .view_id
            .as_str(),
        "current"
    );
    assert_eq!(row_count(root, abandoned.as_str()), 0);
}

#[tokio::test]
async fn dropping_an_old_stage_does_not_unpin_the_same_id_in_a_new_generation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let store = store(root);
    initialize(&store, "ledger", "current", &[]);
    let stage = transcript_view_id("reused-stage-id").unwrap();
    let rows = notices(501, "old");
    {
        let mut old = std::pin::pin!(store.stage_view(
            "ledger",
            StageViewInput {
                view_id: stage.clone(),
                content_start_ordinal: 1,
                rows: &rows,
            }
        ));
        assert!(
            old.as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        store.close_chat("ledger").unwrap();
        store
            .stage_view(
                "ledger",
                StageViewInput {
                    view_id: stage.clone(),
                    content_start_ordinal: 1,
                    rows: &[notice("new")],
                },
            )
            .await
            .unwrap();
    }
    initialize(&store, "other", "other-view", &[]);
    let current = transcript_view_id("current").unwrap();
    assert_eq!(
        store
            .replace_current_view("ledger", &current, &stage)
            .unwrap()
            .view_id,
        stage
    );
    assert_eq!(row_count(root, stage.as_str()), 1);
}

#[tokio::test]
async fn duplicate_submission_across_staging_batches_discards_only_the_staged_view() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let store = store(root);
    initialize(&store, "ledger", "current", &[notice("authoritative")]);
    let input = LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data: LedgerRowData::UserInput {
            detail: input_detail(
                UserMessage {
                    timestamp: AT.into(),
                    content: "synthetic duplicate".into(),
                    images: None,
                    metadata: None,
                    presentation: None,
                },
                Vec::new(),
                Some("repeat".into()),
                false,
            ),
        },
    };
    let mut rows = notices(501, "replacement");
    rows[0] = input.clone();
    rows[500] = input;
    let staged = transcript_view_id("duplicates").unwrap();
    let error = store
        .stage_view(
            "ledger",
            StageViewInput {
                view_id: staged,
                content_start_ordinal: 1,
                rows: &rows,
            },
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error.downcast_ref::<LedgerError>(), Some(LedgerError::Schema(message))
         if message == "Transcript view contains duplicate client message IDs")
    );
    assert_eq!(row_count(root, "duplicates"), 0);
    let current = transcript_view_id("current").unwrap();
    assert_eq!(
        store.append("ledger", &current, &[notice("next")]).unwrap()[0].ordinal,
        2
    );
}

#[tokio::test]
async fn a_failed_promotion_rolls_back_demotion_and_fences_only_writes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let store = store(root);
    let current = transcript_view_id("current").unwrap();
    let staged = transcript_view_id("staged").unwrap();
    initialize(
        &store,
        "ledger",
        current.as_str(),
        &[notice("authoritative")],
    );
    store
        .stage_view(
            "ledger",
            StageViewInput {
                view_id: staged.clone(),
                content_start_ordinal: 1,
                rows: &[notice("not current")],
            },
        )
        .await
        .unwrap();
    let db = Connection::open(root.join("ledger/ledger.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER reject_promotion BEFORE UPDATE OF status ON transcript_views
        WHEN new.view_id = 'staged' AND new.status = 'current'
        BEGIN SELECT RAISE(ABORT, 'synthetic promotion failure'); END;",
    )
    .unwrap();
    let error = store
        .replace_current_view("ledger", &current, &staged)
        .unwrap_err();
    assert_eq!(
        safe_fence_diagnostic(error.as_ref()).cause_code,
        "SQLITE_CONSTRAINT_TRIGGER"
    );
    let durable: String = db
        .query_row(
            "SELECT view_id FROM transcript_views WHERE status = 'current'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(durable, "current");
    assert_eq!(
        store.current_view("ledger").unwrap().unwrap().view_id,
        current
    );
    assert!(matches!(
        store
            .append("ledger", &current, &[notice("rejected")])
            .unwrap_err()
            .downcast_ref::<LedgerError>(),
        Some(LedgerError::Fenced { .. })
    ));
}
