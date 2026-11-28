use std::borrow::Cow;

use garcon_js::{json::Opaque, trim, utf16};
use serde::Serialize;
use serde_json::Value;

use crate::{
    chat_plan::{PlanStep, PlanStepStatus, TodoItem, TodoStatus},
    chat_types::ToolUseChatMessage,
    tool_schedule::{ToolScheduleRequest, tool_schedule_options, tool_schedule_title},
};

use super::units;

const TOOL_SUMMARY_MAX_CHARS: usize = 200;
pub(super) const PROJECTED_BODY_MAX_CHARS: usize = 8_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedToolUseSummary {
    pub text: String,
    pub abridged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix_before_literal: Option<String>,
}

impl ProjectedToolUseSummary {
    fn new(text: impl Into<String>, abridged: bool) -> Self {
        Self {
            text: text.into(),
            abridged,
            prefix_before_literal: None,
        }
    }

    fn literal(text: String, abridged: bool, prefix: String) -> Self {
        Self {
            text,
            abridged,
            prefix_before_literal: Some(prefix),
        }
    }
}

pub type ToolSummaryRedactor<'a> = dyn Fn(&str) -> String + 'a;

pub fn project_tool_use_summary(
    message: &ToolUseChatMessage,
    redact: Option<&ToolSummaryRedactor<'_>>,
) -> ProjectedToolUseSummary {
    match message {
        ToolUseChatMessage::UpdatePlan { todos, .. } => return summarize_plan(todos.as_deref()),
        ToolUseChatMessage::Schedule { request, .. } => return summarize_schedule(request, redact),
        ToolUseChatMessage::BackgroundTask {
            action,
            task_id,
            input: Some(input),
            ..
        } => {
            let input = utf16::truncate(input, TOOL_SUMMARY_MAX_CHARS);
            let raw = format!(
                "{} {} Input: {}",
                enum_text(action),
                task_id.as_deref().unwrap_or(""),
                json_text(input)
            );
            let text = truncate(&raw, TOOL_SUMMARY_MAX_CHARS);
            let abridged = text.as_ref() != raw;
            return ProjectedToolUseSummary::new(text.into_owned(), abridged);
        }
        _ => {}
    }
    let raw = tool_detail(message);
    let safe = redact_text(&raw, redact);
    let collapsed = bounded_collapse(&safe);
    let text = truncate(&collapsed, TOOL_SUMMARY_MAX_CHARS);
    ProjectedToolUseSummary::new(
        text.as_ref(),
        safe != raw || utf16::len(&safe) > PROJECTED_BODY_MAX_CHARS || text.as_ref() != collapsed,
    )
}

fn summarize_schedule(
    request: &ToolScheduleRequest,
    redact: Option<&ToolSummaryRedactor<'_>>,
) -> ProjectedToolUseSummary {
    let title = tool_schedule_title(request);
    let prompt = match request {
        ToolScheduleRequest::Wakeup(wakeup) => &wakeup.prompt,
        ToolScheduleRequest::Cron(cron) => &cron.prompt,
        _ => {
            let safe = redact_text(&title, redact);
            let text = truncate(&safe, TOOL_SUMMARY_MAX_CHARS);
            return ProjectedToolUseSummary::new(text.as_ref(), text.as_ref() != title);
        }
    };
    let mut header = vec![title];
    header.extend(tool_schedule_options(request));
    header.push("Prompt:".to_owned());
    let header = header.join(" ");
    let safe_header = redact_text(&header, redact);
    let prefix = bounded_collapse(&safe_header);
    let overhead = utf16::len(&prefix) + 3;
    if utf16::len(&safe_header) > PROJECTED_BODY_MAX_CHARS || overhead > TOOL_SUMMARY_MAX_CHARS {
        return ProjectedToolUseSummary::new(
            format!("{}...", units::prefix(&prefix, TOOL_SUMMARY_MAX_CHARS)),
            true,
        );
    }
    let literal_budget = TOOL_SUMMARY_MAX_CHARS - overhead;
    let safe_prompt = redact_text(prompt, redact);
    let mut literal = String::new();
    let mut literal_len = 0;
    for ch in safe_prompt.chars() {
        let escaped = json_text(ch.encode_utf8(&mut [0; 4]));
        let escaped = &escaped[1..escaped.len() - 1];
        let escaped_len = utf16::len(escaped);
        if literal_len + escaped_len > literal_budget {
            let text = if literal.is_empty() {
                format!("{prefix}...")
            } else {
                format!("{prefix} \"{literal}\"...")
            };
            return ProjectedToolUseSummary::literal(text, true, prefix);
        }
        literal.push_str(escaped);
        literal_len += escaped_len;
    }
    ProjectedToolUseSummary::literal(
        format!("{prefix} \"{literal}\""),
        safe_header.as_ref() != header || safe_prompt.as_ref() != prompt.as_str(),
        prefix,
    )
}

