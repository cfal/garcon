use garcon_js::{array_index, json::as_number, number_to_string};
use serde_json::{Map, Value};

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct CodexConfigOverrideError(String);

pub fn append_codex_config_args(
    args: &mut Vec<String>,
    config: Option<&Value>,
) -> Result<(), CodexConfigOverrideError> {
    let Some(config) = config else {
        return Ok(());
    };
    let mut overrides = Vec::new();
    flatten_codex_config_overrides(config, "", &mut overrides)?;
    for entry in overrides {
        args.push("--config".into());
        args.push(entry);
    }
    Ok(())
}

fn flatten_codex_config_overrides(
    value: &Value,
    prefix: &str,
    overrides: &mut Vec<String>,
) -> Result<(), CodexConfigOverrideError> {
    if prefix == "model_providers" || !value.is_object() {
        if prefix.is_empty() {
            return Err(CodexConfigOverrideError(
                "Codex config overrides must be a plain object".into(),
            ));
        }
        overrides.push(format!("{prefix}={}", to_toml_value(value, prefix)?));
        return Ok(());
    }
    if let Some(entries) = value.as_object() {
        if entries.is_empty() && !prefix.is_empty() {
            overrides.push(format!("{prefix}={{}}"));
        }
        for (key, child) in ordered_entries(entries) {
            if key.is_empty() {
                return Err(CodexConfigOverrideError(
                    "Codex config override keys must be non-empty strings".into(),
                ));
            }
            let path = if prefix.is_empty() {
                key.to_owned()
            } else {
                format!("{prefix}.{key}")
            };
            if child.is_object() {
                flatten_codex_config_overrides(child, &path, overrides)?;
            } else {
                overrides.push(format!("{path}={}", to_toml_value(child, &path)?));
            }
        }
    }
    Ok(())
}

fn to_toml_value(value: &Value, path: &str) -> Result<String, CodexConfigOverrideError> {
    Ok(match value {
        Value::String(value) => quote(value),
        Value::Number(_) => {
            let number = as_number(value)
                .filter(|number| number.is_finite())
                .ok_or_else(|| {
                    CodexConfigOverrideError(format!(
                        "Codex config override at {path} must be a finite number"
                    ))
                })?;
            number_to_string(number)
        }
        Value::Bool(value) => value.to_string(),
        Value::Array(items) => {
            let values = items
                .iter()
                .enumerate()
                .map(|(index, item)| to_toml_value(item, &format!("{path}[{index}]")))
                .collect::<Result<Vec<_>, _>>()?;
            format!("[{}]", values.join(", "))
        }
        Value::Object(entries) => {
            let values = ordered_entries(entries)
                .into_iter()
                .map(|(key, child)| {
                    Ok(format!(
                        "{} = {}",
                        format_toml_key(key),
                        to_toml_value(child, &format!("{path}.{key}"))?
                    ))
                })
                .collect::<Result<Vec<_>, _>>()?;
            format!("{{{}}}", values.join(", "))
        }
        Value::Null => {
            return Err(CodexConfigOverrideError(format!(
                "Unsupported Codex config override value at {path}: object"
            )));
        }
    })
}

fn ordered_entries(entries: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut entries: Vec<_> = entries.iter().collect();
    entries.sort_by_key(|(key, _)| array_index(key).unwrap_or(u64::MAX));
    entries
}

fn format_toml_key(key: &str) -> String {
    if !key.is_empty()
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        key.to_owned()
    } else {
        quote(key)
    }
}

fn quote(value: &str) -> String {
    // INFALLIBLE: JSON serialization of a Rust string cannot fail.
    serde_json::to_string(value).expect("serialize a config string")
}
