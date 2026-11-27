//! Reading recorded arguments for the dispatchers of the recorded unit cases
//! (ADR-020).
//!
//! A recording holds the values the original received, including what JSON
//! cannot: `undefined`, a lone surrogate, NaN. Untrusted JSON reaches the port
//! as text, so a port takes `serde_json::Value`. An argument therefore reaches
//! a dispatcher as the JSON that `JSON.stringify` writes for the recorded
//! value: `undefined` is absent, a property whose value is `undefined` is
//! left out, and `undefined` inside an array is `null`.

use std::borrow::Cow;

use garcon_cases::{CaseError, markers};
use serde_json::{Map, Value};

/// An argument as JSON, or `None` where the original received `undefined` or
/// no argument.
///
/// A number JSON cannot hold is read as the number it is when JSON has it:
/// negative zero stays negative zero. NaN and the infinities have no JSON form
/// and so can never reach a port that reads JSON; such a recorded value is
/// replayed as `0`. A function that takes a JavaScript number itself reads its
/// argument with [`javascript_number`] instead, which keeps every number.
/// An argument that holds any other marker is not handled.
pub fn round_tripped<'a>(
    function: &str,
    argument: Option<&'a Value>,
) -> Result<Option<Cow<'a, Value>>, CaseError> {
    let Some(value) = argument else {
        return Ok(None);
    };
    if markers::is_undefined(value) {
        return Ok(None);
    }
    let stripped = as_json(value);
    if markers::holds_marker(&stripped) {
        return Err(CaseError::unhandled(function));
    }
    Ok(Some(stripped))
}

fn as_json(value: &Value) -> Cow<'_, Value> {
    if markers::kind(value) == Some("number") {
        return Cow::Owned(match value["value"].as_str() {
            Some("-0") => serde_json::json!(-0.0),
            _ => serde_json::json!(0.0),
        });
    }
    match value {
        Value::Array(items) => Cow::Owned(Value::Array(
            items
                .iter()
                .map(|item| {
                    if markers::is_undefined(item) {
                        Value::Null
                    } else {
                        as_json(item).into_owned()
                    }
                })
                .collect(),
        )),
        Value::Object(entries) => {
            let mut kept = Map::new();
            for (key, item) in entries {
                if markers::is_undefined(item) {
                    continue;
                }
                kept.insert(key.clone(), as_json(item).into_owned());
            }
            Cow::Owned(Value::Object(kept))
        }
        other => Cow::Borrowed(other),
    }
}

/// An argument the original typed `unknown`, where `undefined` and `null`
/// read alike.
pub fn unknown<'a>(
    function: &str,
    argument: Option<&'a Value>,
) -> Result<Cow<'a, Value>, CaseError> {
    Ok(round_tripped(function, argument)?.unwrap_or(Cow::Borrowed(&Value::Null)))
}

/// An argument that is a string, or `None` where the original received
/// `undefined`, `null`, or no argument.
pub fn text<'a>(function: &str, argument: Option<&'a Value>) -> Result<Option<&'a str>, CaseError> {
    match round_tripped(function, argument)? {
        None => Ok(None),
        // `null` is not a string either; the dispatcher says what it means.
        Some(Cow::Borrowed(Value::Null)) => Ok(None),
        // A string has nothing to strip and is borrowed.
        Some(Cow::Borrowed(value)) => value
            .as_str()
            .map(Some)
            .ok_or_else(|| CaseError::unhandled(function)),
        Some(Cow::Owned(_)) => Err(CaseError::unhandled(function)),
    }
}

/// An argument that is a JavaScript number, also where the recording holds
/// it as a marker because JSON cannot.
pub fn javascript_number(function: &str, argument: Option<&Value>) -> Result<f64, CaseError> {
    let Some(value) = argument else {
        return Err(CaseError::unhandled(function));
    };
    if markers::kind(value) == Some("number") {
        return match value["value"].as_str() {
            Some("NaN") => Ok(f64::NAN),
            Some("Infinity") => Ok(f64::INFINITY),
            Some("-Infinity") => Ok(f64::NEG_INFINITY),
            Some("-0") => Ok(-0.0),
            _ => Err(CaseError::unhandled(function)),
        };
    }
    value.as_f64().ok_or_else(|| CaseError::unhandled(function))
}

/// An argument that is a `bigint` the recording holds as a marker.
pub fn bigint(function: &str, argument: Option<&Value>) -> Result<u64, CaseError> {
    let decimal = match argument {
        Some(value) if markers::kind(value) == Some("bigint") => value["value"].as_str(),
        _ => None,
    };
    decimal
        .and_then(|decimal| decimal.parse().ok())
        .ok_or_else(|| CaseError::unhandled(function))
}
