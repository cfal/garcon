use std::{borrow::Cow, collections::HashSet, ptr};

use garcon_contract::{
    chat_types::ToolResultMessage,
    tool_result_content::{ToolResultLimits, is_empty_tool_result, tool_result_text_part},
};
use garcon_js::{array_index, json::as_number, number_to_string, trim, utf16};
use serde_json::{Map, Value};

use super::MAX_TOOL_RESULT_CHARS;

const RESULT_HEAD: usize = 2_000;
const RESULT_TAIL: usize = 512;
const MAX_RECURSIVE_CHARS: usize = 4_000;
const MAX_RECURSIVE_DEPTH: usize = 8;
pub(super) const MAX_RECURSIVE_NODES: usize = 512;

#[derive(Clone, Copy, Default)]
enum Preferred {
    #[default]
    None,
    Result,
    RawOutput,
}

impl Preferred {
    fn fields(self) -> &'static [(&'static str, Self)] {
        match self {
            Self::None => &[],
            Self::Result => &[("raw", Self::None), ("rawOutput", Self::RawOutput)],
            Self::RawOutput => &[("output", Self::None)],
        }
    }
}

pub(super) struct ExtractionBudget {
    remaining: usize,
    nodes: usize,
    indexed_parts: HashSet<*const Map<String, Value>>,
}

impl ExtractionBudget {
    pub(super) fn new(remaining: usize, nodes: usize) -> Self {
        Self {
            remaining,
            nodes,
            indexed_parts: HashSet::new(),
        }
    }

    fn ready(&self) -> bool {
        self.remaining > 0 && self.nodes > 0
    }

    fn consume_node(&mut self, depth: usize) -> bool {
        if !self.ready() {
            return false;
        }
        self.nodes -= 1;
        depth <= MAX_RECURSIVE_DEPTH
    }

    fn take_text(&mut self, text: &str) -> String {
        let selected = text_prefix(text, self.remaining);
        self.remaining -= utf16::len(&selected);
        selected.into_owned()
    }

    fn append_text(&mut self, output: &mut String, text: &str) {
        if text.is_empty() || self.remaining == 0 {
            return;
        }
        self.separator(output);
        output.push_str(&self.take_text(text));
    }

    fn separator(&mut self, output: &mut String) {
        if !output.is_empty() {
            output.push(' ');
            self.remaining -= 1;
        }
    }

    pub(super) fn join(&mut self, fields: impl IntoIterator<Item = impl AsRef<str>>) -> String {
        let mut output = String::new();
        for field in fields {
            self.append_text(&mut output, field.as_ref());
            if self.remaining == 0 {
                break;
            }
        }
        output
    }

    pub(super) fn nested(&mut self, read: impl FnOnce(&mut Self) -> String) -> String {
        let nodes = self.nodes.min(MAX_RECURSIVE_NODES);
        let mut nested = Self::new(self.remaining.min(MAX_RECURSIVE_CHARS), nodes);
        let content = read(&mut nested);
        self.nodes -= nodes - nested.nodes;
        content
    }

