use std::{collections::HashSet, process::Command, time::Instant};

use garcon_js::json::from_slice;
use garcon_ledger::{
    connection_entry::ConnectionEntry,
    connection_setup::{LedgerSynchronous, close_connection, open_connection},
    directories::ensure_ledger_root_directory,
};
use serde_json::{Value, json};

fn original(root: &str, chat: &str, operation: &str) -> Value {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/storage_connection_oracle.ts"
        ))
        .args([root, chat, operation])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    if operation == "measure" {
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
    }
    from_slice(&output.stdout).unwrap()
}

fn snapshot(entry: &ConnectionEntry) -> Value {
    let db = &entry.db;
    let schema = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap()
        .query_map([], |row| {
            Ok(json!({"name": row.get::<_, String>(0)?, "sql": row.get::<_, String>(1)?}))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let number = |sql| db.query_row(sql, [], |row| row.get::<_, i64>(0)).unwrap();
    let journal: String = db
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    json!({
        "schema": schema,
        "version": number("PRAGMA user_version"),
        "journal": journal,
        "synchronous": number("PRAGMA synchronous"),
        "foreignKeys": number("PRAGMA foreign_keys"),
        "busyTimeout": number("PRAGMA busy_timeout"),
        "current": entry.current,
        "nextOrdinal": entry.next_ordinal,
    })
}

fn native(root: &str, chat: &str) -> ConnectionEntry {
    open_connection(root, chat, LedgerSynchronous::Full, &HashSet::new()).unwrap()
}

#[cfg(target_os = "linux")]
#[test]
fn linux_ledger_root_has_buns_realpath_backslash_error() {
    use garcon_base::errors::{ErrorInput, has_node_error_code};

    let root = tempfile::tempdir().unwrap();
    let path = root.path().join(r"with\backslash");
    let path = path.to_str().unwrap();
    let error = ensure_ledger_root_directory(path).unwrap_err();
    let expected = original(path, "", "root-error");
    assert_eq!(expected["name"], "Error");
    assert_eq!(expected["message"], error.to_string());
    assert_eq!(expected["code"], "ENOENT");
    assert!(has_node_error_code(ErrorInput::Error(&error), "ENOENT"));
}

#[test]
fn schemas_pragmas_and_lazy_migrations_match_bun_in_both_directions() {
    let root = tempfile::tempdir().unwrap();
    let root_path = ensure_ledger_root_directory(root.path().to_str().unwrap()).unwrap();
    let ts = original(&root_path, "bun-created", "snapshot");
    let from_bun = native(&root_path, "bun-created");
    assert_eq!(snapshot(&from_bun), ts);
    assert!(matches!(
        close_connection(from_bun),
        garcon_ledger::connection_entry::ConnectionCloseAttempt::Closed { .. }
    ));

    let from_rust = native(&root_path, "rust-created");
    let rs = snapshot(&from_rust);
    assert_eq!(rs, ts);
    from_rust
        .db
        .execute_batch(
            "
        DROP INDEX transcript_ticket_outcome_correlation;
        DROP INDEX transcript_session_rows;
        PRAGMA user_version = 1;
    ",
        )
        .unwrap();
    from_rust.db.close().unwrap();
    assert_eq!(original(&root_path, "rust-created", "snapshot"), rs);

    let from_rust = native(&root_path, "rust-created");
    from_rust
        .db
        .execute_batch(
            "
        DROP INDEX transcript_session_rows;
        PRAGMA user_version = 2;
    ",
        )
        .unwrap();
    from_rust.db.close().unwrap();
    assert_eq!(snapshot(&native(&root_path, "rust-created")), rs);

    #[cfg(unix)]
    {
        use std::{fs, os::unix::fs::PermissionsExt};

        for chat in ["bun-created", "rust-created"] {
            let directory = root.path().join(chat);
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
            let file = directory.join("ledger.sqlite");
            assert_eq!(
                fs::metadata(file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}

fn abandoned_stage(entry: &ConnectionEntry) {
    entry.db.execute_batch(r#"
      BEGIN IMMEDIATE;
      INSERT INTO transcript_views VALUES ('current', 'current', 'synthetic-ts', 1);
      INSERT INTO transcript_views VALUES ('abandoned', 'staging', 'synthetic-ts', 1);
      INSERT INTO transcript_views VALUES ('retained', 'staging', 'synthetic-ts', 1);
      INSERT INTO transcript_rows VALUES ('current', 1, 'notice', 'synthetic-ts', NULL, '{}');
      INSERT INTO transcript_rows VALUES ('retained', 1, 'notice', 'synthetic-ts', NULL, '{}');
      WITH RECURSIVE n(i) AS (
        VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 60000
      )
      INSERT INTO transcript_rows
      SELECT 'abandoned', i, 'provider-row', 'synthetic-ts', NULL,
        '{"providerMeta":null,"value":{"type":"assistant-message","content":"' || printf('%0200d', i) || '"}}'
      FROM n;
      COMMIT;
    "#).unwrap();
}

#[test]
fn reopen_cascades_abandoned_staging_and_keeps_owned_staging() {
    let root = tempfile::tempdir().unwrap();
    let root_path = ensure_ledger_root_directory(root.path().to_str().unwrap()).unwrap();
    for chat in ["bun-reopen", "rust-reopen"] {
        let entry = native(&root_path, chat);
        abandoned_stage(&entry);
        entry.db.close().unwrap();
    }

    let expected = original(&root_path, "bun-reopen", "measure");
    let started = Instant::now();
    let opened = open_connection(
        &root_path,
        "rust-reopen",
        LedgerSynchronous::Full,
        &HashSet::from(["retained".into()]),
    )
    .unwrap();
    eprintln!(
        "Rust open with abandoned staging: {:.2} ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
    let remaining = opened
        .db
        .prepare("SELECT view_id, count(*) FROM transcript_rows GROUP BY view_id ORDER BY view_id")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(remaining, [("current".into(), 1), ("retained".into(), 1)]);
    assert_eq!(snapshot(&opened), expected);
}
