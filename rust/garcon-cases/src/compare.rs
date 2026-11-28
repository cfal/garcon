//! Structural comparison of a recorded result with a port's result, with the
//! rules of `rust/parity/src/wildcard.ts`: a string that contains `[..]`
//! matches any run of characters in place
//! of it, while a string that is exactly `[..]` matches any value. Where both
//! recording runs varied the same way, a wildcard is written with its shape:
//! `[..hex:44]` matches exactly 44 lowercase hexadecimal characters.

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

fn integer(number: &Number) -> Option<i128> {
    number
        .as_i64()
        .map(i128::from)
        .or_else(|| number.as_u64().map(i128::from))
}

fn float_equals_integer(float: &Number, integer: i128) -> bool {
    // All serde_json integers fit in i128; an out-of-range float saturates
    // past every integer this comparison can receive.
    float
        .as_f64()
        .is_some_and(|value| value.fract() == 0.0 && value as i128 == integer)
}

fn numbers_equal(left: &Number, right: &Number) -> bool {
    match (integer(left), integer(right)) {
        (Some(a), Some(b)) => a == b,
        (Some(a), None) => float_equals_integer(right, a),
        (None, Some(b)) => float_equals_integer(left, b),
        (None, None) => left.as_f64() == right.as_f64(),
    }
}

/// One piece of a pattern: a literal text, a wildcard that takes any run of
/// characters, or one that takes exactly `length` characters of an alphabet.
enum Part<'a> {
    Literal(&'a str),
    Any,
    Shaped {
        alphabet: fn(char) -> bool,
        length: usize,
    },
}

fn alphabet(name: &str) -> Option<fn(char) -> bool> {
    match name {
        "digits" => Some(|character: char| character.is_ascii_digit()),
        "hex" => {
            Some(|character: char| character.is_ascii_digit() || ('a'..='f').contains(&character))
        }
        "HEX" => {
            Some(|character: char| character.is_ascii_digit() || ('A'..='F').contains(&character))
        }
        "base64url" => Some(|character: char| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        }),
        _ => None,
    }
}

// The wildcard at the start of `text`, if `text` starts with one: `[..]`, or
// `[..<alphabet>:<length>]`, followed by the rest of the text. Anything else
// between the brackets is not a wildcard and stays literal.
fn wildcard_at<'a>(text: &'a str) -> Option<(Part<'a>, &'a str)> {
    let inner = text.strip_prefix("[..")?;
    let end = inner.find(']')?;
    let part = match &inner[..end] {
        "" => Part::Any,
        shaped => {
            let (name, digits) = shaped.split_once(':')?;
            Part::Shaped {
                alphabet: alphabet(name)?,
                length: digits.parse().ok()?,
            }
        }
    };
    Some((part, &inner[end + 1..]))
}

fn has_wildcard(value: &str) -> bool {
    value
        .match_indices("[..")
        .any(|(at, _)| wildcard_at(&value[at..]).is_some())
}

fn parts(pattern: &str) -> Vec<Part<'_>> {
    let mut parts = Vec::new();
    let mut rest = pattern;
    let mut searched = 0;
    while let Some(at) = rest[searched..].find("[..") {
        let start = searched + at;
        match wildcard_at(&rest[start..]) {
            Some((part, after)) => {
                if start > 0 {
                    parts.push(Part::Literal(&rest[..start]));
                }
                parts.push(part);
                rest = after;
                searched = 0;
            }
            None => searched = start + 3,
        }
    }
    if !rest.is_empty() {
        parts.push(Part::Literal(rest));
    }
    parts
}

