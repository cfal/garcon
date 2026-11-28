use garcon_js::json::Opaque;
use rusqlite::{
    Connection,
    hooks::{AuthAction, AuthContext, Authorization, TransactionOperation},
};

use super::*;
use crate::{
    contracts::{LedgerNoticeDetail, LedgerRowData, transcript_view_id},
    errors::safe_fence_diagnostic,
    sqlite_operations::get_transaction_rollback_failure,
    store::TranscriptLedgerStoreOptions,
};

#[tokio::test]
async fn staging_and_seed_commit_failures_preserve_visibility_with_or_without_a_rollback() {
    for seed in [false, true] {
        for fail_rollback in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let store = TranscriptLedgerStore::new(
                root.path().to_str().unwrap(),
                TranscriptLedgerStoreOptions::default(),
            )
            .unwrap();
            let view = if seed {
                store.current_view("ledger").unwrap()
            } else {
                Some(
                    store
                        .initialize_current_view(
                            "ledger",
                            InitializeViewInput {
                                view_id: Some(transcript_view_id("authoritative").unwrap()),
                                content_start_ordinal: 1,
                                rows: &[],
                            },
                        )
                        .unwrap(),
                )
            };
            let fail_at = if seed { 4 } else { 2 };
            store
                .read("ledger", |entry| {
                    let mut commits = 0;
                    entry.db.authorizer(Some(move |context: AuthContext<'_>| {
                        let AuthAction::Transaction { operation } = context.action else {
                            return Authorization::Allow;
                        };
                        match operation {
                            TransactionOperation::Begin => Authorization::Allow,
                            TransactionOperation::Rollback if fail_rollback => Authorization::Deny,
                            TransactionOperation::Rollback => Authorization::Allow,
                            // The TRANSACTION action has only BEGIN, ROLLBACK, and COMMIT;
                            // rusqlite does not expose COMMIT as a named operation.
                            _ => {
                                commits += 1;
                                if commits == fail_at {
                                    Authorization::Deny
                                } else {
                                    Authorization::Allow
                                }
                            }
                        }
                    }))?;
                    Ok(())
                })
                .unwrap();

            let work = transcript_view_id("failed-stage").unwrap();
            let rows = vec![
                LedgerRowDraft {
                    at: "2026-11-28T09:00:00.000Z".into(),
                    provider_meta: None,
                    data: LedgerRowData::Notice {
                        message: "synthetic".into(),
                        detail: LedgerNoticeDetail::Other(Opaque::from(serde_json::json!({}))),
                    },
                };
                1200
            ];
            let failure = if seed {
                store
                    .seed_current_view(
                        "ledger",
                        InitializeViewInput {
                            view_id: Some(work),
                            content_start_ordinal: 1,
                            rows: &rows,
                        },
                    )
                    .await
                    .unwrap_err()
            } else {
                store
                    .stage_view(
                        "ledger",
                        StageViewInput {
                            view_id: work,
                            content_start_ordinal: 1,
                            rows: &rows,
                        },
                    )
                    .await
                    .unwrap_err()
            };
            assert_eq!(
                safe_fence_diagnostic(failure.as_ref()).cause_code,
                "SQLITE_AUTH"
            );
            let cause = failure.source().unwrap().source().unwrap();
            assert_eq!(
                get_transaction_rollback_failure(cause).is_some(),
                fail_rollback
            );
            let db = Connection::open(root.path().join("ledger/ledger.sqlite")).unwrap();
            let mut statement = db
                .prepare("SELECT view_id FROM transcript_views WHERE status = 'current'")
                .unwrap();
            let current = statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            assert_eq!(
                current,
                view.iter()
                    .map(|view| view.view_id.to_string())
                    .collect::<Vec<_>>()
            );
            if fail_rollback {
                assert!(store.current_view("ledger").is_err());
            } else {
                assert_eq!(store.current_view("ledger").unwrap(), view);
            }
            assert!(
                store
                    .initialize_current_view(
                        "ledger",
                        InitializeViewInput {
                            view_id: None,
                            content_start_ordinal: 1,
                            rows: &[],
                        }
                    )
                    .is_err()
            );
            store.close().unwrap();
        }
    }
}
