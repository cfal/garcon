//! Ports `agents/cursor/tool-use-converter.ts`.

use garcon_agents_common::{
    acp::event_converter::as_object,
    shared::normalize_util::{normalize_todo_items, normalize_tool_input},
};
use garcon_contract::{
    chat_message_coercion::as_optional_changes, chat_plan::PlanStep, chat_types::ToolUseChatMessage,
};
use garcon_js::{
    json::{Opaque, parse},
    trim,
};
use serde_json::{Map, Value};

use crate::json_values::{canonicalize, first_value, number, string};

const CALL_ID: &[&str] = &["call_id", "callId", "toolCallId", "tool_call_id", "id"];
const INPUT: &[&str] = &["args", "input", "parameters"];
const OLD: &[&str] = &["old_string", "oldString", "old"];
const NEW: &[&str] = &["new_string", "newString", "new"];

fn display_name_from_wrapper_key(key: &str) -> String {
    const SUFFIX: &str = "ToolCall";
    let base = key
        .get(key.len().saturating_sub(SUFFIX.len())..)
        .filter(|tail| tail.eq_ignore_ascii_case(SUFFIX))
        .and_then(|tail| key.get(..key.len() - tail.len()))
        .unwrap_or(key);
    let alias = match canonicalize(base).as_str() {
        "shell" | "terminal" | "execute" | "runcommand" => "Bash",
        "ls" | "listdirectory" => "LS",
        "searchfiles" => "Grep",
        "fetchurl" => "WebFetch",
        _ => {
            let mut iter = base.chars();
            return iter.next().map_or_else(String::new, |first| {
                if first.len_utf16() == 2 {
                    return base.to_owned();
                }
                first.to_uppercase().chain(iter).collect()
            });
        }
    };
    alias.to_owned()
}

fn extract_wrapped_tool(raw: &Map<String, Value>) -> Option<(&str, &Value)> {
    const WRAPPERS: [&str; 4] = ["tool_call", "toolCall", "tool_call_delta", "toolCallDelta"];
    WRAPPERS
        .iter()
        .filter_map(|key| raw.get(*key))
        .map(as_object)
        .chain([raw])
        .find_map(|object| {
            object
                .iter()
                .find(|(key, _)| key.to_lowercase().ends_with("toolcall"))
        })
        .map(|(key, value)| (key.as_str(), value))
}

fn file_path(input: &Map<String, Value>) -> Option<String> {
    string(
        input,
        &["file_path", "filePath", "path", "file", "filename"],
    )
}

fn first_edit(input: &Map<String, Value>) -> (Option<String>, Option<String>) {
    let old = string(
        input,
        &["old_string", "oldString", "old", "search", "original"],
    );
    let new = string(
        input,
        &["new_string", "newString", "new", "replace", "content"],
    );
    if old.is_some() || new.is_some() {
        return (old, new);
    }
    let Some([edit]) = input
        .get("edits")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
    else {
        return (None, None);
    };
    let edit = as_object(edit);
    (
        string(edit, &["old_string", "oldString", "oldText", "old"]),
        string(edit, &["new_string", "newString", "newText", "new"]),
    )
}

pub fn convert_cursor_tool_use(timestamp: &str, part: &Value) -> ToolUseChatMessage {
    let raw = as_object(part);
    let wrapped = extract_wrapped_tool(raw);
    let tool = wrapped.map_or(raw, |(_, tool)| as_object(tool));
    let name = string(raw, &["toolName", "name", "tool"])
        .or_else(|| {
            wrapped.map(|(key, _)| {
                string(tool, &["toolName", "name"])
                    .unwrap_or_else(|| display_name_from_wrapper_key(key))
            })
        })
        .unwrap_or_else(|| "Unknown".into());
    let tool_id = string(raw, CALL_ID)
        .or_else(|| string(tool, CALL_ID))
        .unwrap_or_default();
    let empty = Value::Object(Map::new());
    let input = wrapped
        .map(|(_, value)| {
            let nested = first_value(tool, INPUT);
            if !nested.is_null() {
                nested
            } else if value.is_object() {
                value
            } else {
                &empty
            }
        })
        .unwrap_or_else(|| first_value(raw, INPUT));
    let parsed = input
        .as_str()
        .map(trim)
        .filter(|value| !value.is_empty())
        .and_then(|text| parse(text).ok());
    let input = parsed.as_ref().unwrap_or(input);
    let timestamp = timestamp.to_owned();
    typed_tool(
        timestamp.clone(),
        tool_id.clone(),
        &canonicalize(&name),
        as_object(input),
    )
    .unwrap_or_else(|| ToolUseChatMessage::Unknown {
        timestamp,
        tool_id,
        raw_name: name,
        input: normalize_tool_input(Some(&Opaque::from_value(input.clone()))),
    })
}

