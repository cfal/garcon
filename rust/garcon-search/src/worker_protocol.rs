//! Owned frames for the in-process search workers. Enum payloads replace the
//! original's object-shape checks; value and byte budgets still apply.

use std::{io, path::PathBuf};

use garcon_contract::chat_search::{
    CHAT_SEARCH_MAX_COMPILED_QUERY_BYTES, CHAT_SEARCH_MAX_FAILED_CHAT_DETAILS,
    CHAT_SEARCH_MAX_OFFSET, CHAT_SEARCH_MAX_PAGE_SIZE, CHAT_SEARCH_MAX_PREFIX_SIZE,
    CHAT_SEARCH_MAX_SNIPPET_CODE_POINTS, CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT, CHAT_SEARCH_MAX_TERMS,
    CHAT_SEARCH_MAX_WORDS, CHAT_SEARCH_MIN_PREFIX_CHARS, ChatSearchClauseV1, ChatSearchQueryV1,
    ChatSearchResultMode, ChatSearchSnippetRole, ChatSearchTokenMatch, TranscriptSearchAllowedChat,
};
use garcon_js::trim;
use serde::Serialize;

use crate::{
    query::{SearchIndexResult, TranscriptSearchOrder},
    rows::HistoricalSearchMessageRow,
    schema::{
        MAX_SAFE_ORDINAL, SEARCH_INGEST_ROW_MAX_BYTES, SEARCH_TIMESTAMP_MAX_BYTES, SearchChatState,
        SearchChatStatus, SearchStatusCounts, SearchSyncMode, is_search_error_code,
    },
};

pub const MAX_ROWS_PER_FRAME: usize = 250;
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ALLOWLIST_PER_FRAME: usize = 2_000;

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WorkerIdentity {
    pub epoch: u64,
    pub request_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}")]
pub struct WorkerFailure {
    pub code: String,
    pub retryable: bool,
}

impl WorkerFailure {
    pub(crate) fn new(code: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            retryable,
        }
    }
}

#[derive(Debug)]
pub enum IndexerRequest {
    Open(PathBuf),
    ChatStates,
    SyncBegin {
        mode: SearchSyncMode,
        chat_id: String,
        transcript_view_id: String,
        expected_after_ordinal: u64,
        target_through: u64,
    },
    SyncCleanup,
    SyncRows {
        frame_index: u64,
        rows: Vec<HistoricalSearchMessageRow>,
        advance_to: u64,
    },
    SyncFinish,
    MarkFailed {
        chat_id: String,
        transcript_view_id: String,
        error_code: String,
    },
    DeleteChat {
        chat_id: String,
    },
    Maintenance,
    StatusSnapshot,
    Checkpoint,
    Close,
}

