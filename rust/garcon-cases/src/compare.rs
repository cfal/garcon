//! Structural comparison of a recorded result with a port's result, with the
//! rules of `rust/parity/src/wildcard.ts`: object key order is not compared,
//! and a string that contains `[..]` matches any run of characters in place
//! of it, while a string that is exactly `[..]` matches any value.

use serde_json::{Map, Number, Value};

use crate::markers;

const WILDCARD: &str = "[..]";
const DESCRIBED_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Difference {
    pub path: String,
    pub kind: &'static str,
    pub expected: String,
    pub actual: String,
}

impl Difference {
    fn new(path: &str, kind: &'static str, expected: &Value, actual: &Value) -> Self {
        Self {
            path: path.to_owned(),
            kind,
            expected: describe(expected),
            actual: describe(actual),
        }
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn describe(value: &Value) -> String {
    let text = value.to_string();
    if text.chars().count() > DESCRIBED_CHARS {
        format!(
            "{}...",
            text.chars().take(DESCRIBED_CHARS - 3).collect::<String>()
        )
    } else {
        text
    }
}

fn is_identifier(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars.all(|next| next.is_ascii_alphanumeric() || next == '_' || next == '$')
}

fn child_path(path: &str, key: &str) -> String {
    if is_identifier(key) {
        format!("{path}.{key}")
    } else {
        format!("{path}[{key:?}]")
    }
}

fn array_path(path: &str, index: usize) -> String {
    format!("{path}[{index}]")
}

fn is_negative_zero(number: &Number) -> bool {
    number
        .as_f64()
        .is_some_and(|value| value == 0.0 && value.is_sign_negative())
}

fn wildcard_matches(pattern: &str, actual: &str) -> bool {
    if !pattern.contains(WILDCARD) {
        return pattern == actual;
    }
    let mut parts = pattern.split(WILDCARD);
    let head = parts.next().unwrap_or_default();
    let Some(mut rest) = actual.strip_prefix(head) else {
        return false;
    };
    let mut middle: Vec<&str> = parts.collect();
    let tail = if pattern.ends_with(WILDCARD) {
        ""
    } else {
        middle.pop().unwrap_or_default()
    };
    for part in middle {
        let Some(at) = rest.find(part) else {
            return false;
        };
        rest = &rest[at + part.len()..];
    }
    rest.ends_with(tail)
}

/// Every position where a recording has a wildcard, as JSON paths.
pub fn wildcard_paths(value: &Value, path: &str) -> Vec<String> {
    match value {
        Value::String(text) if text.contains(WILDCARD) => vec![path.to_owned()],
        Value::Array(items) => items
            .iter()
            .enumerate()
            .flat_map(|(index, item)| wildcard_paths(item, &array_path(path, index)))
            .collect(),
        Value::Object(entries) => {
            let mut keys: Vec<&String> = entries.keys().collect();
            keys.sort();
            keys.into_iter()
                .flat_map(|key| wildcard_paths(&entries[key], &child_path(path, key)))
                .collect()
        }
        _ => Vec::new(),
    }
}

/// The first position where `actual` departs from `expected`, walking object
/// keys in sorted order so reports are stable.
pub fn first_difference(expected: &Value, actual: &Value) -> Option<Difference> {
    difference(expected, actual, "$")
}

fn difference(expected: &Value, actual: &Value, path: &str) -> Option<Difference> {
    if expected.as_str() == Some(WILDCARD) {
        return None;
    }
    // A port's negative zero is the recording's `-0` marker.
    let negative_zero = markers::number(-0.0);
    let actual = if matches!(actual, Value::Number(number) if is_negative_zero(number)) {
        &negative_zero
    } else {
        actual
    };
    if type_name(expected) != type_name(actual) {
        return Some(Difference::new(path, "type", expected, actual));
    }
    match (expected, actual) {
        (Value::String(pattern), Value::String(text)) => (!wildcard_matches(pattern, text))
            .then(|| Difference::new(path, "value", expected, actual)),
        (Value::Number(left), Value::Number(right)) => (left.as_f64() != right.as_f64())
            .then(|| Difference::new(path, "value", expected, actual)),
        (Value::Array(items), Value::Array(others)) => {
            if items.len() != others.len() {
                return Some(Difference {
                    path: path.to_owned(),
                    kind: "length",
                    expected: format!("{} items", items.len()),
                    actual: format!("{} items: {}", others.len(), describe(actual)),
                });
            }
            items
                .iter()
                .zip(others)
                .enumerate()
                .find_map(|(index, (item, other))| {
                    difference(item, other, &array_path(path, index))
                })
        }
        (Value::Object(entries), Value::Object(others)) => object_difference(entries, others, path),
        _ => (expected != actual).then(|| Difference::new(path, "value", expected, actual)),
    }
}

fn object_difference(
    entries: &Map<String, Value>,
    others: &Map<String, Value>,
    path: &str,
) -> Option<Difference> {
    let mut keys: Vec<&String> = entries.keys().chain(others.keys()).collect();
    keys.sort();
    keys.dedup();
    keys.into_iter()
        .find_map(|key| match (entries.get(key), others.get(key)) {
            (Some(expected), Some(actual)) => difference(expected, actual, &child_path(path, key)),
            (Some(expected), None) => Some(Difference {
                path: child_path(path, key),
                kind: "missing",
                expected: describe(expected),
                actual: "(absent)".to_owned(),
            }),
            (None, Some(actual)) => Some(Difference {
                path: child_path(path, key),
                kind: "extra",
                expected: "(absent)".to_owned(),
                actual: describe(actual),
            }),
            (None, None) => None,
        })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn difference(expected: Value, actual: Value) -> Option<Difference> {
        first_difference(&expected, &actual)
    }

    // The difference between two values that differ.
    fn found(expected: Value, actual: Value) -> Difference {
        first_difference(&expected, &actual).expect("the values differ")
    }

    #[test]
    fn ignores_object_key_order_and_compares_arrays_in_order() {
        assert_eq!(
            difference(
                json!({ "b": 1, "a": [1, { "c": true }] }),
                json!({ "a": [1, { "c": true }], "b": 1 })
            ),
            None
        );
        let swapped = difference(json!([1, 2]), json!([2, 1])).expect("ordered arrays differ");
        assert_eq!((swapped.path.as_str(), swapped.kind), ("$[0]", "value"));
        assert_eq!(found(json!([1, 2]), json!([1])).kind, "length");
    }

    #[test]
    fn reports_type_missing_and_extra_by_path() {
        assert_eq!(found(json!({ "a": "1" }), json!({ "a": 1 })).kind, "type");
        let missing =
            difference(json!({ "a": { "b": 1 } }), json!({ "a": {} })).expect("missing key");
        assert_eq!(
            (missing.path.as_str(), missing.kind, missing.actual.as_str()),
            ("$.a.b", "missing", "(absent)")
        );
        let extra =
            difference(json!({ "a": 1 }), json!({ "a": 1, "odd key": 2 })).expect("extra key");
        assert_eq!(
            (extra.path.as_str(), extra.kind),
            ("$[\"odd key\"]", "extra")
        );
        assert_eq!(found(json!(null), json!(0)).kind, "type");
    }

    #[test]
    fn compares_numbers_by_value_apart_from_negative_zero() {
        assert_eq!(difference(json!(1), json!(1.0)), None);
        assert_eq!(
            difference(json!({ "$": "number", "value": "-0" }), json!(-0.0)),
            None
        );
        assert_eq!(found(json!(0), json!(-0.0)).kind, "type");
        assert_eq!(
            difference(
                json!({ "a": [0, { "$": "number", "value": "-0" }] }),
                json!({ "a": [0.0, -0.0] })
            ),
            None
        );
        assert_eq!(difference(json!(-1), json!(-1.0)), None);
    }

    #[test]
    fn markers_match_only_the_same_marker() {
        let undefined = json!({ "$": "undefined" });
        assert_eq!(difference(undefined.clone(), undefined.clone()), None);
        assert_eq!(found(undefined, Value::Null).kind, "type");
        let error = json!({ "$": "error", "name": "Error", "message": "bad", "properties": { "code": "E" } });
        assert_eq!(difference(error.clone(), error.clone()), None);
        assert_eq!(
            found(
                error,
                json!({ "$": "error", "name": "Error", "message": "bad", "properties": {} })
            )
            .path,
            "$.properties.code",
        );
    }

    #[test]
    fn wildcards_match_what_the_recording_left_open() {
        assert_eq!(difference(json!("[..]"), json!({ "anything": [1] })), None);
        assert_eq!(difference(json!("a.[..](b)"), json!("a.anything(b)")), None);
        assert_eq!(
            found(json!("a.[..](b)"), json!("aXanything(b)")).kind,
            "value"
        );
        assert_eq!(
            difference(
                json!({ "id": "chat-[..]", "keep": true }),
                json!({ "id": "chat-x", "keep": true })
            ),
            None
        );
        assert_eq!(difference(json!("[..] tail"), json!("head tail")), None);
        assert_eq!(found(json!("[..] tail"), json!("tail head")).kind, "value");
        let paths = wildcard_paths(
            &json!({ "id": "[..]", "rows": ["x [..] y", 1], "plain": "text" }),
            "$",
        );
        assert_eq!(paths, ["$.id", "$.rows[0]"]);
    }
}
