//! Replays the unit cases recorded from `server-agents/common/src/acp/`.

use std::borrow::Cow;
use std::error::Error;
use std::rc::Rc;

use garcon_agents_common::acp::{
    errors::{
        AcpRpcError, is_invalid_params_error, is_method_not_found_error,
        is_recoverable_load_failure, is_session_not_found_error,
    },
    event_converter::{acp_content_text, as_object, as_string, evict_oldest_tool_entry},
    in_band_failure::{AcpInBandFailure, AcpSplitChunk, acp_output_update_type},
    protocol::{garcon_initialize_params, is_json_rpc_id},
};
use garcon_base::errors::{ErrorInput, NamedError, error_metadata, js_string};
use garcon_cases::{CaseError, markers, replay, round_tripped, unknown};
use garcon_js::utf16;
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use serde_json::{Value, json};

/// A typed result as it crosses the JSON boundary, in the order the port writes it.
fn wire(value: impl Serialize) -> Result<Value, CaseError> {
    let bytes =
        serde_json::to_vec(&value).map_err(|error| CaseError::undeliverable(error.to_string()))?;
    garcon_js::json::from_slice(&bytes).map_err(|error| CaseError::undeliverable(error.to_string()))
}

/// The error the port threw, in the recording's form.
fn thrown(error: &(dyn Error + 'static)) -> CaseError {
    let metadata = error_metadata(error);
    CaseError::new(metadata.name, error.to_string())
}

/// A recorded argument the original received as a value or as `undefined`.
fn optional(function: &str, argument: Option<&Value>) -> Result<Option<Value>, CaseError> {
    Ok(round_tripped(function, argument)?.map(Cow::into_owned))
}

/// A result in the recording's form: an object with a `$` key of its own is
/// wrapped, so that it is never read as a marker.
fn recorded(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(recorded).collect()),
        Value::Object(entries) => {
            let entries: garcon_contract::json::JsonObject = entries
                .iter()
                .map(|(key, item)| (key.clone(), recorded(item)))
                .collect();
            if entries.contains_key("$") {
                markers::marker("object", Value::Object(entries))
            } else {
                Value::Object(entries)
            }
        }
        other => other.clone(),
    }
}

/// The splitter of the recording: a `marker` reports what follows its first
/// occurrence as the failure, and `null` publishes every chunk as text.
fn splitter(marker: Option<String>) -> Rc<dyn Fn(&str) -> AcpSplitChunk> {
    Rc::new(move |chunk| {
        let Some(marker) = &marker else {
            return AcpSplitChunk {
                text: chunk.to_owned(),
                failure: None,
            };
        };
        match utf16::index_of(chunk, marker) {
            None => AcpSplitChunk {
                text: chunk.to_owned(),
                failure: None,
            },
            Some(at) => AcpSplitChunk {
                text: utf16::slice(chunk, 0, Some(at as isize)).to_owned(),
                failure: Some(
                    utf16::slice(chunk, at as isize + utf16::len(marker) as isize, None).to_owned(),
                ),
            },
        }
    })
}

fn strings(function: &str, argument: Option<&Value>) -> Result<Vec<String>, CaseError> {
    let items = unknown(function, argument)?;
    items
        .as_array()
        .ok_or_else(|| CaseError::undeliverable("expected a list of strings"))?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| CaseError::undeliverable("expected a string"))
        })
        .collect()
}

fn protocol(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "isJsonRpcId" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_json_rpc_id(value.as_ref())))
        }
        "garconInitializeParams" => {
            let options = round_tripped(function, args.first())?;
            garcon_initialize_params(options.as_deref())
                .map_or_else(|error| Err(thrown(error.as_ref())), wire)
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

fn rpc_error(function: &str, args: &[Value]) -> Result<AcpRpcError, CaseError> {
    Ok(AcpRpcError::new(
        optional(function, args.first())?.as_ref(),
        optional(function, args.get(1))?,
        optional(function, args.get(2))?,
    ))
}

/// An error the original received that is not an `AcpRpcError`: the recorded
/// `Error`, or a stand-in for a thrown value that is no error at all.
fn other_error(argument: Option<&Value>) -> Result<Box<dyn Error>, CaseError> {
    let stand_in = || {
        let text = match argument {
            None => "undefined".to_owned(),
            Some(value) if markers::is_undefined(value) => "undefined".to_owned(),
            Some(value) => js_string(ErrorInput::Json(value)).into_owned(),
        };
        NamedError {
            name: "Error".to_owned(),
            message: text,
            code: None,
        }
    };
    let Some(value) = argument.filter(|value| markers::kind(value) == Some("error")) else {
        return Ok(stand_in().into());
    };
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| CaseError::undeliverable(format!("expected text {key}")))
    };
    Ok(NamedError {
        name: text("name")?,
        message: text("message")?,
        code: None,
    }
    .into())
}

