use std::{cmp::Ordering, collections::HashMap};

use garcon_contract::chat_search::{
    CHAT_SEARCH_DEFAULT_PAGE_SIZE, CHAT_SEARCH_MAX_OFFSET, CHAT_SEARCH_MAX_PAGE_SIZE,
    CHAT_SEARCH_MAX_PREFIX_SIZE, CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT, ChatSearchIndexStatus,
    ChatSearchPage, ChatSearchQueryV1, ChatSearchResult, ChatSearchResultMode, ChatSearchSnippet,
    ChatSearchSnippetRole, TranscriptSearchAllowedChat,
};
use garcon_js::{Number, collation::Collation, is_safe_integer};
use indexmap::IndexMap;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize, Serializer, ser::SerializeStruct};
use thiserror::Error;

use super::{
    CompiledSearchTerm, SearchQueryError,
    allowlist::{index_status, prepare_allowed, stage_allowed},
    compile_structured_terms,
    snippet::snippet,
};
use crate::schema::read_counter;

pub const SEARCH_QUERY_MATCH_ROW_LIMIT: usize = 10_000;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptSearchOrder {
    #[default]
    Relevance,
    Allowlist,
}

#[derive(Debug, Clone, Copy)]
pub struct SearchIndexOptions<'a> {
    pub query: &'a ChatSearchQueryV1,
    pub allowed_chats: &'a [TranscriptSearchAllowedChat],
    pub order: TranscriptSearchOrder,
    pub mode: ChatSearchResultMode,
    pub offset: Option<Number>,
    pub limit: Option<Number>,
    pub snippet_limit: Option<Number>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexResult {
    pub mode: ChatSearchResultMode,
    pub snippet_limit: usize,
    pub results: Vec<ChatSearchResult>,
    pub page: ChatSearchPage,
    #[serde(serialize_with = "serialize_index")]
    pub index: ChatSearchIndexStatus,
}

fn serialize_index<S: Serializer>(
    value: &ChatSearchIndexStatus,
    writer: S,
) -> Result<S::Ok, S::Error> {
    if value.indexed_chat_count == 0
        && value.pending_chat_count == 0
        && value.failed_chat_count == 0
    {
        return value.serialize(writer);
    }
    // The nonempty allowlist branch appends pendingChatCount after the failure fields.
    let mut object = writer.serialize_struct("ChatSearchIndexStatus", 8)?;
    object.serialize_field("indexedChatCount", &value.indexed_chat_count)?;
    object.serialize_field("failedChatCount", &value.failed_chat_count)?;
    object.serialize_field("unindexedChatCount", &value.unindexed_chat_count)?;
    object.serialize_field("unsupportedChatCount", &value.unsupported_chat_count)?;
    object.serialize_field("resultsTruncated", &value.results_truncated)?;
    object.serialize_field("failedChats", &value.failed_chats)?;
    object.serialize_field("failedChatsOmittedCount", &value.failed_chats_omitted_count)?;
    object.serialize_field("pendingChatCount", &value.pending_chat_count)?;
    object.end()
}

