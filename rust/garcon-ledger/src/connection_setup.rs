use std::{collections::HashSet, time::Duration};

use garcon_js::path::native;
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::{
    connection_entry::{ConnectionCloseAttempt, ConnectionEntry, ViewRecord},
    contracts::{TranscriptView, TranscriptViewId, TranscriptViewStatus, transcript_view_id},
    directories::{chmod, ensure_ledger_chat_directory},
    errors::LedgerError,
    file_stat::stat_size_if_exists,
    session_query::SESSION_INDEX_SQL,
    sqlite_operations::{
        LedgerResult, SqliteError, as_error, next_ordinal, non_negative_integer, run_query,
        run_transaction,
    },
    ticket_outcome_query::TICKET_OUTCOME_INDEX_SQL,
};

const LEDGER_SCHEMA_VERSION: i64 = 3;

const CREATE_SCHEMA_SQL: &str = "
      CREATE TABLE transcript_views (
        view_id               TEXT PRIMARY KEY,
        status                TEXT NOT NULL CHECK (status IN ('current', 'staging')),
        created_at            TEXT NOT NULL,
        content_start_ordinal INTEGER NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX transcript_one_current
        ON transcript_views(status)
        WHERE status = 'current';

      CREATE TABLE transcript_rows (
        view_id           TEXT NOT NULL
                          REFERENCES transcript_views(view_id) ON DELETE CASCADE,
        ordinal           INTEGER NOT NULL,
        kind              TEXT NOT NULL,
        at                TEXT NOT NULL,
        client_message_id TEXT,
        payload_json      TEXT NOT NULL,
        PRIMARY KEY (view_id, ordinal)
      ) WITHOUT ROWID, STRICT;

      CREATE UNIQUE INDEX transcript_submission
        ON transcript_rows(view_id, client_message_id)
        WHERE client_message_id IS NOT NULL;
    ";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum LedgerSynchronous {
    #[default]
    Normal,
    Full,
}

pub fn open_connection(
    root_directory: &str,
    chat_id: &str,
    synchronous: LedgerSynchronous,
    retained_staging_views: &HashSet<String>,
) -> LedgerResult<ConnectionEntry> {
    let directory = ensure_ledger_chat_directory(root_directory, chat_id)?;
    let database_path = native::join(&[&directory, "ledger.sqlite"]);
    let existed = stat_size_if_exists(&database_path)?.unwrap_or(0) > 0;
    let db = Connection::open(&database_path).map_err(as_error)?;
    // Bun configures the busy timeout last, and an otherwise fresh connection
    // does not wait for locks while applying the earlier pragmas.
    db.busy_timeout(Duration::ZERO).map_err(as_error)?;
    configure_connection(&db, synchronous)?;
    if existed {
        validate_schema(&db)?;
    } else {
        create_schema(&db)?;
    }
    let current = load_and_clean_views(&db, retained_staging_views)?;
    chmod(&database_path, 0o600)?;
    let ordinal = match &current {
        Some(view) => next_ordinal(&db, view.view_id.as_str())?,
        None => 1,
    };
    Ok(ConnectionEntry {
        chat_id: chat_id.into(),
        directory,
        db,
        current,
        next_ordinal: ordinal,
    })
}

pub fn configure_connection(db: &Connection, synchronous: LedgerSynchronous) -> LedgerResult<()> {
    db.execute_batch("PRAGMA journal_mode = WAL")
        .map_err(as_error)?;
    db.execute_batch(match synchronous {
        LedgerSynchronous::Normal => "PRAGMA synchronous = NORMAL",
        LedgerSynchronous::Full => "PRAGMA synchronous = FULL",
    })
    .map_err(as_error)?;
    db.execute_batch("PRAGMA foreign_keys = ON")
        .map_err(as_error)?;
    db.execute_batch("PRAGMA busy_timeout = 5000")
        .map_err(as_error)
}

pub fn create_schema(db: &Connection) -> LedgerResult<()> {
    run_transaction(db, || {
        db.execute_batch(CREATE_SCHEMA_SQL).map_err(as_error)?;
        db.execute_batch(TICKET_OUTCOME_INDEX_SQL)
            .map_err(as_error)?;
        db.execute_batch(SESSION_INDEX_SQL).map_err(as_error)?;
        db.execute_batch("PRAGMA user_version = 3")
            .map_err(as_error)
    })
}

