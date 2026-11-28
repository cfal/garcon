//! Ports `server-agents/antigravity/src/agents/antigravity/tool-use-converter.ts`.

use std::borrow::Cow;

use garcon_agents_common::acp::event_converter::{as_object, as_string};
use garcon_contract::chat_plan::{PlanStep, PlanStepStatus};
use garcon_contract::chat_types::{ToolUseChatMessage, parse_tool_use_message};
use garcon_contract::tool_schedule::parse_tool_schedule_request;
use garcon_js::json::{Opaque, as_number};
use garcon_js::{Number, OptionalNullable};
use serde::Serialize;
use serde_json::{Map, Value, json};

pub const ANTIGRAVITY_TOOL_NAMESPACE: &str = "antigravity";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanTitle {
    Matched,
    Excluded,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityToolCall {
    pub tool_call_id: String,
    pub name: Option<String>,
    pub plan_title: Option<PlanTitle>,
    pub is_mcp: bool,
    pub kind: Option<String>,
    pub input: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_input: Option<Opaque>,
}

fn field<'a>(input: &'a Map<String, Value>, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| input.get(*name))
}

fn string_field(input: &Map<String, Value>, names: &[&str]) -> Option<String> {
    field(input, names).and_then(as_string).map(str::to_owned)
}

fn plan_field(input: &Map<String, Value>, key: &str, alias: &str) -> Option<String> {
    if let (Some(primary), Some(secondary)) = (input.get(key), input.get(alias))
        && !strict_equal(primary, secondary)
    {
        return None;
    }
    string_field(input, &[key, alias])
}

fn strict_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(_), Value::Number(_)) => as_number(left) == as_number(right),
        (Value::Object(_), Value::Object(_)) | (Value::Array(_), Value::Array(_)) => {
            std::ptr::eq(left, right)
        }
        _ => left == right,
    }
}

fn schedule_arguments(input: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut args = Map::new();
    for (key, value) in input {
        let name = match key.as_str() {
            "DurationSeconds" | "duration_seconds" => "delaySeconds",
            "CronExpression" | "cron_expression" => "expression",
            "Prompt" | "prompt" => "prompt",
            "TimerCondition" | "timer_condition" => "timerCondition",
            "IsDaemon" | "is_daemon" => "daemon",
            "MaxIterations" | "max_iterations" => "maxIterations",
            "ExactTiming" | "exact_timing" => "exactTiming",
            _ => return None,
        };
        if args
            .get(name)
            .is_some_and(|previous| !strict_equal(previous, value))
        {
            return None;
        }
        args.insert(name.to_owned(), value.clone());
    }
    Some(args)
}

pub fn antigravity_mcp_arguments(input: &Map<String, Value>) -> Option<&Map<String, Value>> {
    ["arguments", "args", "Arguments"]
        .into_iter()
        .filter_map(|name| input.get(name))
        .find(|value| !value.is_null())?
        .as_object()
}

pub fn antigravity_tool_name(call: &AntigravityToolCall) -> Option<&str> {
    call.name
        .as_deref()
        .or_else(|| (call.plan_title == Some(PlanTitle::Matched)).then_some("update_steps"))
}

fn line_field(input: &Map<String, Value>, names: &[&str]) -> Option<Number> {
    let value = as_number(field(input, names)?)?;
    (garcon_js::is_integer(value) && value > 0.0).then_some(Number(value))
}

fn antigravity_plan_steps(raw: &Value) -> Option<Vec<PlanStep>> {
    raw.as_array()?
        .iter()
        .map(|step| {
            let step = as_object(step);
            let content = step.get("title")?.as_str()?.to_owned();
            let status = match step.get("status")?.as_str()? {
                "done" => PlanStepStatus::Completed,
                "pending" => PlanStepStatus::Pending,
                "in_progress" => PlanStepStatus::InProgress,
                "failed" => PlanStepStatus::Failed,
                "skipped" => PlanStepStatus::Skipped,
                _ => return None,
            };
            Some(PlanStep { content, status })
        })
        .collect()
}

