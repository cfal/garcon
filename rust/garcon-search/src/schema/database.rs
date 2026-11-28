use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use garcon_contract::chat_message_coercion::as_optional_number;
use garcon_js::{trim, trim_end};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params, types::Value as SqlValue};
use serde::Serialize;

use super::{
    SEARCH_FTS_AUTOMERGE, SEARCH_FTS_CRISISMERGE, SEARCH_FTS_RANK, SEARCH_TIMESTAMP_MAX_BYTES,
    SearchDatabase, SearchSchemaError, SearchSchemaResult, TRANSCRIPT_SEARCH_SCHEMA_VERSION,
};

pub const SEARCH_FTS_SHADOW_TABLES: &[&str] = &[
    "search_chunks_fts_data",
    "search_chunks_fts_idx",
    "search_chunks_fts_config",
];

const SEARCH_SCHEMA_OBJECTS: &[(&str, &str, &str)] = &[
    (
        "search_chat_state",
        "table",
        "CREATE TABLE search_chat_state (
  chat_id            TEXT PRIMARY KEY,
  transcript_view_id TEXT NOT NULL,
  status             TEXT NOT NULL CHECK(status IN ('pending', 'indexed', 'failed')),
  indexed_through    INTEGER NOT NULL CHECK(indexed_through >= 0),
  target_through     INTEGER NOT NULL CHECK(target_through >= 0),
  last_error_code    TEXT,
  updated_at         TEXT NOT NULL,
  CHECK(status <> 'indexed' OR indexed_through = target_through),
  CHECK(status <> 'pending' OR indexed_through <= target_through)
) WITHOUT ROWID, STRICT",
    ),
    (
        "search_chunks",
        "table",
        concat!(
            "CREATE TABLE search_chunks (
  id                 INTEGER PRIMARY KEY,
  chat_id            TEXT NOT NULL REFERENCES search_chat_state(chat_id) ON DELETE CASCADE,
  transcript_view_id TEXT NOT NULL,
  ordinal            INTEGER NOT NULL,
  role               INTEGER NOT NULL CHECK(role IN (0, 1, 2, 3)),
  timestamp          TEXT CHECK(
    timestamp IS NULL OR length(CAST(timestamp AS BLOB)) <= ",
            "256",
            "
  ),
  body               TEXT NOT NULL,
  UNIQUE(chat_id, transcript_view_id, ordinal)
) STRICT"
        ),
    ),
    (
        "search_chunks_fts",
        "table",
        "CREATE VIRTUAL TABLE search_chunks_fts USING fts5(
  body,
  content='search_chunks',
  content_rowid='id',
  columnsize=0,
  tokenize='unicode61 remove_diacritics 2'
)",
    ),
    (
        "search_chunks_ai",
        "trigger",
        "CREATE TRIGGER search_chunks_ai AFTER INSERT ON search_chunks BEGIN
  INSERT INTO search_chunks_fts(rowid, body)
  VALUES (new.id, new.body);
END",
    ),
    (
        "search_chunks_ad",
        "trigger",
        "CREATE TRIGGER search_chunks_ad AFTER DELETE ON search_chunks BEGIN
  INSERT INTO search_chunks_fts(search_chunks_fts, rowid, body)
  VALUES ('delete', old.id, old.body);
END",
    ),
    (
        "search_chunks_au",
        "trigger",
        "CREATE TRIGGER search_chunks_au AFTER UPDATE OF body ON search_chunks BEGIN
  INSERT INTO search_chunks_fts(search_chunks_fts, rowid, body)
  VALUES ('delete', old.id, old.body);
  INSERT INTO search_chunks_fts(rowid, body)
  VALUES (new.id, new.body);
END",
    ),
];

const _: () = assert!(SEARCH_TIMESTAMP_MAX_BYTES == 256);

