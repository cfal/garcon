//! Replays the recordings of the `common/` modules ported in this crate
//! (ADR-020). `bun rust/parity/cli.ts unit record <module> --tests <its
//! tests> --inputs tests/inputs/common/<module>.jsonl --out tests/cases/common/<module>`
//! writes each recording, and every case must match here.

mod support;

use garcon_cases::{CaseError, Stats, markers, replay};
use garcon_contract::chat_id::{
    InvalidChatIdError, chat_id_created_at, chat_id_from_epoch_microseconds,
    chat_id_from_timestamp, legacy_chat_id_to_canonical, parse_chat_id,
};
use garcon_contract::error_codes::is_error_code;
use garcon_contract::executor_path::is_within_executor_path;
use garcon_contract::executors::{
    CreateExecutorRequest, ExecutorConnectionTarget, effective_executor_id, is_executor_id,
    is_executor_secret, is_remote_executor_id, parse_create_executor_request,
    parse_executor_connection, parse_executor_id, parse_executor_snapshot, parse_executors,
    parse_update_executor_request,
};
use garcon_contract::json::{is_record, stable_json_stringify};
use serde_json::{Map, Value, json};

use support::{bigint, javascript_number, round_tripped, text, unknown};

fn assert_all_match(module: &str, stats: Stats) {
    // A wildcard would let the port return anything for that case.
    assert_eq!(
        stats.with_wildcards, 0,
        "{module}: the recording has wildcards"
    );
    assert_eq!(stats.passed, stats.total, "{module}: recorded cases differ");
}

const INVALID_CHAT_ID: &str = "Chat ID must be a valid 16-digit Unix-microsecond timestamp";

/// The error the original throws for a value it cannot read as a chat ID: it
/// keeps that value, which JSON cannot hold when it is `undefined`.
fn invalid_chat_id(argument: Option<&Value>) -> CaseError {
    let value = argument.cloned().unwrap_or_else(markers::undefined);
    CaseError::new("InvalidChatIdError", INVALID_CHAT_ID).with_property("value", value)
}

fn chat_id_result(
    chat_id: Result<garcon_contract::chat_id::ChatId, CaseError>,
) -> Result<Value, CaseError> {
    chat_id.map(|chat_id| json!(chat_id.as_str()))
}

fn dispatch_chat_id(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "new InvalidChatIdError" => {
            // The original constructs its error for the value it was given.
            let value = round_tripped(function, args.first())?;
            let constructed = InvalidChatIdError {
                value: value.as_deref().cloned().unwrap_or(Value::Null),
            };
            Err(
                CaseError::new("InvalidChatIdError", constructed.to_string()).with_property(
                    "value",
                    args.first().cloned().unwrap_or_else(markers::undefined),
                ),
            )
        }
        "parseChatId" => {
            let value = round_tripped(function, args.first())?;
            chat_id_result(
                parse_chat_id(value.as_deref().unwrap_or(&Value::Null))
                    .map_err(|_| invalid_chat_id(args.first())),
            )
        }
        "chatIdFromEpochMicroseconds" => chat_id_result(
            chat_id_from_epoch_microseconds(bigint(function, args.first())?).map_err(|error| {
                // The value the original names here is the derived ID as text.
                CaseError::new("InvalidChatIdError", INVALID_CHAT_ID)
                    .with_property("value", error.value)
            }),
        ),
        "chatIdFromTimestamp" => {
            let epoch_ms = javascript_number(function, args.first())?;
            let micros_within_ms = javascript_number(function, args.get(1))?;
            chat_id_result(
                chat_id_from_timestamp(epoch_ms, micros_within_ms).map_err(|error| {
                    let rejected = if let Value::String(_) = error.value {
                        // The derived ID was rejected.
                        error.value
                    } else {
                        // A component was rejected, as the number it is.
                        let component = if !garcon_js::is_safe_integer(epoch_ms) || epoch_ms <= 0.0
                        {
                            epoch_ms
                        } else {
                            micros_within_ms
                        };
                        markers::number(component)
                    };
                    CaseError::new("InvalidChatIdError", INVALID_CHAT_ID)
                        .with_property("value", rejected)
                }),
            )
        }
        "chatIdCreatedAt" => match text(function, args.first())? {
            None => Err(invalid_chat_id(args.first())),
            Some(chat_id) => chat_id_created_at(chat_id)
                .map(|epoch_ms| {
                    markers::marker(
                        "date",
                        json!(
                            garcon_js::to_iso_string(epoch_ms).expect("a chat ID is a valid Date")
                        ),
                    )
                })
                .map_err(|_| invalid_chat_id(args.first())),
        },
        "legacyChatIdToCanonical" => {
            let value = round_tripped(function, args.first())?;
            legacy_chat_id_to_canonical(value.as_deref().unwrap_or(&Value::Null))
                .map(|chat_id| chat_id.map_or(Value::Null, |chat_id| json!(chat_id.as_str())))
                .map_err(|error| {
                    CaseError::new("InvalidChatIdError", INVALID_CHAT_ID)
                        .with_property("value", error.value)
                })
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn chat_id_cases_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/chat-id"),
        dispatch_chat_id,
    );
    assert_all_match("common/chat-id.ts", stats);
}

