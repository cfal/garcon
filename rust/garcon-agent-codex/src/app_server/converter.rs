use garcon_agents_common::shared::normalize_util::{
    normalize_todo_items, normalize_tool_input, normalize_tool_result_content,
};
use garcon_contract::{
    chat_message_coercion::as_optional_changes,
    chat_types::{
        AssistantMessage, ChatMessage, CodexSubagentAction, CodexSubagentDetails,
        CodexSubagentState, CompactionMessage, CompactionTrigger, ThinkingMessage,
        ToolResultMessage, ToolUseChatMessage,
    },
};
use garcon_js::{
    OptionalNullable,
    json::{Opaque, as_number},
    trim,
};
use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::{
    async_questions::codex_async_questions,
    code_mode_command_projection::{
        codex_code_mode_result_tool_id, create_codex_code_mode_bash_messages,
        project_codex_code_mode_commands, remember_codex_code_mode_result,
    },
    jsonl_tool_use_converter::{convert_codex_wait_function_call, normalize_plan_steps},
    subagent_lifecycle::{
        convert_codex_inter_agent_lifecycle, convert_codex_subagent_activity,
        convert_codex_subagent_lifecycle_text,
    },
    subagent_tool_use::convert_codex_subagent_tool_use,
};

use super::command_display::normalize_codex_command_display;

pub fn convert_codex_app_server_live_item(
    item: &Value,
    timestamp: &str,
    compaction_trigger: Option<CompactionTrigger>,
) -> Vec<ChatMessage> {
    let id = string(item, "id").unwrap_or_default();
    match string(item, "type").unwrap_or_default() {
        "agentMessage" | "plan" => {
            let Some(text) = nonempty_trimmed(&item["text"]) else {
                return Vec::new();
            };
            let questions = (item["type"] == "agentMessage")
                .then(|| codex_async_questions(id, &item["delivery"], &item["questions"]))
                .flatten();
            vec![ChatMessage::Assistant(AssistantMessage {
                timestamp: timestamp.into(),
                content: text.into(),
                questions,
            })]
        }
        "reasoning" => {
            let content = ["summary", "content"]
                .into_iter()
                .flat_map(|key| item[key].as_array().into_iter().flatten())
                .filter_map(Value::as_str)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            if trim(&content).is_empty() {
                return Vec::new();
            }
            vec![ChatMessage::Thinking(ThinkingMessage {
                timestamp: timestamp.into(),
                content,
            })]
        }
        "commandExecution" => convert_command_execution(item, timestamp, id),
        "fileChange" => convert_file_change(item, timestamp, id),
        "webSearch" => convert_web_search(item, timestamp, id),
        "dynamicToolCall" => convert_dynamic_tool_call(item, timestamp, id),
        "functionCallOutput" => vec![tool_result(timestamp, id, item.get("output"), false)],
        "collabAgentToolCall" => convert_collab_agent_tool_call(item, timestamp, id),
        "subAgentActivity" => vec![ChatMessage::ToolUse(convert_codex_subagent_activity(
            timestamp,
            id,
            string(item, "kind").unwrap_or_default(),
            string(item, "agentThreadId").unwrap_or_default(),
            string(item, "agentPath").unwrap_or_default(),
        ))],
        "mcpToolCall" => convert_mcp_tool_call(item, timestamp, id),
        "imageGeneration" => {
            let generated = item.get("fileId").map(|file_id| {
                let mut result = json!({"fileId":file_id});
                if truthy(&item["savedPath"]) {
                    result["savedPath"] = item["savedPath"].clone();
                }
                result
            });
            let result = generated.as_ref().unwrap_or(&item["result"]);
            if !truthy(result) {
                return Vec::new();
            }
            vec![tool_result(
                timestamp,
                id,
                Some(result),
                item["status"] == "failed",
            )]
        }
        "contextCompaction" => vec![ChatMessage::Compaction(CompactionMessage {
            timestamp: timestamp.into(),
            trigger: compaction_trigger.unwrap_or(CompactionTrigger::Manual),
            summary: String::new(),
            pre_tokens: None,
            post_tokens: None,
        })],
        _ => Vec::new(),
    }
}