#[derive(Debug, Error)]
pub enum SearchError {
    #[error("Transcript search prefix offset must be zero")]
    PrefixOffset,
    #[error("Transcript search prefix requires one snippet")]
    PrefixSnippetLimit,
    #[error("Transcript search allowlist frontier is invalid")]
    AllowlistFrontier,
    #[error("Transcript search allowlist has contradictory snapshots")]
    ContradictoryAllowlist,
    #[error(transparent)]
    Query(#[from] SearchQueryError),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

type Key = (String, String);

struct Candidate {
    id: i64,
    ordinal: u64,
    role: i64,
    timestamp: Option<String>,
    rank: f64,
}

struct TermMatch {
    rank: f64,
    rows: Vec<Candidate>,
}

struct TermMatches {
    matches: IndexMap<Key, TermMatch>,
    truncated: bool,
}

const READ_BODY: &str = "SELECT body FROM search_chunks WHERE id = ?";

fn term_matches(
    db: &Connection,
    term: &CompiledSearchTerm<'_>,
) -> Result<TermMatches, SearchError> {
    let mut statement = db.prepare_cached(
        "SELECT chunks.id, chunks.chat_id, chunks.transcript_view_id, chunks.ordinal,
            chunks.role, chunks.timestamp, search_chunks_fts.rank
         FROM search_chunks_fts
         JOIN search_chunks chunks ON chunks.id = search_chunks_fts.rowid
         JOIN search_chat_state state ON state.chat_id = chunks.chat_id
            AND state.transcript_view_id = chunks.transcript_view_id
            AND state.status IN ('pending', 'indexed')
            AND chunks.ordinal <= state.indexed_through
         JOIN temp.search_allowed_chats allowed ON allowed.chat_id = chunks.chat_id
            AND allowed.transcript_view_id = chunks.transcript_view_id
            AND chunks.ordinal <= allowed.through_ordinal
         WHERE search_chunks_fts MATCH ?
         ORDER BY search_chunks_fts.rowid DESC LIMIT ?",
    )?;
    let mut rows = statement
        .query_map(
            params![
                format!("body:({})", term.fts_query),
                (SEARCH_QUERY_MATCH_ROW_LIMIT + 1) as i64
            ],
            |row| {
                Ok((
                    (row.get(1)?, row.get(2)?),
                    Candidate {
                        id: row.get(0)?,
                        ordinal: read_counter(row, 3)?,
                        role: row.get(4)?,
                        timestamp: row.get(5)?,
                        rank: row.get(6)?,
                    },
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let truncated = rows.len() > SEARCH_QUERY_MATCH_ROW_LIMIT;
    rows.truncate(SEARCH_QUERY_MATCH_ROW_LIMIT);

    let mut verify = term
        .literal
        .as_ref()
        .map(|literal| -> Result<_, rusqlite::Error> {
            Ok((literal, db.prepare_cached(READ_BODY)?))
        })
        .transpose()?;
    let mut matches = IndexMap::<Key, TermMatch>::new();
    for (key, row) in rows {
        if let Some((literal, body)) = &mut verify {
            let text = body
                .query_row([row.id], |row| row.get::<_, String>(0))
                .optional()?
                .unwrap_or_default();
            if literal.first_span(&text).is_none() {
                continue;
            }
        }
        let group = matches.entry(key).or_insert_with(|| TermMatch {
            rank: row.rank,
            rows: Vec::new(),
        });
        group.rank = group.rank.min(row.rank);
        group.rows.push(row);
    }
    Ok(TermMatches { matches, truncated })
}

fn by_rank(left: f64, right: f64) -> Ordering {
    left.partial_cmp(&right).unwrap_or(Ordering::Equal)
}

fn coverage<'a>(
    terms: &'a [TermMatches],
    allowed: &[TranscriptSearchAllowedChat],
    order: TranscriptSearchOrder,
) -> Vec<(&'a Key, f64)> {
    let Some(first) = terms.first() else {
        return Vec::new();
    };
    let mut rows: Vec<_> = first
        .matches
        .keys()
        .filter_map(|key| {
            let rank = terms.iter().try_fold(0.0, |score, term| {
                term.matches.get(key).map(|matched| score + matched.rank)
            })?;
            Some((key, rank))
        })
        .collect();
    let priorities = (order == TranscriptSearchOrder::Allowlist).then(|| {
        allowed
            .iter()
            .enumerate()
            .map(|(index, entry)| (entry.chat_id.as_str(), index))
            .collect::<HashMap<_, _>>()
    });
    let collator = Collation::english();
    rows.sort_by(|(left, left_rank), (right, right_rank)| {
        let primary = if let Some(priorities) = &priorities {
            let priority = |key: &Key| {
                priorities
                    .get(key.0.as_str())
                    .copied()
                    .unwrap_or(usize::MAX)
            };
            priority(left).cmp(&priority(right))
        } else {
            by_rank(*left_rank, *right_rank)
        };
        primary
            .then_with(|| collator.compare(&left.0, &right.0))
            .then_with(|| collator.compare(&left.1, &right.1))
    });
    rows
}

fn role(code: i64) -> ChatSearchSnippetRole {
    match code {
        0 => ChatSearchSnippetRole::User,
        1 => ChatSearchSnippetRole::Assistant,
        2 => ChatSearchSnippetRole::Tool,
        _ => ChatSearchSnippetRole::System,
    }
}

fn hydrate(
    db: &Connection,
    page: &[(&Key, f64)],
    terms: &[CompiledSearchTerm<'_>],
    matches: &[TermMatches],
    snippet_limit: usize,
) -> Result<Vec<ChatSearchResult>, SearchError> {
    let mut statement = db.prepare_cached(READ_BODY)?;
    page.iter()
        .map(|(key, rank)| {
            let mut rows = IndexMap::new();
            for term in matches {
                if let Some(group) = term.matches.get(*key) {
                    for row in &group.rows {
                        rows.insert(row.id, row);
                    }
                }
            }
            let mut best: Vec<&Candidate> = Vec::with_capacity(snippet_limit + 1);
            for &row in rows.values() {
                best.push(row);
                best.sort_by(|left, right| {
                    by_rank(left.rank, right.rank).then_with(|| left.ordinal.cmp(&right.ordinal))
                });
                best.truncate(snippet_limit);
            }
            let snippets = best
                .into_iter()
                .map(|candidate| -> Result<_, rusqlite::Error> {
                    let body = statement
                        .query_row([candidate.id], |row| row.get::<_, String>(0))
                        .optional()?
                        .unwrap_or_default();
                    Ok(ChatSearchSnippet {
                        ordinal: candidate.ordinal,
                        role: role(candidate.role),
                        timestamp: candidate.timestamp.clone(),
                        text: snippet(&body, terms),
                    })
                })
                .collect::<Result<_, _>>()?;
            Ok(ChatSearchResult {
                chat_id: key.0.clone(),
                transcript_view_id: key.1.clone(),
                score: Number(-*rank),
                matched_message_count: rows.len() as u64,
                snippets,
            })
        })
        .collect()
}

fn clamp(value: Option<Number>, default: u64, maximum: u64) -> u64 {
    value
        .map(|value| value.0)
        .filter(|value| value.is_finite() && value.trunc() == *value)
        .map_or(default, |value| value.clamp(1.0, maximum as f64) as u64)
}

pub fn search_transcript_index_v1(
    db: &Connection,
    options: SearchIndexOptions<'_>,
) -> Result<SearchIndexResult, SearchError> {
    let maximum_snippets = CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT as u64;
    let snippet_limit = clamp(options.snippet_limit, maximum_snippets, maximum_snippets) as usize;
    if options.mode == ChatSearchResultMode::Prefix {
        if options.offset.is_some_and(|value| value.0 != 0.0) {
            return Err(SearchError::PrefixOffset);
        }
        if snippet_limit != 1 {
            return Err(SearchError::PrefixSnippetLimit);
        }
    }
    let allowed = prepare_allowed(options.allowed_chats)?;
    stage_allowed(db, &allowed)?;
    let mut index = index_status(db, allowed.len() as u64)?;
    let terms = compile_structured_terms(options.query)?;
    let maximum_limit = if options.mode == ChatSearchResultMode::Prefix {
        CHAT_SEARCH_MAX_PREFIX_SIZE
    } else {
        CHAT_SEARCH_MAX_PAGE_SIZE
    };
    let limit = clamp(options.limit, CHAT_SEARCH_DEFAULT_PAGE_SIZE, maximum_limit);
    let offset = options
        .offset
        .map(|value| value.0)
        .filter(|&value| is_safe_integer(value))
        .map_or(0, |value| (value as u64).min(CHAT_SEARCH_MAX_OFFSET));
    let mut page = ChatSearchPage {
        offset,
        limit,
        total: 0,
        has_more: false,
        next_offset: None,
    };
    let results = if allowed.is_empty() || terms.is_empty() {
        Vec::new()
    } else {
        let matches = terms
            .iter()
            .map(|term| term_matches(db, term))
            .collect::<Result<Vec<_>, _>>()?;
        let ordered = coverage(&matches, &allowed, options.order);
        page.total = ordered.len() as u64;
        let start = (offset.min(page.total)) as usize;
        let end = ((offset + limit).min(page.total)) as usize;
        let next = offset + (end - start) as u64;
        page.has_more = next < page.total;
        page.next_offset = page.has_more.then_some(next);
        index.results_truncated = matches.iter().any(|matches| matches.truncated);
        hydrate(db, &ordered[start..end], &terms, &matches, snippet_limit)?
    };
    Ok(SearchIndexResult {
        mode: options.mode,
        snippet_limit,
        results,
        page,
        index,
    })
}
