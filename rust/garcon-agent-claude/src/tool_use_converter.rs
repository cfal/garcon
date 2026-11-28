use garcon_contract::{
    chat_message_coercion::{as_allowed_prompts, as_optional_changes, as_optional_string_array},
    chat_plan::{PlanStep, coerce_todo_items},
    chat_types::{
        AskUserQuestionOption, AskUserQuestionPrompt, BackgroundTaskAction, ToolUseChatMessage,
    },
    tool_schedule::{ToolScheduleRequest, parse_tool_schedule_request},
};
use garcon_js::{
    Number,
    json::{self, Opaque},
};
use num_bigint::BigUint;
use num_traits::ToPrimitive;
use serde_json::{Map, Value};

fn string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn first_present<'a>(input: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter()
        .find_map(|key| input.get(key).filter(|value| !value.is_null()))
        .unwrap_or(&Value::Null)
}

fn as_input(value: &Value) -> Opaque {
    let fields = match value {
        Value::Object(fields) => fields.clone(),
        Value::String(raw) if !raw.is_empty() => match json::from_str(raw) {
            Ok(Value::Object(fields)) => fields,
            _ => Map::from_iter([("raw".to_owned(), value.clone())]),
        },
        _ => Map::new(),
    };
    Opaque::from_value(Value::Object(fields))
}

fn claude_ask_user_questions(value: &Value) -> Vec<AskUserQuestionPrompt> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|raw| {
            let question = string(&raw["question"]).filter(|text| !text.is_empty())?;
            let options = raw["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|option| {
                    let label = string(&option["label"]).filter(|text| !text.is_empty())?;
                    Some(AskUserQuestionOption {
                        id: label.clone(),
                        label,
                        description: string(&option["description"]),
                        preview: string(&option["preview"]),
                    })
                })
                .collect();
            Some(AskUserQuestionPrompt {
                id: question.clone(),
                prompt: question,
                options,
                header: string(&raw["header"]).filter(|text| !text.is_empty()),
                allow_multiple: raw["multiSelect"].as_bool(),
                allow_free_text: None,
                allow_notes: None,
                is_secret: None,
            })
        })
        .collect()
}

fn cron_boolean(value: &Value) -> Value {
    match value.as_str() {
        Some("true") => Value::Bool(true),
        Some("false") => Value::Bool(false),
        _ => value.clone(),
    }
}

fn decimal_delay(value: &Value) -> Value {
    let Some(text) = value.as_str().map(garcon_js::trim) else {
        return value.clone();
    };
    let unsigned = text.strip_prefix(['-', '+']).unwrap_or(text);
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let valid = unsigned.split_once('.').map_or_else(
        || digits(unsigned),
        |(whole, fraction)| digits(whole) && digits(fraction),
    );
    if valid && let Ok(delay) = text.parse::<f64>() {
        return serde_json::Number::from_f64(delay).map_or(Value::Null, Value::Number);
    }
    value.clone()
}

fn schedule_request(key: &str, raw_input: Option<&Value>) -> Option<ToolScheduleRequest> {
    let empty = Map::new();
    let input = match raw_input {
        Some(value) => value.as_object()?,
        None => &empty,
    };
    let only = |fields: &[&str]| input.keys().all(|name| fields.contains(&name.as_str()));
    let request = match key {
        "schedulewakeup" if input.get("stop") == Some(&Value::Bool(true)) && only(&["stop"]) => {
            serde_json::json!({ "action": "stop-loop" })
        }
        "schedulewakeup"
            if only(&["stop", "delaySeconds", "prompt", "reason", "noop"])
                && input.get("stop").is_none_or(|v| v == &Value::Bool(false))
                && input.get("reason").is_some_and(Value::is_string) =>
        {
            let mut request = Map::from_iter([("action".into(), Value::String("wakeup".into()))]);
            for field in ["delaySeconds", "prompt", "reason", "noop"] {
                if let Some(value) = input.get(field) {
                    request.insert(
                        field.to_owned(),
                        if field == "delaySeconds" {
                            decimal_delay(value)
                        } else {
                            value.clone()
                        },
                    );
                }
            }
            Value::Object(request)
        }
        "croncreate" if only(&["cron", "prompt", "recurring", "durable"]) => {
            let mut request = Map::from_iter([("action".into(), Value::String("cron".into()))]);
            for (native, wire) in [("cron", "expression"), ("prompt", "prompt")] {
                if let Some(value) = input.get(native) {
                    request.insert(wire.to_owned(), value.clone());
                }
            }
            request.insert(
                "recurring".into(),
                input
                    .get("recurring")
                    .map_or(Value::Bool(true), cron_boolean),
            );
            if let Some(durable) = input.get("durable") {
                request.insert("durable".into(), cron_boolean(durable));
            }
            Value::Object(request)
        }
        "cronlist" if only(&[]) => serde_json::json!({ "action": "list" }),
        "crondelete" if only(&["id"]) => {
            serde_json::json!({ "action": "delete", "jobId": input.get("id")? })
        }
        _ => return None,
    };
    parse_tool_schedule_request(&request)
}

