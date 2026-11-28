//! Replays cases from `server-agents/common/src/lib/errors.ts`.

use garcon_agents_common::errors::{error_message, has_node_error_code};
use garcon_base::errors::ErrorInput;
use garcon_cases::{CaseError, replay, round_tripped, text};
use serde_json::json;

#[test]
fn recorded_lib_errors_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/lib-errors"),
        |function, args| {
            let value = round_tripped(function, args.first())?;
            match function {
                "errorMessage" => Ok(json!(match &value {
                    None => error_message(ErrorInput::Undefined),
                    Some(value) => error_message(ErrorInput::Json(value)),
                })),
                "hasNodeErrorCode" => {
                    let code = text(function, args.get(1))?
                        .ok_or_else(|| CaseError::undeliverable("expected an error code"))?;
                    Ok(json!(match &value {
                        None => has_node_error_code(ErrorInput::Undefined, code),
                        Some(value) => has_node_error_code(ErrorInput::Json(value), code),
                    }))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