pub fn validate_schema(db: &Connection) -> LedgerResult<()> {
    let version = db
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .optional()
        .map_err(as_error)?
        .unwrap_or(0);
    if !(1..=LEDGER_SCHEMA_VERSION).contains(&version) {
        return Err(LedgerError::Schema(format!(
            "Unsupported transcript ledger schema version {version}"
        ))
        .into());
    }
    let mut required = HashSet::from(["transcript_views", "transcript_rows"]);
    let mut statement = db
        .prepare_cached(
            "
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('transcript_views', 'transcript_rows')
  ",
        )
        .map_err(as_error)?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(as_error)?;
    for name in names {
        required.remove(name.map_err(as_error)?.as_str());
    }
    if !required.is_empty() {
        return Err(LedgerError::Schema("Transcript ledger schema is incomplete".into()).into());
    }
    if version < LEDGER_SCHEMA_VERSION {
        run_transaction(db, || {
            if version < 2 {
                db.execute_batch(TICKET_OUTCOME_INDEX_SQL)
                    .map_err(as_error)?;
            }
            db.execute_batch(SESSION_INDEX_SQL).map_err(as_error)?;
            db.execute_batch("PRAGMA user_version = 3")
                .map_err(as_error)
        })?;
    }
    Ok(())
}

pub fn load_and_clean_views(
    db: &Connection,
    retained_staging_views: &HashSet<String>,
) -> LedgerResult<Option<TranscriptView>> {
    let views = load_views(db)?;
    let current = validated_current_view(&views)?;
    for view in views {
        if view.status != "staging" || retained_staging_views.contains(&view.view_id) {
            continue;
        }
        db.prepare_cached("DELETE FROM transcript_views WHERE status = 'staging' AND view_id = ?")
            .and_then(|mut statement| statement.execute([view.view_id]))
            .map_err(as_error)?;
    }
    Ok(current)
}

pub fn load_views(db: &Connection) -> LedgerResult<Vec<ViewRecord>> {
    run_query(|| {
        let mut statement = db.prepare_cached(
            "
      SELECT view_id, status, created_at, content_start_ordinal
      FROM transcript_views
    ",
        )?;
        statement
            .query_map([], view_from_row)?
            .collect::<rusqlite::Result<_>>()
    })
}

pub fn validated_current_view(views: &[ViewRecord]) -> LedgerResult<Option<TranscriptView>> {
    let mut current = views.iter().filter(|view| view.status == "current");
    let first = current.next();
    if current.next().is_some() {
        return Err(LedgerError::Schema(
            "Established transcript ledger must have exactly one current view".into(),
        )
        .into());
    }
    first.map(to_view).transpose()
}

pub fn rehydrate_connection(entry: &mut ConnectionEntry) -> LedgerResult<()> {
    let current = validated_current_view(&load_views(&entry.db)?)?;
    let ordinal = match &current {
        Some(view) => next_ordinal(&entry.db, view.view_id.as_str())?,
        None => 1,
    };
    entry.current = current;
    entry.next_ordinal = ordinal;
    Ok(())
}

pub fn view_record(
    db: &Connection,
    view_id: &TranscriptViewId,
    status: &str,
) -> LedgerResult<Option<ViewRecord>> {
    run_query(|| {
        db.prepare_cached(
            "
      SELECT view_id, status, created_at, content_start_ordinal
      FROM transcript_views WHERE view_id = ? AND status = ?
    ",
        )?
        .query_row(params![view_id.as_str(), status], view_from_row)
        .optional()
    })
}

fn view_from_row(row: &Row<'_>) -> rusqlite::Result<ViewRecord> {
    Ok(ViewRecord {
        view_id: row.get(0)?,
        status: row.get(1)?,
        created_at: row.get(2)?,
        content_start_ordinal: non_negative_integer(row.get(3)?, 3)?,
    })
}

pub fn to_view(record: &ViewRecord) -> LedgerResult<TranscriptView> {
    let view_id = transcript_view_id(&record.view_id)?;
    let status = match record.status.as_str() {
        "current" => TranscriptViewStatus::Current,
        "staging" => TranscriptViewStatus::Staging,
        unknown => {
            return Err(
                LedgerError::Schema(format!("Invalid transcript view status {unknown}")).into(),
            );
        }
    };
    Ok(TranscriptView {
        view_id,
        status,
        created_at: record.created_at.clone(),
        content_start_ordinal: record.content_start_ordinal,
    })
}

pub fn close_connection(entry: ConnectionEntry) -> ConnectionCloseAttempt {
    let checkpoint_failure = entry
        .db
        .execute_batch("PRAGMA wal_checkpoint(PASSIVE)")
        .err()
        .map(as_error);
    match entry.db.close() {
        Ok(()) => ConnectionCloseAttempt::Closed { checkpoint_failure },
        Err((db, failure)) => ConnectionCloseAttempt::Failed {
            entry: Box::new(ConnectionEntry { db, ..entry }),
            failure: SqliteError::new(failure),
        },
    }
}
