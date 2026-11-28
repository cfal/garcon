//! Ports `common/json.ts`.

use serde_json::{Map, Value};

use garcon_js::utf16;

/// A JSON primitive: a string, a number, a boolean, or `null`. The values a
/// JSON document holds are `serde_json::Value`, which is what the port passes
/// where the original has a `JsonPrimitive`, a `JsonValue`, or `unknown`.
pub type JsonPrimitive = Value;

/// A JSON value.
pub type JsonValue = Value;

/// A JSON object.
pub type JsonObject = Map<String, Value>;

/// Serializes JSON semantics with recursively sorted object keys: every key
/// is in code unit order, and among them the array indexes come first in
/// numeric order, as `Object.fromEntries` orders them. The original throws
/// for a value JSON cannot serialize; a `Value` is always JSON, so nothing is
/// thrown here.
pub fn stable_json_stringify(value: &Value) -> String {
    garcon_js::json::stringify(&sort_json_value(value))
}

/// `Object.keys(value).sort()` followed by `Object.fromEntries`: the keys in
/// code unit order. `stringify` then lists array indexes first, as every
/// JavaScript object does.
fn sort_json_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sort_json_value).collect()),
        Value::Object(map) => {
            let mut keys: Vec<String> = map.keys().cloned().collect();
            keys.sort_by(|left, right| utf16::cmp(left, right));
            let mut sorted = Map::with_capacity(keys.len());
            for key in keys {
                // INFALLIBLE: every key comes from this map.
                if let Some(item) = map.get(&key) {
                    sorted.insert(key, sort_json_value(item));
                }
            }
            Value::Object(sorted)
        }
        other => other.clone(),
    }
}

/// Whether `value` is an object and not an array or `null`.
pub fn is_record(value: &Value) -> bool {
    value.is_object()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_keyed_objects() {
        assert!(is_record(&json!({ "value": 1 })));
    }

    #[test]
    fn rejects_non_record_json_values() {
        assert!(!is_record(&Value::Null));
        assert!(!is_record(&json!([])));
        assert!(!is_record(&json!("value")));
        assert!(!is_record(&json!(1)));
        assert!(!is_record(&json!(true)));
    }

    #[test]
    fn sorts_object_keys_recursively_while_preserving_array_order_and_json_semantics() {
        let first =
            json!({ "z": 1, "nested": { "b": 2, "a": 1 }, "rows": [{ "y": 2, "x": 1 }, 3] });
        let second =
            json!({ "rows": [{ "x": 1, "y": 2 }, 3], "nested": { "a": 1, "b": 2 }, "z": 1 });
        assert_eq!(
            stable_json_stringify(&first),
            stable_json_stringify(&second)
        );
        assert_eq!(
            stable_json_stringify(&first),
            r#"{"nested":{"a":1,"b":2},"rows":[{"x":1,"y":2},3],"z":1}"#
        );
        assert_ne!(
            stable_json_stringify(&json!([2, 1])),
            stable_json_stringify(&json!([1, 2]))
        );
        // An `undefined` property is omitted by `JSON.stringify`, which a
        // `Value` cannot hold; `null` is kept.
        assert_eq!(
            stable_json_stringify(&json!({ "kept": null })),
            r#"{"kept":null}"#
        );
    }

    #[test]
    fn sorts_keys_as_javascript_sorts_strings() {
        // Array indexes lead in numeric order; the rest follow in code unit
        // order, where an astral character sorts before U+E000 and U+FF5E.
        assert_eq!(
            stable_json_stringify(
                &json!({ "b": 1, "10": 2, "1": 3, "\u{FF5E}": 4, "\u{1F600}": 5 })
            ),
            "{\"1\":3,\"10\":2,\"b\":1,\"\u{1F600}\":5,\"\u{FF5E}\":4}"
        );
        // A number prints as JavaScript prints it.
        assert_eq!(
            stable_json_stringify(&json!({ "a": 1.0, "b": [1e21] })),
            r#"{"a":1,"b":[1e+21]}"#
        );
    }
}