pub fn convert_claude_tool_use(timestamp: &str, part: &Value) -> ToolUseChatMessage {
    let raw_name = part["name"].as_str().unwrap_or("Unknown");
    let tool_id = part["id"].as_str().unwrap_or_default().to_owned();
    let timestamp = timestamp.to_owned();
    let input = &part["input"];
    let key: String = raw_name
        .to_lowercase()
        .chars()
        .filter(|&ch| {
            !matches!(ch, '_' | '-') && !garcon_js::trim(ch.encode_utf8(&mut [0; 4])).is_empty()
        })
        .collect();
    use ToolUseChatMessage as Row;
    let text = |key| string(&input[key]);
    let first = |keys: &[&str]| string(first_present(input, keys));

    match key.as_str() {
        "schedulewakeup" | "croncreate" | "cronlist" | "crondelete" => {
            if let Some(request) = schedule_request(&key, part.get("input")) {
                return Row::Schedule {
                    timestamp,
                    tool_id,
                    request,
                    native_name: Some(raw_name.to_owned()),
                };
            }
            let fields = part.get("input").map_or_else(Map::new, |raw| {
                raw.as_object()
                    .cloned()
                    .unwrap_or_else(|| Map::from_iter([("raw".to_owned(), raw.clone())]))
            });
            return Row::Unknown {
                timestamp,
                tool_id,
                raw_name: raw_name.to_owned(),
                input: Opaque::from_value(Value::Object(fields)),
            };
        }
        "toolsearch" => {
            return Row::ClaudeToolSearch {
                timestamp,
                tool_id,
                query: text("query").unwrap_or_default(),
                max_results: as_number(&input["max_results"]),
            };
        }
        "monitor" => {
            return Row::ClaudeMonitor {
                timestamp,
                tool_id,
                description: text("description").unwrap_or_default(),
                timeout_ms: as_number(&input["timeout_ms"]),
                command: text("command"),
                web_socket_url: string(&input["ws"]["url"]),
                web_socket_protocols: as_optional_string_array(&input["ws"]["protocols"]),
                persistent: input["persistent"].as_bool(),
                allowed_domains: as_optional_string_array(&input["allowed_domains"]),
            };
        }
        "bash" | "shellcommand" | "execcommand" => {
            if let Some(command) = text("command") {
                return Row::Bash {
                    timestamp,
                    tool_id,
                    command,
                    description: text("description"),
                };
            }
        }
        "read" => {
            if let Some(file_path) = first(&["file_path", "filePath", "path"]) {
                return Row::Read {
                    timestamp,
                    tool_id,
                    file_path,
                    offset: as_number(first_present(input, &["offset", "start_line", "startLine"])),
                    limit: as_number(first_present(input, &["limit", "num_lines", "numLines"])),
                    end_line: as_number(first_present(input, &["end_line", "endLine"])),
                };
            }
        }
        "edit" => {
            return Row::Edit {
                timestamp,
                tool_id,
                file_path: first(&["file_path", "filePath"]),
                old_string: first(&["old_string", "oldString"]),
                new_string: first(&["new_string", "newString"]),
                changes: as_optional_changes(&input["changes"]),
            };
        }
        "write" => {
            if let Some(file_path) = first(&["file_path", "filePath"]) {
                return Row::Write {
                    timestamp,
                    tool_id,
                    file_path,
                    content: text("content"),
                };
            }
        }
        "applypatch" => {
            return Row::ApplyPatch {
                timestamp,
                tool_id,
                file_path: first(&["file_path", "filePath"]),
                old_string: first(&["old_string", "oldString"]),
                new_string: first(&["new_string", "newString"]),
                patch: None,
            };
        }
        "grep" => {
            return Row::Grep {
                timestamp,
                tool_id,
                pattern: text("pattern"),
                path: text("path"),
            };
        }
        "glob" => {
            return Row::Glob {
                timestamp,
                tool_id,
                pattern: text("pattern"),
                path: text("path"),
            };
        }
        "websearch" => {
            if let Some(query) = text("query") {
                return Row::WebSearch {
                    timestamp,
                    tool_id,
                    query,
                };
            }
        }
        "webfetch" => {
            if let Some(url) = text("url") {
                return Row::WebFetch {
                    timestamp,
                    tool_id,
                    url,
                    prompt: text("prompt"),
                };
            }
        }
        "todowrite" => {
            return Row::TodoWrite {
                timestamp,
                tool_id,
                todos: coerce_todo_items(first_present(input, &["todos", "items"])),
            };
        }
        "todoread" => return Row::TodoRead { timestamp, tool_id },
        "taskstop" => {
            if let Some(id) = first(&["task_id", "shell_id"]).filter(|id| !id.is_empty()) {
                return Row::BackgroundTask {
                    timestamp,
                    tool_id,
                    action: BackgroundTaskAction::Stop,
                    task_id: Some(id),
                    input: None,
                };
            }
        }
        "agent" | "task" => {
            return Row::Task {
                timestamp,
                tool_id,
                subagent_type: first(&["subagent_type", "subagentType"]),
                description: text("description"),
                prompt: text("prompt"),
                model: text("model"),
                resume: text("resume"),
            };
        }
        "updateplan" => {
            return Row::UpdatePlan {
                timestamp,
                tool_id,
                todos: coerce_todo_items(first_present(input, &["items", "todos"])).map(|todos| {
                    todos
                        .into_iter()
                        .map(|todo| PlanStep {
                            content: todo.content,
                            status: todo.status.into(),
                        })
                        .collect()
                }),
            };
        }
        "writestdin" => {
            return Row::WriteStdin {
                timestamp,
                tool_id,
                input: Opaque::from_value(Value::Object(
                    input.as_object().cloned().unwrap_or_default(),
                )),
            };
        }
        "enterplanmode" | "planenter" => return Row::EnterPlanMode { timestamp, tool_id },
        "exitplanmode" | "exitplan" | "planexit" => {
            if let Some(plan) = text("plan") {
                return Row::ExitPlanMode {
                    timestamp,
                    tool_id,
                    plan,
                    allowed_prompts: as_allowed_prompts(&input["allowedPrompts"]),
                };
            }
        }
        "askuserquestion" => {
            let questions = claude_ask_user_questions(&input["questions"]);
            if !questions.is_empty() {
                return Row::AskUserQuestion {
                    timestamp,
                    tool_id,
                    title: text("title"),
                    questions,
                };
            }
        }
        _ => {}
    }
    Row::Unknown {
        timestamp,
        tool_id,
        raw_name: raw_name.to_owned(),
        input: as_input(input),
    }
}

fn as_number(value: &Value) -> Option<Number> {
    let n = match value {
        Value::String(raw) => {
            let text = garcon_js::trim(raw);
            if text.is_empty() {
                0.0
            } else if let Some((radix, digits)) =
                [(16, ['x', 'X']), (8, ['o', 'O']), (2, ['b', 'B'])]
                    .into_iter()
                    .find_map(|(radix, prefix)| {
                        Some((radix, text.strip_prefix('0')?.strip_prefix(prefix)?))
                    })
            {
                if digits.is_empty() || !digits.chars().all(|ch| ch.is_digit(radix)) {
                    return None;
                }
                BigUint::parse_bytes(digits.as_bytes(), radix)?.to_f64()?
            } else {
                text.parse::<f64>().ok()?
            }
        }
        _ => json::as_number(value)?,
    };
    n.is_finite().then_some(Number(n))
}
