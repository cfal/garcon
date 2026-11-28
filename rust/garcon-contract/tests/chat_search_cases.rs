use garcon_cases::{CaseError, replay, round_tripped, text, unknown};
use garcon_contract::{chat_filter_query, chat_search};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

fn typed<T: DeserializeOwned>(function: &str, value: &Value) -> Result<T, CaseError> {
    serde_json::from_value(value.clone()).map_err(|_| CaseError::unhandled(function))
}

fn result(value: impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(&value).unwrap()).unwrap()
}

fn required_text<'a>(function: &str, value: Option<&'a Value>) -> Result<&'a str, CaseError> {
    text(function, value)?.ok_or_else(|| CaseError::unhandled(function))
}

fn run(unit: &str, dispatch: impl Fn(&str, &[Value]) -> Result<Value, CaseError>) {
    let cases = format!("{}/tests/cases/common/{unit}", env!("CARGO_MANIFEST_DIR"));
    let stats = replay(cases, dispatch);
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn filter_keys_follow_their_first_valid_operator() {
    let spec = chat_filter_query::parse_chat_search(
        "status:invalid source:1783725900000201 status:active is:pinned status:unread",
    );
    assert_eq!(
        serde_json::to_string(&spec).unwrap(),
        r#"{"textTokens":[],"titles":[],"tags":[],"agents":[],"models":[],"project":[],"sources":[["1783725900000201"]],"status":"unread","orderGroup":{"group":"pinned","negated":false}}"#,
    );
}

#[test]
fn chat_filter_query_cases_match() {
    use chat_filter_query::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct OrderFlags {
        is_pinned: bool,
        is_archived: bool,
    }

    run("chat-filter-query", |function, args| {
        let first = unknown(function, args.first())?;
        Ok(match function {
            "emptyFilterSpec" => result(empty_filter_spec()),
            "isEmptyFilter" => json!(is_empty_filter(&typed(function, &first)?)),
            "parseChatFilterQuery" => result(parse_chat_filter_query(required_text(
                function,
                args.first(),
            )?)),
            "parseChatSearch" => result(parse_chat_search(required_text(function, args.first())?)),
            "matchesChatFilter" => {
                let chat = typed(function, &first)?;
                let second = unknown(function, args.get(1))?;
                let spec = typed(function, &second)?;
                json!(matches_chat_filter(&chat, &spec))
            }
            "chatOrderGroupFor" => {
                let flags: OrderFlags = typed(function, &first)?;
                result(chat_order_group_for(flags.is_pinned, flags.is_archived))
            }
            "serializeChatFilter" => json!(serialize_chat_filter(&typed(function, &first)?)),
            "addTagToQuery" | "removeTagFromQuery" | "queryHasTag" => {
                let query = required_text(function, args.first())?;
                let tag = required_text(function, args.get(1))?;
                match function {
                    "addTagToQuery" => json!(add_tag_to_query(query, tag)),
                    "removeTagFromQuery" => json!(remove_tag_from_query(query, tag)),
                    _ => json!(query_has_tag(query, tag)),
                }
            }
            "hasChatFilterWhitespace" => json!(has_chat_filter_whitespace(required_text(
                function,
                args.first()
            )?)),
            "tokenizeChatFilter" => {
                result(tokenize_chat_filter(required_text(function, args.first())?))
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn chat_search_cases_match() {
    use chat_search::*;
    run("chat-search", |function, args| {
        let first = unknown(function, args.first())?;
        match function {
            "parseChatSearchResponse" => {
                let request = typed(function, &first)?;
                let raw = unknown(function, args.get(1))?;
                parse_chat_search_response(&request, &raw).map(result).map_err(|error| CaseError::new(error.name(), error.to_string()))
            }
            "compileChatSearchQuery" => {
                let query = required_text(function, args.first())?;
                let tokens: Option<Vec<String>> = round_tripped(function, args.get(1))?
                    .map(|tokens| typed(function, &tokens)).transpose()?.flatten();
                Ok(result(compile_chat_search_query(query, tokens.as_deref())))
            }
            "classifyChatSearchFailureRecovery" => {
                let stage = typed(function, &first)?;
                let code = required_text(function, args.get(1))?;
                Ok(result(classify_chat_search_failure_recovery(&stage, code)))
            }
            "isTranscriptSearchStatusV1" => Ok(json!(is_transcript_search_status_v1(&first).is_some())),
            "parseTranscriptSearchStatusResponse" => parse_transcript_search_status_response(&first)
                .map(result).map_err(|error| CaseError::new("Error", error.to_string())),
            "parseTranscriptSearchRebuildResponse" => parse_transcript_search_rebuild_response(&first)
                .map(result).map_err(|error| {
                    let base = CaseError::new("Error", error.to_string());
                    if let InvalidTranscriptSearchRebuild::InvalidStatus(cause) = error {
                        base.with_property("cause", json!({"$": "error", "name": "Error", "message": cause.to_string(), "properties": {}}))
                    } else { base }
                }),
            _ => Err(CaseError::unhandled(function)),
        }
    });
}
