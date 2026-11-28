use std::error::Error;

use garcon_agent_codex::app_server::{
    client::CodexAppServerRpcError,
    runtime_session_state::FinishSessionOptions,
    runtime_support::{
        denial_response_for_request, has_terminal_pending_finish, humanize_codex_app_server_error,
        is_active_session_status, is_capacity_error, is_terminal_session_status,
        is_utility_overload, merge_finish_options,
    },
};
use garcon_cases::{CaseError, replay, text, unknown};
use garcon_js::{
    Number,
    json::{Opaque, as_number},
};
use serde_json::{Value, json};

fn native_error(value: &Value) -> Box<dyn Error> {
    let message = value["message"].as_str().unwrap().to_owned();
    if let Some(code) = as_number(&value["rpcCode"]) {
        Box::new(CodexAppServerRpcError {
            message,
            code: Number(code),
            data: value.get("data").cloned().map(Opaque::from_value),
        })
    } else {
        Box::new(std::io::Error::other(message))
    }
}

#[test]
fn runtime_error_and_terminal_predicates_match_recorded_cases() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/app-server-runtime-support"
        ),
        |function, args| {
            let first = unknown(function, args.first())?;
            Ok(match function {
                "humanizeCodexAppServerError" => json!(humanize_codex_app_server_error(
                    native_error(&first).as_ref()
                )),
                "isUtilityOverload" => json!(is_utility_overload(native_error(&first).as_ref())),
                "isCapacityError" => json!(is_capacity_error(
                    (!first.is_null()).then_some(first.as_ref())
                )),
                "denialResponseForRequest" => {
                    let method = text(function, args.first())?.unwrap();
                    let params = unknown(function, args.get(1))?;
                    denial_response_for_request(
                        method,
                        (!params.is_null()).then_some(params.as_ref()),
                    )
                }
                "mergeFinishOptions" => json!(merge_finish_options(
                    serde_json::from_value(first.into_owned()).unwrap(),
                    serde_json::from_value(unknown(function, args.get(1))?.into_owned()).unwrap(),
                )),
                "hasTerminalPendingFinish" => {
                    let options: Option<FinishSessionOptions> =
                        serde_json::from_value(first.into_owned()).unwrap();
                    json!(has_terminal_pending_finish(options.as_ref()))
                }
                "isTerminalSessionStatus" => json!(is_terminal_session_status(
                    serde_json::from_value(first.into_owned()).unwrap()
                )),
                "isActiveSessionStatus" => json!(is_active_session_status(
                    serde_json::from_value(first.into_owned()).unwrap()
                )),
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}
