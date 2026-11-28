use std::{path::Path, process::Command};

use garcon_contract::chat_search::ChatSearchSnippetRole as Role;
use garcon_js::{
    clock::ManualClock,
    json::{Opaque, from_str},
};
use garcon_search::{
    rows::{HistoricalSearchMessageRow, SearchMessageRowInput},
    schema::*,
};
use rusqlite::{Connection, types::ValueRef};
use serde::Deserialize;
use serde_json::{Value, json};
use tempfile::TempDir;

const CLOCK_MS: i64 = 1_767_225_600_000;

fn directory() -> TempDir {
    let parent = std::path::PathBuf::from(std::env::var_os("HOME").unwrap())
        .join("tmp")
        .join("interface");
    std::fs::create_dir_all(&parent).unwrap();
    tempfile::Builder::new()
        .prefix("search-schema-")
        .tempdir_in(parent)
        .unwrap()
}

fn bun(mode: &str, path: Option<&Path>) -> String {
    let mut command = Command::new("bun");
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/schema-interop.ts"
        ))
        .arg(mode);
    if let Some(path) = path {
        command.arg(path);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "Bun {mode}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end()
        .to_owned()
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum Action {
    Build {
        chat_id: String,
        transcript_view_id: String,
        target_through: u64,
        expected_after_ordinal: u64,
        mode: SearchSyncMode,
        advance_to: u64,
        rows: Vec<HistoricalSearchMessageRow>,
        finish: bool,
    },
    Fail {
        chat_id: String,
        transcript_view_id: String,
        error_code: String,
    },
    Delete {
        chat_id: String,
    },
}

fn write_with_rust(path: &Path) {
    let actions: Vec<Action> = from_str(&bun("actions", None)).unwrap();
    let clock = ManualClock::new(CLOCK_MS);
    let opened = open_search_database(path).unwrap();
    assert!(opened.recreated);
    let db = opened.db;
    for action in actions {
        match action {
            Action::Build {
                chat_id,
                transcript_view_id,
                target_through,
                expected_after_ordinal,
                mode,
                advance_to,
                rows,
                finish,
            } => {
                let plan = plan_chat_sync(
                    &db,
                    PlanChatSync {
                        mode,
                        chat_id: &chat_id,
                        transcript_view_id: &transcript_view_id,
                        target_through,
                        expected_after_ordinal,
                    },
                    &clock,
                )
                .unwrap();
                let SearchSyncPlan::Build { state, stale_rows } = plan else {
                    panic!("expected to build")
                };
                if stale_rows {
                    while delete_stale_rows_batch(
                        &db,
                        DeleteStaleRows {
                            chat_id: &chat_id,
                            keep_view_id: &transcript_view_id,
                            keep_through: state.indexed_through,
                            limit: None,
                        },
                    )
                    .unwrap()
                        != 0
                    {}
                }
                insert_rows_batch(
                    &db,
                    InsertRowsBatch {
                        chat_id: &chat_id,
                        transcript_view_id: &transcript_view_id,
                        rows: &rows,
                        advance_to,
                    },
                    &clock,
                )
                .unwrap();
                if finish {
                    finish_chat_sync(&db, &chat_id, &transcript_view_id, &clock).unwrap();
                }
            }
            Action::Fail {
                chat_id,
                transcript_view_id,
                error_code,
            } => {
                mark_chat_failed(&db, &chat_id, &transcript_view_id, &error_code, &clock).unwrap();
            }
            Action::Delete { chat_id } => {
                while !delete_chat_batch(&db, &chat_id, None).unwrap().done {}
            }
        }
    }
    assert_eq!(observe_wal_truncate(&db).unwrap().busy, 0);
    close_search_database(db).unwrap();
}

fn rows(db: &Connection, sql: &str) -> Vec<Vec<Value>> {
    let mut statement = db.prepare(sql).unwrap();
    let columns = statement.column_count();
    statement
        .query_map([], |row| {
            (0..columns)
                .map(|index| {
                    let value = match row.get_ref(index)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(value) => json!(value),
                        ValueRef::Real(value) => json!(value),
                        ValueRef::Text(value) => json!(std::str::from_utf8(value).unwrap()),
                        ValueRef::Blob(_) => panic!("fixture query returned binary data"),
                    };
                    Ok(value)
                })
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn inspect_with_rust(path: &Path) -> Value {
    let db = open_search_read_database(path).unwrap();
    db.execute_batch(
        "CREATE VIRTUAL TABLE temp.fixture_vocab USING fts5vocab(main, search_chunks_fts, row)",
    )
    .unwrap();
    json!({
        "version": rows(&db, "PRAGMA user_version")[0][0],
        "vacuum": rows(&db, "PRAGMA auto_vacuum")[0][0],
        "objects": rows(&db, "SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name"),
        "shadows": rows(&db, "SELECT name FROM pragma_table_list WHERE schema='main' AND type='shadow' ORDER BY name"),
        "config": rows(&db, "SELECT k, v FROM search_chunks_fts_config ORDER BY k"),
        "states": rows(&db, "SELECT chat_id, transcript_view_id, status, indexed_through, target_through, last_error_code FROM search_chat_state ORDER BY chat_id"),
        "rows": rows(&db, "SELECT id, chat_id, transcript_view_id, ordinal, role, timestamp, body FROM search_chunks ORDER BY id"),
        "vocab": rows(&db, "SELECT term, doc, cnt FROM temp.fixture_vocab ORDER BY term"),
        "rank": rows(&db, "SELECT rowid, rank FROM search_chunks_fts WHERE search_chunks_fts MATCH 'quartz' ORDER BY rank, rowid"),
    })
}

fn wire(value: Value) -> String {
    serde_json::to_string(&Opaque::from_value(value)).unwrap()
}

#[test]
fn bun_and_rust_read_each_others_derived_indexes() {
    let directory = directory();
    let bun_path = directory.path().join("bun.sqlite");
    let rust_path = directory.path().join("rust.sqlite");
    let bun_native = bun("write", Some(&bun_path));
    write_with_rust(&rust_path);
    let rust_reads_bun = inspect_with_rust(&bun_path);
    let rust_native = inspect_with_rust(&rust_path);
    let bun_reads_rust = bun("inspect", Some(&rust_path));
    assert_eq!(rust_reads_bun["version"], 11);
    assert_eq!(rust_reads_bun["rows"].as_array().unwrap().len(), 12);
    assert_eq!(rust_reads_bun["states"].as_array().unwrap().len(), 4);
    for key in [
        "objects", "shadows", "config", "states", "rows", "vocab", "rank",
    ] {
        assert_eq!(
            wire(rust_reads_bun[key].clone()),
            wire(rust_native[key].clone()),
            "{key}"
        );
    }
    assert_eq!(wire(rust_reads_bun), bun_native, "Rust reader of Bun index");
    assert_eq!(
        wire(rust_native),
        bun_reads_rust,
        "Bun reader of Rust index"
    );
    assert_eq!(
        bun_native, bun_reads_rust,
        "Bun and Rust writers agree byte-for-byte"
    );
}

#[test]
fn recreates_a_stale_or_malformed_derived_file() {
    let directory = directory();
    let path = directory.path().join("index.sqlite");
    let stale = Connection::open(&path).unwrap();
    stale
        .execute_batch("CREATE TABLE stale_marker(value TEXT); PRAGMA user_version = 10")
        .unwrap();
    stale.close().unwrap();
    let opened = open_search_database(&path).unwrap();
    assert!(opened.recreated);
    assert_eq!(
        opened
            .db
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .unwrap(),
        11
    );
    assert!(
        rows(
            &opened.db,
            "SELECT name FROM sqlite_schema WHERE name='stale_marker'"
        )
        .is_empty()
    );
    opened
        .db
        .execute_batch("DROP TRIGGER search_chunks_ad")
        .unwrap();
    close_search_database(opened.db).unwrap();
    assert!(matches!(
        open_search_read_database(&path),
        Err(SearchSchemaError::InvalidSchema)
    ));
    let repaired = open_search_database(&path).unwrap();
    assert!(repaired.recreated);
    close_search_database(repaired.db).unwrap();
    let valid = open_search_database(&path).unwrap();
    assert!(!valid.recreated);
}

#[test]
fn reader_temp_state_does_not_weaken_read_only_main() {
    let directory = directory();
    let path = directory.path().join("index.sqlite");
    let opened = open_search_database(&path).unwrap();
    close_search_database(opened.db).unwrap();
    let reader = open_search_read_database(&path).unwrap();
    reader
        .execute_batch(
            "CREATE TEMP TABLE staged_ids(id TEXT PRIMARY KEY);
        INSERT INTO staged_ids VALUES ('chat');",
        )
        .unwrap();
    assert_eq!(
        rows(&reader, "SELECT id FROM staged_ids"),
        [vec![json!("chat")]]
    );
    assert!(
        reader
            .execute_batch("CREATE TABLE main.forbidden(value TEXT)")
            .is_err()
    );
}

#[test]
fn validates_the_complete_shadow_set_and_enables_bundled_fts5() {
    let db = Connection::open_in_memory().unwrap();
    let enabled: i64 = db
        .query_row(
            "SELECT sqlite_compileoption_used('ENABLE_FTS5')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(enabled, 1);
    let mut exact = SEARCH_FTS_SHADOW_TABLES
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    assert!(require_exact_shadow_set(&exact).is_ok());
    exact.insert("search_extra_fts_data".to_owned());
    assert!(matches!(
        require_exact_shadow_set(&exact),
        Err(SearchSchemaError::InvalidSchema)
    ));
}

fn row(ordinal: u64, body: &str) -> HistoricalSearchMessageRow {
    HistoricalSearchMessageRow {
        ordinal,
        row: SearchMessageRowInput {
            role: Role::Assistant,
            timestamp: None,
            body: body.to_owned(),
        },
    }
}

fn build(
    db: &Connection,
    target_through: u64,
    clock: &dyn garcon_js::Clock,
) -> PlanChatSync<'static> {
    let plan = PlanChatSync {
        mode: SearchSyncMode::Replace,
        chat_id: "chat",
        transcript_view_id: "view",
        target_through,
        expected_after_ordinal: 0,
    };
    plan_chat_sync(db, plan, clock).unwrap();
    plan
}

#[test]
fn a_covered_plan_performs_zero_writes_and_append_fences_the_frontier() {
    let directory = directory();
    let opened = open_search_database(&directory.path().join("index.sqlite")).unwrap();
    let db = opened.db;
    let clock = ManualClock::new(CLOCK_MS);
    let plan = build(&db, 4, &clock);
    insert_rows_batch(
        &db,
        InsertRowsBatch {
            chat_id: "chat",
            transcript_view_id: "view",
            rows: &[row(4, "quartz")],
            advance_to: 4,
        },
        &clock,
    )
    .unwrap();
    finish_chat_sync(&db, "chat", "view", &clock).unwrap();
    let changes = db.total_changes();
    assert!(matches!(
        plan_chat_sync(&db, plan, &clock).unwrap(),
        SearchSyncPlan::Current { .. }
    ));
    assert_eq!(db.total_changes(), changes);
    let gap = PlanChatSync {
        mode: SearchSyncMode::Append,
        target_through: 6,
        expected_after_ordinal: 3,
        ..plan
    };
    assert!(matches!(
        plan_chat_sync(&db, gap, &clock),
        Err(SearchSchemaError::IndexGap)
    ));
    assert_eq!(db.total_changes(), changes);
}

#[test]
fn an_invalid_row_rolls_back_the_batch_and_fts_trigger() {
    let directory = directory();
    let opened = open_search_database(&directory.path().join("index.sqlite")).unwrap();
    let db = opened.db;
    let clock = ManualClock::new(CLOCK_MS);
    build(&db, 5, &clock);
    let result = insert_rows_batch(
        &db,
        InsertRowsBatch {
            chat_id: "chat",
            transcript_view_id: "view",
            rows: &[row(1, "quartz"), row(3, "")],
            advance_to: 3,
        },
        &clock,
    );
    assert!(matches!(result, Err(SearchSchemaError::InvalidRow)));
    assert!(rows(&db, "SELECT id FROM search_chunks").is_empty());
    assert!(
        rows(
            &db,
            "SELECT rowid FROM search_chunks_fts WHERE search_chunks_fts MATCH 'quartz'"
        )
        .is_empty()
    );
    assert_eq!(
        get_chat_state(&db, "chat")
            .unwrap()
            .unwrap()
            .indexed_through,
        0
    );
    assert!(matches!(
        finish_chat_sync(&db, "chat", "view", &clock),
        Err(SearchSchemaError::InvalidFrontier)
    ));
}

#[test]
fn enforces_ingest_budgets_without_losing_a_large_safe_frontier() {
    let directory = directory();
    let opened = open_search_database(&directory.path().join("index.sqlite")).unwrap();
    let db = opened.db;
    let clock = ManualClock::new(CLOCK_MS);
    let frontier = 9_007_199_254_740_991;
    let plan = build(&db, frontier, &clock);
    assert!(matches!(
        plan_chat_sync(
            &db,
            PlanChatSync {
                target_through: frontier + 1,
                ..plan
            },
            &clock
        ),
        Err(SearchSchemaError::InvalidFrontier)
    ));
    let insert = |rows: &[HistoricalSearchMessageRow]| {
        insert_rows_batch(
            &db,
            InsertRowsBatch {
                chat_id: "chat",
                transcript_view_id: "view",
                rows,
                advance_to: frontier,
            },
            &clock,
        )
    };
    assert!(matches!(
        insert(&vec![row(1, "word"); SEARCH_INGEST_TXN_MAX_ROWS + 1]),
        Err(SearchSchemaError::BatchTooLarge)
    ));
    let oversized = "x".repeat(SEARCH_INGEST_ROW_MAX_BYTES + 1);
    assert!(matches!(
        insert(&[row(1, &oversized)]),
        Err(SearchSchemaError::RowTooLarge)
    ));
    let large = row(1, &oversized[..SEARCH_INGEST_ROW_MAX_BYTES]);
    assert!(matches!(
        insert(&[large, row(2, "word")]),
        Err(SearchSchemaError::BatchTooLarge)
    ));
    assert_eq!(status_counts(&db).unwrap().backlog_rows, frontier);
    assert_eq!(
        insert(&[row(frontier, "quartz")]).unwrap().indexed_through,
        frontier
    );
    assert_eq!(
        finish_chat_sync(&db, "chat", "view", &clock)
            .unwrap()
            .target_through,
        frontier
    );
}

#[test]
fn bounds_stale_cleanup_and_keeps_failure_frontiers_view_local() {
    let directory = directory();
    let opened = open_search_database(&directory.path().join("index.sqlite")).unwrap();
    let db = opened.db;
    let clock = ManualClock::new(CLOCK_MS);
    let plan = build(&db, 4, &clock);
    insert_rows_batch(
        &db,
        InsertRowsBatch {
            chat_id: "chat",
            transcript_view_id: "view",
            rows: &[row(1, "old first"), row(2, "old second")],
            advance_to: 3,
        },
        &clock,
    )
    .unwrap();
    mark_chat_failed(&db, "chat", "view", "READ_FAILED", &clock).unwrap();
    let failed = get_chat_state(&db, "chat").unwrap().unwrap();
    assert_eq!(
        (failed.status, failed.indexed_through, failed.target_through),
        (SearchChatStatus::Failed, 3, 4)
    );
    let retry = plan_chat_sync(&db, plan, &clock).unwrap();
    assert!(
        matches!(retry, SearchSyncPlan::Build { state, stale_rows: false } if state.indexed_through == 3)
    );
    mark_chat_failed(&db, "chat", "next", "READ_FAILED", &clock).unwrap();
    let failed = get_chat_state(&db, "chat").unwrap().unwrap();
    assert_eq!(
        (failed.status, failed.indexed_through, failed.target_through),
        (SearchChatStatus::Failed, 0, 0)
    );
    let cleanup = DeleteStaleRows {
        chat_id: "chat",
        keep_view_id: "next",
        keep_through: 0,
        limit: Some(1),
    };
    assert_eq!(delete_stale_rows_batch(&db, cleanup).unwrap(), 1);
    assert_eq!(delete_stale_rows_batch(&db, cleanup).unwrap(), 1);
    assert_eq!(delete_stale_rows_batch(&db, cleanup).unwrap(), 0);
    assert_eq!(
        delete_chat_batch(&db, "chat", Some(1)).unwrap(),
        DeleteChatProgress {
            done: true,
            deleted_rows: 0
        }
    );
    assert!(list_state_chat_ids(&db).unwrap().is_empty());
}
