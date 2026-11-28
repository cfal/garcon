//! Ports `server-agents/common/src/search/message-projector.ts`.

mod extraction;
mod values;

use std::borrow::Cow;

use garcon_contract::{
    chat_search::ChatSearchSnippetRole as Role,
    chat_types::{ChatMessage, CommandOutputChannel, ToolUseChatMessage},
    command_output::is_clean_command_success,
};
use serde::Serialize;

use crate::rows::{SEARCH_TIMESTAMP_MAX_BYTES, SearchMessageRowInput};

use self::{
    extraction::{ExtractionBudget, MAX_RECURSIVE_NODES, collapse_whitespace},
    values::{ask_question, cursor_phase, cursor_todo, schedule_request, subagent_details},
};

const MAX_BODY_CHARS: usize = 64_000;
const MAX_TOOL_INPUT_CHARS: usize = 16_000;
const MAX_TOOL_RESULT_CHARS: usize = 2_512;

pub fn project_search_message(message: &ChatMessage) -> Option<SearchMessageRowInput> {
    let (role, timestamp, cap): (_, &str, _) = match message {
        ChatMessage::User(value) => (Role::User, &value.timestamp, MAX_BODY_CHARS),
        ChatMessage::Assistant(value) => (Role::Assistant, &value.timestamp, MAX_BODY_CHARS),
        ChatMessage::Thinking(value) => (Role::Assistant, &value.timestamp, MAX_BODY_CHARS),
        ChatMessage::CommandOutput(value) => {
            let role = match value.channel {
                CommandOutputChannel::Stdout => Role::Assistant,
                CommandOutputChannel::Stderr => Role::System,
            };
            (role, &value.timestamp, MAX_BODY_CHARS)
        }
        ChatMessage::CommandResult(value) => (Role::System, &value.timestamp, MAX_BODY_CHARS),
        ChatMessage::Compaction(value) => (Role::System, &value.timestamp, MAX_BODY_CHARS),
        ChatMessage::AgentSwitch(value) => (Role::System, &value.timestamp, MAX_BODY_CHARS),
        ChatMessage::ToolUse(value) => (Role::Tool, value.timestamp(), MAX_TOOL_INPUT_CHARS),
        ChatMessage::ToolResult(value) => (Role::Tool, &value.timestamp, MAX_TOOL_RESULT_CHARS),
        ChatMessage::PermissionRequest(value) => {
            (Role::Tool, &value.timestamp, MAX_TOOL_INPUT_CHARS)
        }
        ChatMessage::Error(_)
        | ChatMessage::CliRow(_)
        | ChatMessage::Notice(_)
        | ChatMessage::PermissionResolved(_)
        | ChatMessage::PermissionCancelled(_)
        | ChatMessage::PermissionExpired(_) => return None,
    };
    let mut budget = ExtractionBudget::new(cap, MAX_RECURSIVE_NODES);
    let raw = match message {
        ChatMessage::User(value) => budget.join([value.content.as_str()]),
        ChatMessage::Assistant(value) => budget.join([value.content.as_str()]),
        ChatMessage::CommandOutput(value) => budget.join([value.content.as_str()]),
        ChatMessage::Thinking(value) => budget.join([value.content.as_str()]),
        ChatMessage::CommandResult(value) if !is_clean_command_success(&value.result) => {
            budget.join([value.content.as_str()])
        }
        ChatMessage::Compaction(value) => budget.join([value.summary.as_str()]),
        ChatMessage::AgentSwitch(value) => budget.join([
            value.from_agent_id.as_str(),
            &value.to_agent_id,
            maybe(&value.from_model),
            maybe(&value.to_model),
        ]),
        ChatMessage::ToolResult(value) => budget.tool_result(value),
        ChatMessage::ToolUse(value) => tool_text(value, &mut budget),
        ChatMessage::PermissionRequest(value) => tool_text(&value.requested_tool, &mut budget),
        _ => return None,
    };
    let body = collapse_whitespace(&raw);
    if body.is_empty() {
        return None;
    }
    Some(SearchMessageRowInput {
        role,
        timestamp: (timestamp.len() <= SEARCH_TIMESTAMP_MAX_BYTES).then(|| timestamp.to_owned()),
        body,
    })
}

fn maybe(value: &Option<String>) -> &str {
    value.as_deref().unwrap_or_default()
}

fn enum_text(value: impl Serialize) -> String {
    // INFALLIBLE: the caller supplies a unit enum with string wire names.
    let encoded = serde_json::to_string(&value).expect("a tool enum serializes as text");
    encoded.trim_matches('"').to_owned()
}

