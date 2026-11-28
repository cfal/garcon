//! Recognizes empty tool output within a bounded UTF-16 prefix.

use garcon_js::{trim, utf16};
use serde_json::{Map, Value};

pub use crate::tool_result_message::tool_result_text_part;
use crate::tool_result_message::{ToolTextPart, as_text_part};

fn has_only_fields(value: &Map<String, Value>, first: &str, second: Option<&str>) -> bool {
    value
        .keys()
        .all(|key| key == first || Some(key.as_str()) == second)
}

pub fn is_plain_text_part(value: &Value) -> bool {
    plain_text_part(value).is_some()
}

fn plain_text_part(value: &Value) -> Option<ToolTextPart<'_>> {
    let part = as_text_part(value)?;
    has_only_fields(part.raw, "type", Some("text")).then_some(part)
}

pub fn plain_tool_result_text_part(value: &Value) -> Option<ToolTextPart<'_>> {
    if let Some(part) = plain_text_part(value) {
        return Some(part);
    }
    let raw = value.as_object()?;
    if value["type"] != "content" || !has_only_fields(raw, "type", Some("content")) {
        return None;
    }
    plain_text_part(raw.get("content")?)
}

#[derive(Debug, Clone, Copy)]
pub struct ToolResultLimits {
    pub max_chars: f64,
    pub max_blocks: f64,
}

impl Default for ToolResultLimits {
    fn default() -> Self {
        Self {
            max_chars: f64::INFINITY,
            max_blocks: f64::INFINITY,
        }
    }
}

pub fn is_empty_tool_result(value: &Value, limits: Option<ToolResultLimits>) -> bool {
    if value.is_null() {
        return true;
    }
    let Some(content) = value.as_object() else {
        return false;
    };
    let limit = limits.unwrap_or_default();
    let (mut chars, mut blocks) = (limit.max_chars, limit.max_blocks);
    for (key, value) in content {
        match key.as_str() {
            "raw" | "rawOutput" => {
                let output = if key == "rawOutput"
                    && let Some(raw) = value.as_object()
                {
                    if !has_only_fields(raw, "output", None) {
                        return false;
                    }
                    raw.get("output").and_then(Value::as_str)
                } else {
                    value.as_str()
                };
                if output.is_none_or(|text| !blank_prefix(text, prefix_len(text, limit.max_chars)))
                {
                    return false;
                }
            }
            "items" | "content" => {
                let Some(items) = value.as_array() else {
                    return false;
                };
                for block in items {
                    let before = blocks;
                    blocks -= 1.0;
                    if before <= 0.0 {
                        break;
                    }
                    let Some(part) = plain_tool_result_text_part(block) else {
                        return false;
                    };
                    let units = prefix_len(part.text, chars);
                    if !blank_prefix(part.text, units) {
                        return false;
                    }
                    chars -= units as f64;
                }
            }
            _ => return false,
        }
    }
    true
}

fn prefix_len(text: &str, limit: f64) -> usize {
    let end = limit as isize;
    if end < 0 {
        utf16::len(text).saturating_sub(end.unsigned_abs())
    } else {
        text.encode_utf16().take(end as usize).count()
    }
}

fn blank_prefix(text: &str, mut units: usize) -> bool {
    let mut utf8 = [0; 4];
    for character in text.chars() {
        if units == 0 {
            break;
        }
        // The first half of a surrogate pair is itself non-whitespace.
        if !trim(character.encode_utf8(&mut utf8)).is_empty() {
            return false;
        }
        units -= character.len_utf16();
    }
    true
}
