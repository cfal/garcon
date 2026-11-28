//! Ports `server-agents/opencode/src/agents/opencode/tool-result-converter.ts`.

use std::borrow::Cow;

use garcon_agents_common::shared::normalize_util::normalize_tool_result_content;
use garcon_js::{json::Opaque, string_to_number, trim};
use indexmap::IndexSet;
use serde_json::{Map, Value};

use crate::js::{is_js_whitespace, prop, string_of, strip_name_separators};

fn as_number(value: &Value) -> Option<f64> {
    value
        .as_str()
        .map(string_to_number)
        .or_else(|| garcon_js::json::as_number(value))
        .filter(|number| number.is_finite())
}

fn output_lines(output: &Value) -> Vec<Cow<'_, str>> {
    if let Some(lines) = output.as_array() {
        return lines
            .iter()
            .map(|line| match string_of(Some(line)) {
                Cow::Borrowed(line) => Cow::Borrowed(trim(line)),
                Cow::Owned(line) => Cow::Owned(trim(&line).to_owned()),
            })
            .filter(|line| !line.is_empty())
            .collect();
    }
    output
        .as_str()
        .unwrap_or_default()
        .split('\n')
        .map(trim)
        .filter(|line| !line.is_empty())
        .map(Cow::Borrowed)
        .collect()
}

fn is_glob_path_line(line: &str) -> bool {
    line != "No files found"
        && !line.starts_with("(Results are truncated")
        && !line.starts_with("(Output capped")
        && !(line.starts_with('(') && line.ends_with(')'))
}

fn grep_path_line(line: &str) -> Option<&str> {
    let path = line.strip_suffix(':')?;
    let (first, rest) = path.split_at(path.chars().next()?.len_utf8());
    (!matches!(first, " " | "\t") && !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
        .then_some(path)
}

// `/^Found\s+(\d+)\s+matches/i` checks only a prefix of the header.
fn grep_header_count(first_line: &str) -> Option<f64> {
    let prefix = first_line.get(..5)?;
    if !prefix.eq_ignore_ascii_case("Found") {
        return None;
    }
    let rest = first_line.get(5..)?;
    let rest = after_whitespace(rest)?;
    let digits_end = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits_end == 0 {
        return None;
    }
    let (digits, rest) = rest.split_at(digits_end);
    let word = after_whitespace(rest)?.get(..7)?;
    word.eq_ignore_ascii_case("matches")
        .then(|| string_to_number(digits))
}

fn after_whitespace(text: &str) -> Option<&str> {
    let remainder = text.trim_start_matches(is_js_whitespace);
    (remainder.len() < text.len()).then_some(remainder)
}

fn normalize_glob_result(state: &Value, output: &Value) -> Map<String, Value> {
    let (filenames, count): (Vec<Value>, Option<f64>) =
        if let Some(filenames) = prop(state, "filenames").as_array() {
            let count = prop(state, "numFiles");
            let count = if count.is_null() {
                prop(state, "count")
            } else {
                count
            };
            (
                filenames
                    .iter()
                    .filter(|name| name.is_string())
                    .cloned()
                    .collect(),
                as_number(count),
            )
        } else {
            let count = prop(prop(state, "metadata"), "count");
            (
                output_lines(output)
                    .into_iter()
                    .filter(|line| is_glob_path_line(line))
                    .map(|line| Value::String(line.into_owned()))
                    .collect(),
                as_number(count),
            )
        };
    search_result(filenames, count)
}

fn normalize_grep_result(state: &Value, output: &Value) -> Map<String, Value> {
    let lines = output_lines(output);
    let filenames = lines
        .iter()
        .filter_map(|line| grep_path_line(line))
        .collect::<IndexSet<_>>()
        .into_iter()
        .map(Value::from)
        .collect();
    let matches = as_number(prop(prop(state, "metadata"), "matches"))
        .or_else(|| lines.first().and_then(|line| grep_header_count(line)))
        .unwrap_or(0.0);
    let mut result = search_result(filenames, None);
    result.insert("totalMatches".to_owned(), Value::from(matches));
    result
}

fn search_result(filenames: Vec<Value>, count: Option<f64>) -> Map<String, Value> {
    let count = count.map_or_else(|| Value::from(filenames.len()), Value::from);
    Map::from_iter([
        ("filenames".to_owned(), Value::Array(filenames)),
        ("numFiles".to_owned(), count),
    ])
}

pub fn normalize_open_code_tool_result_content(tool_name: &Value, state: &Value) -> Opaque {
    let output = match state {
        Value::String(_) => Cow::Borrowed(state),
        Value::Array(lines) => Cow::Owned(Value::String(
            lines
                .iter()
                .map(|line| {
                    if line.is_null() {
                        Cow::Borrowed("")
                    } else {
                        string_of(Some(line))
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"),
        )),
        _ => Cow::Borrowed(prop(state, "output")),
    };
    let key = strip_name_separators(tool_name.as_str().unwrap_or_default());
    if prop(state, "status").as_str() != Some("error") {
        match key.as_str() {
            "glob" | "globtooluse" => {
                return Value::Object(normalize_glob_result(state, &output)).into();
            }
            "grep" | "greptooluse" => {
                return Value::Object(normalize_grep_result(state, &output)).into();
            }
            _ => {}
        }
    }
    normalize_tool_result_content(Some(&Opaque::from_value(output.into_owned())))
}
