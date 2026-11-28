//! Reading a recorded argument for a dispatcher (rust/RULES.md, "Tests").
//!
//! A recording holds the values the original received, including what JSON
//! cannot hold: `undefined`, negative zero, NaN. The original's parsers of
//! untrusted input take a JavaScript value, so a port takes a
//! `serde_json::Value`. An argument therefore reaches a dispatcher as the JSON
//! that `JSON.stringify` writes for the recorded value, with the one exception
//! the rules make: negative zero stays negative zero, which a port reads as
//! `-0.0`.
//!
//! - A property whose value was `undefined` is absent, and `undefined` inside
//!   an array is `null`.
//! - A number has its exact recorded value. A function that takes a JavaScript
//!   number reads it with [`javascript_number`], which keeps NaN and the
//!   infinities.
//! - Any other marker, such as a Date, a Map, or a Set, is a value JSON cannot
//!   round-trip to. A reader reports such an argument as not handled, and the
//!   dispatcher decodes it with [`crate::markers`].

use std::borrow::Cow;

use serde_json::{Map, Value, json};

use crate::CaseError;
use crate::markers;

/// An argument as the JSON it round-trips to, or `None` where the original
/// received `undefined` or no argument.
///
/// A port that takes a JSON value gets negative zero as `-0.0`. NaN and the
/// infinities have no JSON form, and the recorder makes those traps only for
/// an argument a port reads as a number; one that reaches here is read as `0`.
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
    match json_of(value) {
        Some(json) => Ok(Some(json)),
        None => Err(CaseError::unhandled(function)),
    }
}

// The JSON of a recorded value, or `None` when it holds a marker JSON cannot
// carry.
fn json_of(value: &Value) -> Option<Cow<'_, Value>> {
    if let Some(kind) = markers::kind(value) {
        return match kind {
            "number" => Some(Cow::Owned(match value["value"].as_str() {
                Some("-0") => json!(-0.0),
                _ => json!(0.0),
            })),
            // A plain object with a `$` property of its own, which the
            // recording wraps to tell it from a marker.
            "object" => object_json(&value["value"]),
            _ => None,
        };
    }
    match value {
        Value::Array(items) => {
            let mut kept = Vec::with_capacity(items.len());
            for item in items {
                kept.push(if markers::is_undefined(item) {
                    Value::Null
                } else {
                    json_of(item)?.into_owned()
                });
            }
            Some(Cow::Owned(Value::Array(kept)))
        }
        Value::Object(_) => object_json(value),
        other => Some(Cow::Borrowed(other)),
    }
}

// An object as JSON, without the properties whose value was `undefined`. The
// object itself is not tested for being a marker: inside an `object` wrapper
// its `$` key is data.
fn object_json(value: &Value) -> Option<Cow<'_, Value>> {
    let mut kept = Map::new();
    for (key, item) in value.as_object()? {
        if markers::is_undefined(item) {
            continue;
        }
        kept.insert(key.clone(), json_of(item)?.into_owned());
    }
    Some(Cow::Owned(Value::Object(kept)))
}

/// An argument the original typed `unknown`, where `undefined` and `null`
/// read alike: `null` where it received either, or no argument.
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
        // What had to be rebuilt is an array, an object, or a number.
        Some(Cow::Owned(_)) => Err(CaseError::unhandled(function)),
    }
}

/// An argument as the exact JavaScript number the original received, also
/// where the recording holds it as a marker because JSON cannot: negative
/// zero, NaN, and the infinities.
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