    pub(super) fn compound(
        &mut self,
        depth: usize,
        emit: impl FnOnce(&mut Compound<'_>),
    ) -> String {
        if !self.consume_node(depth) {
            return String::new();
        }
        let mut object = Compound {
            budget: self,
            depth,
            output: String::new(),
            started: false,
        };
        emit(&mut object);
        object.output
    }

    pub(super) fn list<T>(
        &mut self,
        values: &[T],
        depth: usize,
        emit: impl Fn(&mut Self, usize, &T) -> String,
    ) -> String {
        self.compound(depth, |array| {
            for item in values {
                if !array.budget.ready() {
                    break;
                }
                array.child(None, |budget, depth| emit(budget, depth, item));
            }
        })
    }

    pub(super) fn optional_strings(&mut self, items: Option<&[String]>, depth: usize) -> String {
        match items {
            Some(items) => self.list(items, depth, |budget, depth, text| budget.text(text, depth)),
            None => self.optional_text(None, depth),
        }
    }

    pub(super) fn text(&mut self, text: &str, depth: usize) -> String {
        if self.consume_node(depth) {
            self.take_text(text)
        } else {
            String::new()
        }
    }

    pub(super) fn optional_text(&mut self, text: Option<&str>, depth: usize) -> String {
        match text {
            Some(text) => self.text(text, depth),
            None => {
                self.consume_node(depth);
                String::new()
            }
        }
    }

    fn scalar(&mut self, value: impl FnOnce() -> String, depth: usize) -> String {
        // JS recurses a second time after converting the scalar to text.
        if self.consume_node(depth) {
            self.text(&value(), depth)
        } else {
            String::new()
        }
    }

    pub(super) fn value(&mut self, value: &Value, depth: usize) -> String {
        self.extract(value, depth, Preferred::None)
    }

    fn extract(&mut self, value: &Value, depth: usize, preferred: Preferred) -> String {
        match value {
            Value::Null => self.optional_text(None, depth),
            Value::String(text) => self.text(text, depth),
            Value::Number(_) => self.scalar(
                || number_to_string(as_number(value).unwrap_or_default()),
                depth,
            ),
            Value::Bool(value) => self.scalar(|| value.to_string(), depth),
            Value::Array(values) => self.list(values, depth, Self::array_element),
            Value::Object(record) => self.compound(depth, |object| {
                let preferred = preferred.fields();
                for &(key, fields) in preferred {
                    let Some(child) = record.get(key) else {
                        continue;
                    };
                    if let Some(text) = child.as_str() {
                        let text = collapse_whitespace(&text_prefix(text, object.budget.remaining));
                        if !text.is_empty() {
                            object.child(Some(key), |budget, depth| budget.text(&text, depth));
                        }
                    } else {
                        object.child(Some(key), |budget, depth| {
                            budget.extract(child, depth, fields)
                        });
                    }
                }
                for key in javascript_keys(record.keys()) {
                    if preferred.iter().any(|(field, _)| *field == key)
                        || (key == "text"
                            && object.budget.indexed_parts.contains(&ptr::from_ref(record)))
                    {
                        continue;
                    }
                    object.child(Some(key), |budget, depth| budget.value(&record[key], depth));
                    if !object.budget.ready() {
                        break;
                    }
                }
            }),
        }
    }

    fn array_element(&mut self, depth: usize, item: &Value) -> String {
        self.value(item, depth)
    }

    pub(super) fn tool_result(&mut self, message: &ToolResultMessage) -> String {
        let content = &message.content;
        if let Some(text) = content.as_str() {
            if text_prefix(text, MAX_TOOL_RESULT_CHARS).as_ref() == text {
                return text.to_owned();
            }
            return format!(
                "{} {}",
                text_prefix(text, RESULT_HEAD),
                text_suffix(text, RESULT_TAIL)
            );
        }
        let mut primary = self.referenced_text(message);
        if primary.is_empty()
            && !message.is_error
            && is_empty_tool_result(
                content,
                Some(ToolResultLimits {
                    max_chars: MAX_TOOL_RESULT_CHARS as f64,
                    max_blocks: MAX_RECURSIVE_NODES as f64,
                }),
            )
        {
            return String::new();
        }
        if !primary.is_empty() && self.remaining > 0 {
            self.remaining -= 1;
        }
        let details = self.extract(content, 0, Preferred::Result);
        if primary.is_empty() {
            return details;
        }
        if !details.is_empty() {
            primary.push(' ');
            primary.push_str(&details);
        }
        primary
    }

    fn referenced_text(&mut self, message: &ToolResultMessage) -> String {
        let (Some(items), Some(indices)) = (
            message.content.get("items").and_then(Value::as_array),
            message.primary_text_items.as_deref(),
        ) else {
            return String::new();
        };
        let mut output = String::new();
        for &index in indices {
            if !self.ready() {
                break;
            }
            self.nodes -= 1;
            let Some(part) = items.get(index).and_then(tool_result_text_part) else {
                continue;
            };
            let text = collapse_whitespace(&text_prefix(part.text, self.remaining));
            self.append_text(&mut output, &text);
            self.indexed_parts.insert(ptr::from_ref(part.raw));
        }
        output
    }
}

pub(super) struct Compound<'a> {
    budget: &'a mut ExtractionBudget,
    depth: usize,
    output: String,
    started: bool,
}