fn tool_text(message: &ToolUseChatMessage, budget: &mut ExtractionBudget) -> String {
    use ToolUseChatMessage::*;
    match message {
        Bash {
            description,
            command,
            ..
        } => budget.join([maybe(description), command]),
        ClaudeMonitor {
            description,
            command,
            web_socket_url,
            web_socket_protocols,
            allowed_domains,
            ..
        } => {
            let protocols =
                budget.nested(|nested| nested.optional_strings(web_socket_protocols.as_deref(), 0));
            let domains =
                budget.nested(|nested| nested.optional_strings(allowed_domains.as_deref(), 0));
            budget.join([
                description,
                maybe(command),
                maybe(web_socket_url),
                &protocols,
                &domains,
            ])
        }
        Exec { language, code, .. } => budget.join([language, code]),
        Wait {
            execution_id,
            yield_time_ms,
            max_tokens,
            terminate,
            ..
        } => budget.join([
            execution_id.as_str(),
            yield_time_ms
                .map(|value| value.to_js_string())
                .as_deref()
                .unwrap_or_default(),
            max_tokens
                .map(|value| value.to_js_string())
                .as_deref()
                .unwrap_or_default(),
            terminate
                .map(|value| if value { "true" } else { "false" })
                .unwrap_or_default(),
        ]),
        Read { file_path, .. } => budget.join([file_path]),
        Write {
            file_path, content, ..
        } => budget.join([file_path, maybe(content)]),
        List { path, .. } => budget.join([maybe(path)]),
        Edit {
            file_path,
            old_string,
            new_string,
            ..
        } => budget.join([maybe(file_path), maybe(old_string), maybe(new_string)]),
        ApplyPatch {
            file_path,
            old_string,
            new_string,
            patch,
            ..
        } => budget.join([
            maybe(file_path),
            maybe(old_string),
            maybe(new_string),
            maybe(patch),
        ]),
        Grep { pattern, path, .. } | Glob { pattern, path, .. } => {
            budget.join([maybe(pattern), maybe(path)])
        }
        WebSearch { query, .. } | PiToolSearch { query, .. } | ClaudeToolSearch { query, .. } => {
            budget.join([query])
        }
        AmpFinder { query, .. } | AmpFindThread { query, .. } => budget.join([maybe(query)]),
        AmpLibrarian { query, context, .. } => budget.join([maybe(query), maybe(context)]),
        WebFetch { url, prompt, .. } => budget.join([url, maybe(prompt)]),
        TodoWrite { todos, .. } => budget.join(
            todos
                .iter()
                .flatten()
                .map(|todo| format!("{} {}", enum_text(todo.status), todo.content)),
        ),
        UpdatePlan { todos, .. } => budget.join(
            todos
                .iter()
                .flatten()
                .map(|todo| format!("{} {}", enum_text(todo.status), todo.content)),
        ),
        Task {
            subagent_type,
            description,
            prompt,
            model,
            ..
        } => budget.join([
            maybe(subagent_type),
            maybe(description),
            maybe(prompt),
            maybe(model),
        ]),
        BackgroundTask {
            action,
            task_id,
            input,
            ..
        } => budget.join([enum_text(*action).as_str(), maybe(task_id), maybe(input)]),
        AgentMessage {
            recipient, message, ..
        } => budget.join([recipient, message]),
        Schedule {
            request,
            native_name,
            ..
        } => budget.compound(0, |array| {
            array.child(None, |budget, depth| budget.text("schedule", depth));
            array.child(None, |budget, depth| {
                budget.optional_text(native_name.as_deref(), depth)
            });
            array.child(None, |budget, depth| {
                schedule_request(budget, depth, request)
            });
        }),
        AntigravityEnterPlanMode { reason, .. } => budget.join(["enter_plan_mode", reason]),
        AntigravityExitPlanMode { plan, .. } => budget.join(["exit_plan_mode", plan]),
        CodexSubagent {
            action, details, ..
        } => {
            let details = budget.nested(|nested| subagent_details(nested, 0, details));
            budget.join([enum_text(*action).as_str(), &details])
        }
        WriteStdin { input, .. } => budget.value(input, 0),
        ExitPlanMode {
            plan,
            allowed_prompts,
            ..
        } => budget.join(
            std::iter::once(Cow::Borrowed(plan.as_str())).chain(
                allowed_prompts
                    .iter()
                    .flatten()
                    .map(|value| Cow::Owned(format!("{} {}", value.tool, value.prompt))),
            ),
        ),
        AskUserQuestion {
            title, questions, ..
        } => {
            let questions = budget.nested(|nested| nested.list(questions, 0, ask_question));
            budget.join([maybe(title), questions.as_str()])
        }
        CursorCreatePlan {
            name,
            overview,
            plan,
            todos,
            phases,
            ..
        } => {
            let todos = budget.nested(|nested| match todos {
                Some(todos) => nested.list(todos, 0, cursor_todo),
                None => nested.optional_text(None, 0),
            });
            let phases = budget.nested(|nested| match phases {
                Some(phases) => nested.list(phases, 0, cursor_phase),
                None => nested.optional_text(None, 0),
            });
            budget.join([maybe(name), maybe(overview), plan, &todos, &phases])
        }
        AmpOracle {
            task,
            context,
            files,
            ..
        } => budget.join(
            [maybe(task), maybe(context)]
                .into_iter()
                .chain(files.iter().flatten().map(String::as_str)),
        ),
        AmpSkill { name, .. } => budget.join([maybe(name)]),
        AmpHandoff { goal, .. } => budget.join([maybe(goal)]),
        AmpLookAt {
            path, objective, ..
        } => budget.join([maybe(path), maybe(objective)]),
        AmpReadThread {
            thread_id, goal, ..
        } => budget.join([maybe(thread_id), maybe(goal)]),
        AmpTaskList {
            action,
            task_id,
            title,
            status,
            ..
        } => budget.join([maybe(action), maybe(task_id), maybe(title), maybe(status)]),
        External {
            namespace,
            name,
            input,
            ..
        } => {
            let input = budget.nested(|nested| nested.value(input, 0));
            budget.join([namespace.as_deref().unwrap_or_default(), name, &input])
        }
        Mcp {
            server,
            tool,
            input,
            ..
        } => {
            let input = budget.nested(|nested| nested.value(input, 0));
            budget.join([server, tool, &input])
        }
        RequestPermissions {
            permissions,
            reason,
            ..
        } => {
            let permissions = budget.nested(|nested| nested.value(permissions, 0));
            budget.join([maybe(reason), &permissions])
        }
        Unknown {
            raw_name, input, ..
        } => {
            let input = budget.nested(|nested| nested.value(input, 0));
            budget.join([raw_name, &input])
        }
        TodoRead { .. } | EnterPlanMode { .. } | AmpMermaid { .. } => String::new(),
    }
}
