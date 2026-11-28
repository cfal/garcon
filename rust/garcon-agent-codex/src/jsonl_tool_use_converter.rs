use garcon_agents_common::shared::normalize_util::{normalize_todo_items, normalize_tool_input};
use garcon_contract::{chat_plan::PlanStep, chat_types::ToolUseChatMessage};
use garcon_js::{
    Number,
    json::{Opaque, as_number, from_str},
};
use serde_json::Value;

use crate::{
    subagent_tool_use::convert_codex_subagent_tool_use, user_input::codex_historical_user_input,
};

pub struct ParsedApplyPatch {
    pub file_path: String,
    pub old_string: String,
    pub new_string: String,
}

pub fn convert_codex_wait_function_call(
    timestamp: &str,
    call_id: &str,
    arguments: Option<&Opaque>,
) -> Option<ToolUseChatMessage> {
    wait_from_input(timestamp, call_id, &normalize_tool_input(arguments))
}

fn wait_from_input(timestamp: &str, call_id: &str, input: &Opaque) -> Option<ToolUseChatMessage> {
    let numeric = |key: &str| {
        as_number(&input[key])
            .filter(|value| value.is_finite())
            .map(Number)
    };
    Some(ToolUseChatMessage::Wait {
        timestamp: timestamp.into(),
        tool_id: call_id.into(),
        execution_id: input["cell_id"].as_str()?.into(),
        yield_time_ms: numeric("yield_time_ms"),
        max_tokens: numeric("max_tokens"),
        terminate: input["terminate"].as_bool(),
    })
}

pub fn convert_codex_function_call(timestamp: &str, payload: &Opaque) -> ToolUseChatMessage {
    let name = payload["name"].as_str().unwrap_or("unknown");
    let id = payload["call_id"].as_str().unwrap_or_default();
    let arguments = payload.get("arguments").cloned().map(Opaque::from_value);
    let input = normalize_tool_input(arguments.as_ref());
    if name == "request_user_input" {
        return codex_historical_user_input(timestamp, id, &input);
    }
    if let Some(message) = convert_codex_subagent_tool_use(timestamp, id, name, &input) {
        return message;
    }
    match name {
        "wait" => {
            if let Some(wait) = wait_from_input(timestamp, id, &input) {
                return wait;
            }
        }
        "shell_command" | "exec_command" => {
            if let Some(command) = arguments.as_ref().and_then(shell_command) {
                return ToolUseChatMessage::Bash {
                    timestamp: timestamp.into(),
                    tool_id: id.into(),
                    command,
                    description: None,
                };
            }
        }
        "write_stdin" => {
            return ToolUseChatMessage::WriteStdin {
                timestamp: timestamp.into(),
                tool_id: id.into(),
                input,
            };
        }
        "update_plan" => {
            let raw = ["items", "todos", "plan"]
                .iter()
                .find_map(|key| input.get(*key).filter(|item| !item.is_null()));
            return ToolUseChatMessage::UpdatePlan {
                timestamp: timestamp.into(),
                tool_id: id.into(),
                todos: normalize_plan_steps(raw.unwrap_or(&Value::Null)),
            };
        }
        _ => {}
    }
    unknown_tool(timestamp, id, name, input)
}

pub(crate) fn normalize_plan_steps(raw: &Value) -> Option<Vec<PlanStep>> {
    normalize_todo_items(raw).map(|items| {
        items
            .into_iter()
            .map(|item| PlanStep {
                content: item.content,
                status: item.status.into(),
            })
            .collect()
    })
}

fn shell_command(arguments: &Opaque) -> Option<String> {
    let parsed;
    let object = if let Some(text) = arguments.as_str() {
        parsed = from_str::<Opaque>(if text.is_empty() { "{}" } else { text }).ok()?;
        &parsed
    } else {
        arguments
    };
    ["command", "cmd"].into_iter().find_map(|key| {
        object[key]
            .as_str()
            .filter(|command| !command.is_empty())
            .map(str::to_owned)
    })
}

pub fn convert_codex_custom_tool_call(
    timestamp: &str,
    payload: &Opaque,
    parse_apply_patch: impl FnOnce(&str) -> ParsedApplyPatch,
) -> ToolUseChatMessage {
    let name = payload["name"].as_str().unwrap_or("custom_tool");
    let id = payload["call_id"].as_str().unwrap_or_default();
    let raw = payload.get("input");
    let text = raw.and_then(Value::as_str);
    if name == "exec"
        && let Some(code) = text
    {
        return ToolUseChatMessage::Exec {
            timestamp: timestamp.into(),
            tool_id: id.into(),
            code: code.into(),
            language: "javascript".into(),
        };
    }
    if name == "apply_patch" {
        let parsed = parse_apply_patch(text.unwrap_or_default());
        return ToolUseChatMessage::Edit {
            timestamp: timestamp.into(),
            tool_id: id.into(),
            file_path: Some(parsed.file_path),
            old_string: Some(parsed.old_string),
            new_string: Some(parsed.new_string),
            changes: None,
        };
    }
    let raw = raw.cloned().map(Opaque::from_value);
    unknown_tool(timestamp, id, name, normalize_tool_input(raw.as_ref()))
}

fn unknown_tool(timestamp: &str, id: &str, name: &str, input: Opaque) -> ToolUseChatMessage {
    ToolUseChatMessage::Unknown {
        timestamp: timestamp.into(),
        tool_id: id.into(),
        raw_name: name.into(),
        input,
    }
}