impl Compound<'_> {
    pub(super) fn can_add_field(&self) -> bool {
        !self.started || self.budget.ready()
    }

    pub(super) fn child(
        &mut self,
        key: Option<&str>,
        emit: impl FnOnce(&mut ExtractionBudget, usize) -> String,
    ) {
        if self.budget.remaining == 0 {
            return;
        }
        self.started = true;
        self.budget.separator(&mut self.output);
        if let Some(key) = key.filter(|key| !key.is_empty()) {
            self.output.push_str(&self.budget.take_text(key));
            if self.budget.remaining > 0 {
                self.output.push(' ');
                self.budget.remaining -= 1;
            }
        }
        self.output.push_str(&emit(self.budget, self.depth + 1));
    }

    pub(super) fn field(
        &mut self,
        name: &str,
        emit: impl FnOnce(&mut ExtractionBudget, usize) -> String,
    ) {
        if self.can_add_field() {
            self.child(Some(name), emit);
        }
    }

    pub(super) fn text(&mut self, name: &str, value: &str) {
        self.field(name, |budget, depth| budget.text(value, depth));
    }

    pub(super) fn optional_text(&mut self, name: &str, value: Option<&str>) {
        if let Some(value) = value {
            self.text(name, value);
        }
    }

    pub(super) fn boolean(&mut self, name: &str, value: Option<bool>) {
        self.field(name, |budget, depth| match value {
            Some(value) => budget.scalar(|| value.to_string(), depth),
            None => budget.optional_text(None, depth),
        });
    }

    pub(super) fn number(&mut self, name: &str, value: f64) {
        self.field(name, |budget, depth| {
            budget.scalar(|| number_to_string(value), depth)
        });
    }
}

pub(super) fn collapse_whitespace(text: &str) -> String {
    let mut collapsed = String::new();
    let mut pending_space = false;
    for character in text.chars() {
        if trim(character.encode_utf8(&mut [0; 4])).is_empty() {
            pending_space = !collapsed.is_empty();
        } else {
            if pending_space {
                collapsed.push(' ');
                pending_space = false;
            }
            collapsed.push(character);
        }
    }
    collapsed
}

fn text_prefix(text: &str, units: usize) -> Cow<'_, str> {
    // Three UTF-8 bytes per UTF-16 unit cover the prefix and its boundary.
    let scan = text.floor_char_boundary(text.len().min(3 * units + 4));
    let bounded = &text[..scan];
    let head = utf16::truncate(bounded, units);
    if head.len() < bounded.len() && utf16::len(head) < units {
        Cow::Owned(format!("{head}\u{fffd}"))
    } else {
        Cow::Borrowed(head)
    }
}

fn text_suffix(text: &str, units: usize) -> Cow<'_, str> {
    let start = text.ceil_char_boundary(text.len().saturating_sub(3 * units + 4));
    let bounded = &text[start..];
    let tail = utf16::slice(bounded, -(units as isize), None);
    if tail.len() < bounded.len() && utf16::len(tail) < units {
        Cow::Owned(format!("\u{fffd}{tail}"))
    } else {
        Cow::Borrowed(tail)
    }
}

pub(super) fn javascript_keys<'a>(
    keys: impl Iterator<Item = &'a String> + Clone + 'a,
) -> impl Iterator<Item = &'a str> {
    let mut indices: Vec<_> = keys
        .clone()
        .filter_map(|key| array_index(key).map(|index| (index, key.as_str())))
        .collect();
    indices.sort_by_key(|&(index, _)| index);
    indices.into_iter().map(|(_, key)| key).chain(
        keys.map(String::as_str)
            .filter(|key| array_index(key).is_none()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn integer_index_keys_spend_the_object_budget_first() {
        let value = json!({"b":"bee", "10":"ten", "2":"two"});
        assert_eq!(
            ExtractionBudget::new(10, 512).value(&value, 0),
            "2 two 10 t"
        );
    }
}