/// An argument as the `bigint` the original received, which the recording
/// holds as its decimal digits.
pub fn bigint(function: &str, argument: Option<&Value>) -> Result<u64, CaseError> {
    let decimal = match argument {
        Some(value) if markers::kind(value) == Some("bigint") => value["value"].as_str(),
        _ => None,
    };
    decimal
        .and_then(|decimal| decimal.parse().ok())
        .ok_or_else(|| CaseError::unhandled(function))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn number(text: &str) -> Value {
        json!({ "$": "number", "value": text })
    }

    fn is_negative_zero(value: &Value) -> bool {
        value
            .as_f64()
            .is_some_and(|value| value == 0.0 && value.is_sign_negative())
    }

    #[test]
    fn an_undefined_argument_is_absent() {
        assert_eq!(round_tripped("f", None), Ok(None));
        assert_eq!(round_tripped("f", Some(&markers::undefined())), Ok(None));
        // `null` is a value, apart from `undefined`.
        assert_eq!(
            round_tripped("f", Some(&Value::Null)),
            Ok(Some(Cow::Borrowed(&Value::Null)))
        );
    }

    #[test]
    fn an_undefined_property_is_absent_and_undefined_in_an_array_is_null() {
        let recorded = json!([
            { "kept": 1, "dropped": markers::undefined(), "nested": [markers::undefined(), null, "x"] },
            markers::undefined(),
            true
        ]);
        assert_eq!(
            round_tripped("f", Some(&recorded)),
            Ok(Some(Cow::Owned(json!([
                { "kept": 1, "nested": [null, null, "x"] },
                null,
                true
            ]))))
        );
        // Nothing to strip borrows the recorded value.
        let plain = json!({ "a": [1, null, "s"] });
        assert_eq!(
            round_tripped("f", Some(&plain)),
            Ok(Some(Cow::Borrowed(&plain)))
        );
    }

    #[test]
    fn negative_zero_stays_and_the_other_numbers_json_cannot_hold_are_zero() {
        for (recorded, negative) in [
            ("-0", true),
            ("NaN", false),
            ("Infinity", false),
            ("-Infinity", false),
        ] {
            let argument = number(recorded);
            let json = round_tripped("f", Some(&argument))
                .expect("a number")
                .expect("a value");
            assert_eq!(is_negative_zero(&json), negative, "{recorded}");
            if !negative {
                assert_eq!(json.as_f64(), Some(0.0), "{recorded}");
            }
            // The same inside an object and an array.
            let nested = json!({ "a": [number(recorded)] });
            let json = round_tripped("f", Some(&nested))
                .expect("a number")
                .expect("a value");
            assert_eq!(
                is_negative_zero(&json["a"][0]),
                negative,
                "{recorded} nested"
            );
        }
    }

    #[test]
    fn an_object_with_a_dollar_property_is_its_json() {
        // The recording wraps it, so that it is not mistaken for a marker.
        let recorded =
            json!({ "$": "object", "value": { "$": "date", "when": markers::undefined() } });
        assert_eq!(
            round_tripped("f", Some(&recorded)),
            Ok(Some(Cow::Owned(json!({ "$": "date" }))))
        );
        let nested = json!({ "list": [{ "$": "object", "value": { "$": 5 } }] });
        assert_eq!(
            round_tripped("f", Some(&nested)),
            Ok(Some(Cow::Owned(json!({ "list": [{ "$": 5 }] }))))
        );
    }

    #[test]
    fn a_marker_json_cannot_hold_is_not_handled() {
        for recorded in [
            json!({ "$": "date", "value": "2026-11-27T00:00:00.000Z" }),
            json!({ "$": "map", "value": [["k", 1]] }),
            json!({ "$": "set", "value": [1] }),
            json!({ "$": "bigint", "value": "10" }),
            json!({ "$": "bytes", "value": "AQID" }),
            json!({ "$": "error", "name": "Error", "message": "x", "properties": {} }),
            json!({ "$": "unknown-kind" }),
            json!({ "a": { "$": "date", "value": "2026-11-27T00:00:00.000Z" } }),
            json!({ "a": { "$": "object", "value": { "$": "date", "x": { "$": "set", "value": [] } } } }),
            json!({ "$": "object", "value": "not an object" }),
        ] {
            assert_eq!(
                round_tripped("f", Some(&recorded)),
                Err(CaseError::unhandled("f")),
                "{recorded}"
            );
        }
    }

    #[test]
    fn unknown_reads_undefined_and_null_alike() {
        assert_eq!(unknown("f", None), Ok(Cow::Borrowed(&Value::Null)));
        assert_eq!(
            unknown("f", Some(&markers::undefined())),
            Ok(Cow::Borrowed(&Value::Null))
        );
        assert_eq!(
            unknown("f", Some(&Value::Null)),
            Ok(Cow::Borrowed(&Value::Null))
        );
        let value = json!({ "a": 1 });
        assert_eq!(unknown("f", Some(&value)), Ok(Cow::Borrowed(&value)));
    }

    #[test]
    fn text_is_a_string_and_none_for_undefined_or_null() {
        assert_eq!(text("f", Some(&json!("chat-1"))), Ok(Some("chat-1")));
        assert_eq!(text("f", Some(&json!(""))), Ok(Some("")));
        assert_eq!(text("f", None), Ok(None));
        assert_eq!(text("f", Some(&markers::undefined())), Ok(None));
        assert_eq!(text("f", Some(&Value::Null)), Ok(None));
        for not_text in [
            json!(1),
            json!(true),
            json!(number("NaN")),
            json!(["a"]),
            json!({ "a": "b" }),
        ] {
            assert_eq!(
                text("f", Some(&not_text)),
                Err(CaseError::unhandled("f")),
                "{not_text}"
            );
        }
    }

    #[test]
    fn a_javascript_number_is_exact_and_keeps_what_json_cannot_hold() {
        let exact: [(Value, f64); 5] = [
            (json!(1), 1.0),
            (json!(1e21), 1e21),
            (json!(1e-7), 1e-7),
            (json!(9_007_199_254_740_992_u64), 9_007_199_254_740_992.0),
            (json!(-0.5), -0.5),
        ];
        for (recorded, expected) in exact {
            let read = javascript_number("f", Some(&recorded)).expect("a number");
            assert_eq!(read.to_bits(), expected.to_bits(), "{recorded}");
        }
        assert!(is_negative_zero(&json!(
            javascript_number("f", Some(&number("-0"))).expect("a number")
        )));
        assert!(
            javascript_number("f", Some(&number("NaN")))
                .expect("a number")
                .is_nan()
        );
        assert_eq!(
            javascript_number("f", Some(&number("Infinity"))).expect("a number"),
            f64::INFINITY
        );
        assert_eq!(
            javascript_number("f", Some(&number("-Infinity"))).expect("a number"),
            f64::NEG_INFINITY
        );
        for not_number in [json!("1"), json!(null), json!([1]), number("other")] {
            assert_eq!(
                javascript_number("f", Some(&not_number)),
                Err(CaseError::unhandled("f")),
                "{not_number}"
            );
        }
        assert_eq!(javascript_number("f", None), Err(CaseError::unhandled("f")));
    }

    #[test]
    fn a_bigint_is_read_from_its_digits() {
        let bigint = |digits: &str| json!({ "$": "bigint", "value": digits });
        assert_eq!(
            super::bigint("f", Some(&bigint("1783725900000123456"))),
            Ok(1_783_725_900_000_123_456)
        );
        for not_bigint in [
            bigint("-1"),
            bigint("18446744073709551616"),
            bigint("ten"),
            json!(10),
            json!("10"),
        ] {
            assert_eq!(
                super::bigint("f", Some(&not_bigint)),
                Err(CaseError::unhandled("f")),
                "{not_bigint}"
            );
        }
        assert_eq!(super::bigint("f", None), Err(CaseError::unhandled("f")));
    }
}
