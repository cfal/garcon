use std::{iter::once, ops::Range};

use garcon_contract::chat_search::CHAT_SEARCH_MAX_SNIPPET_CODE_POINTS;

use super::{CompiledSearchTerm, normalize_fts_token, word_character};

const PREFIX: &str = "... ";
const SUFFIX: &str = " ...";
const MAX_LEADING_CONTEXT: usize = 160;
const MAX_CHARS: usize = CHAT_SEARCH_MAX_SNIPPET_CODE_POINTS - PREFIX.len() - SUFFIX.len();

struct Token {
    normalized: String,
    span: Range<usize>,
}

struct Anchor {
    token_index: usize,
    span: Range<usize>,
}

fn tokenize(body: &str) -> Vec<Token> {
    let mut start = None;
    let mut tokens = Vec::new();
    for (index, ch) in body.char_indices().chain(once((body.len(), ' '))) {
        if word_character(ch) {
            start.get_or_insert(index);
        } else if let Some(start) = start.take() {
            tokens.push(Token {
                normalized: normalize_fts_token(&body[start..index]),
                span: start..index,
            });
        }
    }
    tokens
}

fn match_term(body: &str, tokens: &[Token], term: &CompiledSearchTerm<'_>) -> Option<Anchor> {
    if let Some(literal) = &term.literal {
        let span = literal.first_span(body)?;
        let token_index = tokens.partition_point(|token| token.span.end <= span.start);
        return (token_index < tokens.len()).then_some(Anchor { token_index, span });
    }
    if term.exact_phrase {
        let token_index = tokens
            .windows(term.normalized_words.len())
            .position(|window| {
                window
                    .iter()
                    .zip(&term.normalized_words)
                    .all(|(token, word)| token.normalized == *word)
            })?;
        let end = token_index + term.normalized_words.len() - 1;
        return Some(Anchor {
            token_index,
            span: tokens[token_index].span.start..tokens[end].span.end,
        });
    }

    let mut token_index = usize::MAX;
    for (&word, &prefix) in term.normalized_words.iter().zip(&term.prefix_words) {
        let first = tokens.iter().position(|token| {
            if prefix {
                token.normalized.starts_with(word)
            } else {
                token.normalized == word
            }
        })?;
        token_index = token_index.min(first);
    }
    Some(Anchor {
        token_index,
        span: tokens.get(token_index)?.span.clone(),
    })
}

fn render(body: &str, tokens: &[Token], anchor: Anchor) -> String {
    let start_token = anchor.token_index.saturating_sub(8);
    let end_token = (start_token + 32).min(tokens.len());
    let start = if start_token == 0 {
        0
    } else {
        tokens[start_token].span.start.min(anchor.span.start)
    };
    let end = anchor.span.end.max(
        tokens
            .get(end_token)
            .map_or(body.len(), |token| token.span.start),
    );
    let match_length = body[anchor.span.clone()].chars().count();
    let context_budget = MAX_LEADING_CONTEXT.min(MAX_CHARS.saturating_sub(match_length));
    let context = &body[start..anchor.span.start];
    let context_start = context
        .char_indices()
        .rev()
        .nth(context_budget)
        .map_or(0, |(index, ch)| index + ch.len_utf8());
    let raw = &body[start + context_start..end];
    let normalized = raw
        .split(|ch: char| ch.is_whitespace() || ch == '\u{feff}')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let limit = normalized
        .char_indices()
        .nth(MAX_CHARS)
        .map_or(normalized.len(), |(index, _)| index);
    let prefix = if start > 0 || context_start > 0 {
        PREFIX
    } else {
        ""
    };
    let suffix = if end < body.len() || limit < normalized.len() {
        SUFFIX
    } else {
        ""
    };
    format!("{prefix}{}{suffix}", &normalized[..limit])
}

pub(super) fn snippet(body: &str, terms: &[CompiledSearchTerm<'_>]) -> String {
    let tokens = tokenize(body);
    let Some(first_token) = tokens.first() else {
        return String::new();
    };
    let mut first = None::<Anchor>;
    let mut first_literal = None::<Anchor>;
    for term in terms {
        let Some(anchor) = match_term(body, &tokens, term) else {
            continue;
        };
        let earliest = if term.literal.is_some() {
            &mut first_literal
        } else {
            &mut first
        };
        if earliest
            .as_ref()
            .is_none_or(|prior| anchor.span.start < prior.span.start)
        {
            *earliest = Some(anchor);
        }
    }
    render(
        body,
        &tokens,
        first_literal.or(first).unwrap_or_else(|| Anchor {
            token_index: 0,
            span: first_token.span.clone(),
        }),
    )
}
