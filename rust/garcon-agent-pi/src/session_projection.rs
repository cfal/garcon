//! Ports `server-agents/pi/src/agents/pi/session-projection.ts`.

use std::collections::{HashMap, HashSet};

use garcon_base::{
    errors::{ErrorInput, js_string},
    event_loop::EventLoopSteps,
};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{date_parse::date_parse, json::as_number};
use serde_json::{Value, json};

pub fn is_pi_session_entry(value: &Value) -> bool {
    value["type"].is_string()
}

pub struct ProjectedSessionEntry<'a> {
    pub source_entry: &'a Value,
    pub messages: Vec<Value>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum EntryKey<'a> {
    Undefined,
    Null,
    Boolean(bool),
    Number(u64),
    String(&'a str),
    Object(*const Value),
}

impl<'a> From<Option<&'a Value>> for EntryKey<'a> {
    fn from(value: Option<&'a Value>) -> Self {
        match value {
            None => Self::Undefined,
            Some(Value::Null) => Self::Null,
            Some(Value::Bool(value)) => Self::Boolean(*value),
            Some(Value::Number(value)) => {
                let value = value.as_f64().unwrap_or_default();
                Self::Number(if value == 0.0 { 0 } else { value.to_bits() })
            }
            Some(Value::String(value)) => Self::String(value),
            Some(value) => Self::Object(std::ptr::from_ref(value)),
        }
    }
}

pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::Array(_) | Value::Object(_) => true,
    }
}

// Mirrors the pinned SDK's entry semantics in bounded passes.
// https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/session-manager.ts#L468-L584
pub async fn project_pi_history<'a>(
    entries: &'a [Value],
    steps: &mut EventLoopSteps,
) -> ExecutorResult<Vec<ProjectedSessionEntry<'a>>> {
    let context = active_context_entries(entries, steps).await?;
    let mut edits = HashMap::new();
    steps
        .for_each(&context, |entry| {
            if entry["type"] == "context_edit" {
                edits.insert(EntryKey::from(entry.get("targetId")), *entry);
            }
        })
        .await;

    let mut projected = Vec::with_capacity(context.len());
    steps
        .try_for_each(context.into_iter().enumerate(), |(index, source_entry)| {
            let edit = edits.get(&EntryKey::from(source_entry.get("id"))).copied();
            let messages = if source_entry["type"] == "compaction" && index != 0 {
                Vec::new()
            } else {
                project_entry(source_entry, edit)?
            };
            projected.push(ProjectedSessionEntry {
                source_entry,
                messages,
            });
            Ok::<_, Box<dyn std::error::Error>>(())
        })
        .await?;
    Ok(projected)
}

async fn active_context_entries<'a>(
    entries: &'a [Value],
    steps: &mut EventLoopSteps,
) -> ExecutorResult<Vec<&'a Value>> {
    let mut by_id = HashMap::new();
    steps
        .for_each(entries, |entry| {
            by_id.insert(EntryKey::from(entry.get("id")), entry);
        })
        .await;

    let mut reverse_path = Vec::new();
    let mut visited = HashSet::new();
    let mut current = entries.last();
    while let Some(entry) = current {
        if !visited.insert(std::ptr::from_ref(entry)) {
            return Err("Pi transcript parent graph contains a cycle".into());
        }
        reverse_path.push(entry);
        current = entry
            .get("parentId")
            .filter(|parent| truthy(parent))
            .and_then(|parent| by_id.get(&EntryKey::from(Some(parent))).copied());
        steps.next().await;
    }

    let mut path = Vec::with_capacity(reverse_path.len());
    let mut compaction_index = None;
    for entry in reverse_path.into_iter().rev() {
        // The SDK inspects message containers before compaction discards entries.
        if entry["type"] == "message" && entry["message"].is_null() {
            return Err("Pi transcript message entry has no message".into());
        }
        if entry["type"] == "compaction" {
            compaction_index = Some(path.len());
        }
        path.push(entry);
        steps.next().await;
    }

    let Some(compaction_index) = compaction_index else {
        return Ok(path);
    };
    let compaction = path[compaction_index];
    let mut context = vec![compaction];
    let mut retaining = false;
    for (index, entry) in path.into_iter().enumerate() {
        if index < compaction_index {
            if EntryKey::from(entry.get("id")) == EntryKey::from(compaction.get("firstKeptEntryId"))
            {
                retaining = true;
            }
            let system = entry["type"] == "message" && entry["message"]["role"] == "system";
            if retaining && !system {
                context.push(entry);
            }
        } else if index > compaction_index {
            context.push(entry);
        }
        steps.next().await;
    }
    Ok(context)
}

