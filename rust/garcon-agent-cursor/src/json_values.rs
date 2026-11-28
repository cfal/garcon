use garcon_js::{Number, string_to_number, trim};
use serde_json::{Map, Value};

pub(crate) fn first_value<'a>(object: &'a Map<String, Value>, keys: &[&str]) -> &'a Value {
    keys.iter()
        .filter_map(|key| object.get(*key))
        .find(|value| !value.is_null())
        .unwrap_or(&Value::Null)
}

pub(crate) fn string(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    first_value(object, keys).as_str().map(str::to_owned)
}

pub(crate) fn number(value: &Value) -> Option<Number> {
    let value = if let Some(number) = value.as_f64() {
        number
    } else {
        string_to_number(value.as_str()?)
    };
    value.is_finite().then_some(Number(value))
}

pub(crate) fn canonicalize(text: &str) -> String {
    trim(text)
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, '_' | '-') && !trim(c.encode_utf8(&mut [0; 4])).is_empty())
        .collect()
}
