//! Compiles and runs queries from `server-agents/common/src/search/query.ts`.

mod allowlist;
mod execution;
mod snippet;

pub use execution::{
    SEARCH_QUERY_MATCH_ROW_LIMIT, SearchError, SearchIndexOptions, SearchIndexResult,
    TranscriptSearchOrder, search_transcript_index_v1,
};

use std::{borrow::Cow, ops::Range};

use garcon_contract::chat_search::{
    CHAT_SEARCH_MAX_TERMS, CHAT_SEARCH_MAX_WORDS, ChatSearchClauseV1, ChatSearchQueryV1,
    ChatSearchTokenMatch,
};
use garcon_js::unicode;
use icu_normalizer::DecomposingNormalizer;
use regress::Regex;

const LITERAL_WORD_CLASS: &str = r"[\p{L}\p{N}\p{M}_]";

#[derive(Debug)]
pub struct LiteralPattern(Regex);

impl LiteralPattern {
    pub fn compile(text: &str) -> Result<Self, regress::Error> {
        let mut source = String::new();
        if text.chars().next().is_some_and(literal_word_character) {
            source.push_str("(?<!");
            source.push_str(LITERAL_WORD_CLASS);
            source.push(')');
        }
        for ch in text.chars() {
            match ch {
                ' ' => source.push_str(r"[\s\p{White_Space}]+"),
                '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']'
                | '\\' => {
                    source.push('\\');
                    source.push(ch);
                }
                ch => source.push(ch),
            }
        }
        if text.chars().next_back().is_some_and(literal_word_character) {
            source.push_str("(?!");
            source.push_str(LITERAL_WORD_CLASS);
            source.push(')');
        }
        Regex::with_flags(&source, "iu").map(Self)
    }

    /// The first match, in UTF-8 byte offsets into `body`.
    pub fn first_span(&self, body: &str) -> Option<Range<usize>> {
        self.0.find(body).map(|matched| matched.range())
    }
}

fn word_character(ch: char) -> bool {
    let category = unicode::category(ch);
    ch == '_' || category.is_letter() || category.is_number()
}

fn literal_word_character(ch: char) -> bool {
    word_character(ch) || unicode::category(ch).is_mark()
}

fn words_in(text: &str) -> impl Iterator<Item = &str> {
    text.split(|ch| !word_character(ch))
        .filter(|word| !word.is_empty())
}

fn normalize_fts_token(word: &str) -> String {
    DecomposingNormalizer::new_nfd()
        .normalize(word)
        .chars()
        .filter(|&ch| !unicode::category(ch).is_mark())
        .collect::<String>()
        .to_lowercase()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchQueryError {
    Terms,
    Clause,
    Words,
    Token,
    Literal,
}

impl std::fmt::Display for SearchQueryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Terms => write!(
                formatter,
                "Transcript search accepts at most {CHAT_SEARCH_MAX_TERMS} terms"
            ),
            Self::Clause => formatter.write_str("Transcript search query is invalid"),
            Self::Words => write!(
                formatter,
                "Transcript search accepts at most {CHAT_SEARCH_MAX_WORDS} words"
            ),
            Self::Token => formatter.write_str("Transcript search token is invalid"),
            Self::Literal => formatter.write_str("Transcript search literal is invalid"),
        }
    }
}

impl std::error::Error for SearchQueryError {}

#[derive(Debug)]
pub struct CompiledSearchTerm<'a> {
    pub fts_query: String,
    pub words: Vec<&'a str>,
    pub normalized_words: Vec<&'a str>,
    pub exact_phrase: bool,
    pub prefix_words: Vec<bool>,
    pub literal: Option<LiteralPattern>,
}

pub fn compile_structured_terms(
    query: &ChatSearchQueryV1,
) -> Result<Vec<CompiledSearchTerm<'_>>, SearchQueryError> {
    if query.version != 1 || query.clauses.len() > CHAT_SEARCH_MAX_TERMS {
        return Err(SearchQueryError::Terms);
    }
    let mut word_count = 0;
    query
        .clauses
        .iter()
        .map(|clause| {
            let tokens = clause.tokens();
            if tokens.is_empty() {
                return Err(SearchQueryError::Clause);
            }
            word_count += tokens.len();
            if word_count > CHAT_SEARCH_MAX_WORDS {
                return Err(SearchQueryError::Words);
            }
            let mut words = Vec::with_capacity(tokens.len());
            for token in tokens {
                let mut parsed = words_in(&token.text);
                let word = parsed.next().ok_or(SearchQueryError::Token)?;
                if parsed.next().is_some() || normalize_fts_token(word) != token.normalized {
                    return Err(SearchQueryError::Token);
                }
                words.push(word);
            }
            let exact_phrase = !matches!(clause, ChatSearchClauseV1::AllWords { .. });
            let literal = match clause {
                ChatSearchClauseV1::Literal { text, .. } => {
                    if !words_in(text).eq(words.iter().copied())
                        || tokens
                            .iter()
                            .any(|token| token.match_kind != ChatSearchTokenMatch::Exact)
                    {
                        return Err(SearchQueryError::Literal);
                    }
                    Some(LiteralPattern::compile(text).map_err(|_| SearchQueryError::Literal)?)
                }
                _ => None,
            };
            let prefix_words: Vec<_> = tokens
                .iter()
                .map(|token| !exact_phrase && token.match_kind == ChatSearchTokenMatch::Prefix)
                .collect();
            let fts_query = if exact_phrase {
                let phrase = match clause {
                    ChatSearchClauseV1::Literal { text, .. } => Cow::Borrowed(text.as_str()),
                    _ => Cow::Owned(words.join(" ")),
                };
                escape_fts_word(&phrase.replace('\0', " "))
            } else {
                words
                    .iter()
                    .zip(&prefix_words)
                    .map(|(word, prefix)| {
                        let mut escaped = escape_fts_word(word);
                        if *prefix {
                            escaped.push('*');
                        }
                        escaped
                    })
                    .collect::<Vec<_>>()
                    .join(" AND ")
            };
            Ok(CompiledSearchTerm {
                fts_query,
                words,
                normalized_words: tokens
                    .iter()
                    .map(|token| token.normalized.as_str())
                    .collect(),
                exact_phrase,
                prefix_words,
                literal,
            })
        })
        .collect()
}

fn escape_fts_word(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