fn normalize_ddl(sql: &str) -> String {
    trim_end(sql)
        .trim_end_matches(';')
        .split(|ch: char| trim(ch.encode_utf8(&mut [0; 4])).is_empty())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn require_exact_shadow_set(shadows: &HashSet<String>) -> SearchSchemaResult<()> {
    if shadows.len() != SEARCH_FTS_SHADOW_TABLES.len()
        || SEARCH_FTS_SHADOW_TABLES
            .iter()
            .any(|name| !shadows.contains(*name))
    {
        return Err(SearchSchemaError::InvalidSchema);
    }
    Ok(())
}

pub fn configure_connection(db: &Connection) -> SearchSchemaResult<()> {
    db.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA secure_delete = ON;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

pub fn create_schema(db: &Connection) -> SearchSchemaResult<()> {
    db.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    for &(_, _, statement) in SEARCH_SCHEMA_OBJECTS {
        db.execute_batch(statement)?;
    }
    let mut configure =
        db.prepare("INSERT INTO search_chunks_fts(search_chunks_fts, rank) VALUES (?, ?)")?;
    configure.execute(params!["secure-delete", 1])?;
    configure.execute(params!["rank", SEARCH_FTS_RANK])?;
    configure.execute(params!["crisismerge", SEARCH_FTS_CRISISMERGE])?;
    configure.execute(params!["automerge", SEARCH_FTS_AUTOMERGE])?;
    drop(configure);
    db.pragma_update(None, "user_version", TRANSCRIPT_SEARCH_SCHEMA_VERSION)?;
    Ok(())
}

fn valid_config_number(value: &SqlValue, expected: i64) -> bool {
    match value {
        SqlValue::Integer(value) => *value == expected,
        SqlValue::Real(value) => *value == expected as f64,
        SqlValue::Text(value) => as_optional_number(&serde_json::Value::String(value.clone()))
            .is_some_and(|number| number.0 == expected as f64),
        _ => false,
    }
}

fn validate_existing_schema(db: &Connection) -> SearchSchemaResult<()> {
    let version: u32 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != TRANSCRIPT_SEARCH_SCHEMA_VERSION {
        return Err(SearchSchemaError::InvalidSchema);
    }
    let auto_vacuum: u32 = db.pragma_query_value(None, "auto_vacuum", |row| row.get(0))?;
    if auto_vacuum != 2 {
        return Err(SearchSchemaError::InvalidSchema);
    }
    let mut shadow_query =
        db.prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'shadow'")?;
    let shadows = shadow_query
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    require_exact_shadow_set(&shadows)?;
    let mut objects = db.prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
    )?;
    let mut rows = objects.query([])?;
    let mut matched = 0;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if shadows.contains(&name) {
            continue;
        }
        let kind: String = row.get(0)?;
        let statement: Option<String> = row.get(2)?;
        if !SEARCH_SCHEMA_OBJECTS
            .iter()
            .any(|&(expected_name, expected_kind, expected_sql)| {
                expected_name == name
                    && expected_kind == kind
                    && statement
                        .as_deref()
                        .is_some_and(|sql| normalize_ddl(sql) == normalize_ddl(expected_sql))
            })
        {
            return Err(SearchSchemaError::InvalidSchema);
        }
        matched += 1;
    }
    if matched != SEARCH_SCHEMA_OBJECTS.len() {
        return Err(SearchSchemaError::InvalidSchema);
    }

    let mut config = db.prepare("SELECT v FROM search_chunks_fts_config WHERE k = ?")?;
    for (key, expected) in [
        ("crisismerge", SEARCH_FTS_CRISISMERGE),
        ("automerge", SEARCH_FTS_AUTOMERGE),
        ("secure-delete", 1),
    ] {
        let value = config
            .query_row([key], |row| row.get::<_, SqlValue>(0))
            .optional()?;
        if !value
            .as_ref()
            .is_some_and(|value| valid_config_number(value, expected))
        {
            return Err(SearchSchemaError::InvalidSchema);
        }
    }
    let rank = config
        .query_row(["rank"], |row| row.get::<_, SqlValue>(0))
        .optional()?;
    if !matches!(rank, Some(SqlValue::Text(rank)) if rank == SEARCH_FTS_RANK) {
        return Err(SearchSchemaError::InvalidSchema);
    }
    Ok(())
}