fn matches(parts: &[Part<'_>], actual: &str) -> bool {
    match parts {
        [] => actual.is_empty(),
        [Part::Literal(literal), rest @ ..] => actual
            .strip_prefix(literal)
            .is_some_and(|tail| matches(rest, tail)),
        [Part::Shaped { alphabet, length }, rest @ ..] => {
            let mut taken = 0;
            let mut consumed = 0;
            for character in actual.chars() {
                if taken == *length {
                    return matches(rest, &actual[consumed..]);
                }
                if !alphabet(character) {
                    return false;
                }
                consumed += character.len_utf8();
                taken += 1;
            }
            taken == *length && matches(rest, &actual[consumed..])
        }
        [Part::Any, rest @ ..] => {
            (0..=actual.len()).any(|at| actual.is_char_boundary(at) && matches(rest, &actual[at..]))
        }
    }
}

fn wildcard_matches(pattern: &str, actual: &str) -> bool {
    if !has_wildcard(pattern) {
        return pattern == actual;
    }
    matches(&parts(pattern), actual)
}

/// Every position where a recording has a wildcard, as JSON paths.
pub fn wildcard_paths(value: &Value, path: &str) -> Vec<String> {
    match value {
        Value::String(text) if has_wildcard(text) => vec![path.to_owned()],
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
    difference(expected, actual, "$", Comparison::RecordedResult)
}

pub fn first_difference_exact(expected: &Value, actual: &Value) -> Option<Difference> {
    difference(expected, actual, "$", Comparison::Exact)
}

/// Compares the serialized object order after structural comparison passed.
pub(crate) fn first_key_order_difference(
    expected: &Value,
    actual: &Value,
    mut except: impl FnMut(&str) -> bool,
) -> Option<Difference> {
    let mut first = None;
    compare_key_order(expected, actual, "$", false, &mut except, &mut first);
    first
}

fn compare_key_order(
    expected: &Value,
    actual: &Value,
    path: &str,
    excepted_ancestor: bool,
    except: &mut impl FnMut(&str) -> bool,
    first: &mut Option<Difference>,
) {
    match (expected, actual) {
        (Value::Object(entries), Value::Object(others)) => {
            let ignored = except(path) || excepted_ancestor;
            // A recorded undefined property can be absent at the JSON boundary.
            let keys = || entries.keys().filter(|key| others.contains_key(*key));
            if !ignored && first.is_none() && keys().ne(others.keys()) {
                let expected = Value::Array(keys().cloned().map(Value::String).collect());
                let actual = Value::Array(others.keys().cloned().map(Value::String).collect());
                *first = Some(Difference::new(path, "key-order", &expected, &actual));
            }
            for key in keys() {
                compare_key_order(
                    &entries[key],
                    &others[key],
                    &child_path(path, key),
                    ignored,
                    except,
                    first,
                );
            }
        }
        (Value::Array(items), Value::Array(others)) => {
            let ignored = except(path) || excepted_ancestor;
            for (index, (item, other)) in items.iter().zip(others).enumerate() {
                compare_key_order(
                    item,
                    other,
                    &array_path(path, index),
                    ignored,
                    except,
                    first,
                );
            }
        }
        _ => {}
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Comparison {
    RecordedResult,
    Exact,
}

fn difference(
    expected: &Value,
    actual: &Value,
    path: &str,
    comparison: Comparison,
) -> Option<Difference> {
    let recorded = comparison == Comparison::RecordedResult;
    if recorded && expected.as_str() == Some(WILDCARD) {
        return None;
    }
    if recorded
        && markers::kind(expected) == Some("number")
        && expected["value"] == "-0"
        && matches!(actual, Value::Number(number) if number.as_i64() == Some(0))
    {
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
        (Value::String(pattern), Value::String(text)) => (!(pattern == text
            || recorded && wildcard_matches(pattern, text)))
        .then(|| Difference::new(path, "value", expected, actual)),
        (Value::Number(left), Value::Number(right)) => {
            (!numbers_equal(left, right)).then(|| Difference::new(path, "value", expected, actual))
        }
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
                    if recorded && markers::is_undefined(item) && other.is_null() {
                        None
                    } else {
                        difference(item, other, &array_path(path, index), comparison)
                    }
                })
        }
        (Value::Object(entries), Value::Object(others)) => {
            object_difference(entries, others, path, comparison)
        }
        _ => (expected != actual).then(|| Difference::new(path, "value", expected, actual)),
    }
}

fn object_difference(
    entries: &Map<String, Value>,
    others: &Map<String, Value>,
    path: &str,
    comparison: Comparison,
) -> Option<Difference> {
    let mut keys: Vec<&String> = entries.keys().chain(others.keys()).collect();
    keys.sort();
    keys.dedup();
    keys.into_iter()
        .find_map(|key| match (entries.get(key), others.get(key)) {
            (Some(expected), Some(actual)) => {
                difference(expected, actual, &child_path(path, key), comparison)
            }
            (Some(expected), None)
                if comparison == Comparison::RecordedResult && markers::is_undefined(expected) =>
            {
                None
            }
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
    fn finds_the_first_serialized_object_order_difference_in_a_nested_result() {
        let expected = json!({"rows":[{"1":1,"2":2,"z":0,"a":1}]});
        let actual = json!({"rows":[{"2":2,"1":1,"a":1,"z":0}]});
        assert!(first_difference(&expected, &actual).is_none());
        let order = first_key_order_difference(&expected, &actual, |_| false).unwrap();
        assert_eq!(order.kind, "key-order");
        assert_eq!(order.path, "$.rows[0]");
        assert_eq!(order.expected, r#"["1","2","z","a"]"#);
        assert_eq!(order.actual, r#"["2","1","a","z"]"#);
    }

    #[test]
    fn order_comparison_leaves_discarded_and_wildcard_values_open() {
        let expected =
            json!({"z": "[..]", "discarded": markers::undefined(), "a": [markers::undefined()]});
        let actual = json!({"z": {"any": 1, "order": 2}, "a": [null]});
        assert!(first_difference(&expected, &actual).is_none());
        assert!(first_key_order_difference(&expected, &actual, |_| false).is_none());
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
    fn recorded_negative_zero_matches_integer_zero_but_not_positive_float_zero() {
        let expected = json!({"field": markers::number(-0.0)});
        assert!(first_difference(&expected, &json!({"field": 0})).is_none());
        assert!(first_difference(&expected, &json!({"field": -0.0})).is_none());
        assert_eq!(
            found(expected.clone(), json!({"field": 0.0})).path,
            "$.field"
        );
        assert!(first_difference_exact(&expected, &json!({"field": 0})).is_some());
    }

    #[test]
    fn compares_mixed_numeric_representations_without_rounding_integers() {
        let base = json!(9_007_199_254_740_992_u64);
        let neighbor = json!(9_007_199_254_740_993_u64);
        let rounded = json!(9_007_199_254_740_992.0);
        assert!(first_difference(&base, &neighbor).is_some());
        assert!(first_difference(&rounded, &neighbor).is_some());
        assert!(first_difference(&neighbor, &rounded).is_some());
        assert!(first_difference(&base, &rounded).is_none());
        assert!(first_difference(&json!(u64::MAX), &json!(18_446_744_073_709_551_616.0)).is_some());
        assert!(first_difference(&json!(i64::MIN), &json!(-9_223_372_036_854_775_808.0)).is_none());
        assert!(first_difference_exact(&json!(1), &json!(1.0)).is_none());
        assert!(first_difference_exact(&json!(-1.0), &json!(-1)).is_none());
        assert!(first_difference_exact(&json!(1), &json!(1.5)).is_some());
    }

    #[test]
    fn compares_undefined_at_the_result_json_boundary_only() {
        let undefined = markers::undefined();
        let object = json!({"forgotten": undefined, "still_here": [1, undefined]});
        let encoded = json!({"still_here": [1, null]});
        assert!(first_difference(&object, &encoded).is_none());
        assert!(first_difference_exact(&object, &encoded).is_some());
        assert_eq!(found(json!({"field": null}), json!({})).kind, "missing");
        assert_eq!(found(json!({"field": 7}), json!({})).kind, "missing");
        assert_eq!(
            found(json!({"field": undefined}), json!({"field": null})).path,
            "$.field"
        );
        assert_eq!(found(json!({}), json!({"field": undefined})).kind, "extra");
        assert_eq!(found(json!([null]), json!([undefined])).path, "$[0]");
        assert_eq!(found(json!([undefined]), json!([])).kind, "length");
        assert_eq!(found(undefined.clone(), Value::Null).kind, "type");
        assert!(first_difference(&undefined, &undefined).is_none());
    }

    #[test]
    fn surrogate_results_match_units_not_the_lossy_string() {
        let first = markers::utf16(&[0xd800]);
        assert!(first_difference(&first, &markers::utf16(&[0xd800])).is_none());
        assert!(first_difference(&first, &markers::utf16(&[0xd801])).is_some());
        assert!(first_difference(&first, &json!("\u{fffd}")).is_some());
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
    fn a_shaped_wildcard_takes_exactly_its_length_of_its_alphabet() {
        let accepted = |value: &str| {
            difference(
                json!({ "proof": "[..base64url:43]" }),
                json!({ "proof": value }),
            )
            .is_none()
        };
        assert!(accepted(&"A".repeat(43)));
        assert!(accepted(&"_-_0zZ9".repeat(7)[..43]));
        assert!(!accepted(&"A".repeat(42)));
        assert!(!accepted(&"A".repeat(44)));
        assert!(!accepted(&format!("{}+", "A".repeat(42))));

        assert!(difference(json!("[..hex:4]"), json!("7f3a")).is_none());
        assert_eq!(found(json!("[..hex:4]"), json!("7F3A")).kind, "value");
        assert!(difference(json!("[..HEX:4]"), json!("7F3A")).is_none());
        assert!(difference(json!("[..digits:13]"), json!("1764234905123")).is_none());
        assert_eq!(found(json!("[..digits:3]"), json!("12")).kind, "value");
        assert_eq!(found(json!("[..digits:3]"), json!("abc")).kind, "value");

        // Inside a string, and beside an unshaped wildcard.
        assert!(difference(json!("id-[..hex:4].json"), json!("id-7f3a.json")).is_none());
        assert!(difference(json!("a[..][..hex:4]z"), json!("anything7f3az")).is_none());
        assert!(!difference(json!("a[..][..hex:4]z"), json!("anything7f3az!")).is_none());

        // A shaped wildcard still needs a string, where `[..]` takes any value.
        assert!(difference(json!("[..]"), json!({ "any": "thing" })).is_none());
        assert_eq!(found(json!("[..digits:3]"), json!(123)).kind, "type");
        assert_eq!(
            found(json!("[..base64url:8]"), json!({ "any": "thing" })).kind,
            "type"
        );
    }

    #[test]
    fn brackets_that_are_not_a_wildcard_stay_literal() {
        assert!(difference(json!("[..odd]"), json!("[..odd]")).is_none());
        assert_eq!(found(json!("[..odd]"), json!("x")).kind, "value");
        assert_eq!(
            wildcard_paths(&json!({ "a": "x [..digits:2] y", "b": "[..odd]" }), "$"),
            ["$.a"]
        );
    }

    #[test]
    fn unshaped_wildcards_still_match_any_run() {
        assert!(difference(json!("a[..]b[..]c"), json!("a-anything-b!c")).is_none());
        assert!(difference(json!("[..] tail"), json!("head tail")).is_none());
        assert_eq!(
            wildcard_paths(&json!({ "a": "x [..hex:2] y", "b": "[..]" }), "$"),
            ["$.a", "$.b"]
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
