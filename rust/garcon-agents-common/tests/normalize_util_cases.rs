//! Replays the unit cases recorded from `server-agents/common/src/shared/normalize-util.ts`.

use garcon_agents_common::shared::normalize_util::{
    normalize_todo_items, normalize_tool_input, normalize_tool_result_content,
};
use garcon_cases::{CaseError, markers::undefined, replay, round_tripped};
use garcon_js::json::Opaque;
use serde::Serialize;
use serde_json::{Value, json};

fn undeliverable(error: impl std::fmt::Display) -> CaseError {
    CaseError::undeliverable(error.to_string())
}

// A value as it crosses the JSON boundary, where object keys follow JavaScript's order.
fn wire(value: impl Serialize) -> Result<Value, CaseError> {
    let bytes = serde_json::to_vec(&value).map_err(undeliverable)?;
    garcon_js::json::from_slice(&bytes).map_err(undeliverable)
}

fn opaque_argument(function: &str, argument: Option<&Value>) -> Result<Option<Opaque>, CaseError> {
    Ok(round_tripped(function, argument)?.map(|value| Opaque::from_value(value.into_owned())))
}

#[test]
fn recorded_normalize_util_matches() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/normalize-util"),
        |function, args| match function {
            "normalizeTodoItems" => {
                let raw = round_tripped(function, args.first())?;
                Ok(match raw {
                    None => undefined(),
                    Some(raw) => {
                        normalize_todo_items(&raw).map_or_else(undefined, |items| json!(items))
                    }
                })
            }
            "normalizeToolInput" => {
                let value = opaque_argument(function, args.first())?;
                wire(normalize_tool_input(value.as_ref()))
            }
            "normalizeToolResultContent" => {
                let value = opaque_argument(function, args.first())?;
                wire(normalize_tool_result_content(value.as_ref()))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
    assert_eq!(
        stats.total,
        include_str!("inputs/normalize-util.jsonl").lines().count()
    );
    assert_eq!(stats.with_wildcards, 0);
}
