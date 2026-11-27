//! The markers of `rust/parity/src/unit/encode.ts`: how a recording writes
//! the values JSON cannot hold. A marker is an object whose `$` key names the
//! kind; a plain object that has a `$` property is wrapped in an `object`
//! marker, so the two are never confused.
//!
//! Arguments reach a dispatcher as recorded, so a port reads markers with
//! [`kind`] and [`is_undefined`], or takes the whole argument through
//! [`json_argument`]. A result that holds such a value is built with the
//! constructors here, so that the comparison sees the recording's form.

use serde_json::{Value, json};

use crate::CaseError;

const MARKER: &str = "$";

/// The kind of a marker, or `None` for a value that is not one.
pub fn kind(value: &Value) -> Option<&str> {
    value.as_object()?.get(MARKER)?.as_str()
}

pub fn is_undefined(value: &Value) -> bool {
    kind(value) == Some("undefined")
}

/// Whether a value is or holds a marker.
pub fn holds_marker(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(holds_marker),
        Value::Object(_) => {
            kind(value).is_some()
                || value
                    .as_object()
                    .is_some_and(|entries| entries.values().any(holds_marker))
        }
        _ => false,
    }
}

/// An argument for a port whose function takes a value that is JSON or
/// `undefined`: `None` where the original received `undefined` (or no
/// argument), otherwise the value as recorded. An argument that holds any
/// other marker is a value JSON cannot hold, which the port must decode itself
/// with [`kind`]; such an argument is not handled.
pub fn json_argument<'a>(
    function: &str,
    argument: Option<&'a Value>,
) -> Result<Option<&'a Value>, CaseError> {
    let Some(value) = argument else {
        return Ok(None);
    };
    if is_undefined(value) {
        return Ok(None);
    }
    if holds_marker(value) {
        return Err(CaseError::unhandled(function));
    }
    Ok(Some(value))
}

/// A marker whose content is one value, such as a `date` (its ISO string),
/// `bytes` (base64), `bigint` (decimal), `map` (an array of key-value pairs),
/// or `set` (an array).
pub fn marker(kind: &str, value: Value) -> Value {
    json!({ MARKER: kind, "value": value })
}

/// A JavaScript number as a recording holds it. NaN, the infinities, and
/// negative zero have no JSON form and become a `number` marker.
pub fn number(value: f64) -> Value {
    match value {
        f if f.is_nan() => marker("number", json!("NaN")),
        f if f == f64::INFINITY => marker("number", json!("Infinity")),
        f if f == f64::NEG_INFINITY => marker("number", json!("-Infinity")),
        f if f == 0.0 && f.is_sign_negative() => marker("number", json!("-0")),
        f => json!(f),
    }
}

pub fn undefined() -> Value {
    json!({ MARKER: "undefined" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_markers_and_keeps_plain_objects_apart() {
        assert_eq!(
            kind(&json!({ "$": "date", "value": "2026-11-27T00:00:00.000Z" })),
            Some("date")
        );
        assert_eq!(kind(&json!({ "label": "Worker" })), None);
        assert_eq!(kind(&json!({ "$": 5 })), None);
        assert!(is_undefined(&undefined()));
        assert!(!is_undefined(&Value::Null));
        assert!(holds_marker(&json!({ "a": [1, { "b": undefined() }] })));
        assert!(!holds_marker(&json!({ "a": [1, { "b": null }] })));
    }

    #[test]
    fn a_json_argument_is_undefined_or_plain() {
        let plain = json!({ "a": [1, null] });
        assert_eq!(json_argument("f", Some(&plain)), Ok(Some(&plain)));
        let undefined = undefined();
        assert_eq!(json_argument("f", Some(&undefined)), Ok(None));
        assert_eq!(json_argument("f", None), Ok(None));
        // `null` is a value, apart from `undefined`.
        assert_eq!(
            json_argument("f", Some(&Value::Null)),
            Ok(Some(&Value::Null))
        );
        assert_eq!(
            json_argument(
                "f",
                Some(&json!({ "a": marker("date", json!("2026-11-27T00:00:00.000Z")) }))
            ),
            Err(CaseError::unhandled("f"))
        );
    }

    #[test]
    fn numbers_without_a_json_form_are_markers() {
        assert_eq!(number(f64::NAN), json!({ "$": "number", "value": "NaN" }));
        assert_eq!(
            number(f64::INFINITY),
            json!({ "$": "number", "value": "Infinity" })
        );
        assert_eq!(
            number(f64::NEG_INFINITY),
            json!({ "$": "number", "value": "-Infinity" })
        );
        assert_eq!(number(-0.0), json!({ "$": "number", "value": "-0" }));
        for value in [0.0, 1e21, -1.0, 0.5] {
            assert_eq!(number(value).as_f64(), Some(value));
        }
    }
}
