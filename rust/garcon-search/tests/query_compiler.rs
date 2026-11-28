use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::chat_search::{
    ChatSearchClauseV1, ChatSearchQueryV1, ChatSearchTokenMatch, ChatSearchTokenV1,
};
use garcon_search::query::{SearchQueryError, compile_structured_terms};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct RecordedToken {
    text: String,
    normalized: String,
    #[serde(rename = "match")]
    match_kind: RecordedMatch,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum RecordedMatch {
    Exact,
    Prefix,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum RecordedClause {
    Phrase {
        tokens: Vec<RecordedToken>,
    },
    AllWords {
        tokens: Vec<RecordedToken>,
    },
    Literal {
        text: String,
        tokens: Vec<RecordedToken>,
    },
}

#[derive(Deserialize)]
struct RecordedQuery {
    version: f64,
    clauses: Vec<RecordedClause>,
}

fn adapt_tokens(tokens: Vec<RecordedToken>) -> Vec<ChatSearchTokenV1> {
    tokens
        .into_iter()
        .map(|token| ChatSearchTokenV1 {
            text: token.text,
            normalized: token.normalized,
            match_kind: match token.match_kind {
                RecordedMatch::Exact => ChatSearchTokenMatch::Exact,
                RecordedMatch::Prefix => ChatSearchTokenMatch::Prefix,
            },
        })
        .collect()
}

fn read_query(value: &Value) -> Result<ChatSearchQueryV1, serde_json::Error> {
    let query: RecordedQuery = garcon_js::json::from_str(&value.to_string())?;
    let clauses = query
        .clauses
        .into_iter()
        .map(|clause| match clause {
            RecordedClause::Phrase { tokens } => ChatSearchClauseV1::Phrase {
                tokens: adapt_tokens(tokens),
            },
            RecordedClause::AllWords { tokens } => ChatSearchClauseV1::AllWords {
                tokens: adapt_tokens(tokens),
            },
            RecordedClause::Literal { text, tokens } => ChatSearchClauseV1::Literal {
                text,
                tokens: adapt_tokens(tokens),
            },
        })
        .collect();
    Ok(ChatSearchQueryV1 {
        version: query.version as u8,
        clauses,
    })
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    if function != "validateSearchQuery" {
        return Err(CaseError::unhandled(function));
    }
    let value = unknown(function, args.first())?;
    let query = read_query(&value).map_err(|_| CaseError::unhandled(function))?;
    compile_structured_terms(&query)
        .map(|_| json!(true))
        .map_err(|error| CaseError::new("RangeError", error.to_string()))
}

#[test]
fn query_validation_matches_real_bun_queries() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/query-compiler"
        ),
        dispatch,
    );
    assert_eq!(stats.total, 74);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn compiles_prefixes_only_for_all_words_and_preserves_literal_spelling() {
    let query = read_query(&json!({
        "version":1,"clauses":[
            {"kind":"all-words","tokens":[
                {"text":"CAF\u{c9}","normalized":"cafe","match":"prefix"},
                {"text":"beta","normalized":"beta","match":"exact"}
            ]},
            {"kind":"phrase","tokens":[
                {"text":"CAFE","normalized":"cafe","match":"prefix"},
                {"text":"beta","normalized":"beta","match":"exact"}
            ]},
            {"kind":"literal","text":"x:\"A\0B\"","tokens":[
                {"text":"x","normalized":"x","match":"exact"},
                {"text":"A","normalized":"a","match":"exact"},
                {"text":"B","normalized":"b","match":"exact"}
            ]}
        ]
    }))
    .unwrap();
    let terms = compile_structured_terms(&query).unwrap();
    assert_eq!(terms[0].fts_query, "\"CAF\u{c9}\"* AND \"beta\"");
    assert_eq!(terms[1].fts_query, "\"CAFE beta\"");
    assert_eq!(terms[2].fts_query, "\"x:\"\"A B\"\"\"");
    assert!(
        terms[2]
            .literal
            .as_ref()
            .unwrap()
            .first_span("!X:\"a\0b\"!")
            .is_some()
    );
}

#[test]
fn rejects_a_malformed_token_before_a_mismatched_literal() {
    let query = read_query(&json!({
        "version":1,"clauses":[
            {"kind":"literal","text":"#731","tokens":[{"text":"732","normalized":"wrong","match":"prefix"}]}
        ]
    })).unwrap();
    assert_eq!(
        compile_structured_terms(&query).unwrap_err(),
        SearchQueryError::Token
    );
}