fn redact_text<'a>(text: &'a str, redact: Option<&ToolSummaryRedactor<'_>>) -> Cow<'a, str> {
    redact.map_or(Cow::Borrowed(text), |redact| Cow::Owned(redact(text)))
}

fn tool_detail(message: &ToolUseChatMessage) -> Cow<'_, str> {
    use ToolUseChatMessage::*;
    match message {
        Exec { code, .. } => Cow::Borrowed(code),
        PiToolSearch { query, .. } | ClaudeToolSearch { query, .. } => Cow::Borrowed(query),
        ClaudeMonitor {
            description,
            command,
            web_socket_url,
            ..
        } => Cow::Borrowed(first_nonempty([
            Some(description.as_str()),
            command.as_deref(),
            web_socket_url.as_deref(),
        ])),
        WriteStdin { input, .. } => stringify_tool_payload(input),
        CodexSubagent { action, .. } => Cow::Owned(enum_text(action)),
        AntigravityEnterPlanMode { reason, .. } => Cow::Borrowed(reason),
        AntigravityExitPlanMode { plan, .. } => Cow::Borrowed(plan),
        BackgroundTask {
            action, task_id, ..
        } => {
            let action = enum_text(action);
            Cow::Owned(match task_id.as_deref().filter(|id| !id.is_empty()) {
                Some(id) => format!("{action} {id}"),
                None => action,
            })
        }
        AgentMessage {
            recipient, message, ..
        } => Cow::Owned(format!("To {recipient}: {message}")),
        TodoWrite { todos, .. } => Cow::Owned(summarize_todos(todos.as_deref())),
        AskUserQuestion {
            title, questions, ..
        } => match title.as_deref().filter(|title| !title.is_empty()) {
            Some(title) => Cow::Borrowed(title),
            None => Cow::Owned(
                questions
                    .iter()
                    .map(|question| question.prompt.as_str())
                    .collect::<Vec<_>>()
                    .join("; "),
            ),
        },
        Wait { execution_id, .. } => Cow::Borrowed(execution_id),
        Mcp { server, tool, .. } if server.is_empty() => Cow::Borrowed(tool),
        _ => legacy_tool_detail(message),
    }
}

fn legacy_tool_detail(message: &ToolUseChatMessage) -> Cow<'_, str> {
    use ToolUseChatMessage::*;
    match message {
        Bash {
            description,
            command,
            ..
        } => Cow::Borrowed(first_nonempty([description.as_deref(), Some(command)])),
        Read { file_path, .. } | Write { file_path, .. } => Cow::Borrowed(file_path),
        Edit { file_path, .. } | ApplyPatch { file_path, .. } => {
            Cow::Borrowed(file_path.as_deref().unwrap_or(""))
        }
        List { path, .. } => Cow::Borrowed(path.as_deref().unwrap_or("")),
        Grep { pattern, .. } | Glob { pattern, .. } => {
            Cow::Borrowed(pattern.as_deref().unwrap_or(""))
        }
        WebSearch { query, .. } => Cow::Borrowed(query),
        WebFetch { url, .. } => Cow::Borrowed(url),
        Task {
            description,
            prompt,
            subagent_type,
            ..
        } => Cow::Borrowed(first_nonempty([
            description.as_deref(),
            prompt.as_deref(),
            subagent_type.as_deref(),
        ])),
        External { name, .. } => Cow::Borrowed(name),
        Mcp { server, tool, .. } => Cow::Owned(format!("{server}/{tool}")),
        Unknown { raw_name, .. } => Cow::Borrowed(raw_name),
        _ => Cow::Borrowed(""),
    }
}

fn first_nonempty<const N: usize>(values: [Option<&str>; N]) -> &str {
    values
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty())
        .unwrap_or("")
}

pub(super) fn legacy_tool_summary(message: &ToolUseChatMessage) -> String {
    truncate(
        &collapse(&legacy_tool_detail(message)),
        TOOL_SUMMARY_MAX_CHARS,
    )
    .into_owned()
}

