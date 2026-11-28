//! Replays cases from `server-agents/common/src/chats/artificial-native-path.ts`.

use garcon_agents_common::chats::artificial_native_path::{
    create_artificial_native_path, get_artificial_agent_session_id, is_artificial_native_path,
    parse_artificial_native_path,
};
use garcon_cases::{CaseError, replay, round_tripped, text};
use serde_json::{Value, json};

// A `string | readonly string[]` argument, as the ids it names.
fn string_or_strings(function: &str, argument: Option<&Value>) -> Result<Vec<String>, CaseError> {
    let value = round_tripped(function, argument)?
        .ok_or_else(|| CaseError::undeliverable("expected agent ids"))?;
    let string = |value: &Value| {
        value
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| CaseError::undeliverable("expected a string"))
    };
    match &*value {
        Value::Array(items) => items.iter().map(&string).collect(),
        value => Ok(vec![string(value)?]),
    }
}

#[test]
fn recorded_artificial_native_path_matches() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/artificial-native-path"
        ),
        |function, args| match function {
            "createArtificialNativePath" => Ok(json!(create_artificial_native_path(
                text(function, args.first())?,
                text(function, args.get(1))?,
            ))),
            "isArtificialNativePath"
            | "parseArtificialNativePath"
            | "getArtificialAgentSessionId" => {
                let value = round_tripped(function, args.first())?;
                let value: &Value = value.as_deref().unwrap_or(&Value::Null);
                match function {
                    "isArtificialNativePath" => Ok(json!(is_artificial_native_path(value))),
                    "parseArtificialNativePath" => Ok(parse_artificial_native_path(value)
                        .map_or(Value::Null, |parts| json!(parts))),
                    _ => {
                        let agent_ids = string_or_strings(function, args.get(1))?;
                        Ok(json!(get_artificial_agent_session_id(
                            value,
                            agent_ids.iter().map(String::as_str),
                        )))
                    }
                }
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
    assert_eq!(
        stats.total,
        include_str!("inputs/artificial-native-path.jsonl")
            .lines()
            .count()
    );
    assert_eq!(stats.with_wildcards, 0);
}