fn project_entry(entry: &Value, edit: Option<&Value>) -> ExecutorResult<Vec<Value>> {
    let mut messages = entry_messages(entry);
    let Some(edit) = edit else {
        return Ok(messages);
    };
    let replacement = edit.get("replacement");
    if replacement == Some(&Value::Null) {
        return Ok(Vec::new());
    }
    for message in &mut messages {
        let role = message["role"].as_str().unwrap_or_default();
        if !matches!(role, "user" | "assistant" | "toolResult" | "custom") {
            continue;
        }
        let replacement = replacement.ok_or("Missing Pi context edit replacement")?;
        let content = replacement.get("content").map(|content| {
            if matches!(role, "assistant" | "toolResult") && content.is_string() {
                json!([{ "type": "text", "text": content }])
            } else {
                content.clone()
            }
        });
        if let Some(object) = message.as_object_mut() {
            match content {
                Some(content) => {
                    object.insert("content".to_owned(), content);
                }
                None => {
                    object.shift_remove("content");
                }
            }
        }
    }
    Ok(messages)
}

fn entry_timestamp(entry: &Value) -> Value {
    let Some(timestamp) = entry.get("timestamp") else {
        return Value::Null;
    };
    let time = match timestamp {
        Value::Null => Some(0),
        Value::Bool(flag) => Some(if *flag { 1 } else { 0 }),
        Value::Number(_) => as_number(timestamp)
            .filter(|time| time.abs() <= 8_640_000_000_000_000.0)
            .map(|time| time as i64),
        Value::String(text) => date_parse(text),
        Value::Array(_) | Value::Object(_) => date_parse(&js_string(ErrorInput::Json(timestamp))),
    };
    json!(time)
}

fn entry_messages(entry: &Value) -> Vec<Value> {
    let mut message = match entry["type"].as_str() {
        Some("message") => {
            let mut message = entry["message"].clone();
            if message["content"].is_null() {
                match message["role"].as_str() {
                    Some("system") => message["content"] = json!(""),
                    Some("user" | "assistant" | "toolResult") => message["content"] = json!([]),
                    _ => {}
                }
            }
            return vec![message];
        }
        Some("custom_message") => {
            let mut message = json!({ "role": "custom" });
            copy_fields(entry, &mut message, &["customType", "content"]);
            if message["content"].is_null() {
                message["content"] = json!([]);
            }
            copy_fields(entry, &mut message, &["display", "details"]);
            message
        }
        Some("branch_summary") if truthy(&entry["summary"]) => {
            let mut message = json!({ "role": "branchSummary" });
            copy_fields(entry, &mut message, &["summary", "fromId"]);
            message
        }
        Some("compaction") => {
            let mut summary = json!({ "role": "compactionSummary" });
            copy_fields(entry, &mut summary, &["summary", "tokensBefore"]);
            summary["timestamp"] = entry_timestamp(entry);
            return if truthy(&entry["systemMessage"]) {
                vec![entry["systemMessage"].clone(), summary]
            } else {
                vec![summary]
            };
        }
        _ => return Vec::new(),
    };
    message["timestamp"] = entry_timestamp(entry);
    vec![message]
}

fn copy_fields(from: &Value, to: &mut Value, fields: &[&str]) {
    if let Some(to) = to.as_object_mut() {
        to.extend(
            fields
                .iter()
                .filter_map(|field| Some(((*field).to_owned(), from.get(*field)?.clone()))),
        );
    }
}