fn errors(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    if function == "isRecoverableLoadFailureOfOther" {
        let other = other_error(args.first())?;
        return Ok(json!(is_recoverable_load_failure(other.as_ref())));
    }
    let predicate: fn(&(dyn Error + 'static)) -> bool = match function {
        "isMethodNotFoundError" => is_method_not_found_error,
        "isInvalidParamsError" => is_invalid_params_error,
        "isSessionNotFoundError" => is_session_not_found_error,
        "isRecoverableLoadFailure" => is_recoverable_load_failure,
        _ => return Err(CaseError::unhandled(function)),
    };
    let error = rpc_error(function, args)?;
    Ok(json!(predicate(&error)))
}

fn event_converter(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let value = unknown(function, args.first())?;
    match function {
        "asObject" => Ok(recorded(&Value::Object(as_object(&value).clone()))),
        "asString" => Ok(as_string(&value).map_or_else(markers::undefined, |text| json!(text))),
        "acpContentText" => Ok(json!(acp_content_text(&value))),
        "evictOldest" => {
            let items = value
                .as_array()
                .ok_or_else(|| CaseError::undeliverable("expected a list of entries"))?;
            let text_at = |pair: &Value, index: usize| {
                pair.get(index)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| CaseError::undeliverable("expected a string key"))
            };
            if items.first().is_some_and(Value::is_array) {
                let mut entries: IndexMap<String, Value> = IndexMap::new();
                for pair in items {
                    entries.insert(
                        text_at(pair, 0)?,
                        pair.get(1).cloned().unwrap_or(Value::Null),
                    );
                }
                evict_oldest_tool_entry(&mut entries);
                Ok(json!(entries.keys().cloned().collect::<Vec<_>>()))
            } else {
                let mut entries: IndexSet<String> = IndexSet::new();
                for item in items {
                    entries.insert(
                        item.as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| CaseError::undeliverable("expected a string key"))?,
                    );
                }
                evict_oldest_tool_entry(&mut entries);
                Ok(json!(entries.iter().collect::<Vec<_>>()))
            }
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

fn in_band_failure(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "acpOutputUpdateType" => {
            let update = unknown(function, args.first())?;
            let update = update
                .as_object()
                .ok_or_else(|| CaseError::undeliverable("expected an update object"))?;
            let known = strings(function, args.get(1))?;
            let update_type = acp_output_update_type(update, |tool_call_id| {
                known.iter().any(|known| known == tool_call_id)
            });
            Ok(update_type.map_or_else(markers::undefined, |update_type| json!(update_type)))
        }
        "inBandFailure" => {
            let marker = match round_tripped(function, args.first())?.as_deref() {
                None | Some(Value::Null) => None,
                Some(Value::String(marker)) => Some(marker.clone()),
                Some(_) => {
                    return Err(CaseError::undeliverable("expected a marker or null"));
                }
            };
            let calls = unknown(function, args.get(1))?;
            let calls = calls
                .as_array()
                .ok_or_else(|| CaseError::undeliverable("expected a list of calls"))?;
            let mut failure = AcpInBandFailure::new(splitter(marker));
            let mut answers = Vec::with_capacity(calls.len());
            for call in calls {
                if let Some(chunk) = call.get("offer").and_then(Value::as_str) {
                    answers.push(json!(failure.offer(chunk)));
                } else if let Some(update_type) = call.get("continueOn") {
                    answers.push(json!(failure.continue_on(update_type.as_str())));
                } else if call.get("take").is_some() {
                    answers.push(json!(failure.take()));
                } else {
                    failure.reset();
                    answers.push(Value::Null);
                }
            }
            Ok(Value::Array(answers))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

const CASES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases");

#[test]
fn recorded_acp_protocol_cases_match() {
    let stats = replay(format!("{CASES}/acp-protocol"), protocol);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn recorded_acp_error_cases_match() {
    let stats = replay(format!("{CASES}/acp-errors"), errors);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn recorded_acp_event_converter_cases_match() {
    let stats = replay(format!("{CASES}/acp-event-converter"), event_converter);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn recorded_acp_in_band_failure_cases_match() {
    let stats = replay(format!("{CASES}/acp-in-band-failure"), in_band_failure);
    assert_eq!(stats.with_wildcards, 0);
}
