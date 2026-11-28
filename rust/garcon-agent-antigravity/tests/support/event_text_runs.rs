use garcon_cases::CaseError;
use serde_json::{Map, Value, json};

const TAG: &str = "$agyTextRuns";
const MIN_RUN: usize = 8192;

fn pack_text(text: String) -> Value {
    if text.len() < MIN_RUN {
        return Value::String(text);
    }
    let bytes = text.as_bytes();
    let mut parts = Vec::new();
    let mut pending = 0;
    let mut start = 0;
    while let Some(&byte) = bytes.get(start) {
        if !matches!(byte, b'x' | b' ') {
            start += 1;
            continue;
        }
        let mut end = start + 1;
        while bytes.get(end) == Some(&byte) {
            end += 1;
        }
        if end - start >= MIN_RUN {
            if pending < start {
                parts.push(Value::from(&text[pending..start]));
            }
            parts.push(json!([&text[start..start + 1], end - start]));
            pending = end;
        }
        start = end;
    }
    if parts.is_empty() {
        return Value::String(text);
    }
    if pending < text.len() {
        parts.push(Value::from(&text[pending..]));
    }
    Value::Object(Map::from_iter([(TAG.to_owned(), Value::Array(parts))]))
}

pub fn pack(value: Value) -> Value {
    match value {
        Value::String(text) => pack_text(text),
        Value::Array(items) => Value::Array(items.into_iter().map(pack).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key, pack(value)))
                .collect(),
        ),
        other => other,
    }
}

fn unpack_text(parts: &Value) -> Result<Value, CaseError> {
    let malformed = || CaseError::undeliverable("invalid fixture text run");
    let mut text = String::new();
    for part in parts.as_array().ok_or_else(malformed)? {
        if let Some(literal) = part.as_str() {
            text.push_str(literal);
        } else if let Some(run) = part.as_array().filter(|parts| parts.len() == 2) {
            let character = run[0]
                .as_str()
                .filter(|s| matches!(*s, "x" | " "))
                .ok_or_else(malformed)?;
            let length = run[1]
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(malformed)?;
            text.extend(std::iter::repeat_n(character.as_bytes()[0] as char, length));
        } else {
            return Err(malformed());
        }
    }
    Ok(Value::String(text))
}

pub fn unpack(value: Value) -> Result<Value, CaseError> {
    match value {
        Value::Array(items) => items
            .into_iter()
            .map(unpack)
            .collect::<Result<_, _>>()
            .map(Value::Array),
        Value::Object(fields) if fields.len() == 1 && fields.contains_key(TAG) => {
            unpack_text(&fields[TAG])
        }
        Value::Object(fields) => fields
            .into_iter()
            .map(|(key, value)| Ok((key, unpack(value)?)))
            .collect::<Result<_, _>>()
            .map(Value::Object),
        other => Ok(other),
    }
}
