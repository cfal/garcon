use std::collections::HashMap;

use garcon_contract::chat_search::{
    CHAT_SEARCH_MAX_FAILED_CHAT_DETAILS, ChatSearchFailedChat, ChatSearchFailureStage,
    ChatSearchIndexStatus, TranscriptSearchAllowedChat, classify_chat_search_failure_recovery,
};
use garcon_js::trim;
use rusqlite::Connection;

use super::execution::SearchError;
use crate::schema::{MAX_SAFE_ORDINAL, read_counter};

pub(super) fn prepare_allowed(
    input: &[TranscriptSearchAllowedChat],
) -> Result<Vec<TranscriptSearchAllowedChat>, SearchError> {
    let mut prepared = Vec::with_capacity(input.len());
    let mut positions = HashMap::<&str, usize>::new();
    for entry in input {
        let chat = trim(&entry.chat_id);
        let view = trim(&entry.transcript_view_id);
        if chat.is_empty() || view.is_empty() {
            continue;
        }
        if entry.through_ordinal > MAX_SAFE_ORDINAL {
            return Err(SearchError::AllowlistFrontier);
        }
        if let Some(&index) = positions.get(chat) {
            let previous: &TranscriptSearchAllowedChat = &prepared[index];
            if previous.transcript_view_id != view
                || previous.through_ordinal != entry.through_ordinal
            {
                return Err(SearchError::ContradictoryAllowlist);
            }
            continue;
        }
        positions.insert(chat, prepared.len());
        prepared.push(TranscriptSearchAllowedChat {
            chat_id: chat.to_owned(),
            transcript_view_id: view.to_owned(),
            through_ordinal: entry.through_ordinal,
        });
    }
    Ok(prepared)
}

pub(super) fn stage_allowed(
    db: &Connection,
    allowed: &[TranscriptSearchAllowedChat],
) -> Result<(), SearchError> {
    db.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS search_allowed_chats (
            chat_id TEXT PRIMARY KEY,
            transcript_view_id TEXT NOT NULL,
            through_ordinal INTEGER NOT NULL
        ) WITHOUT ROWID, STRICT;
        DELETE FROM temp.search_allowed_chats;",
    )?;
    db.prepare_cached(
        "INSERT INTO temp.search_allowed_chats(chat_id, transcript_view_id, through_ordinal)
         SELECT json_extract(value, '$.chatId'), json_extract(value, '$.transcriptViewId'),
           json_extract(value, '$.throughOrdinal') FROM json_each(?)",
    )?
    .execute([serde_json::to_string(allowed)?])?;
    Ok(())
}

pub(super) fn index_status(
    db: &Connection,
    allowed_count: u64,
) -> Result<ChatSearchIndexStatus, SearchError> {
    let mut status = ChatSearchIndexStatus {
        indexed_chat_count: 0,
        pending_chat_count: 0,
        failed_chat_count: 0,
        unindexed_chat_count: 0,
        unsupported_chat_count: 0,
        results_truncated: false,
        failed_chats: Vec::new(),
        failed_chats_omitted_count: 0,
    };
    if allowed_count == 0 {
        return Ok(status);
    }

    let snapshot = db.unchecked_transaction()?;
    (status.indexed_chat_count, status.failed_chat_count) = snapshot
        .prepare_cached(
            "SELECT
            COALESCE(SUM(CASE WHEN state.status = 'indexed'
              AND state.indexed_through >= allowed.through_ordinal THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN state.status = 'failed' THEN 1 ELSE 0 END), 0)
         FROM temp.search_allowed_chats allowed
         LEFT JOIN search_chat_state state ON state.chat_id = allowed.chat_id
            AND state.transcript_view_id = allowed.transcript_view_id",
        )?
        .query_row([], |row| Ok((read_counter(row, 0)?, read_counter(row, 1)?)))?;
    status.failed_chats = snapshot
        .prepare_cached(
            "SELECT state.chat_id, state.transcript_view_id, state.indexed_through,
            state.target_through, state.last_error_code
         FROM temp.search_allowed_chats allowed
         JOIN search_chat_state state ON state.chat_id = allowed.chat_id
            AND state.transcript_view_id = allowed.transcript_view_id
         WHERE state.status = 'failed'
         ORDER BY state.chat_id ASC LIMIT ?",
        )?
        .query_map([CHAT_SEARCH_MAX_FAILED_CHAT_DETAILS as i64], |row| {
            let stage = ChatSearchFailureStage::Indexing;
            let error_code = row
                .get::<_, Option<String>>(4)?
                .unwrap_or_else(|| "SEARCH_INDEX_FAILED".to_owned());
            let recovery = classify_chat_search_failure_recovery(&stage, &error_code);
            Ok(ChatSearchFailedChat {
                chat_id: row.get(0)?,
                transcript_view_id: row.get(1)?,
                stage,
                error_code,
                indexed_through_ordinal: Some(read_counter(row, 2)?),
                target_through_ordinal: Some(read_counter(row, 3)?),
                recovery,
            })
        })?
        .collect::<Result<_, _>>()?;
    snapshot.commit()?;
    status.failed_chats_omitted_count = status
        .failed_chat_count
        .saturating_sub(status.failed_chats.len() as u64);
    status.pending_chat_count =
        allowed_count.saturating_sub(status.indexed_chat_count + status.failed_chat_count);
    Ok(status)
}
