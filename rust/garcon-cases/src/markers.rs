//! The markers of `rust/parity/src/unit/encode.ts`: how a recording writes
//! the values JSON cannot hold. A marker is an object whose `$` key names the
//! kind; a plain object that has a `$` property is wrapped in an `object`
//! marker, so the two are never confused.
//!
//! Arguments reach a dispatcher as recorded. An argument that is JSON, with
//! `undefined` and negative zero, is read with the readers of
//! [`crate::arguments`]; one that holds a marker a port decodes itself with
//! [`kind`] and [`is_undefined`]. A result that holds such a value is built
//! with the constructors here, so that the comparison sees the recording's
//! form.

use serde_json::{Value, json};

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

/// A marker whose content is one value, such as a `date` (its ISO string),
/// `bytes` (base64), `bigint` (decimal), `map` (an array of key-value pairs),
/// or `set` (an array).
pub fn marker(kind: &str, value: Value) -> Value {
    json!({ MARKER: kind, "value": value })
}

/// A JavaScript string with lone surrogates, preserving every UTF-16 unit.
pub fn utf16(units: &[u16]) -> Value {
    json!({ MARKER: "utf16", "value": units, "text": String::from_utf16_lossy(units) })
}

pub(crate) fn utf16_projection(value: &Value) -> Option<&Value> {
    if kind(value) != Some("utf16") {
        return None;
    }
    let units: Vec<u16> = value
        .get("value")?
        .as_array()?
        .iter()
        .map(|unit| u16::try_from(unit.as_u64()?).ok())
        .collect::<Option<_>>()?;
    let text = value.get("text")?;
    (text.as_str()? == String::from_utf16_lossy(&units)).then_some(text)
}

/// A returned JavaScript class instance, as recorded with `--instances`.
/// `fields` holds its encoded enumerable own properties, including markers
/// for `undefined` and for any nested instances.
pub fn instance(name: &str, fields: serde_json::Map<String, Value>) -> Value {
    json!({ MARKER: "instance", "name": name, "fields": object_fields(fields) })
}

pub(crate) fn object_fields(fields: serde_json::Map<String, Value>) -> Value {
    if fields.contains_key(MARKER) {
        marker("object", Value::Object(fields))
    } else {
        Value::Object(fields)
    }
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

    #[test]
    fn instance_markers_keep_the_class_name_and_encoded_own_fields() {
        let encoded = instance(
            "Reply",
            serde_json::Map::from_iter([
                ("$".to_owned(), json!("data")),
                ("field".to_owned(), undefined()),
            ]),
        );
        assert_eq!(
            encoded,
            json!({
                "$": "instance", "name": "Reply",
                "fields": {"$": "object", "value": {"$": "data", "field": {"$": "undefined"}}},
            })
        );
    }
}