pub fn convert_codex_raw_code_mode_item(
    item: &Value,
    timestamp: &str,
    active_result_ids: &mut IndexMap<String, String>,
) -> Vec<ChatMessage> {
    let kind = string(item, "type").unwrap_or_default();
    if kind == "agent_message" || (kind == "message" && item["role"] == "user") {
        let text = raw_response_item_text(&item["content"]);
        let fallback = format!("subagent-lifecycle-{timestamp}");
        let id = string(item, "id").unwrap_or(&fallback);
        let lifecycle = if kind == "agent_message" {
            convert_codex_inter_agent_lifecycle(
                timestamp,
                id,
                &item["author"],
                &item["recipient"],
                &text,
            )
        } else {
            convert_codex_subagent_lifecycle_text(timestamp, id, &text)
        };
        return lifecycle.into_iter().map(ChatMessage::ToolUse).collect();
    }
    let Some(id) = string(item, "call_id") else {
        return Vec::new();
    };
    match kind {
        "custom_tool_call" if item["name"] == "exec" => {
            let Some(input) = string(item, "input").filter(|_| !active_result_ids.contains_key(id))
            else {
                return Vec::new();
            };
            if let Some(projection) = project_codex_code_mode_commands(input) {
                let result_id = codex_code_mode_result_tool_id(id, &projection);
                remember_codex_code_mode_result(active_result_ids, id.into(), result_id);
                return create_codex_code_mode_bash_messages(timestamp, id, &projection)
                    .into_iter()
                    .map(ChatMessage::ToolUse)
                    .collect();
            }
            remember_codex_code_mode_result(active_result_ids, id.into(), id.into());
            vec![ChatMessage::ToolUse(ToolUseChatMessage::Exec {
                timestamp: timestamp.into(),
                tool_id: id.into(),
                code: input.into(),
                language: "javascript".into(),
            })]
        }
        "function_call" if item["name"] == "wait" && !active_result_ids.contains_key(id) => {
            let arguments = item.get("arguments").cloned().map(Opaque::from_value);
            let Some(message) = convert_codex_wait_function_call(timestamp, id, arguments.as_ref())
            else {
                return Vec::new();
            };
            remember_codex_code_mode_result(active_result_ids, id.into(), id.into());
            vec![ChatMessage::ToolUse(message)]
        }
        "custom_tool_call_output" | "function_call_output" => {
            if active_result_ids.get(id).is_none_or(String::is_empty) {
                return Vec::new();
            }
            active_result_ids
                .shift_remove(id)
                .into_iter()
                .map(|id| tool_result(timestamp, &id, item.get("output"), false))
                .collect()
        }
        _ => Vec::new(),
    }
}

fn raw_response_item_text(content: &Value) -> String {
    content.as_array().map_or_else(
        || content.as_str().unwrap_or_default().into(),
        |items| {
            items
                .iter()
                .filter_map(|item| string(item, "text"))
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        },
    )
}

fn tool_result(timestamp: &str, id: &str, content: Option<&Value>, error: bool) -> ChatMessage {
    let content = content.cloned().map(Opaque::from_value);
    ChatMessage::ToolResult(ToolResultMessage::new(
        timestamp.into(),
        id.into(),
        normalize_tool_result_content(content.as_ref()),
        error,
        None,
    ))
}

fn convert_command_execution(item: &Value, timestamp: &str, id: &str) -> Vec<ChatMessage> {
    let command = normalize_codex_command_display(string(item, "command").unwrap_or_default());
    let mut messages = vec![ChatMessage::ToolUse(ToolUseChatMessage::Bash {
        timestamp: timestamp.into(),
        tool_id: id.into(),
        command: command.into_owned(),
        description: None,
    })];
    if item["status"] != "inProgress" {
        let status = &item["status"];
        let content = if truthy(&item["aggregatedOutput"]) {
            &item["aggregatedOutput"]
        } else if status == "completed" {
            &Value::Null
        } else {
            status
        };
        let is_error = match item.get("exitCode") {
            Some(Value::Null) => status != "completed",
            other => other.and_then(as_number) != Some(0.0),
        };
        messages.push(tool_result(timestamp, id, Some(content), is_error));
    }
    messages
}

