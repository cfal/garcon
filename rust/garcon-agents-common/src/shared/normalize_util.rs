//! Ports `server-agents/common/src/shared/normalize-util.ts`. Normalizes provider payloads into the canonical chat contract.

use garcon_contract::chat_plan::{TodoItem, coerce_todo_items};
use garcon_js::json::Opaque;
use garcon_js::trim;
use serde_json::{Map, Value};

// Normalizes a provider-specific todo/plan list into canonical TodoItem[],
// the coercion `common/chat-plan.ts` owns.
pub fn normalize_todo_items(raw: &Value) -> Option<Vec<TodoItem>> {
    coerce_todo_items(raw)
}

pub fn normalize_tool_input(value: Option<&Opaque>) -> Opaque {
    let Some(value) = value else {
        return empty_object();
    };
    match value.as_value() {
        Value::Null => empty_object(),
        value @ Value::Object(_) => value.clone().into(),
        Value::String(text) if !text.is_empty() => {
            match parse(text).ok().filter(|parsed| parsed.is_object()) {
                Some(parsed) => parsed,
                None => wrapped("raw", value),
            }
        }
        _ => empty_object(),
    }
}

pub fn normalize_tool_result_content(value: Option<&Opaque>) -> Opaque {
    let Some(value) = value else {
        return empty_object();
    };
    match value.as_value() {
        Value::Null => empty_object(),
        value @ Value::Object(_) => value.clone().into(),
        Value::Array(_) => wrapped("items", value),
        Value::String(text) => {
            if trim(text).is_empty() {
                return empty_object();
            }
            match parse(text) {
                Ok(parsed) if parsed.is_object() => parsed,
                Ok(parsed) if parsed.is_array() => wrapped("items", parsed.as_value()),
                _ => wrapped("raw", value),
            }
        }
        _ => empty_object(),
    }
}

// `JSON.parse`: a value the text holds, read as JavaScript reads it.
fn parse(text: &str) -> Result<Opaque, serde_json::Error> {
    garcon_js::json::from_str(text)
}

fn empty_object() -> Opaque {
    Value::Object(Map::new()).into()
}

fn wrapped(key: &str, value: &Value) -> Opaque {
    Value::Object(Map::from_iter([(key.to_owned(), value.clone())])).into()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn opaque(value: Value) -> Opaque {
        Opaque::from_value(value)
    }

    fn written(value: &Opaque) -> Value {
        garcon_js::json::from_slice(&serde_json::to_vec(value).unwrap()).unwrap()
    }

    #[test]
    fn a_tool_input_object_is_returned_as_it_was() {
        let value = opaque(json!({"command": "ls", "args": ["-la", null], "n": 1e20}));
        assert_eq!(written(&normalize_tool_input(Some(&value))), *value);
        assert_eq!(
            normalize_tool_input(Some(&opaque(Value::Null))),
            empty_object()
        );
        assert_eq!(normalize_tool_input(None), empty_object());
        assert_eq!(
            normalize_tool_input(Some(&opaque(json!("")))),
            empty_object()
        );
        assert_eq!(
            normalize_tool_input(Some(&opaque(json!([])))),
            empty_object()
        );
        assert_eq!(
            normalize_tool_input(Some(&opaque(json!(5)))),
            empty_object()
        );
    }

    #[test]
    fn a_tool_input_string_becomes_the_object_it_holds_or_is_kept_raw() {
        assert_eq!(
            written(&normalize_tool_input(Some(&opaque(json!(
                " {\"command\":\"ls -la\",\"cwd\":\"/tmp\"} "
            ))))),
            json!({"command": "ls -la", "cwd": "/tmp"})
        );
        for text in ["[1,2]", "null", "42", "{bad}", "plain text", "{\"a\":1}x"] {
            assert_eq!(
                written(&normalize_tool_input(Some(&opaque(json!(text))))),
                json!({ "raw": text }),
                "{text}"
            );
        }
    }

    #[test]
    fn a_tool_result_keeps_objects_wraps_arrays_and_ignores_other_primitives() {
        let value = opaque(json!({"exitCode": 0}));
        assert_eq!(
            written(&normalize_tool_result_content(Some(&value))),
            json!({"exitCode": 0})
        );
        assert_eq!(
            written(&normalize_tool_result_content(Some(&opaque(json!([
                1, "a", null
            ]))))),
            json!({ "items": [1, "a", null] })
        );
        assert_eq!(
            written(&normalize_tool_result_content(Some(&opaque(json!(
                "[{\"content\":\"a\"}]"
            ))))),
            json!({ "items": [{"content": "a"}] })
        );
        for blank in [
            None,
            Some(json!(null)),
            Some(json!("")),
            Some(json!(" \t\n")),
            Some(json!(5)),
            Some(json!(true)),
        ] {
            let blank = blank.map(opaque);
            assert_eq!(
                normalize_tool_result_content(blank.as_ref()),
                empty_object(),
                "{blank:?}"
            );
        }
        assert_eq!(
            written(&normalize_tool_result_content(Some(&opaque(json!(
                "plain text"
            ))))),
            json!({ "raw": "plain text" })
        );
    }
}
