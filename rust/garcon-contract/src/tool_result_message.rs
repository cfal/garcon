use garcon_js::{
    is_safe_integer,
    json::{Opaque, as_number},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub struct ToolTextPart<'a> {
    pub text: &'a str,
    pub raw: &'a Map<String, Value>,
}

pub(crate) fn as_text_part(value: &Value) -> Option<ToolTextPart<'_>> {
    let raw = value.as_object()?;
    if raw.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    Some(ToolTextPart {
        text: raw.get("text")?.as_str()?,
        raw,
    })
}

pub fn is_text_part(value: &Value) -> bool {
    as_text_part(value).is_some()
}

pub fn tool_result_text_part(block: &Value) -> Option<ToolTextPart<'_>> {
    let wrapped = block
        .as_object()
        .is_some_and(|body| body.get("type").and_then(Value::as_str) == Some("content"));
    let part = if wrapped {
        block.get("content")?
    } else {
        block
    };
    as_text_part(part)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultMessage {
    pub timestamp: String,
    pub tool_id: String,
    pub content: Opaque,
    pub is_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_text_items: Option<Vec<usize>>,
    #[serde(rename = "type")]
    kind: ToolResultKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ToolResultKind {
    ToolResult,
}

impl ToolResultMessage {
    pub fn new(
        timestamp: String,
        tool_id: String,
        content: Opaque,
        is_error: bool,
        primary_text_items: Option<Vec<usize>>,
    ) -> Self {
        Self {
            timestamp,
            tool_id,
            content,
            is_error,
            primary_text_items,
            kind: ToolResultKind::ToolResult,
        }
    }

    pub fn from_data(data: &Map<String, Value>) -> Self {
        let timestamp = data
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into();
        let tool_id = data
            .get("toolId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into();
        let content = data.get("content").filter(|content| !content.is_null());
        let primary_text_items = parse_primary_text_items(
            data.get("primaryTextItems"),
            content.and_then(|content| content.get("items")),
        );
        let content = content
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()))
            .into();
        let is_error = data.get("isError").is_some_and(truthy);
        Self::new(timestamp, tool_id, content, is_error, primary_text_items)
    }
}

fn parse_primary_text_items(
    references: Option<&Value>,
    items: Option<&Value>,
) -> Option<Vec<usize>> {
    let references = references?.as_array()?;
    let items = items?.as_array()?;
    if references.is_empty() || references.len() > items.len() {
        return None;
    }
    let mut indices = Vec::with_capacity(references.len());
    for index in references {
        let index = as_number(index)?;
        if !is_safe_integer(index) || index < 0.0 || index >= items.len() as f64 {
            return None;
        }
        let index = index as usize;
        if indices.last().is_some_and(|previous| index <= *previous) {
            return None;
        }
        tool_result_text_part(&items[index])?;
        indices.push(index);
    }
    Some(indices)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(_) => as_number(value).is_some_and(|value| value != 0.0 && !value.is_nan()),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_only_increasing_references_to_text() {
        let mut data = json!({
            "content": {"items": [
                {"type":"text", "text":""}, {"type":"image", "data":"synthetic"},
                {"type":"content", "content":{"type":"text","text":"x","extra":true}},
            ]},
            "primaryTextItems": [0, 2],
        });
        let read = |data: &Value| ToolResultMessage::from_data(data.as_object().unwrap());
        assert_eq!(read(&data).primary_text_items, Some(vec![0, 2]));
        for invalid in [
            json!([]),
            json!([1]),
            json!([3]),
            json!([2, 0]),
            json!([0, 0]),
            json!([0.5]),
            json!(["0"]),
        ] {
            data["primaryTextItems"] = invalid;
            assert!(read(&data).primary_text_items.is_none());
        }
    }

    #[test]
    fn preserves_original_wire_field_order_and_opaque_content() {
        let data = json!({
            "timestamp":"time", "toolId":"tool", "content":1e21, "isError":"false",
        });
        let message = ToolResultMessage::from_data(data.as_object().unwrap());
        assert_eq!(
            serde_json::to_string(&message).unwrap(),
            r#"{"timestamp":"time","toolId":"tool","content":1e+21,"isError":true,"type":"tool-result"}"#,
        );
    }
}
