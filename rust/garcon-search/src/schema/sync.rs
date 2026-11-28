use garcon_contract::chat_search::ChatSearchSnippetRole;
use garcon_js::{Clock, to_iso_string};
use rusqlite::{Connection, OptionalExtension, Row, Rows, params, types::Type};
use serde::{Deserialize, Serialize};

use crate::rows::HistoricalSearchMessageRow;

use super::{
    MAX_SAFE_ORDINAL, SEARCH_DELETE_BATCH_MAX_ROWS, SEARCH_FTS_MERGE_PAGES_PER_TXN,
    SEARCH_INGEST_ROW_MAX_BYTES, SEARCH_INGEST_TXN_MAX_BYTES, SEARCH_INGEST_TXN_MAX_ROWS,
    SEARCH_TIMESTAMP_MAX_BYTES, SearchSchemaError, SearchSchemaResult, read_counter,
    require_identifier, transaction,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchChatStatus {
    Pending,
    Indexed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchChatState {
    pub chat_id: String,
    pub transcript_view_id: String,
    pub status: SearchChatStatus,
    pub indexed_through: u64,
    pub target_through: u64,
    pub last_error_code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchStatusCounts {
    pub indexed: u64,
    pub pending: u64,
    pub failed: u64,
    pub backlog_rows: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "plan",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum SearchSyncPlan {
    Current {
        state: SearchChatState,
    },
    Build {
        state: SearchChatState,
        stale_rows: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchSyncMode {
    Replace,
    Append,
}

#[derive(Debug, Clone, Copy)]
pub struct PlanChatSync<'a> {
    pub mode: SearchSyncMode,
    pub chat_id: &'a str,
    pub transcript_view_id: &'a str,
    pub target_through: u64,
    pub expected_after_ordinal: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct DeleteStaleRows<'a> {
    pub chat_id: &'a str,
    pub keep_view_id: &'a str,
    pub keep_through: u64,
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, Copy)]
pub struct InsertRowsBatch<'a> {
    pub chat_id: &'a str,
    pub transcript_view_id: &'a str,
    pub rows: &'a [HistoricalSearchMessageRow],
    pub advance_to: u64,
}

const READ_CHAT_STATE: &str = "
    SELECT chat_id, transcript_view_id, status, indexed_through,
      target_through, last_error_code FROM search_chat_state
";

fn decode_chat_state(row: &Row<'_>) -> rusqlite::Result<SearchChatState> {
    let status: String = row.get(2)?;
    let status = match status.as_str() {
        "pending" => SearchChatStatus::Pending,
        "indexed" => SearchChatStatus::Indexed,
        "failed" => SearchChatStatus::Failed,
        _ => {
            return Err(rusqlite::Error::InvalidColumnType(
                2,
                "status".to_owned(),
                Type::Text,
            ));
        }
    };
    Ok(SearchChatState {
        chat_id: row.get(0)?,
        transcript_view_id: row.get(1)?,
        status,
        indexed_through: read_counter(row, 3)?,
        target_through: read_counter(row, 4)?,
        last_error_code: row.get(5)?,
    })
}

pub fn get_chat_state(
    db: &Connection,
    chat_id: &str,
) -> SearchSchemaResult<Option<SearchChatState>> {
    let mut statement = db.prepare_cached(&format!("{READ_CHAT_STATE} WHERE chat_id = ?"))?;
    Ok(statement
        .query_row([chat_id], decode_chat_state)
        .optional()?)
}

pub fn list_chat_states(db: &Connection) -> SearchSchemaResult<Vec<SearchChatState>> {
    let mut statement = db.prepare_cached(&format!("{READ_CHAT_STATE} ORDER BY chat_id"))?;
    Ok(statement
        .query_map([], decode_chat_state)?
        .collect::<Result<_, _>>()?)
}

pub fn list_state_chat_ids(db: &Connection) -> SearchSchemaResult<Vec<String>> {
    let mut statement =
        db.prepare_cached("SELECT chat_id FROM search_chat_state ORDER BY chat_id")?;
    Ok(statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?)
}

pub fn status_counts(db: &Connection) -> SearchSchemaResult<SearchStatusCounts> {
    let mut statement = db.prepare_cached(
        "
      SELECT
        COALESCE(SUM(status = 'indexed'), 0),
        COALESCE(SUM(status = 'pending'), 0),
        COALESCE(SUM(status = 'failed'), 0),
        COALESCE(SUM(CASE WHEN status = 'pending'
          THEN target_through - indexed_through ELSE 0 END), 0)
      FROM search_chat_state
    ",
    )?;
    Ok(statement.query_row([], |row| {
        Ok(SearchStatusCounts {
            indexed: read_counter(row, 0)?,
            pending: read_counter(row, 1)?,
            failed: read_counter(row, 2)?,
            backlog_rows: read_counter(row, 3)?,
        })
    })?)
}

pub fn plan_chat_sync(
    db: &Connection,
    input: PlanChatSync<'_>,
    clock: &dyn Clock,
) -> SearchSchemaResult<SearchSyncPlan> {
    require_identifier(input.chat_id)?;
    require_identifier(input.transcript_view_id)?;
    if input.target_through > MAX_SAFE_ORDINAL || input.expected_after_ordinal > MAX_SAFE_ORDINAL {
        return Err(SearchSchemaError::InvalidFrontier);
    }
    let prior = get_chat_state(db, input.chat_id)?;
    if let Some(prior) = &prior
        && prior.status == SearchChatStatus::Indexed
        && prior.transcript_view_id == input.transcript_view_id
        && prior.indexed_through >= input.target_through
    {
        return Ok(SearchSyncPlan::Current {
            state: prior.clone(),
        });
    }
    if input.mode == SearchSyncMode::Append {
        let prior = prior
            .as_ref()
            .filter(|prior| prior.transcript_view_id == input.transcript_view_id)
            .ok_or(SearchSchemaError::ViewMismatch)?;
        if prior.status != SearchChatStatus::Indexed
            || prior.indexed_through != input.expected_after_ordinal
        {
            return Err(SearchSchemaError::IndexGap);
        }
    }
    transaction(db, || {
        let resume = input.mode == SearchSyncMode::Append
            || prior
                .as_ref()
                .is_some_and(|prior| prior.transcript_view_id == input.transcript_view_id);
        let indexed_through = if resume {
            prior
                .as_ref()
                .map_or(0, |prior| prior.indexed_through)
                .min(input.target_through)
        } else {
            0
        };
        db.prepare_cached(
            "
          INSERT INTO search_chat_state(
            chat_id, transcript_view_id, status, indexed_through, target_through,
            last_error_code, updated_at
          ) VALUES (?, ?, 'pending', ?, ?, NULL, ?)
          ON CONFLICT(chat_id) DO UPDATE SET
            transcript_view_id = excluded.transcript_view_id,
            status = 'pending',
            indexed_through = excluded.indexed_through,
            target_through = excluded.target_through,
            last_error_code = NULL,
            updated_at = excluded.updated_at
        ",
        )?
        .execute(params![
            input.chat_id,
            input.transcript_view_id,
            indexed_through as i64,
            input.target_through as i64,
            to_iso_string(clock.now_ms())?,
        ])?;
        let state = required_state(db, input.chat_id)?;
        let stale_rows = db
            .prepare_cached(
                "
          SELECT 1 FROM search_chunks
          WHERE chat_id = ? AND (transcript_view_id <> ? OR ordinal > ?) LIMIT 1
        ",
            )?
            .exists(params![
                input.chat_id,
                input.transcript_view_id,
                indexed_through as i64
            ])?;
        Ok(SearchSyncPlan::Build { state, stale_rows })
    })
}

pub fn delete_stale_rows_batch(
    db: &Connection,
    input: DeleteStaleRows<'_>,
) -> SearchSchemaResult<u64> {
    require_identifier(input.chat_id)?;
    require_identifier(input.keep_view_id)?;
    let limit = batch_limit(input.limit)?;
    transaction(db, || {
        let mut statement = db.prepare_cached(
            "
          DELETE FROM search_chunks WHERE id IN (
            SELECT id FROM search_chunks
            WHERE chat_id = ? AND (transcript_view_id <> ? OR ordinal > ?)
            LIMIT ?
          )
          RETURNING id
        ",
        )?;
        count_returning(statement.query(params![
            input.chat_id,
            input.keep_view_id,
            i64::try_from(input.keep_through).unwrap_or(i64::MAX),
            limit as i64
        ])?)
    })
}

pub fn insert_rows_batch(
    db: &Connection,
    input: InsertRowsBatch<'_>,
    clock: &dyn Clock,
) -> SearchSchemaResult<SearchChatState> {
    require_identifier(input.chat_id)?;
    require_identifier(input.transcript_view_id)?;
    if input.rows.len() > SEARCH_INGEST_TXN_MAX_ROWS {
        return Err(SearchSchemaError::BatchTooLarge);
    }
    let mut batch_bytes = 0;
    for row in input.rows {
        let body = row.row.body.len();
        if body > SEARCH_INGEST_ROW_MAX_BYTES {
            return Err(SearchSchemaError::RowTooLarge);
        }
        let timestamp = row.row.timestamp.as_ref().map_or(0, String::len);
        if timestamp > SEARCH_TIMESTAMP_MAX_BYTES {
            return Err(SearchSchemaError::InvalidRow);
        }
        batch_bytes += body + timestamp;
    }
    if input.rows.len() > 1 && batch_bytes > SEARCH_INGEST_TXN_MAX_BYTES {
        return Err(SearchSchemaError::BatchTooLarge);
    }

    transaction(db, || {
        let state = get_chat_state(db, input.chat_id)?
            .filter(|state| state.transcript_view_id == input.transcript_view_id)
            .ok_or(SearchSchemaError::ViewMismatch)?;
        if state.status != SearchChatStatus::Pending
            || input.advance_to > MAX_SAFE_ORDINAL
            || input.advance_to <= state.indexed_through
            || input.advance_to > state.target_through
        {
            return Err(SearchSchemaError::InvalidFrontier);
        }
        let mut previous = state.indexed_through;
        let mut insert = db.prepare_cached(
            "
          INSERT INTO search_chunks(chat_id, transcript_view_id, ordinal, role, timestamp, body)
          VALUES (?, ?, ?, ?, ?, ?)
        ",
        )?;
        for row in input.rows {
            let role = role_code(&row.row.role);
            if row.ordinal > MAX_SAFE_ORDINAL
                || row.ordinal <= previous
                || row.ordinal > input.advance_to
                || role.is_none()
                || row.row.body.is_empty()
            {
                return Err(SearchSchemaError::InvalidRow);
            }
            insert.execute(params![
                input.chat_id,
                input.transcript_view_id,
                row.ordinal as i64,
                role,
                row.row.timestamp,
                row.row.body,
            ])?;
            previous = row.ordinal;
        }
        db.prepare_cached(
            "
          UPDATE search_chat_state SET indexed_through = ?, updated_at = ? WHERE chat_id = ?
        ",
        )?
        .execute(params![
            input.advance_to as i64,
            to_iso_string(clock.now_ms())?,
            input.chat_id
        ])?;
        db.prepare_cached(
            "INSERT INTO search_chunks_fts(search_chunks_fts, rank) VALUES ('merge', ?)",
        )?
        .execute([SEARCH_FTS_MERGE_PAGES_PER_TXN])?;
        required_state(db, input.chat_id)
    })
}

pub fn finish_chat_sync(
    db: &Connection,
    chat_id: &str,
    transcript_view_id: &str,
    clock: &dyn Clock,
) -> SearchSchemaResult<SearchChatState> {
    require_identifier(chat_id)?;
    require_identifier(transcript_view_id)?;
    transaction(db, || {
        let state = required_state(db, chat_id)?;
        if state.transcript_view_id != transcript_view_id
            || state.status != SearchChatStatus::Pending
        {
            return Err(SearchSchemaError::StateInvariant);
        }
        if state.indexed_through != state.target_through {
            return Err(SearchSchemaError::InvalidFrontier);
        }
        db.prepare_cached(
            "
          UPDATE search_chat_state SET status = 'indexed', last_error_code = NULL, updated_at = ?
          WHERE chat_id = ?
        ",
        )?
        .execute(params![to_iso_string(clock.now_ms())?, chat_id])?;
        required_state(db, chat_id)
    })
}

pub fn is_search_error_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    matches!(bytes, [first, rest @ ..] if *first >= b'A' && *first <= b'Z'
        && rest.len() <= 63 && rest.iter().all(|&byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'))
}

pub fn mark_chat_failed(
    db: &Connection,
    chat_id: &str,
    transcript_view_id: &str,
    error_code: &str,
    clock: &dyn Clock,
) -> SearchSchemaResult<()> {
    require_identifier(chat_id)?;
    require_identifier(transcript_view_id)?;
    if !is_search_error_code(error_code) {
        return Err(SearchSchemaError::InvalidErrorCode);
    }
    transaction(db, || {
        let prior = get_chat_state(db, chat_id)?;
        let same_view = prior.is_some_and(|prior| prior.transcript_view_id == transcript_view_id);
        db.prepare_cached(
            "
          INSERT INTO search_chat_state(
            chat_id, transcript_view_id, status, indexed_through, target_through,
            last_error_code, updated_at
          ) VALUES (?, ?, 'failed', 0, 0, ?, ?)
          ON CONFLICT(chat_id) DO UPDATE SET
            transcript_view_id = excluded.transcript_view_id,
            status = 'failed',
            indexed_through = CASE WHEN ? THEN indexed_through ELSE 0 END,
            target_through = CASE WHEN ? THEN target_through ELSE 0 END,
            last_error_code = excluded.last_error_code,
            updated_at = excluded.updated_at
        ",
        )?
        .execute(params![
            chat_id,
            transcript_view_id,
            error_code,
            to_iso_string(clock.now_ms())?,
            same_view,
            same_view
        ])?;
        Ok(())
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteChatProgress {
    pub done: bool,
    pub deleted_rows: u64,
}

pub fn delete_chat_batch(
    db: &Connection,
    chat_id: &str,
    limit: Option<u64>,
) -> SearchSchemaResult<DeleteChatProgress> {
    require_identifier(chat_id)?;
    let limit = batch_limit(limit)?;
    transaction(db, || {
        let mut statement = db.prepare_cached(
            "
          DELETE FROM search_chunks WHERE id IN (
            SELECT id FROM search_chunks WHERE chat_id = ? LIMIT ?
          )
          RETURNING id
        ",
        )?;
        let deleted_rows = count_returning(statement.query(params![chat_id, limit as i64])?)?;
        let done = deleted_rows < limit;
        if done {
            db.prepare_cached("DELETE FROM search_chat_state WHERE chat_id = ?")?
                .execute([chat_id])?;
        }
        Ok(DeleteChatProgress { done, deleted_rows })
    })
}

fn required_state(db: &Connection, chat_id: &str) -> SearchSchemaResult<SearchChatState> {
    get_chat_state(db, chat_id)?.ok_or(SearchSchemaError::StateInvariant)
}

fn batch_limit(limit: Option<u64>) -> SearchSchemaResult<u64> {
    let limit = limit.unwrap_or(SEARCH_DELETE_BATCH_MAX_ROWS);
    if !(1..=SEARCH_DELETE_BATCH_MAX_ROWS).contains(&limit) {
        return Err(SearchSchemaError::BatchTooLarge);
    }
    Ok(limit)
}

fn count_returning(mut rows: Rows<'_>) -> SearchSchemaResult<u64> {
    let mut deleted = 0;
    while rows.next()?.is_some() {
        deleted += 1;
    }
    Ok(deleted)
}

fn role_code(role: &ChatSearchSnippetRole) -> Option<i64> {
    match role {
        ChatSearchSnippetRole::User => Some(0),
        ChatSearchSnippetRole::Assistant => Some(1),
        ChatSearchSnippetRole::Tool => Some(2),
        ChatSearchSnippetRole::System => Some(3),
        ChatSearchSnippetRole::CoercedArray(_) => None,
    }
}