pub(super) fn legacy_tool_result(content: &Opaque) -> Cow<'_, str> {
    match tool_payload_text(content, &["text", "output", "content", "stdout"]) {
        Some(text) => Cow::Borrowed(text),
        None => Cow::Owned(json_text(content)),
    }
}

fn tool_payload_text<'a>(content: &'a Opaque, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| content.get(key).filter(|value| !value.is_null()))
        .and_then(Value::as_str)
}

fn stringify_tool_payload(content: &Opaque) -> Cow<'_, str> {
    if let Some(text) = tool_payload_text(content, &["text", "output", "content", "stdout", "raw"])
    {
        return Cow::Borrowed(text);
    }
    if let Some(items) = content.get("items").and_then(Value::as_array) {
        let text = items
            .iter()
            .filter_map(|item| item.get("text")?.as_str())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if !text.is_empty() {
            return Cow::Owned(text);
        }
    }
    Cow::Owned(json_text(content))
}

fn summarize_plan(steps: Option<&[PlanStep]>) -> ProjectedToolUseSummary {
    let Some(steps) = steps else {
        return ProjectedToolUseSummary::new("", false);
    };
    if steps.is_empty() {
        return ProjectedToolUseSummary::new("Empty plan snapshot", false);
    }
    let find = |status| steps.iter().find(|step| step.status == status);
    let active = find(PlanStepStatus::InProgress);
    let parts = [
        ("failed", find(PlanStepStatus::Failed)),
        ("skipped", find(PlanStepStatus::Skipped)),
        if active.is_some() {
            ("current", active)
        } else {
            ("next", find(PlanStepStatus::Pending))
        },
    ];
    let mut abridged = false;
    let parts: Vec<_> = parts
        .into_iter()
        .filter_map(|(label, step)| {
            let step = step?;
            abridged |= utf16::len(&step.content) > PROJECTED_BODY_MAX_CHARS;
            Some(format!("{label}: {}", bounded_collapse(&step.content)))
        })
        .collect();
    if parts.is_empty() {
        return ProjectedToolUseSummary::new(
            format!("{} item(s), all completed", steps.len()),
            false,
        );
    }
    let summary = parts.join("; ");
    if utf16::len(&summary) <= TOOL_SUMMARY_MAX_CHARS {
        return ProjectedToolUseSummary::new(summary, abridged);
    }
    let budget = (TOOL_SUMMARY_MAX_CHARS - 2 * (parts.len() - 1)) / parts.len();
    let text = parts
        .iter()
        .map(|part| {
            if utf16::len(part) > budget {
                truncate(part, budget - 3)
            } else {
                Cow::Borrowed(part.as_str())
            }
        })
        .collect::<Vec<_>>()
        .join("; ");
    ProjectedToolUseSummary::new(text, true)
}

fn summarize_todos(todos: Option<&[TodoItem]>) -> String {
    let Some(todos) = todos.filter(|todos| !todos.is_empty()) else {
        return String::new();
    };
    let active = todos
        .iter()
        .find(|todo| todo.status == TodoStatus::InProgress)
        .unwrap_or(&todos[0]);
    format!("{} item(s), current: {}", todos.len(), active.content)
}

fn json_text(value: &(impl Serialize + ?Sized)) -> String {
    // INFALLIBLE: strings and opaque JSON always serialize to JSON text.
    serde_json::to_string(value).expect("the value is JSON")
}

fn enum_text(value: &impl Serialize) -> String {
    let encoded = json_text(value);
    encoded[1..encoded.len() - 1].to_owned()
}

pub(super) fn tool_name(message: &ToolUseChatMessage) -> &str {
    let kind = message.message_type();
    kind.strip_suffix("-tool-use").unwrap_or(kind)
}

pub(super) fn collapse(text: &str) -> String {
    let mut output = String::new();
    let mut space = false;
    for ch in text.chars() {
        if trim(ch.encode_utf8(&mut [0; 4])).is_empty() {
            space = !output.is_empty();
        } else {
            if space {
                output.push(' ');
                space = false;
            }
            output.push(ch);
        }
    }
    output
}

pub(super) fn bounded_collapse(text: &str) -> String {
    collapse(&units::prefix(text, PROJECTED_BODY_MAX_CHARS))
}

fn truncate(text: &str, max_chars: usize) -> Cow<'_, str> {
    let prefix = units::prefix(text, max_chars);
    if prefix == text {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(format!("{prefix}..."))
    }
}
