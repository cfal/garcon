use std::{error::Error, process::Command};

use garcon_base::{domain_error::DomainError, errors::DiagnosticError};
use garcon_contract::error_codes::ErrorCode;
use garcon_interface::errors::{
    AgentCallError, AgentDeliveryOutcome, AgentIntegrationError, AgentIntegrationErrorCode,
};
use garcon_js::json::from_slice;
use garcon_ledger::{
    errors::{LedgerError, SafeFenceDiagnostic, TranscriptSinkClosedError, safe_fence_diagnostic},
    sqlite_operations::SqliteError,
};
use rusqlite::{Connection, ffi};
use serde_json::{Value, json};

#[test]
fn a_fence_preserves_the_concrete_cause_name_separately_from_its_code() {
    let cases: Vec<(Box<dyn Error>, &str, &str)> = vec![
        (
            Box::new(TranscriptSinkClosedError),
            "TranscriptSinkClosedError",
            "UNKNOWN",
        ),
        (
            Box::new(DomainError::new(
                ErrorCode::PROJECT_PATH_NOT_FOUND,
                "Synthetic path failure",
                404,
                false,
            )),
            "DomainError",
            "PROJECT_PATH_NOT_FOUND",
        ),
        (
            Box::new(AgentCallError::new(
                AgentDeliveryOutcome::Unknown,
                "Synthetic call failure",
            )),
            "AgentCallError",
            "OUTCOME_UNKNOWN",
        ),
        (
            Box::new(AgentIntegrationError::new(
                AgentIntegrationErrorCode::UNAVAILABLE,
                "Synthetic integration failure",
                true,
                None,
            )),
            "AgentIntegrationError",
            "UNAVAILABLE",
        ),
    ];
    for (cause, cause_name, cause_code) in cases {
        let fence = LedgerError::Fenced {
            chat_id: "synthetic".into(),
            cause,
        };
        assert_eq!(
            safe_fence_diagnostic(&fence),
            SafeFenceDiagnostic {
                cause_name: cause_name.into(),
                cause_code: cause_code.into()
            },
        );
    }
}

#[test]
fn a_fence_does_not_reduce_extended_sqlite_codes_to_the_primary_code() {
    for (number, name) in [
        (ffi::SQLITE_IOERR_LOCK, "SQLITE_IOERR_LOCK"),
        (ffi::SQLITE_IOERR_ACCESS, "SQLITE_IOERR_ACCESS"),
        (ffi::SQLITE_READONLY_DBMOVED, "SQLITE_READONLY_DBMOVED"),
        (ffi::SQLITE_READONLY_RECOVERY, "SQLITE_READONLY_RECOVERY"),
        (ffi::SQLITE_CANTOPEN_ISDIR, "SQLITE_CANTOPEN_ISDIR"),
    ] {
        let cause = SqliteError(rusqlite::Error::SqliteFailure(
            ffi::Error::new(number),
            None,
        ));
        let fence = LedgerError::Fenced {
            chat_id: "synthetic".into(),
            cause: Box::new(cause),
        };
        assert_eq!(safe_fence_diagnostic(&fence).cause_code, name);
    }
}

#[test]
fn extended_sqlite_error_names_match_bun_on_real_failures() {
    let root = tempfile::tempdir().unwrap();
    for operation in [
        #[cfg(unix)]
        "moved",
        "datatype",
        "foreign-key",
    ] {
        let path = root.path().join(format!("{operation}-rust.sqlite"));
        let db = Connection::open(&path).unwrap();
        let error = match operation {
            "moved" => {
                db.execute_batch("CREATE TABLE entries(n INTEGER) STRICT")
                    .unwrap();
                std::fs::rename(&path, path.with_extension("moved")).unwrap();
                db.execute_batch("INSERT INTO entries VALUES (1)")
                    .unwrap_err()
            }
            "datatype" => {
                db.execute_batch("CREATE TABLE entries(n INTEGER) STRICT")
                    .unwrap();
                db.execute_batch("INSERT INTO entries VALUES ('synthetic')")
                    .unwrap_err()
            }
            "foreign-key" => {
                db.execute_batch(
                    "PRAGMA foreign_keys = ON; CREATE TABLE parents(id INTEGER PRIMARY KEY);
                    CREATE TABLE entries(parent INTEGER REFERENCES parents(id))",
                )
                .unwrap();
                db.execute_batch("INSERT INTO entries VALUES (1)")
                    .unwrap_err()
            }
            _ => unreachable!(),
        };
        let errno = error.sqlite_error().unwrap().extended_code;
        let cause = SqliteError(error);
        let metadata = cause.diagnostic_metadata();
        let output = Command::new("bun")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/sqlite_error_oracle.ts"
            ))
            .arg(root.path().join(format!("{operation}-bun.sqlite")))
            .arg(operation)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let original: Value = from_slice(&output.stdout).unwrap();
        assert_eq!(
            json!({
                "name": metadata.name,
                "code": metadata.code,
                "errno": errno,
                "message": cause.to_string(),
            }),
            original,
            "{operation}"
        );
    }
}