#[derive(Debug, PartialEq, Eq)]
pub enum IndexerEvent {
    Opened {
        recreated: bool,
    },
    ChatStates {
        states: Vec<SearchChatState>,
    },
    SyncAccepted {
        indexed_through: u64,
        current: bool,
        stale_rows: bool,
    },
    CleanupProgress {
        deleted_rows: u64,
        remaining: bool,
    },
    SyncProgress {
        frame_index: u64,
        indexed_through: u64,
    },
    SyncComplete {
        state: SearchChatState,
    },
    DeleteProgress {
        deleted_rows: u64,
    },
    Status {
        counts: SearchStatusCounts,
    },
    CheckpointComplete {
        busy: i64,
    },
    Ack,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderSearch {
    pub query: ChatSearchQueryV1,
    pub order: TranscriptSearchOrder,
    pub mode: ChatSearchResultMode,
    pub offset: u64,
    pub limit: u64,
    pub snippet_limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ReaderFrame {
    SearchStart(ReaderSearch),
    SearchAllowlistChunk {
        chunk_index: u64,
        allowed_chats: Vec<TranscriptSearchAllowedChat>,
        done: bool,
    },
}

#[derive(Debug)]
pub enum ReaderRequest {
    Open(PathBuf),
    Search(ReaderFrame),
    Close,
}

#[derive(Debug, PartialEq)]
pub enum ReaderEvent {
    Opened,
    SearchResult(SearchIndexResult),
    Closed,
}

fn bounded_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256
}

fn positive_safe(value: u64) -> bool {
    (1..=MAX_SAFE_ORDINAL).contains(&value)
}

struct ByteBudget(usize);

impl io::Write for ByteBudget {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_sub(buffer.len())
            .ok_or_else(|| io::Error::other("frame byte budget exceeded"))?;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn json_bytes_within(value: &(impl Serialize + ?Sized), bytes: usize) -> bool {
    serde_json::to_writer(ByteBudget(bytes), value).is_ok()
}

pub(crate) fn json_byte_len(value: &(impl Serialize + ?Sized)) -> serde_json::Result<usize> {
    let mut budget = ByteBudget(usize::MAX);
    serde_json::to_writer(&mut budget, value)?;
    Ok(usize::MAX - budget.0)
}

pub(crate) fn valid_indexer_request(request: &IndexerRequest) -> bool {
    use IndexerRequest::*;
    match request {
        Open(path) => !path.as_os_str().is_empty(),
        SyncBegin {
            chat_id,
            transcript_view_id,
            expected_after_ordinal,
            target_through,
            ..
        } => {
            bounded_identifier(chat_id)
                && bounded_identifier(transcript_view_id)
                && expected_after_ordinal <= target_through
                && *target_through <= MAX_SAFE_ORDINAL
        }
        SyncRows {
            frame_index,
            rows,
            advance_to,
        } => {
            *frame_index <= MAX_SAFE_ORDINAL
                && rows.len() <= MAX_ROWS_PER_FRAME
                && rows.iter().all(|entry| {
                    let row = &entry.row;
                    positive_safe(entry.ordinal)
                        && !matches!(row.role, ChatSearchSnippetRole::CoercedArray(_))
                        && row
                            .timestamp
                            .as_ref()
                            .is_none_or(|value| value.len() <= SEARCH_TIMESTAMP_MAX_BYTES)
                        && row.body.len() <= SEARCH_INGEST_ROW_MAX_BYTES
                })
                && json_bytes_within(rows, MAX_FRAME_BYTES)
                && positive_safe(*advance_to)
        }
        MarkFailed {
            chat_id,
            transcript_view_id,
            error_code,
        } => {
            bounded_identifier(chat_id)
                && bounded_identifier(transcript_view_id)
                && is_search_error_code(error_code)
        }
        DeleteChat { chat_id } => bounded_identifier(chat_id),
        ChatStates | SyncCleanup | SyncFinish | Maintenance | StatusSnapshot | Checkpoint
        | Close => true,
    }
}

fn valid_query(query: &ChatSearchQueryV1) -> bool {
    if query.version != 1
        || query.clauses.len() > CHAT_SEARCH_MAX_TERMS
        || !json_bytes_within(query, CHAT_SEARCH_MAX_COMPILED_QUERY_BYTES)
    {
        return false;
    }
    let mut word_count = 0;
    query.clauses.iter().all(|clause| {
        let tokens = clause.tokens();
        word_count += tokens.len();
        !tokens.is_empty()
            && word_count <= CHAT_SEARCH_MAX_WORDS
            && !matches!(clause, ChatSearchClauseV1::Literal { text, .. } if trim(text).is_empty())
            && tokens.iter().all(|token| {
                token.match_kind == ChatSearchTokenMatch::Exact
                    || (matches!(clause, ChatSearchClauseV1::AllWords { .. })
                        && token
                            .text
                            .chars()
                            .take(CHAT_SEARCH_MIN_PREFIX_CHARS)
                            .count()
                            == CHAT_SEARCH_MIN_PREFIX_CHARS)
            })
    })
}

pub(crate) fn valid_reader_request(request: &ReaderRequest) -> bool {
    match request {
        ReaderRequest::Open(path) => !path.as_os_str().is_empty(),
        ReaderRequest::Search(ReaderFrame::SearchStart(search)) => {
            let prefix = search.mode == ChatSearchResultMode::Prefix;
            let maximum = if prefix {
                CHAT_SEARCH_MAX_PREFIX_SIZE
            } else {
                CHAT_SEARCH_MAX_PAGE_SIZE
            };
            valid_query(&search.query)
                && search.offset <= CHAT_SEARCH_MAX_OFFSET
                && (1..=maximum).contains(&search.limit)
                && (1..=CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT).contains(&search.snippet_limit)
                && (!prefix || (search.offset == 0 && search.snippet_limit == 1))
        }
        ReaderRequest::Search(ReaderFrame::SearchAllowlistChunk {
            chunk_index,
            allowed_chats,
            ..
        }) => {
            *chunk_index <= MAX_SAFE_ORDINAL
                && allowed_chats.len() <= MAX_ALLOWLIST_PER_FRAME
                && allowed_chats.iter().all(|entry| {
                    bounded_identifier(&entry.chat_id)
                        && bounded_identifier(&entry.transcript_view_id)
                        && entry.through_ordinal <= MAX_SAFE_ORDINAL
                })
                && json_bytes_within(allowed_chats, MAX_FRAME_BYTES)
        }
        ReaderRequest::Close => true,
    }
}

fn valid_chat_state(state: &SearchChatState) -> bool {
    bounded_identifier(&state.chat_id)
        && bounded_identifier(&state.transcript_view_id)
        && state.indexed_through <= MAX_SAFE_ORDINAL
        && state.target_through <= MAX_SAFE_ORDINAL
        && state
            .last_error_code
            .as_deref()
            .is_none_or(is_search_error_code)
        && match state.status {
            SearchChatStatus::Indexed => state.indexed_through == state.target_through,
            SearchChatStatus::Pending => state.indexed_through <= state.target_through,
            SearchChatStatus::Failed => true,
        }
}

pub(crate) fn valid_indexer_event(event: &IndexerEvent) -> bool {
    use IndexerEvent::*;
    match event {
        ChatStates { states } => {
            states.iter().all(valid_chat_state) && json_bytes_within(states, MAX_FRAME_BYTES)
        }
        SyncAccepted {
            indexed_through,
            current,
            stale_rows,
        } => *indexed_through <= MAX_SAFE_ORDINAL && !(*current && *stale_rows),
        CleanupProgress { deleted_rows, .. } => *deleted_rows <= MAX_SAFE_ORDINAL,
        SyncProgress {
            frame_index,
            indexed_through,
        } => *frame_index <= MAX_SAFE_ORDINAL && *indexed_through <= MAX_SAFE_ORDINAL,
        SyncComplete { state } => valid_chat_state(state),
        DeleteProgress { deleted_rows } => positive_safe(*deleted_rows),
        Status { counts } => [
            counts.indexed,
            counts.pending,
            counts.failed,
            counts.backlog_rows,
        ]
        .into_iter()
        .all(|value| value <= MAX_SAFE_ORDINAL),
        CheckpointComplete { busy } => matches!(busy, 0 | 1),
        Opened { .. } | Ack | Closed => true,
    }
}

fn valid_search_result(result: &SearchIndexResult, identity: WorkerIdentity) -> bool {
    use garcon_contract::chat_search::{ChatSearchFailureRecovery, ChatSearchFailureStage};

    let prefix = result.mode == ChatSearchResultMode::Prefix;
    let maximum = if prefix {
        CHAT_SEARCH_MAX_PREFIX_SIZE
    } else {
        CHAT_SEARCH_MAX_PAGE_SIZE
    };
    if !(1..=CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT).contains(&result.snippet_limit)
        || (prefix && (result.snippet_limit != 1 || result.page.offset != 0))
        || result.results.len() as u64 > maximum
        || result.results.iter().any(|hit| {
            !bounded_identifier(&hit.chat_id)
                || !bounded_identifier(&hit.transcript_view_id)
                || !hit.score.0.is_finite()
                || hit.matched_message_count > MAX_SAFE_ORDINAL
                || hit.snippets.len() > result.snippet_limit
                || hit.snippets.iter().any(|snippet| {
                    !positive_safe(snippet.ordinal)
                        || matches!(snippet.role, ChatSearchSnippetRole::CoercedArray(_))
                        || snippet
                            .timestamp
                            .as_ref()
                            .is_some_and(|value| value.len() > SEARCH_TIMESTAMP_MAX_BYTES)
                        || snippet
                            .text
                            .chars()
                            .take(CHAT_SEARCH_MAX_SNIPPET_CODE_POINTS + 1)
                            .count()
                            > CHAT_SEARCH_MAX_SNIPPET_CODE_POINTS
                })
        })
    {
        return false;
    }
    let page = &result.page;
    let hit_count = result.results.len() as u64;
    if page.offset > CHAT_SEARCH_MAX_OFFSET
        || !(1..=maximum).contains(&page.limit)
        || page.total > MAX_SAFE_ORDINAL
        || page.has_more != page.next_offset.is_some()
        || hit_count > page.limit
    {
        return false;
    }
    if !match page.next_offset {
        Some(next) => {
            next > page.offset
                && next <= CHAT_SEARCH_MAX_OFFSET
                && next == page.offset + hit_count
                && next < page.total
        }
        None if page.offset >= page.total => hit_count == 0,
        None => page.offset + hit_count >= page.total,
    } {
        return false;
    }

    let index = &result.index;
    if [
        index.indexed_chat_count,
        index.pending_chat_count,
        index.failed_chat_count,
        index.unindexed_chat_count,
        index.unsupported_chat_count,
        index.failed_chats_omitted_count,
    ]
    .into_iter()
    .any(|value| value > MAX_SAFE_ORDINAL)
        || index.failed_chats.len() > CHAT_SEARCH_MAX_FAILED_CHAT_DETAILS
        || index.failed_chats.len() as u64 + index.failed_chats_omitted_count
            != index.failed_chat_count
    {
        return false;
    }
    let mut ids = std::collections::HashSet::new();
    if !index.failed_chats.iter().all(|entry| {
        entry.chat_id.len() == 16
            && entry.chat_id.bytes().all(|byte| byte.is_ascii_digit())
            && ids.insert(&entry.chat_id)
            && entry
                .transcript_view_id
                .as_deref()
                .is_none_or(bounded_identifier)
            && !matches!(entry.stage, ChatSearchFailureStage::CoercedArray(_))
            && is_search_error_code(&entry.error_code)
            && entry
                .indexed_through_ordinal
                .is_none_or(|value| value <= MAX_SAFE_ORDINAL)
            && entry
                .target_through_ordinal
                .is_none_or(|value| value <= MAX_SAFE_ORDINAL)
            && entry
                .indexed_through_ordinal
                .zip(entry.target_through_ordinal)
                .is_none_or(|(indexed, target)| indexed <= target)
            && !matches!(entry.recovery, ChatSearchFailureRecovery::CoercedArray(_))
    }) {
        return false;
    }

    // Lifecycle epochs are integers on the channel; the byte limit includes the original UUID envelope.
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct WireSize<'a> {
        r#type: &'static str,
        request_id: u64,
        lifecycle_epoch: &'static str,
        #[serde(flatten)]
        result: &'a SearchIndexResult,
    }
    json_bytes_within(
        &WireSize {
            r#type: "search-result",
            request_id: identity.request_id,
            lifecycle_epoch: "00000000-0000-0000-0000-000000000000",
            result,
        },
        MAX_FRAME_BYTES,
    )
}

pub(crate) fn valid_reader_event(event: &ReaderEvent, identity: WorkerIdentity) -> bool {
    match event {
        ReaderEvent::SearchResult(result) => valid_search_result(result, identity),
        ReaderEvent::Opened | ReaderEvent::Closed => true,
    }
}
