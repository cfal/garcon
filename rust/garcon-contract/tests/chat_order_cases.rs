use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::{chat_order_contracts, chat_order_sort};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

fn typed<T: DeserializeOwned>(function: &str, value: &Value) -> Result<T, CaseError> {
    serde_json::from_value(value.clone()).map_err(|_| CaseError::unhandled(function))
}

fn result(value: impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(&value).unwrap()).unwrap()
}

fn run(unit: &str, dispatch: impl Fn(&str, &[Value]) -> Result<Value, CaseError>) {
    let cases = format!("{}/tests/cases/common/{unit}", env!("CARGO_MANIFEST_DIR"));
    let stats = replay(cases, dispatch);
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn chat_order_sort_cases_match() {
    use chat_order_sort::*;
    run("chat-order-sort", |function, args| {
        let first = unknown(function, args.first())?;
        match function {
            "isChatOrderSortKey" => Ok(json!(is_chat_order_sort_key(&first).is_some())),
            "chatActivityTimeMs" => Ok(json!(chat_activity_time_ms(&typed(function, &first)?))),
            "chatCreationTimeMs" => Ok(json!(chat_creation_time_ms(&typed(function, &first)?))),
            "compareChatOrderNewestFirst" => {
                let key: ChatOrderSortKey = typed(function, &first)?;
                let left = unknown(function, args.get(1))?;
                let right = unknown(function, args.get(2))?;
                Ok(result(garcon_js::Number(compare_chat_order_newest_first(
                    key,
                )(
                    &typed(function, &left)?,
                    &typed(function, &right)?,
                ))))
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

#[test]
fn chat_order_contracts_cases_match() {
    use chat_order_contracts::*;
    run("chat-order-contracts", |function, args| {
        let value = unknown(function, args.first())?;
        Ok(match function {
            "parseReorderChatRequest" => result(parse_reorder_chat_request(&value)),
            "parseReorderChatResponse" => result(parse_reorder_chat_response(&value)),
            "parseSortChatOrderRequest" => result(parse_sort_chat_order_request(&value)),
            "parseSortChatOrderResponse" => result(parse_sort_chat_order_response(&value)),
            "parseSetChatPinnedRequest" => result(parse_set_chat_pinned_request(&value)),
            "parseSetChatArchivedRequest" => result(parse_set_chat_archived_request(&value)),
            "parseSetChatOrderStateResponse" => result(parse_set_chat_order_state_response(&value)),
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}
