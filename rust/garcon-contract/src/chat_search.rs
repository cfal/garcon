//! Ports `common/chat-search.ts`.

use std::collections::{HashSet, VecDeque};

use garcon_js::{
    Number, clock::to_iso_string, date_parse::date_parse, is_safe_integer, json::as_number, trim,
    unicode, utf16,
};
use icu_normalizer::DecomposingNormalizer;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::chat_filter_query::{
    ChatFilterTerm, filter_whitespace, has_chat_filter_whitespace, parse_chat_filter_query,
    tokenize_chat_filter,
};

pub const CHAT_SEARCH_MAX_TERMS: usize = 16;
pub const CHAT_SEARCH_MAX_WORDS: usize = 32;
pub const CHAT_SEARCH_MAX_COMPILED_QUERY_BYTES: usize = 64 * 1024;
pub const CHAT_SEARCH_MIN_PREFIX_CHARS: usize = 3;
pub const CHAT_SEARCH_DEFAULT_PAGE_SIZE: u64 = 20;
pub const CHAT_SEARCH_MAX_PAGE_SIZE: u64 = 100;
pub const CHAT_SEARCH_MAX_PREFIX_SIZE: u64 = 500;
pub const CHAT_SEARCH_MAX_OFFSET: u64 = 9_999;
pub const CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT: usize = 3;
pub const CHAT_SEARCH_MAX_SNIPPET_CODE_POINTS: usize = 520;
pub const CHAT_SEARCH_MAX_CHAT_IDS: usize = 10_000;
pub const CHAT_SEARCH_MAX_FAILED_CHAT_DETAILS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatSearchSort {
    Relevance,
    Activity,
    Created,
}