fn typed_tool(
    timestamp: String,
    tool_id: String,
    key: &str,
    input: &Map<String, Value>,
) -> Option<ToolUseChatMessage> {
    use ToolUseChatMessage as Tool;
    let text = |keys: &[&str]| string(input, keys);
    let num = |keys: &[&str]| number(first_value(input, keys));
    let path = || text(&["path", "cwd"]);
    Some(match key {
        "bash" | "shell" | "terminal" | "execute" | "runcommand" => Tool::Bash {
            timestamp,
            tool_id,
            command: text(&["command", "cmd", "script"])?,
            description: text(&["description"]),
        },
        "read" => Tool::Read {
            timestamp,
            tool_id,
            file_path: file_path(input)?,
            offset: num(&["offset", "start_line", "startLine"]),
            limit: num(&["limit", "num_lines", "numLines"]),
            end_line: num(&["end_line", "endLine"]),
        },
        "ls" | "list" | "listdirectory" | "readdir" => Tool::List {
            timestamp,
            tool_id,
            path: file_path(input),
        },
        "write" | "create" => Tool::Write {
            timestamp,
            tool_id,
            file_path: file_path(input)?,
            content: text(&[
                "content",
                "text",
                "value",
                "contents",
                "fileContent",
                "new_string",
                "newString",
            ]),
        },
        "edit" => {
            let (old_string, new_string) = first_edit(input);
            Tool::Edit {
                timestamp,
                tool_id,
                file_path: file_path(input),
                old_string,
                new_string,
                changes: as_optional_changes(first_value(input, &["changes"])),
            }
        }
        "applypatch" | "patch" => Tool::ApplyPatch {
            timestamp,
            tool_id,
            file_path: file_path(input),
            old_string: text(OLD),
            new_string: text(NEW),
            patch: text(&["patch", "diff", "content"]),
        },
        "grep" | "search" | "searchfiles" => Tool::Grep {
            timestamp,
            tool_id,
            pattern: text(&["pattern", "query", "search", "regex"]),
            path: path(),
        },
        "glob" | "find" | "fileglob" => Tool::Glob {
            timestamp,
            tool_id,
            pattern: text(&[
                "pattern",
                "glob_pattern",
                "globPattern",
                "filePattern",
                "glob",
                "query",
            ]),
            path: path(),
        },
        "websearch" => Tool::WebSearch {
            timestamp,
            tool_id,
            query: text(&["query"])?,
        },
        "webfetch" | "fetchurl" | "fetch" => Tool::WebFetch {
            timestamp,
            tool_id,
            url: text(&["url"])?,
            prompt: text(&["prompt", "objective"]),
        },
        "todowrite" => Tool::TodoWrite {
            timestamp,
            tool_id,
            todos: normalize_todo_items(first_value(input, &["todos", "items"])),
        },
        "todoread" => Tool::TodoRead { timestamp, tool_id },
        "updateplan" => Tool::UpdatePlan {
            timestamp,
            tool_id,
            todos: normalize_todo_items(first_value(input, &["items", "todos"])).map(|items| {
                items
                    .into_iter()
                    .map(|item| PlanStep {
                        content: item.content,
                        status: item.status.into(),
                    })
                    .collect()
            }),
        },
        "task" => Tool::Task {
            timestamp,
            tool_id,
            subagent_type: text(&["subagent_type", "subagentType"]),
            description: text(&["description"]),
            prompt: text(&["prompt"]),
            model: text(&["model"]),
            resume: text(&["resume"]),
        },
        _ => return None,
    })
}
