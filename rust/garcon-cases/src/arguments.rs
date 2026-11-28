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
//! - NaN and an infinity have no JSON form, so no port that takes JSON can
//!   receive them. A JSON reader fails such a case and names the two ways out.
//!   The recorder makes those traps only for an argument that is a number and
//!   is not declared with `--json`.
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
/// A port that takes a JSON value gets negative zero as `-0.0`. An argument
/// that holds NaN or an infinity, anywhere, fails the case: JSON cannot carry
/// it, and anything put in its place could let a port pass by luck.
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
        Json::Value(json) => Ok(Some(json)),
        Json::Marker => Err(CaseError::unhandled(function)),
        Json::Number(number) => Err(undeliverable(function, &number)),
    }
}

// What a recorded value is for a port that takes JSON.
enum Json<'a> {
    Value(Cow<'a, Value>),
    // A marker JSON cannot carry, which the dispatcher decodes itself.
    Marker,
    // NaN or an infinity, by the name the recording gives it.
    Number(String),
}

fn json_of(value: &Value) -> Json<'_> {
    if let Some(kind) = markers::kind(value) {
        return match kind {
            "number" => match value["value"].as_str() {
                Some("-0") => Json::Value(Cow::Owned(json!(-0.0))),
                Some(number @ ("NaN" | "Infinity" | "-Infinity")) => {
                    Json::Number(number.to_owned())
                }
                _ => Json::Marker,
            },
            // A plain object with a `$` property of its own, which the
            // recording wraps to tell it from a marker.
            "object" => object_json(&value["value"]),
            _ => Json::Marker,
        };
    }
    match value {
        Value::Array(items) => {
            let mut kept = Vec::with_capacity(items.len());
            for item in items {
                let json = if markers::is_undefined(item) {
                    Json::Value(Cow::Borrowed(&Value::Null))
                } else {
                    json_of(item)
                };
                match json {
                    Json::Value(json) => kept.push(json.into_owned()),
                    other => return other,
                }
            }
            Json::Value(Cow::Owned(Value::Array(kept)))
        }
        Value::Object(_) => object_json(value),
        other => Json::Value(Cow::Borrowed(other)),
    }
}

// An object as JSON, without the properties whose value was `undefined`. The
// object itself is not tested for being a marker: inside an `object` wrapper
// its `$` key is data.
fn object_json(value: &Value) -> Json<'_> {
    let Some(entries) = value.as_object() else {
        return Json::Marker;
    };
    let mut kept = Map::new();
    for (key, item) in entries {
        if markers::is_undefined(item) {
            continue;
        }
        match json_of(item) {
            Json::Value(json) => {
                kept.insert(key.clone(), json.into_owned());
            }
            other => return other,
        }
    }
    Json::Value(Cow::Owned(Value::Object(kept)))
}

// The failure for an argument that holds NaN or an infinity. The two ways out
// are the reader for numbers and the recorder's `--json`.
fn undeliverable(function: &str, number: &str) -> CaseError {
    CaseError::undeliverable(format!(
        "`{function}` received {number}, which JSON cannot carry. Read the argument with `javascript_number` if the port takes a number there, or record the module again with `--json {function}:<argument index>`, which keeps the recorder from making that trap."
    ))
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
        // What had to be rebuilt is an array or an object.
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

    // How every JSON reader fails an argument that holds NaN or an infinity.
    fn not_delivered(number: &str) -> CaseError {
        CaseError::undeliverable(format!(
            "`f` received {number}, which JSON cannot carry. Read the argument with `javascript_number` if the port takes a number there, or record the module again with `--json f:<argument index>`, which keeps the recorder from making that trap."
        ))
    }

    #[test]
    fn negative_zero_stays_negative_zero() {
        let argument = number("-0");
        let json = round_tripped("f", Some(&argument))
            .expect("a value")
            .expect("a value");
        assert!(is_negative_zero(&json));
        // The same inside an object and an array.
        let nested = json!({ "a": [number("-0"), markers::undefined()] });
        let json = round_tripped("f", Some(&nested))
            .expect("a value")
            .expect("a value");
        assert!(is_negative_zero(&json["a"][0]));
        assert!(json["a"][1].is_null());
    }

    #[test]
    fn nan_and_the_infinities_fail_the_case_and_reach_no_port_as_something_else() {
        // JSON cannot carry them, so no value put in their place is the one the original received.
        for recorded in ["NaN", "Infinity", "-Infinity"] {
            assert_eq!(
                round_tripped("f", Some(&number(recorded))),
                Err(not_delivered(recorded))
            );
            assert_eq!(
                unknown("f", Some(&number(recorded))),
                Err(not_delivered(recorded))
            );
            assert_eq!(
                text("f", Some(&number(recorded))),
                Err(not_delivered(recorded))
            );
            // Wherever they sit in the argument.
            let nested = json!({ "a": [1, { "b": number(recorded) }] });
            assert_eq!(
                round_tripped("f", Some(&nested)),
                Err(not_delivered(recorded))
            );
            // The reader for numbers is the way out when the port takes one there.
            assert!(javascript_number("f", Some(&number(recorded))).is_ok());
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
            json!(number("-0")),
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
