//! Replays the unit cases recorded from `server-agents/common/src/lib/jsonl.ts`.

use garcon_agents_common::jsonl::{JsonlLineResult, parse_first_jsonl_value};
use garcon_cases::{CaseError, replay, text};
use serde::Serialize;
use serde_json::{Map, Value, json};

fn undeliverable(error: impl std::fmt::Display) -> CaseError {
    CaseError::undeliverable(error.to_string())
}

// A value as it crosses the JSON boundary, where object keys follow JavaScript's order.
fn wire(value: impl Serialize) -> Result<Value, CaseError> {
    let bytes = serde_json::to_vec(&value).map_err(undeliverable)?;
    garcon_js::json::from_slice(&bytes).map_err(undeliverable)
}

#[test]
fn recorded_jsonl_matches() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/jsonl"),
        |function, args| {
            if function != "parseFirstJsonlValue" {
                return Err(CaseError::unhandled(function));
            }
            let line =
                text(function, args.first())?.ok_or_else(|| undeliverable("expected a line"))?;
            Ok(match parse_first_jsonl_value(line) {
                JsonlLineResult::Empty => json!({ "kind": "empty" }),
                JsonlLineResult::Incomplete => json!({ "kind": "incomplete" }),
                JsonlLineResult::Invalid { error } => json!({
                    "kind": "invalid",
                    "error": {
                        "$": "error",
                        "name": error.name,
                        "message": error.message,
                        "properties": {},
                    },
                }),
                JsonlLineResult::Value {
                    value,
                    raw,
                    discarded_suffix,
                } => {
                    let mut result = Map::new();
                    result.insert("kind".to_owned(), json!("value"));
                    result.insert("value".to_owned(), wire(&value)?);
                    result.insert("raw".to_owned(), Value::String(raw));
                    result.insert("discardedSuffix".to_owned(), Value::Bool(discarded_suffix));
                    Value::Object(result)
                }
            })
        },
    );
    assert!(stats.total >= include_str!("inputs/jsonl.jsonl").lines().count());
    assert_eq!(stats.with_wildcards, 0);
}
