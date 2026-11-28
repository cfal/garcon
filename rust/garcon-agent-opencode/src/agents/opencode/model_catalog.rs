//! Ports `server-agents/opencode/src/agents/opencode/model-catalog.ts`.

use garcon_contract::chat_modes::ThinkingMode;
use garcon_js::{sort_object_keys, utf16};
use serde_json::{Map, Value};

use super::thinking_variant::thinking_modes_from_variants;
use crate::js::{prop, same_value_zero, string_of, truthy};

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeModelOption {
    pub value: String,
    pub label: String,
    pub supports_images: Option<bool>,
    pub thinking_modes: Option<Vec<ThinkingMode>>,
}

// The server computes capabilities.input from config modalities and the
// registry, so it is the authoritative image-input signal; older payloads
// without it fall back to the raw declarations.
fn model_supports_images(model: &Map<String, Value>) -> Option<bool> {
    let capabilities = prop(model, "capabilities").as_object();
    let input = capabilities.and_then(|capabilities| prop(capabilities, "input").as_object());
    if let Some(image) = input.and_then(|input| prop(input, "image").as_bool()) {
        return Some(image);
    }
    let modalities = prop(model, "modalities").as_object();
    if let Some(input) = modalities.and_then(|modalities| prop(modalities, "input").as_array()) {
        return Some(input.iter().any(|value| value.as_str() == Some("image")));
    }
    prop(model, "attachment").as_bool()
}

pub fn configured_providers_from_result(result: &Value) -> &[Value] {
    prop(prop(result, "data"), "providers")
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

pub fn connected_providers_from_list_result(result: &Value) -> Vec<&Value> {
    let data = prop(result, "data");
    let all_providers = prop(data, "all")
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let connected = prop(data, "connected")
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    all_providers
        .iter()
        .filter(|provider| {
            let identity = provider_identity(provider);
            connected
                .iter()
                .any(|value| same_value_zero(value, identity))
        })
        .collect()
}

// `provider.id || provider.name`.
fn provider_identity(provider: &Value) -> &Value {
    let id = prop(provider, "id");
    if truthy(id) {
        id
    } else {
        prop(provider, "name")
    }
}

pub fn models_from_providers(providers: &[&Value]) -> Vec<OpenCodeModelOption> {
    let mut models = Vec::new();
    for provider in providers {
        let provider_id = provider_identity(provider);
        let name = prop(provider, "name");
        let provider_name = if truthy(name) { name } else { provider_id };
        let declared = prop(provider, "models");
        let entries = if truthy(declared) {
            object_entries(declared)
        } else {
            Vec::new()
        };
        for (model_key, model) in entries {
            let Some(model_object) = model.as_object() else {
                continue;
            };
            let model_id = match prop(model_object, "id").as_str() {
                Some(id) => id,
                None => model_key.as_str(),
            };
            let model_name = prop(model_object, "name").as_str().unwrap_or(model_id);
            models.push(OpenCodeModelOption {
                value: format!("{}/{}", string_of(Some(provider_id)), model_id),
                label: format!("{}: {}", string_of(Some(provider_name)), model_name),
                supports_images: model_supports_images(model_object),
                thinking_modes: thinking_modes_from_variants(prop(model_object, "variants")),
            });
        }
    }
    models
}

/// `Object.entries(value)` for the values a provider's `models` can be: an
/// object's keys in the order JavaScript enumerates them, the indexes of an
/// array, or the UTF-16 units of a string.
fn object_entries(value: &Value) -> Vec<(String, &Value)> {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<String> = object.keys().cloned().collect();
            sort_object_keys(&mut keys);
            keys.into_iter()
                .filter_map(|key| object.get(&key).map(|value| (key, value)))
                .collect()
        }
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, item)| (index.to_string(), item))
            .collect(),
        Value::String(text) => (0..utf16::len(text))
            .map(|index| {
                (
                    index.to_string(),
                    // The unit of a string is never a record, so the entry's value is not read.
                    &Value::Null,
                )
            })
            .collect(),
        _ => Vec::new(),
    }
}
