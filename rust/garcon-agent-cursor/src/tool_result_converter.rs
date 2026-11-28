//! Ports `agents/cursor/tool-result-converter.ts`.

use std::sync::LazyLock;

use garcon_agents_common::{
    acp::event_converter::as_object, shared::normalize_util::normalize_tool_result_content,
};
use garcon_js::{Number, json::Opaque, trim};
use indexmap::IndexSet;
use regress::Regex;
use serde_json::{Map, Value, json};

use crate::json_values::{canonicalize, first_value, number};

fn member<'a>(object: &'a Value, name: &str) -> &'a Value {
    object.get(name).unwrap_or(&Value::Null)
}

fn filenames(value: &Value) -> Option<Vec<&str>> {
    let names: Vec<_> = value
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .filter(|name| !trim(name).is_empty())
        .collect();
    (!names.is_empty()).then_some(names)
}

fn search_success(success: &Map<String, Value>) -> Option<Value> {
    let names = filenames(first_value(success, &["files", "filenames", "paths"]));
    let count = number(first_value(
        success,
        &["totalFiles", "numFiles", "total", "count"],
    ));
    if names.is_none() && count.is_none() {
        return None;
    }
    let names = names.unwrap_or_default();
    Some(json!({"filenames": names, "numFiles": count.unwrap_or(Number(names.len() as f64))}))
}

fn grep_workspace_success(success: &Map<String, Value>) -> Option<Value> {
    let workspaces = success.get("workspaceResults").map(as_object)?;
    if workspaces.is_empty() {
        return None;
    }
    let mut filenames = IndexSet::new();
    let mut matches = Vec::new();
    let mut total_matches = 0.0;
    let mut saw_total_matches = false;
    let mut truncated = false;

    for workspace in workspaces.values() {
        let content = as_object(member(workspace, "content"));
        if let Some(total) = number(first_value(content, &["totalMatchedLines", "totalLines"])) {
            total_matches += total.0;
            saw_total_matches = true;
        }
        truncated |= ["clientTruncated", "ripgrepTruncated"]
            .iter()
            .any(|key| content.get(*key).and_then(Value::as_bool) == Some(true));

        for file_match in content
            .get("matches")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(file) = file_match
                .get("file")
                .and_then(Value::as_str)
                .filter(|file| !file.is_empty())
            else {
                continue;
            };
            filenames.insert(file);
            let lines: Vec<_> = file_match
                .get("matches")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(line_match)
                .collect();
            if !saw_total_matches {
                total_matches += lines.len() as f64;
            }
            matches.push(json!({"file": file, "matches": lines}));
        }
    }
    if filenames.is_empty() && total_matches == 0.0 {
        return None;
    }

    let num_files = filenames.len();
    let mut result = Map::from_iter([
        (
            "filenames".into(),
            json!(filenames.into_iter().collect::<Vec<_>>()),
        ),
        ("numFiles".into(), json!(num_files)),
        ("totalMatches".into(), json!(Number(total_matches))),
        ("matches".into(), json!(matches)),
    ]);
    for key in ["pattern", "path"] {
        if let Some(value) = success
            .get(key)
            .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()))
        {
            result.insert(key.into(), value.clone());
        }
    }
    if truncated {
        result.insert("truncated".into(), json!(true));
    }
    Some(result.into())
}

fn line_match(raw: &Value) -> Option<Value> {
    let mut line = Map::new();
    if let Some(number) = number(member(raw, "lineNumber")) {
        line.insert("lineNumber".into(), json!(number));
    }
    if let Some(content) = member(raw, "content").as_str() {
        line.insert("content".into(), json!(content));
    }
    for key in ["contentTruncated", "isContextLine"] {
        if let Some(flag) = member(raw, key).as_bool() {
            line.insert(key.into(), json!(flag));
        }
    }
    (!line.is_empty()).then_some(line.into())
}

fn search_text(raw: &str) -> Option<Value> {
    static TOTAL: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: constant pattern from the original.
        Regex::with_flags(r"\btotal\s+(\d+)\s+files?\b", "i").expect("valid search total pattern")
    });
    let filenames: Vec<_> = raw
        .split('\n')
        .map(trim)
        .filter_map(|line| line.strip_prefix("- "))
        .map(trim)
        .filter(|name| !name.is_empty())
        .collect();
    let count = TOTAL
        .find(raw)
        .and_then(|matched| matched.group(1))
        .map(|range| garcon_js::string_to_number(&raw[range]));
    if filenames.is_empty() && count.is_none() {
        return None;
    }
    let count = count
        .filter(|num| num.is_finite())
        .unwrap_or(filenames.len() as f64);
    Some(json!({"filenames": filenames, "numFiles": Number(count)}))
}

pub fn normalize_cursor_tool_result_content(
    tool_name: &Value,
    raw: Option<&Opaque>,
    high_level: Option<&Value>,
) -> Opaque {
    let kind = canonicalize(tool_name.as_str().unwrap_or_default());
    let high_level = high_level.map_or(&Value::Null, |raw| member(raw, "output"));
    let raw_value = raw.map_or(&Value::Null, Opaque::as_value);
    let success = [high_level, raw_value]
        .into_iter()
        .map(|value| as_object(member(value, "success")))
        .find(|value| !value.is_empty());

    if matches!(kind.as_str(), "glob" | "grep" | "search" | "searchfiles") {
        if let Some(result) = success
            .and_then(|success| grep_workspace_success(success).or_else(|| search_success(success)))
        {
            return result.into();
        }
        let normalized = normalize_tool_result_content(raw);
        if let Some(wire) = normalized
            .get("raw")
            .and_then(Value::as_str)
            .and_then(search_text)
        {
            return wire.into();
        }
        return normalized;
    }

    if kind == "read"
        && let Some(success) = success
    {
        return Value::Object(
            ["content", "path", "totalLines", "fileSize", "readRange"]
                .into_iter()
                .filter_map(|key| Some((key.to_owned(), success.get(key)?.clone())))
                .collect(),
        )
        .into();
    }
    normalize_tool_result_content(raw)
}