pub const CHAT_SEARCH_SORT_VALUES: &[ChatSearchSort] = &[
    ChatSearchSort::Relevance,
    ChatSearchSort::Activity,
    ChatSearchSort::Created,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatSearchResultMode {
    Page,
    Prefix,
}

pub const CHAT_SEARCH_RESULT_MODES: &[ChatSearchResultMode] =
    &[ChatSearchResultMode::Page, ChatSearchResultMode::Prefix];

impl ChatSearchResultMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Page => "page",
            Self::Prefix => "prefix",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatSearchQueryV1 {
    pub version: u8,
    pub clauses: Vec<ChatSearchClauseV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ChatSearchClauseV1 {
    Phrase {
        tokens: Vec<ChatSearchTokenV1>,
    },
    AllWords {
        tokens: Vec<ChatSearchTokenV1>,
    },
    Literal {
        text: String,
        tokens: Vec<ChatSearchTokenV1>,
    },
}

impl ChatSearchClauseV1 {
    pub fn tokens(&self) -> &[ChatSearchTokenV1] {
        match self {
            Self::Phrase { tokens } | Self::AllWords { tokens } | Self::Literal { tokens, .. } => {
                tokens
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatSearchTokenMatch {
    Exact,
    Prefix,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatSearchTokenV1 {
    pub text: String,
    pub normalized: String,
    #[serde(rename = "match")]
    pub match_kind: ChatSearchTokenMatch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchRequest {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_tokens: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort: Option<ChatSearchSort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<ChatSearchResultMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet_limit: Option<Number>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSearchAllowedChat {
    pub chat_id: String,
    pub transcript_view_id: String,
    pub through_ordinal: u64,
}

macro_rules! coerced_names {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $text)] $variant,)+
            #[serde(untagged)]
            CoercedArray([Box<$name>; 1]),
        }

        impl $name {
            fn parse(value: &Value) -> Result<Option<Self>, InvalidChatSearchResponse> {
                parse_coerced_name(value, Self::CoercedArray, |text| match text {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                })
            }
        }
    };
}

coerced_names!(ChatSearchSnippetRole { User => "user", Assistant => "assistant", Tool => "tool", System => "system" });
coerced_names!(ChatSearchFailureStage { Adoption => "adoption", Ledger => "ledger", Indexing => "indexing" });
coerced_names!(ChatSearchFailureRecovery { SourceRequired => "source-required", IndexRetry => "index-retry", Unknown => "unknown" });

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatSearchSnippet {
    pub ordinal: u64,
    pub role: ChatSearchSnippetRole,
    pub timestamp: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchNavigateRequest {
    pub chat_id: String,
    pub transcript_view_id: String,
    pub ordinal: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchNavigateResponse {
    pub chat_id: String,
    pub ordinal: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchResult {
    pub chat_id: String,
    pub transcript_view_id: String,
    pub score: Number,
    pub matched_message_count: u64,
    pub snippets: Vec<ChatSearchSnippet>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchIndexStatus {
    pub indexed_chat_count: u64,
    pub pending_chat_count: u64,
    pub failed_chat_count: u64,
    pub unindexed_chat_count: u64,
    pub unsupported_chat_count: u64,
    pub results_truncated: bool,
    pub failed_chats: Vec<ChatSearchFailedChat>,
    pub failed_chats_omitted_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchFailedChat {
    pub chat_id: String,
    pub transcript_view_id: Option<String>,
    pub stage: ChatSearchFailureStage,
    pub error_code: String,
    pub indexed_through_ordinal: Option<u64>,
    pub target_through_ordinal: Option<u64>,
    pub recovery: ChatSearchFailureRecovery,
}

pub fn classify_chat_search_failure_recovery(
    stage: &ChatSearchFailureStage,
    error_code: &str,
) -> ChatSearchFailureRecovery {
    if matches!(
        stage,
        ChatSearchFailureStage::Adoption | ChatSearchFailureStage::Ledger
    ) || matches!(
        error_code,
        "CARRYOVER_HISTORY_UNAVAILABLE"
            | "HISTORY_LOAD_FAILED"
            | "LEDGER_FENCED"
            | "SOURCE_TRANSCRIPT_UNAVAILABLE"
            | "TRANSCRIPT_UNAVAILABLE"
    ) || error_code.starts_with("SQLITE_")
    {
        return ChatSearchFailureRecovery::SourceRequired;
    }
    if *stage == ChatSearchFailureStage::Indexing && error_code.starts_with("SEARCH_") {
        return ChatSearchFailureRecovery::IndexRetry;
    }
    ChatSearchFailureRecovery::Unknown
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchPage {
    pub offset: u64,
    pub limit: u64,
    pub total: u64,
    pub has_more: bool,
    pub next_offset: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchResponse {
    pub query: String,
    pub mode: ChatSearchResultMode,
    pub snippet_limit: Number,
    pub results: Vec<ChatSearchResult>,
    pub page: ChatSearchPage,
    pub index: ChatSearchIndexStatus,
    pub removed_stale_result_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InvalidChatSearchResponse {
    #[error("Invalid chat search response: {0}")]
    Field(&'static str),
    #[error("No default value")]
    StringCoercion,
}

impl InvalidChatSearchResponse {
    pub fn name(self) -> &'static str {
        match self {
            Self::Field(_) => "Error",
            Self::StringCoercion => "TypeError",
        }
    }
}

pub fn parse_chat_search_response(
    request: &ChatSearchRequest,
    value: &Value,
) -> Result<ChatSearchResponse, InvalidChatSearchResponse> {
    use InvalidChatSearchResponse::Field;
    let query = value["query"].as_str().ok_or(Field("response"))?;
    if query != request.query {
        return Err(Field("query does not match request"));
    }
    let mode = request.mode.unwrap_or(ChatSearchResultMode::Page);
    let snippet_limit = request
        .snippet_limit
        .unwrap_or(Number(CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT as f64));
    let expected_offset = request.offset.unwrap_or(Number(0.0));
    let expected_limit = request
        .limit
        .unwrap_or(Number(CHAT_SEARCH_DEFAULT_PAGE_SIZE as f64));
    if value["mode"] != mode.as_str() {
        return Err(Field("mode does not match request"));
    }
    if as_number(&value["snippetLimit"]) != Some(snippet_limit.0) {
        return Err(Field("snippetLimit does not match request"));
    }
    let results = value["results"]
        .as_array()
        .ok_or(Field("results"))?
        .iter()
        .map(|result| parse_chat_search_result(result, snippet_limit.0))
        .collect::<Result<Vec<_>, _>>()?;
    let page = &value["page"];
    let raw = page.as_object().ok_or(Field("page"))?;
    let maximum_limit = if mode == ChatSearchResultMode::Prefix {
        CHAT_SEARCH_MAX_PREFIX_SIZE
    } else {
        CHAT_SEARCH_MAX_PAGE_SIZE
    };
    let offset = nonnegative_integer(&page["offset"])
        .filter(|&n| n <= CHAT_SEARCH_MAX_OFFSET && n as f64 == expected_offset.0)
        .ok_or(Field("offset does not match request"))?;
    let limit = positive_integer(&page["limit"])
        .filter(|&n| n <= maximum_limit && n as f64 == expected_limit.0)
        .ok_or(Field("limit does not match request"))?;
    if mode == ChatSearchResultMode::Prefix && (offset != 0 || snippet_limit.0 != 1.0) {
        return Err(Field("prefix projection"));
    }
    let total = nonnegative_integer(&page["total"]).ok_or(Field("page fields"))?;
    let has_more = page["hasMore"].as_bool().ok_or(Field("page fields"))?;
    let next_offset =
        nullable(raw.get("nextOffset"), positive_integer).ok_or(Field("page fields"))?;
    if has_more != next_offset.is_some() {
        return Err(Field("cursor presence"));
    }
    if next_offset.is_some_and(|next| {
        next <= offset || next > CHAT_SEARCH_MAX_OFFSET || next > offset + limit || next > total
    }) {
        return Err(Field("cursor bounds"));
    }
    let remaining = total.saturating_sub(offset);
    let visible = results.len() as u64;
    if visible > limit || visible > remaining {
        return Err(Field("result window"));
    }
    let index = parse_chat_search_index_status(&value["index"])?;
    let removed_stale_result_count = nonnegative_integer(&value["removedStaleResultCount"])
        .filter(|&removed| visible + removed <= limit && visible + removed <= remaining)
        .ok_or(Field("removed stale result count"))?;
    Ok(ChatSearchResponse {
        query: query.to_owned(),
        mode,
        snippet_limit,
        results,
        page: ChatSearchPage {
            offset,
            limit,
            total,
            has_more,
            next_offset,
        },
        index,
        removed_stale_result_count,
    })
}

pub fn compile_chat_search_query(query: &str, text_tokens: Option<&[String]>) -> ChatSearchQueryV1 {
    let terms = if let Some(tokens) = text_tokens.filter(|tokens| !tokens.is_empty()) {
        let mut originals: IndexMap<String, VecDeque<_>> = IndexMap::new();
        for term in parse_chat_filter_query(query).text_terms {
            originals
                .entry(trim(&term.text).to_lowercase())
                .or_default()
                .push_back(term);
        }
        tokens
            .iter()
            .map(|text| {
                originals
                    .get_mut(&trim(text).to_lowercase())
                    .and_then(VecDeque::pop_front)
                    .unwrap_or_else(|| ChatFilterTerm {
                        text: text.clone(),
                        quoted: has_chat_filter_whitespace(text),
                        source: text.clone(),
                    })
            })
            .collect()
    } else {
        tokenize_chat_filter(trim(query))
    };
    let clauses = terms
        .iter()
        .enumerate()
        .map(|(index, term)| {
            compile_search_clause(
                term,
                text_tokens
                    .and_then(|tokens| tokens.get(index))
                    .map(String::as_str),
            )
        })
        .filter(|clause| !clause.tokens().is_empty())
        .collect();
    ChatSearchQueryV1 {
        version: 1,
        clauses,
    }
}

fn compile_search_clause(term: &ChatFilterTerm, browser_text: Option<&str>) -> ChatSearchClauseV1 {
    let is_word = |category: unicode::Category| category.is_letter() || category.is_number();
    let source_text = if term.quoted && !term.source.starts_with(['"', '\'']) {
        &term.source
    } else {
        &term.text
    };
    let literal = source_text.chars().any(|ch| {
        let category = unicode::category(ch);
        !is_word(category) && !category.is_mark() && !category.is_format() && !filter_whitespace(ch)
    });
    let text = if literal {
        source_text
    } else {
        browser_text.unwrap_or(source_text)
    };
    let phrase = term.quoted || has_chat_filter_whitespace(text);
    let normalizer = DecomposingNormalizer::new_nfd();
    let tokens = text
        .split(|ch| ch != '_' && !is_word(unicode::category(ch)))
        .filter(|word| !word.is_empty())
        .map(|word| {
            let normalized = normalizer
                .normalize(word)
                .chars()
                .filter(|&ch| !unicode::category(ch).is_mark())
                .collect::<String>()
                .to_lowercase();
            let match_kind =
                if !literal && !phrase && word.chars().count() >= CHAT_SEARCH_MIN_PREFIX_CHARS {
                    ChatSearchTokenMatch::Prefix
                } else {
                    ChatSearchTokenMatch::Exact
                };
            ChatSearchTokenV1 {
                text: word.to_owned(),
                normalized,
                match_kind,
            }
        })
        .collect();
    if literal {
        ChatSearchClauseV1::Literal {
            text: text
                .split(filter_whitespace)
                .filter(|piece| !piece.is_empty())
                .collect::<Vec<_>>()
                .join(" "),
            tokens,
        }
    } else if phrase {
        ChatSearchClauseV1::Phrase { tokens }
    } else {
        ChatSearchClauseV1::AllWords { tokens }
    }
}

fn parse_chat_search_result(
    value: &Value,
    snippet_limit: f64,
) -> Result<ChatSearchResult, InvalidChatSearchResponse> {
    use InvalidChatSearchResponse::Field;
    let chat_id = nonempty_string(&value["chatId"]).ok_or(Field("result"))?;
    let transcript_view_id = nonempty_string(&value["transcriptViewId"]).ok_or(Field("result"))?;
    let score = as_number(&value["score"])
        .filter(|score| score.is_finite())
        .ok_or(Field("result"))?;
    let matched_message_count =
        nonnegative_integer(&value["matchedMessageCount"]).ok_or(Field("result"))?;
    let snippets = value["snippets"]
        .as_array()
        .filter(|snippets| snippets.len() as f64 <= snippet_limit)
        .ok_or(Field("result"))?;
    let snippets = snippets
        .iter()
        .map(parse_chat_search_snippet)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ChatSearchResult {
        chat_id,
        transcript_view_id,
        score: Number(score),
        matched_message_count,
        snippets,
    })
}

fn parse_chat_search_snippet(
    value: &Value,
) -> Result<ChatSearchSnippet, InvalidChatSearchResponse> {
    use InvalidChatSearchResponse::Field;
    let ordinal = positive_integer(&value["ordinal"]).ok_or(Field("snippet"))?;
    let role = ChatSearchSnippetRole::parse(&value["role"])?.ok_or(Field("snippet"))?;
    let timestamp = nullable(value.get("timestamp"), owned_string).ok_or(Field("snippet"))?;
    let text = owned_string(&value["text"]).ok_or(Field("snippet"))?;
    Ok(ChatSearchSnippet {
        ordinal,
        role,
        timestamp,
        text,
    })
}

fn parse_chat_search_index_status(
    value: &Value,
) -> Result<ChatSearchIndexStatus, InvalidChatSearchResponse> {
    use InvalidChatSearchResponse::Field;
    let count = |name: &str| nonnegative_integer(&value[name]).ok_or(Field("index"));
    let indexed_chat_count = count("indexedChatCount")?;
    let pending_chat_count = count("pendingChatCount")?;
    let failed_chat_count = count("failedChatCount")?;
    let unindexed_chat_count = count("unindexedChatCount")?;
    let unsupported_chat_count = count("unsupportedChatCount")?;
    let results_truncated = value["resultsTruncated"].as_bool().ok_or(Field("index"))?;
    let failed_chats = value["failedChats"]
        .as_array()
        .filter(|chats| chats.len() <= CHAT_SEARCH_MAX_FAILED_CHAT_DETAILS)
        .ok_or(Field("index"))?;
    let failed_chats_omitted_count = count("failedChatsOmittedCount")?;
    let failed_chats = failed_chats
        .iter()
        .map(parse_failed_chat)
        .collect::<Result<Vec<_>, _>>()?;
    if failed_chats
        .iter()
        .map(|chat| chat.chat_id.as_str())
        .collect::<HashSet<_>>()
        .len()
        != failed_chats.len()
        || failed_chats.len() as u64 + failed_chats_omitted_count != failed_chat_count
    {
        return Err(Field("failed chat details"));
    }
    Ok(ChatSearchIndexStatus {
        indexed_chat_count,
        pending_chat_count,
        failed_chat_count,
        unindexed_chat_count,
        unsupported_chat_count,
        results_truncated,
        failed_chats,
        failed_chats_omitted_count,
    })
}

fn parse_failed_chat(value: &Value) -> Result<ChatSearchFailedChat, InvalidChatSearchResponse> {
    use InvalidChatSearchResponse::Field;
    let invalid = Field("failed chat detail");
    let chat_id = value["chatId"]
        .as_str()
        .filter(|id| id.len() == 16 && id.bytes().all(|byte| byte.is_ascii_digit()))
        .ok_or(invalid)?;
    let transcript_view_id = nullable(value.get("transcriptViewId"), |id| {
        nonempty_string(id).filter(|id| utf16::len(id) <= 512)
    })
    .ok_or(invalid)?;
    let stage = ChatSearchFailureStage::parse(&value["stage"])?.ok_or(invalid)?;
    let error_code = value["errorCode"]
        .as_str()
        .filter(|code| valid_error_code(code))
        .ok_or(invalid)?;
    let indexed_through_ordinal =
        nullable(value.get("indexedThroughOrdinal"), nonnegative_integer).ok_or(invalid)?;
    let target_through_ordinal =
        nullable(value.get("targetThroughOrdinal"), nonnegative_integer).ok_or(invalid)?;
    if indexed_through_ordinal
        .zip(target_through_ordinal)
        .is_some_and(|(indexed, target)| indexed > target)
    {
        return Err(invalid);
    }
    let recovery = ChatSearchFailureRecovery::parse(&value["recovery"])?.ok_or(invalid)?;
    Ok(ChatSearchFailedChat {
        chat_id: chat_id.to_owned(),
        transcript_view_id,
        stage,
        error_code: error_code.to_owned(),
        indexed_through_ordinal,
        target_through_ordinal,
        recovery,
    })
}

fn parse_coerced_name<T>(
    value: &Value,
    array: fn([Box<T>; 1]) -> T,
    parse: impl Fn(&str) -> Option<T> + Copy,
) -> Result<Option<T>, InvalidChatSearchResponse> {
    if value
        .as_object()
        .is_some_and(|raw| raw.contains_key("toString"))
    {
        return Err(InvalidChatSearchResponse::StringCoercion);
    }
    if let Some(items) = value.as_array() {
        if let [item] = items.as_slice() {
            return parse_coerced_name(item, array, parse)
                .map(|item| item.map(|name| array([Box::new(name)])));
        }
        // Only a singleton can stringify to a valid name, but any element can throw.
        for item in items {
            parse_coerced_name(item, array, parse)?;
        }
        return Ok(None);
    }
    Ok(value.as_str().and_then(parse))
}

fn owned_string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}
fn nonempty_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn nonnegative_integer(value: &Value) -> Option<u64> {
    as_number(value)
        .filter(|&number| is_safe_integer(number) && number >= 0.0)
        .map(|number| number as u64)
}

fn positive_integer(value: &Value) -> Option<u64> {
    nonnegative_integer(value).filter(|&number| number > 0)
}

fn nullable<T>(
    value: Option<&Value>,
    parse: impl FnOnce(&Value) -> Option<T>,
) -> Option<Option<T>> {
    match value? {
        Value::Null => Some(None),
        value => parse(value).map(Some),
    }
}

fn valid_error_code(code: &str) -> bool {
    code.len() <= 64
        && code.as_bytes().split_first().is_some_and(|(first, rest)| {
            first.is_ascii_uppercase()
                && rest
                    .iter()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptSearchPhase {
    Disabled,
    Opening,
    Rebuilding,
    Ready,
    Degraded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSearchStatusV1 {
    pub version: u8,
    pub phase: TranscriptSearchPhase,
    pub chats: TranscriptSearchChatCounts,
    pub queued_jobs: u64,
    pub resync: Option<TranscriptSearchResync>,
    pub backlog_rows: u64,
    pub active_chat: Option<TranscriptSearchActiveChat>,
    pub last_error_code: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TranscriptSearchChatCounts {
    pub total: u64,
    pub indexed: u64,
    pub pending: u64,
    pub failed: u64,
    pub unindexed: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSearchResync {
    pub completed_chats: u64,
    pub total_chats: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TranscriptSearchActiveChat {
    pub position: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSearchQueryStatsV1 {
    pub served: u64,
    pub timed_out: u64,
    pub rejected_busy: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub max_ms: u64,
    pub admission_p50_ms: u64,
    pub admission_p95_ms: u64,
    pub admission_max_ms: u64,
    pub total_p50_ms: u64,
    pub total_p95_ms: u64,
    pub total_max_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSearchStatusResponse {
    #[serde(flatten)]
    pub status: TranscriptSearchStatusV1,
    pub query_stats: TranscriptSearchQueryStatsV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TranscriptSearchRebuildResponse {
    pub success: bool,
    pub status: TranscriptSearchStatusResponse,
}

const TRANSCRIPT_SEARCH_STATUS_KEYS: &[&str] = &[
    "version",
    "phase",
    "chats",
    "queuedJobs",
    "resync",
    "backlogRows",
    "activeChat",
    "lastErrorCode",
    "updatedAt",
];
const TRANSCRIPT_SEARCH_CHAT_KEYS: &[&str] =
    &["total", "indexed", "pending", "failed", "unindexed"];
const TRANSCRIPT_SEARCH_QUERY_STAT_KEYS: &[&str] = &[
    "served",
    "timedOut",
    "rejectedBusy",
    "p50Ms",
    "p95Ms",
    "maxMs",
    "admissionP50Ms",
    "admissionP95Ms",
    "admissionMaxMs",
    "totalP50Ms",
    "totalP95Ms",
    "totalMaxMs",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InvalidTranscriptSearchStatus {
    #[error("Invalid transcript search status response: unexpected fields")]
    UnexpectedFields,
    #[error("Invalid transcript search status response: invalid status")]
    InvalidStatus,
    #[error("Invalid transcript search status response: invalid query statistics")]
    InvalidQueryStatistics,
}

pub fn parse_transcript_search_status_response(
    value: &Value,
) -> Result<TranscriptSearchStatusResponse, InvalidTranscriptSearchStatus> {
    let raw = value
        .as_object()
        .ok_or(InvalidTranscriptSearchStatus::UnexpectedFields)?;
    if raw.len() != TRANSCRIPT_SEARCH_STATUS_KEYS.len() + 1
        || !raw.contains_key("queryStats")
        || !TRANSCRIPT_SEARCH_STATUS_KEYS
            .iter()
            .all(|key| raw.contains_key(*key))
    {
        return Err(InvalidTranscriptSearchStatus::UnexpectedFields);
    }
    let status = parse_status_fields(value).ok_or(InvalidTranscriptSearchStatus::InvalidStatus)?;
    let query_stats = parse_query_statistics(&value["queryStats"])
        .ok_or(InvalidTranscriptSearchStatus::InvalidQueryStatistics)?;
    Ok(TranscriptSearchStatusResponse {
        status,
        query_stats,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InvalidTranscriptSearchRebuild {
    #[error("Invalid transcript search rebuild response: unexpected fields")]
    UnexpectedFields,
    #[error("Invalid transcript search rebuild response: rebuild was not accepted")]
    RebuildNotAccepted,
    #[error("Invalid transcript search rebuild response: invalid status")]
    InvalidStatus(#[source] InvalidTranscriptSearchStatus),
}

pub fn parse_transcript_search_rebuild_response(
    value: &Value,
) -> Result<TranscriptSearchRebuildResponse, InvalidTranscriptSearchRebuild> {
    if !has_exact_keys(value, &["success", "status"]) {
        return Err(InvalidTranscriptSearchRebuild::UnexpectedFields);
    }
    if value["success"] != true {
        return Err(InvalidTranscriptSearchRebuild::RebuildNotAccepted);
    }
    let status = parse_transcript_search_status_response(&value["status"])
        .map_err(InvalidTranscriptSearchRebuild::InvalidStatus)?;
    Ok(TranscriptSearchRebuildResponse {
        success: true,
        status,
    })
}

fn parse_query_statistics(value: &Value) -> Option<TranscriptSearchQueryStatsV1> {
    if !has_exact_keys(value, TRANSCRIPT_SEARCH_QUERY_STAT_KEYS) {
        return None;
    }
    let count = |field: &str| nonnegative_integer(&value[field]);
    Some(TranscriptSearchQueryStatsV1 {
        served: count("served")?,
        timed_out: count("timedOut")?,
        rejected_busy: count("rejectedBusy")?,
        p50_ms: count("p50Ms")?,
        p95_ms: count("p95Ms")?,
        max_ms: count("maxMs")?,
        admission_p50_ms: count("admissionP50Ms")?,
        admission_p95_ms: count("admissionP95Ms")?,
        admission_max_ms: count("admissionMaxMs")?,
        total_p50_ms: count("totalP50Ms")?,
        total_p95_ms: count("totalP95Ms")?,
        total_max_ms: count("totalMaxMs")?,
    })
}

pub fn is_transcript_search_status_v1(value: &Value) -> Option<TranscriptSearchStatusV1> {
    if !has_exact_keys(value, TRANSCRIPT_SEARCH_STATUS_KEYS) {
        return None;
    }
    parse_status_fields(value)
}

fn parse_status_fields(value: &Value) -> Option<TranscriptSearchStatusV1> {
    if as_number(&value["version"]) != Some(1.0) {
        return None;
    }
    let phase = match value["phase"].as_str()? {
        "disabled" => TranscriptSearchPhase::Disabled,
        "opening" => TranscriptSearchPhase::Opening,
        "rebuilding" => TranscriptSearchPhase::Rebuilding,
        "ready" => TranscriptSearchPhase::Ready,
        "degraded" => TranscriptSearchPhase::Degraded,
        "failed" => TranscriptSearchPhase::Failed,
        _ => return None,
    };
    let chats = parse_chat_counts(&value["chats"])?;
    let queued_jobs = nonnegative_integer(&value["queuedJobs"])?;
    let backlog_rows = nonnegative_integer(&value["backlogRows"])?;
    let resync = nullable(value.get("resync"), parse_resync)?;
    let active_chat = nullable(value.get("activeChat"), parse_active_chat)?;
    let last_error_code = nullable(value.get("lastErrorCode"), |code| {
        code.as_str()
            .filter(|code| valid_error_code(code))
            .map(str::to_owned)
    })?;
    let updated_at = value["updatedAt"].as_str()?;
    if to_iso_string(date_parse(updated_at)?).ok().as_deref() != Some(updated_at) {
        return None;
    }
    Some(TranscriptSearchStatusV1 {
        version: 1,
        phase,
        chats,
        queued_jobs,
        resync,
        backlog_rows,
        active_chat,
        last_error_code,
        updated_at: updated_at.to_owned(),
    })
}

fn parse_chat_counts(value: &Value) -> Option<TranscriptSearchChatCounts> {
    if !has_exact_keys(value, TRANSCRIPT_SEARCH_CHAT_KEYS) {
        return None;
    }
    let total = nonnegative_integer(&value["total"])?;
    let indexed = nonnegative_integer(&value["indexed"])?;
    let pending = nonnegative_integer(&value["pending"])?;
    let failed = nonnegative_integer(&value["failed"])?;
    let unindexed = nonnegative_integer(&value["unindexed"])?;
    (indexed + pending + failed + unindexed >= total).then_some(TranscriptSearchChatCounts {
        total,
        indexed,
        pending,
        failed,
        unindexed,
    })
}

fn parse_resync(value: &Value) -> Option<TranscriptSearchResync> {
    if !has_exact_keys(value, &["completedChats", "totalChats"]) {
        return None;
    }
    let completed_chats = nonnegative_integer(&value["completedChats"])?;
    let total_chats = nonnegative_integer(&value["totalChats"])?;
    (total_chats >= completed_chats).then_some(TranscriptSearchResync {
        completed_chats,
        total_chats,
    })
}

fn parse_active_chat(value: &Value) -> Option<TranscriptSearchActiveChat> {
    if !has_exact_keys(value, &["position", "total"]) {
        return None;
    }
    let position = nonnegative_integer(&value["position"])?;
    let total = nonnegative_integer(&value["total"])?;
    (total >= position).then_some(TranscriptSearchActiveChat { position, total })
}

fn has_exact_keys(value: &Value, expected: &[&str]) -> bool {
    value.as_object().is_some_and(|raw: &Map<String, Value>| {
        raw.len() == expected.len() && expected.iter().all(|key| raw.contains_key(*key))
    })
}
