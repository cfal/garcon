//! Ports `server-agents/opencode/src/agents/opencode/prompt.ts`.

use serde_json::{Map, Value};

use crate::js::{prop, truthy};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCodeModel {
    pub provider_id: String,
    pub model_id: String,
}

/// Splits `provider/model`; `None` when either side is empty.
pub fn parse_open_code_model(model: Option<&str>) -> Option<OpenCodeModel> {
    let model = model?;
    let separator = model.find('/')?;
    if separator < 1 || separator == model.len() - 1 {
        return None;
    }
    Some(OpenCodeModel {
        provider_id: model[..separator].to_owned(),
        model_id: model[separator + 1..].to_owned(),
    })
}

pub const GARCON_OPERATION_PART_METADATA_KEY: &str = "garcon_operation_part_id";

// OpenCode compares monotonic user and assistant IDs when deciding whether a turn is complete.
// Letting OpenCode assign both IDs preserves that ordering. Image attachments ride as file
// parts with data URLs, the same shape OpenCode's own app submits; the provider assigns their
// part IDs, so the operation identity stays on the text prompt part alone.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/session/prompt.ts#L1111-L1116
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/app/src/components/prompt-input/build-request-parts.ts#L197-L203
pub fn build_prompt_body(
    command: &str,
    model: Option<&str>,
    part_id: &str,
    attachments: &[Value],
    thinking_variant: Option<&str>,
) -> Map<String, Value> {
    let prompt_part = Map::from_iter([
        ("id".to_owned(), Value::String(part_id.to_owned())),
        ("type".to_owned(), Value::String("text".to_owned())),
        ("text".to_owned(), Value::String(command.to_owned())),
        (
            "metadata".to_owned(),
            Value::Object(Map::from_iter([(
                GARCON_OPERATION_PART_METADATA_KEY.to_owned(),
                Value::String(part_id.to_owned()),
            )])),
        ),
    ]);
    let file_parts = attachments.iter().filter_map(|attachment| {
        let attachment = attachment.as_object()?;
        (prop(attachment, "kind").as_str() == Some("image")).then(|| {
            let name = prop(attachment, "name");
            let mut file_part = Map::from_iter([
                ("type".to_owned(), Value::String("file".to_owned())),
                ("mime".to_owned(), prop(attachment, "mimeType").clone()),
                ("url".to_owned(), prop(attachment, "data").clone()),
            ]);
            if truthy(name) {
                file_part.insert("filename".to_owned(), name.clone());
            }
            Value::Object(file_part)
        })
    });
    let mut body = Map::from_iter([(
        "parts".to_owned(),
        Value::Array(
            std::iter::once(Value::Object(prompt_part))
                .chain(file_parts)
                .collect(),
        ),
    )]);
    if let Some(parsed_model) = parse_open_code_model(model) {
        body.insert(
            "model".to_owned(),
            Value::Object(Map::from_iter([
                (
                    "providerID".to_owned(),
                    Value::String(parsed_model.provider_id),
                ),
                ("modelID".to_owned(), Value::String(parsed_model.model_id)),
            ])),
        );
    }
    if let Some(thinking_variant) = thinking_variant.filter(|variant| !variant.is_empty()) {
        body.insert(
            "variant".to_owned(),
            Value::String(thinking_variant.to_owned()),
        );
    }
    body
}