/// Reads the identity from a tool update or a permission request.
pub fn antigravity_tool_call(raw: &Map<String, Value>) -> Option<AntigravityToolCall> {
    let tool_call_id = raw
        .get("toolCallId")?
        .as_str()
        .filter(|id| !id.is_empty())?
        .to_owned();
    let is_mcp = raw
        .get("_meta")
        .and_then(|meta| meta.get("is_mcp_tool_call"))
        .and_then(Value::as_bool)
        == Some(true);
    let kind = raw.get("kind");
    let plan_title =
        if is_mcp || kind.is_some_and(|kind| truthy(kind) && kind.as_str() != Some("other")) {
            Some(PlanTitle::Excluded)
        } else if raw.get("title").and_then(Value::as_str) == Some("Run update_steps") {
            Some(PlanTitle::Matched)
        } else {
            None
        };
    let raw_input = match raw.get("args") {
        None => raw.get("rawInput"),
        Some(args) => raw
            .get("rawInput")
            .filter(|input| !input.is_null())
            .or(Some(args)),
    };
    Some(AntigravityToolCall {
        tool_call_id,
        name: raw.get("name").and_then(as_string).map(str::to_owned),
        plan_title,
        is_mcp,
        kind: kind.and_then(as_string).map(str::to_owned),
        input: raw_input.map(as_object).cloned().unwrap_or_default(),
        raw_input: raw_input.cloned().map(Opaque::from_value),
    })
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(_) => as_number(value) != Some(0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

pub fn reports_plan_or_schedule(name: Option<&str>) -> bool {
    matches!(
        name,
        Some("schedule" | "enter_plan_mode" | "exit_plan_mode")
    )
}

pub fn convert_antigravity_tool_use(
    timestamp: &str,
    call: &AntigravityToolCall,
) -> ToolUseChatMessage {
    let id = &call.tool_call_id;
    if let Some(server) = call
        .input
        .get("server")
        .and_then(as_string)
        .filter(|server| !server.is_empty())
        && let Some(tool) = call
            .input
            .get("tool")
            .and_then(as_string)
            .filter(|tool| !tool.is_empty())
    {
        return mcp(timestamp, id, server, tool, &call.input);
    }
    let name = antigravity_tool_name(call);
    let input = if !call.is_mcp
        && reports_plan_or_schedule(name)
        && let Some(raw) = &call.raw_input
    {
        match raw.as_value() {
            Value::Object(input) => Cow::Borrowed(input),
            other => Cow::Owned(Map::from_iter([("raw".to_owned(), other.clone())])),
        }
    } else {
        Cow::Borrowed(&call.input)
    };
    if let Some(name) = name
        && (!call.is_mcp || name == "call_mcp_tool")
        && let Some(tool) = convert_named_tool(timestamp, id, name, &input)
    {
        return tool;
    }
    let input = Opaque::from_value(Value::Object(input.into_owned()));
    if let Some(name) = name {
        ToolUseChatMessage::External {
            timestamp: timestamp.to_owned(),
            tool_id: id.clone(),
            name: name.to_owned(),
            input,
            namespace: OptionalNullable::some(ANTIGRAVITY_TOOL_NAMESPACE.to_owned()),
        }
    } else {
        ToolUseChatMessage::Unknown {
            timestamp: timestamp.to_owned(),
            tool_id: id.clone(),
            raw_name: call.kind.as_deref().unwrap_or("unknown").to_owned(),
            input,
        }
    }
}

fn convert_named_tool(
    timestamp: &str,
    id: &str,
    name: &str,
    input: &Map<String, Value>,
) -> Option<ToolUseChatMessage> {
    use ToolUseChatMessage as Tool;
    let timestamp = timestamp.to_owned();
    let tool_id = id.to_owned();
    let string = |names: &[&str]| string_field(input, names);
    Some(match name {
        "run_command" => Tool::Bash {
            timestamp,
            tool_id,
            command: string(&["CommandLine", "command_line", "commandLine", "command"])?,
            description: string(&["toolSummary"]),
        },
        "read_file" | "view_file" => Tool::Read {
            timestamp,
            tool_id,
            file_path: string(&["Path", "path", "AbsolutePath", "file_path"])?,
            offset: line_field(input, &["StartLine", "start_line"]),
            limit: None,
            end_line: line_field(input, &["EndLine", "end_line"]),
        },
        "write_file" | "write_to_file" => Tool::Write {
            timestamp,
            tool_id,
            file_path: string(&["Path", "path", "TargetFile", "file_path"])?,
            content: string(&["Content", "content", "CodeContent"]),
        },
        "edit_file" | "replace_file_content" => Tool::Edit {
            timestamp,
            tool_id,
            file_path: Some(string(&["Path", "path", "TargetFile", "file_path"])?),
            old_string: string(&["Target", "target", "TargetContent"]),
            new_string: string(&["Replacement", "replacement", "ReplacementContent"]),
            changes: None,
        },
        "multi_replace_file_content" => {
            let file_path = string(&["TargetFile", "target_file", "Path", "path", "file_path"])?;
            let chunks = field(input, &["ReplacementChunks", "replacement_chunks"])
                .and_then(Value::as_array)
                .filter(|chunks| !chunks.is_empty());
            let join = |names: &[&str]| {
                let parts: Option<Vec<_>> = chunks?
                    .iter()
                    .map(|chunk| field(as_object(chunk), names).and_then(as_string))
                    .collect();
                parts.map(|parts| parts.join("\n\n"))
            };
            Tool::Edit {
                timestamp,
                tool_id,
                file_path: Some(file_path),
                old_string: join(&["TargetContent", "target_content"]),
                new_string: join(&["ReplacementContent", "replacement_content"]),
                changes: None,
            }
        }
        "grep_search" => Tool::Grep {
            timestamp,
            tool_id,
            pattern: Some(string(&["Query", "query", "Pattern"])?),
            path: string(&["SearchPath", "SearchDirectory", "path"]),
        },
        "find_by_name" => Tool::Glob {
            timestamp,
            tool_id,
            pattern: Some(string(&["Pattern", "pattern"])?),
            path: string(&["SearchDirectory", "path"]),
        },
        "list_dir" => Tool::List {
            timestamp,
            tool_id,
            path: string(&["DirectoryPath", "Path", "path"]),
        },
        "read_url_content" => Tool::WebFetch {
            timestamp,
            tool_id,
            url: string(&["Url", "url"])?,
            prompt: None,
        },
        "search_web" => Tool::WebSearch {
            timestamp,
            tool_id,
            query: string(&["query", "Query"])?,
        },
        "schedule" => {
            let args = schedule_arguments(input)?;
            let action = if line_field(&args, &["delaySeconds"]).is_some() {
                "wakeup"
            } else {
                "cron"
            };
            let mut request = Map::from_iter([("action".to_owned(), json!(action))]);
            request.extend(args);
            Tool::Schedule {
                timestamp,
                tool_id,
                request: parse_tool_schedule_request(&Value::Object(request))?,
                native_name: None,
            }
        }
        "enter_plan_mode" => Tool::AntigravityEnterPlanMode {
            timestamp,
            tool_id,
            reason: plan_field(input, "Reason", "reason")?,
        },
        "exit_plan_mode" => Tool::AntigravityExitPlanMode {
            timestamp,
            tool_id,
            plan: plan_field(input, "Plan", "plan")?,
        },
        "update_steps" => Tool::UpdatePlan {
            timestamp,
            tool_id,
            todos: Some(antigravity_plan_steps(input.get("steps")?)?),
        },
        "manage_task" => {
            let action = field(input, &["Action", "action"])?;
            let action = match action.as_str() {
                Some("stop") => return None,
                Some("kill") => json!("stop"),
                _ => action.clone(),
            };
            let mut row = json!({"timestamp": timestamp, "toolId": tool_id, "type": "background-task-tool-use", "action": action});
            if let Some(task) = field(input, &["TaskId", "task_id"]) {
                row["taskId"] = task.clone();
            }
            if let Some(text) = field(input, &["Input", "input"]) {
                row["input"] = text.clone();
            }
            return parse_tool_use_message(&row);
        }
        "send_message" => Tool::AgentMessage {
            timestamp,
            tool_id,
            recipient: string(&["Recipient", "recipient"])
                .filter(|recipient| !recipient.is_empty())?,
            message: string(&["Message", "message"])?,
        },
        "invoke_subagent" => {
            let role = string(&["Role", "role"]);
            Tool::Task {
                timestamp,
                tool_id,
                subagent_type: string(&["TypeName", "type_name"]).or_else(|| role.clone()),
                description: role,
                prompt: string(&["Prompt", "prompt"]),
                model: string(&["Model", "model"]),
                resume: None,
            }
        }
        "call_mcp_tool" => {
            let server =
                string(&["ServerName", "server_name"]).filter(|server| !server.is_empty())?;
            let tool = string(&["ToolName", "tool_name"]).filter(|tool| !tool.is_empty())?;
            return Some(mcp(&timestamp, &tool_id, &server, &tool, input));
        }
        _ => return None,
    })
}

fn mcp(
    timestamp: &str,
    tool_id: &str,
    server: &str,
    tool: &str,
    input: &Map<String, Value>,
) -> ToolUseChatMessage {
    ToolUseChatMessage::Mcp {
        timestamp: timestamp.to_owned(),
        tool_id: tool_id.to_owned(),
        server: server.to_owned(),
        tool: tool.to_owned(),
        input: Opaque::from_value(Value::Object(
            antigravity_mcp_arguments(input)
                .cloned()
                .unwrap_or_default(),
        )),
    }
}

pub fn antigravity_tool_result_text<'a>(name: &str, text: &'a str) -> &'a str {
    if name != "run_command" || !text.starts_with("Created At: ") {
        return text;
    }
    let Some((_, rest)) = text.split_once('\n') else {
        return text;
    };
    if rest.starts_with("Completed At: ")
        && let Some((_, result)) = rest.split_once('\n')
    {
        return result;
    }
    rest
}