fn convert_file_change(item: &Value, timestamp: &str, id: &str) -> Vec<ChatMessage> {
    let mut messages = vec![ChatMessage::ToolUse(ToolUseChatMessage::Edit {
        timestamp: timestamp.into(),
        tool_id: id.into(),
        file_path: None,
        old_string: None,
        new_string: None,
        changes: as_optional_changes(&item["changes"]),
    })];
    if item["status"] != "inProgress" {
        let applied = json!("File changes applied");
        let status = &item["status"];
        messages.push(tool_result(
            timestamp,
            id,
            Some(if status == "completed" {
                &applied
            } else {
                status
            }),
            status != "completed",
        ));
    }
    messages
}

fn convert_web_search(item: &Value, timestamp: &str, id: &str) -> Vec<ChatMessage> {
    let query = nonempty_trimmed(&item["query"]).or_else(|| {
        let action = &item["action"];
        match string(action, "type")? {
            "search" => nonempty_trimmed(&action["query"]).or_else(|| {
                action["queries"]
                    .as_array()?
                    .iter()
                    .find_map(nonempty_trimmed)
            }),
            "openPage" | "open_page" => nonempty_trimmed(&action["url"]),
            "findInPage" | "find_in_page" => {
                nonempty_trimmed(&action["pattern"]).or_else(|| nonempty_trimmed(&action["url"]))
            }
            _ => None,
        }
    });
    let Some(query) = query.map(trim) else {
        return Vec::new();
    };
    vec![
        ChatMessage::ToolUse(ToolUseChatMessage::WebSearch {
            timestamp: timestamp.into(),
            tool_id: id.into(),
            query: query.into(),
        }),
        tool_result(
            timestamp,
            id,
            Some(&json!(format!("Searched: {query}"))),
            false,
        ),
    ]
}

fn convert_dynamic_tool_call(item: &Value, timestamp: &str, id: &str) -> Vec<ChatMessage> {
    let arguments = item.get("arguments").cloned().map(Opaque::from_value);
    let input = normalize_tool_input(arguments.as_ref());
    let name = string(item, "tool").unwrap_or_default();
    let namespace = match item.get("namespace") {
        Some(Value::Null) => OptionalNullable::NULL,
        Some(Value::String(value)) => OptionalNullable::some(value.clone()),
        _ => OptionalNullable::ABSENT,
    };
    let known = convert_known_dynamic_tool(timestamp, id, name, truthy(&item["namespace"]), &input);
    let mut messages = vec![ChatMessage::ToolUse(known.unwrap_or_else(|| {
        ToolUseChatMessage::External {
            timestamp: timestamp.into(),
            tool_id: id.into(),
            name: name.into(),
            input,
            namespace,
        }
    }))];
    if item["status"] != "inProgress" {
        let content = not_null(item, "contentItems").or_else(|| item.get("success"));
        messages.push(tool_result(
            timestamp,
            id,
            content,
            item["success"] == false || item["status"] == "failed",
        ));
    }
    messages
}

fn convert_collab_agent_tool_call(item: &Value, timestamp: &str, id: &str) -> Vec<ChatMessage> {
    use CodexSubagentAction as Action;
    let action = match string(item, "tool").unwrap_or_default() {
        "spawnAgent" => Action::SpawnAgent,
        "sendInput" => Action::SendInput,
        "resumeAgent" => Action::ResumeAgent,
        "wait" => Action::WaitAgent,
        "closeAgent" => Action::CloseAgent,
        "sendMessage" => Action::SendMessage,
        "followupTask" => Action::FollowupTask,
        "interruptAgent" => Action::InterruptAgent,
        "listAgents" => Action::ListAgents,
        _ => return Vec::new(),
    };
    let receivers: Vec<_> = item["receiverThreadIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let agent_states = item["agentsStates"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(agent, state)| {
            let status = serde_json::from_value(state["status"].clone()).ok()?;
            let message = string(state, "message")
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            Some((agent.clone(), CodexSubagentState { status, message }))
        })
        .collect();
    let details = CodexSubagentDetails {
        target: (receivers.len() == 1).then(|| receivers[0].clone()),
        targets: (receivers.len() > 1).then_some(receivers),
        message: string(item, "prompt")
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        model: string(item, "model")
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        reasoning_effort: string(item, "reasoningEffort")
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        agent_states: Some(agent_states),
        ..CodexSubagentDetails::default()
    };
    let mut messages = vec![ChatMessage::ToolUse(ToolUseChatMessage::CodexSubagent {
        timestamp: timestamp.into(),
        tool_id: id.into(),
        action,
        details: Box::new(details),
    })];
    if item["status"] != "inProgress" {
        messages.push(tool_result(
            timestamp,
            id,
            item.get("agentsStates"),
            item["status"] == "failed",
        ));
    }
    messages
}