/// A request to create an executor as the original builds it: `noTls` and
/// `allowUnverifiedTls` are always present, as `undefined` when left out.
fn create_request_as_recorded(request: &CreateExecutorRequest) -> Value {
    let present = |value: Option<bool>| value.map_or_else(markers::undefined, |value| json!(value));
    let mut recorded = Map::new();
    recorded.insert("label".to_owned(), json!(request.label));
    if let Some(value) = request.allow_executor_management {
        recorded.insert("allowExecutorManagement".to_owned(), json!(value));
    }
    if let Some(value) = request.allow_controller_cli {
        recorded.insert("allowControllerCli".to_owned(), json!(value));
    }
    recorded.insert("noTls".to_owned(), present(request.no_tls));
    recorded.insert(
        "allowUnverifiedTls".to_owned(),
        present(request.allow_unverified_tls),
    );
    match &request.target {
        ExecutorConnectionTarget::ExecutorConnects { advertised_url } => {
            recorded.insert("direction".to_owned(), json!("executor-connects"));
            if let Some(advertised_url) = advertised_url {
                recorded.insert("advertisedUrl".to_owned(), json!(advertised_url));
            }
        }
        ExecutorConnectionTarget::ControllerConnects { connection_url } => {
            recorded.insert("direction".to_owned(), json!("controller-connects"));
            recorded.insert("connectionUrl".to_owned(), json!(connection_url));
        }
    }
    Value::Object(recorded)
}

fn as_json_value<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("a contract type serializes")
}

fn dispatch_executors(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "effectiveExecutorId" => Ok(json!(effective_executor_id(text(function, args.first())?))),
        "isRemoteExecutorId" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_remote_executor_id(&value)))
        }
        "isExecutorSecret" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_executor_secret(&value)))
        }
        "isExecutorId" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_executor_id(&value)))
        }
        "parseExecutorId" => {
            let value = unknown(function, args.first())?;
            Ok(parse_executor_id(&value).map_or(Value::Null, |id| json!(id)))
        }
        "parseCreateExecutorRequest" => {
            let value = round_tripped(function, args.first())?;
            Ok(
                parse_create_executor_request(value.as_deref().unwrap_or(&Value::Null))
                    .map_or(Value::Null, |request| create_request_as_recorded(&request)),
            )
        }
        "parseUpdateExecutorRequest" => {
            let value = round_tripped(function, args.first())?;
            Ok(
                parse_update_executor_request(value.as_deref().unwrap_or(&Value::Null))
                    .map_or(Value::Null, as_json_value),
            )
        }
        "parseExecutorSnapshot" => {
            let value = round_tripped(function, args.first())?;
            Ok(
                parse_executor_snapshot(value.as_deref().unwrap_or(&Value::Null))
                    .map_or(Value::Null, as_json_value),
            )
        }
        "parseExecutors" => {
            let value = round_tripped(function, args.first())?;
            Ok(parse_executors(value.as_deref().unwrap_or(&Value::Null))
                .map_or(Value::Null, as_json_value))
        }
        "parseExecutorConnection" => {
            let value = round_tripped(function, args.first())?;
            Ok(
                parse_executor_connection(value.as_deref().unwrap_or(&Value::Null))
                    .map_or(Value::Null, as_json_value),
            )
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn executors_cases_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/executors"),
        dispatch_executors,
    );
    assert_all_match("common/executors.ts", stats);
}

fn dispatch_json(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "isRecord" => {
            let value = round_tripped(function, args.first())?;
            Ok(json!(is_record(value.as_deref().unwrap_or(&Value::Null))))
        }
        "stableJsonStringify" => {
            let value = round_tripped(function, args.first())?;
            let value = value.ok_or_else(|| CaseError::unhandled(function))?;
            Ok(json!(stable_json_stringify(&value)))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn json_cases_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/json"),
        dispatch_json,
    );
    assert_all_match("common/json.ts", stats);
}

#[test]
fn error_codes_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/error-codes"
        ),
        |function, args| match function {
            "isErrorCode" => {
                let value = unknown(function, args.first())?;
                Ok(json!(is_error_code(&value).is_some()))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
    assert_all_match("common/error-codes.ts", stats);
}

#[test]
fn executor_path_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/executor-path"
        ),
        |function, args| match function {
            "isWithinExecutorPath" => {
                let root = text(function, args.first())?;
                let candidate = text(function, args.get(1))?;
                match (root, candidate) {
                    (Some(root), Some(candidate)) => {
                        Ok(json!(is_within_executor_path(root, candidate)))
                    }
                    _ => Err(CaseError::unhandled(function)),
                }
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
    assert_all_match("common/executor-path.ts", stats);
}
