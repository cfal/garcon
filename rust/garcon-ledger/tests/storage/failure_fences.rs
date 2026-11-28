use std::collections::HashSet;

use garcon_ledger::{
    connection_setup::{LedgerSynchronous, open_connection, rehydrate_connection},
    directories::ensure_ledger_root_directory,
    errors::{LedgerError, safe_fence_diagnostic},
    failure_fences::LedgerFailureFences,
    sqlite_operations::{
        LedgerResult, get_transaction_rollback_failure, run_query, run_transaction,
    },
};
use rusqlite::Connection;

#[test]
fn failed_transaction_rolls_back_and_remains_a_write_fence() {
    let root = tempfile::tempdir().unwrap();
    let root_path = ensure_ledger_root_directory(root.path().to_str().unwrap()).unwrap();
    let mut entry = open_connection(
        &root_path,
        "test",
        LedgerSynchronous::Normal,
        &HashSet::new(),
    )
    .unwrap();
    let mut fences = LedgerFailureFences::default();

    let response = fences.write(
        "test",
        || Ok(&mut entry),
        |entry| {
            run_transaction(&entry.db, || {
                entry.db.execute_batch(
                    "INSERT INTO transcript_views VALUES ('one', 'current', 'synthetic-time', 1)",
                )?;
                entry.db.execute_batch(
                    "INSERT INTO transcript_views VALUES ('two', 'current', 'synthetic-time', 1)",
                )?;
                Ok(())
            })
        },
        rehydrate_connection,
    );
    let error = response.unwrap_err();
    assert!(matches!(
        error.downcast_ref::<LedgerError>(),
        Some(LedgerError::Fenced { .. })
    ));
    let diagnostic = safe_fence_diagnostic(error.as_ref());
    assert_eq!(diagnostic.cause_name, "SQLiteError");
    assert_eq!(diagnostic.cause_code, "SQLITE_CONSTRAINT_UNIQUE");
    assert!(entry.db.is_autocommit());
    assert!(entry.current.is_none());
    let count = fences
        .read(
            "test",
            || Ok(&mut entry),
            |entry| {
                Ok(entry
                    .db
                    .query_row("SELECT count(*) FROM transcript_views", [], |row| {
                        row.get::<_, i64>(0)
                    })?)
            },
        )
        .unwrap();
    assert_eq!(count, 0);
    assert!(
        fences
            .write(
                "test",
                || panic!("a fenced write must not acquire the connection"),
                |_| Ok(()),
                rehydrate_connection
            )
            .is_err()
    );
}

#[test]
fn a_failed_query_fences_only_the_originating_chat() {
    let root = tempfile::tempdir().unwrap();
    let root_path = ensure_ledger_root_directory(root.path().to_str().unwrap()).unwrap();
    let mut a = open_connection(
        &root_path,
        "one",
        LedgerSynchronous::Normal,
        &HashSet::new(),
    )
    .unwrap();
    let mut b = open_connection(
        &root_path,
        "two",
        LedgerSynchronous::Normal,
        &HashSet::new(),
    )
    .unwrap();
    let mut fences = LedgerFailureFences::default();
    let fail = fences
        .read(
            "one",
            || Ok(&mut a),
            |entry| {
                run_query(|| {
                    entry
                        .db
                        .query_row("SELECT nope FROM transcript_views", [], |row| {
                            row.get::<_, String>(0)
                        })
                })
            },
        )
        .unwrap_err();
    assert_eq!(
        safe_fence_diagnostic(fail.as_ref()).cause_code,
        "SQLITE_ERROR"
    );
    assert!(fences.has_read_failure("one"));
    assert!(!fences.has_read_failure("two"));
    assert!(
        fences
            .write(
                "one",
                || panic!("must not reopen a fenced ledger"),
                |_| Ok(()),
                rehydrate_connection
            )
            .is_err()
    );
    assert!(fences.read("two", || Ok(&mut b), |_| Ok(())).is_ok());
}

#[test]
fn a_busy_begin_does_not_roll_back_another_connections_transaction() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("test.sqlite");
    let one = Connection::open(&path).unwrap();
    let two = Connection::open(path).unwrap();
    two.busy_timeout(std::time::Duration::ZERO).unwrap();
    one.execute_batch("BEGIN IMMEDIATE").unwrap();
    let result: LedgerResult<()> =
        run_transaction(&two, || panic!("busy write reached statements"));
    let error = result.unwrap_err();
    assert!(get_transaction_rollback_failure(error.as_ref()).is_none());
    assert_eq!(error.to_string(), "database is locked");
    assert!(two.is_autocommit());
    assert!(!one.is_autocommit());
    one.execute_batch("ROLLBACK").unwrap();
}