fn convert_mcp_tool_call(item: &Value, timestamp: &str, id: &str) -> Vec<ChatMessage> {
    let arguments = item.get("arguments").cloned().map(Opaque::from_value);
    let mut messages = vec![ChatMessage::ToolUse(ToolUseChatMessage::Mcp {
        timestamp: timestamp.into(),
        tool_id: id.into(),
        server: string(item, "server").unwrap_or_default().into(),
        tool: string(item, "tool").unwrap_or_default().into(),
        input: normalize_tool_input(arguments.as_ref()),
    })];
    if item["status"] != "inProgress" {
        messages.push(tool_result(
            timestamp,
            id,
            not_null(item, "error").or_else(|| item.get("result")),
            truthy(&item["error"]) || item["status"] == "failed",
        ));
    }
    messages
}

fn convert_known_dynamic_tool(
    time: &str,
    id: &str,
    name: &str,
    namespaced: bool,
    input: &Opaque,
) -> Option<ToolUseChatMessage> {
    if !namespaced && let Some(tool) = convert_codex_subagent_tool_use(time, id, name, input) {
        return Some(tool);
    }
    use ToolUseChatMessage as Tool;
    let timestamp = time.to_owned();
    let tool_id = id.to_owned();
    let field = |key| string(input, key).map(str::to_owned);
    let or_field = |key, fallback| {
        field(key)
            .filter(|value| !value.is_empty())
            .or_else(|| field(fallback))
    };
    let path = || or_field("filePath", "path");
    let todos = || not_null(input, "items").or_else(|| not_null(input, "todos"));
    Some(match name {
        "shell_command" | "exec_command" | "bash" => Tool::Bash {
            timestamp,
            tool_id,
            command: or_field("command", "cmd").unwrap_or_default(),
            description: None,
        },
        "read" => Tool::Read {
            timestamp,
            tool_id,
            file_path: path().unwrap_or_default(),
            offset: None,
            limit: None,
            end_line: None,
        },
        "list" => Tool::List {
            timestamp,
            tool_id,
            path: field("path"),
        },
        "edit" | "apply_patch" => Tool::Edit {
            timestamp,
            tool_id,
            file_path: path(),
            old_string: field("oldString"),
            new_string: field("newString"),
            changes: None,
        },
        "write" => Tool::Write {
            timestamp,
            tool_id,
            file_path: path().unwrap_or_default(),
            content: field("content"),
        },
        "grep" => Tool::Grep {
            timestamp,
            tool_id,
            pattern: field("pattern"),
            path: field("path"),
        },
        "glob" => Tool::Glob {
            timestamp,
            tool_id,
            pattern: field("pattern"),
            path: field("path"),
        },
        "web_search" => Tool::WebSearch {
            timestamp,
            tool_id,
            query: field("query").unwrap_or_default(),
        },
        "web_fetch" => Tool::WebFetch {
            timestamp,
            tool_id,
            url: field("url").unwrap_or_default(),
            prompt: field("prompt"),
        },
        "update_plan" => Tool::UpdatePlan {
            timestamp,
            tool_id,
            todos: normalize_plan_steps(todos().unwrap_or(&input["plan"])),
        },
        "write_stdin" => Tool::WriteStdin {
            timestamp,
            tool_id,
            input: input.clone(),
        },
        "todo_list" => Tool::TodoWrite {
            timestamp,
            tool_id,
            todos: normalize_todo_items(todos().unwrap_or(&Value::Null)),
        },
        _ => return None,
    })
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn not_null<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|value| !value.is_null())
}

fn nonempty_trimmed(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !trim(text).is_empty())
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(text) => !text.is_empty(),
        Value::Number(_) => as_number(value).is_some_and(|number| number != 0.0),
        _ => true,
    }
}
