//! Ports the derived FTS5 store in `server-agents/common/src/search/schema.ts`.

mod database;
mod sync;

use std::path::PathBuf;

use garcon_js::clock::InvalidTimeValue;
use rusqlite::{Connection, Row, types::Type};
use thiserror::Error;

pub use database::*;
pub use sync::*;

pub use crate::rows::SEARCH_TIMESTAMP_MAX_BYTES;

pub const TRANSCRIPT_SEARCH_SCHEMA_VERSION: u32 = 11;
pub const SEARCH_INGEST_TXN_MAX_ROWS: usize = 256;
pub const SEARCH_INGEST_TXN_MAX_BYTES: usize = 1_048_576;
pub const SEARCH_INGEST_ROW_MAX_BYTES: usize = 1_048_576;
pub const SEARCH_DELETE_BATCH_MAX_ROWS: u64 = 512;
pub const SEARCH_FTS_CRISISMERGE: i64 = 1_000;
pub const SEARCH_FTS_AUTOMERGE: i64 = 4;
pub const SEARCH_FTS_MERGE_PAGES_PER_TXN: i64 = 16;
pub const SEARCH_FTS_RANK: &str = "bm25(1.0)";

pub(crate) const MAX_SAFE_ORDINAL: u64 = 9_007_199_254_740_991;

pub(crate) fn read_counter(row: &Row<'_>, index: usize) -> rusqlite::Result<u64> {
    u64::try_from(row.get::<_, i64>(index)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Integer, Box::new(error))
    })
}

#[derive(Debug)]
pub struct SearchDatabase {
    pub db: Connection,
    pub db_path: PathBuf,
    pub recreated: bool,
}

#[derive(Debug, Error)]
pub enum SearchSchemaError {
    #[error("SEARCH_SCHEMA_INVALID")]
    InvalidSchema,
    #[error("SEARCH_IDENTIFIER_INVALID")]
    InvalidIdentifier,
    #[error("SEARCH_FRONTIER_INVALID")]
    InvalidFrontier,
    #[error("SEARCH_VIEW_MISMATCH")]
    ViewMismatch,
    #[error("SEARCH_INDEX_GAP")]
    IndexGap,
    #[error("SEARCH_STATE_INVARIANT")]
    StateInvariant,
    #[error("SEARCH_BATCH_TOO_LARGE")]
    BatchTooLarge,
    #[error("SEARCH_ROW_TOO_LARGE")]
    RowTooLarge,
    #[error("SEARCH_ROW_INVALID")]
    InvalidRow,
    #[error("INVALID_SEARCH_ERROR_CODE")]
    InvalidErrorCode,
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Clock(#[from] InvalidTimeValue),
}

pub type SearchSchemaResult<T> = Result<T, SearchSchemaError>;

fn require_identifier(value: &str) -> SearchSchemaResult<()> {
    if value.is_empty() || value.len() > 256 {
        return Err(SearchSchemaError::InvalidIdentifier);
    }
    Ok(())
}

fn transaction<T>(
    db: &Connection,
    work: impl FnOnce() -> SearchSchemaResult<T>,
) -> SearchSchemaResult<T> {
    db.execute_batch("BEGIN IMMEDIATE")?;
    let result = work().and_then(|value| {
        db.execute_batch("COMMIT")?;
        Ok(value)
    });
    if result.is_err() {
        db.execute_batch("ROLLBACK")?;
    }
    result
}