fn database_files(path: &Path) -> [PathBuf; 3] {
    let sidecar = |suffix: &str| {
        let mut path = path.as_os_str().to_owned();
        path.push(suffix);
        PathBuf::from(path)
    };
    [path.to_owned(), sidecar("-wal"), sidecar("-shm")]
}

fn ignore_missing(result: std::io::Result<()>) -> std::io::Result<()> {
    match result {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn unlink_database_files(path: &Path) -> SearchSchemaResult<()> {
    for file in database_files(path) {
        ignore_missing(fs::remove_file(file))?;
    }
    Ok(())
}

fn protect_database_files(_path: &Path) -> SearchSchemaResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in database_files(_path) {
            ignore_missing(fs::set_permissions(file, fs::Permissions::from_mode(0o600)))?;
        }
    }
    Ok(())
}

fn create_fresh_database(db_path: &Path) -> SearchSchemaResult<SearchDatabase> {
    let db = Connection::open(db_path)?;
    db.execute_batch("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;")?;
    configure_connection(&db)?;
    create_schema(&db)?;
    protect_database_files(db_path)?;
    Ok(SearchDatabase {
        db,
        db_path: db_path.to_owned(),
        recreated: true,
    })
}

pub fn open_search_database(db_path: &Path) -> SearchSchemaResult<SearchDatabase> {
    let mut directory = fs::DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    let parent = db_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    directory.create(parent)?;
    if !fs::metadata(db_path).is_ok_and(|entry| entry.is_file() && entry.len() > 0) {
        return create_fresh_database(db_path);
    }
    let open_existing = || -> SearchSchemaResult<Connection> {
        let db = Connection::open(db_path)?;
        configure_connection(&db)?;
        validate_existing_schema(&db)?;
        protect_database_files(db_path)?;
        Ok(db)
    };
    if let Ok(db) = open_existing() {
        return Ok(SearchDatabase {
            db,
            db_path: db_path.to_owned(),
            recreated: false,
        });
    }
    unlink_database_files(db_path)?;
    create_fresh_database(db_path)
}

pub fn open_search_read_database(db_path: &Path) -> SearchSchemaResult<Connection> {
    let db = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.execute_batch(
        "PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 2000;
        PRAGMA temp_store = MEMORY;",
    )?;
    validate_existing_schema(&db)?;
    let temp_store: u32 = db.pragma_query_value(None, "temp_store", |row| row.get(0))?;
    if temp_store != 2 {
        return Err(SearchSchemaError::InvalidSchema);
    }
    Ok(db)
}

pub fn close_search_database(db: Connection) -> SearchSchemaResult<()> {
    let checkpoint = observe_wal_truncate(&db);
    db.close().map_err(|(_, error)| error)?;
    checkpoint.map(|_| ())
}

pub fn run_idle_maintenance(db: &Connection) -> SearchSchemaResult<()> {
    db.execute_batch("PRAGMA incremental_vacuum(512)")?;
    for _ in 0..2 {
        db.execute(
            "INSERT INTO search_chunks_fts(search_chunks_fts, rank) VALUES ('merge', 64)",
            [],
        )?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalTruncateObservation {
    pub busy: i64,
    pub log_frames: i64,
}

pub fn observe_wal_truncate(db: &Connection) -> SearchSchemaResult<WalTruncateObservation> {
    let result = db
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok(WalTruncateObservation {
                busy: row.get(0)?,
                log_frames: row.get(1)?,
            })
        })
        .optional()?;
    Ok(result.unwrap_or(WalTruncateObservation {
        busy: 1,
        log_frames: -1,
    }))
}
