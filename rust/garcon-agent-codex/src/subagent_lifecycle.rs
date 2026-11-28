use std::sync::LazyLock;

use garcon_contract::chat_types::{
    CodexSubagentAction, CodexSubagentDetails, CodexSubagentLifecycleSource, CodexSubagentState,
    CodexSubagentStatus, ToolUseChatMessage, codex_subagent_source_fingerprint,
};
use garcon_js::{json::parse, trim};
use indexmap::IndexMap;
use regress::Regex;
use serde_json::Value;

const AGENT_ERROR_PREFIX: &str = "Agent errored: ";
const AGENT_ERROR_SUFFIX: &str = "\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.";

pub fn convert_codex_inter_agent_lifecycle(
    timestamp: &str,
    tool_id: &str,
    author: &Value,
    recipient: &Value,
    content: &str,
) -> Option<ToolUseChatMessage> {
    let author = author.as_str().filter(|value| is_agent_path(value))?;
    let recipient = recipient.as_str().filter(|value| is_agent_path(value))?;
    let answer = parse_final_answer(content)?;
    if answer.task_name != recipient
        || answer.sender != author
        || immediate_parent_path(author) != Some(recipient)
    {
        return None;
    }
    Some(lifecycle_message(
        timestamp,
        tool_id,
        author,
        state_for_final_answer(answer.payload),
        CodexSubagentLifecycleSource::Structured,
        content,
    ))
}

fn immediate_parent_path(agent_path: &str) -> Option<&str> {
    agent_path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .filter(|path| !path.is_empty())
}

fn is_agent_path(path: &str) -> bool {
    matches!(path, "/root" | "/morpheus")
        || path.strip_prefix("/root/").is_some_and(|path| {
            path.split('/').all(|segment| {
                !segment.is_empty()
                    && segment != "root"
                    && segment.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                    })
            })
        })
}

pub fn convert_codex_subagent_lifecycle_text(
    timestamp: &str,
    tool_id: &str,
    text: &str,
) -> Option<ToolUseChatMessage> {
    if let Some(answer) = parse_final_answer(text) {
        return Some(lifecycle_message(
            timestamp,
            tool_id,
            answer.sender,
            state_for_final_answer(answer.payload),
            CodexSubagentLifecycleSource::Legacy,
            text,
        ));
    }
    static NOTIFICATION: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::new(r"^<subagent_notification>\s*([\s\S]*?)\s*</subagent_notification>$")
            .expect("subagent notification pattern")
    });
    let trimmed = trim(text);
    let notification = NOTIFICATION.find(trimmed)?;
    let payload = parse(&trimmed[notification.group(1)?]).ok()?;
    let target = nonempty_string(&payload["agent_path"])
        .or_else(|| nonempty_string(&payload["agent_id"]))?;
    let state = normalize_legacy_agent_status(&payload["status"])?;
    Some(lifecycle_message(
        timestamp,
        tool_id,
        target,
        state,
        CodexSubagentLifecycleSource::Legacy,
        text,
    ))
}

struct FinalAnswer<'a> {
    task_name: &'a str,
    sender: &'a str,
    payload: &'a str,
}

fn parse_final_answer(text: &str) -> Option<FinalAnswer<'_>> {
    static FINAL_ANSWER: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::new(r"^Message Type: FINAL_ANSWER\r?\nTask name: ([^\r\n]+)\r?\nSender: ([^\r\n]+)\r?\nPayload:(?:\r?\n([\s\S]*))?$")
            .expect("subagent final answer pattern")
    });
    let text = trim(text);
    let answer = FINAL_ANSWER.find(text)?;
    Some(FinalAnswer {
        task_name: trim(&text[answer.group(1)?]),
        sender: trim(&text[answer.group(2)?]),
        payload: answer.group(3).map_or("", |range| &text[range]),
    })
}

pub fn convert_codex_subagent_activity(
    timestamp: &str,
    tool_id: &str,
    kind: &str,
    agent_thread_id: &str,
    agent_path: &str,
) -> ToolUseChatMessage {
    let status = match kind {
        "interrupted" => CodexSubagentStatus::Interrupted,
        "completed" => CodexSubagentStatus::Completed,
        _ => CodexSubagentStatus::Running,
    };
    status_message(
        timestamp,
        tool_id,
        CodexSubagentDetails {
            target: Some(agent_path.into()),
            thread_id: Some(agent_thread_id.into()),
            agent_states: Some(IndexMap::from([(
                agent_path.into(),
                CodexSubagentState {
                    status,
                    message: None,
                },
            )])),
            lifecycle_source: Some(CodexSubagentLifecycleSource::Structured),
            ..Default::default()
        },
    )
}

fn lifecycle_message(
    timestamp: &str,
    tool_id: &str,
    target: &str,
    state: CodexSubagentState,
    source: CodexSubagentLifecycleSource,
    source_content: &str,
) -> ToolUseChatMessage {
    status_message(
        timestamp,
        tool_id,
        CodexSubagentDetails {
            target: Some(target.into()),
            agent_states: Some(IndexMap::from([(target.into(), state)])),
            lifecycle_source: Some(source),
            source_fingerprint: Some(codex_subagent_source_fingerprint(source_content)),
            ..Default::default()
        },
    )
}

fn status_message(
    timestamp: &str,
    tool_id: &str,
    details: CodexSubagentDetails,
) -> ToolUseChatMessage {
    ToolUseChatMessage::CodexSubagent {
        timestamp: timestamp.into(),
        tool_id: tool_id.into(),
        action: CodexSubagentAction::AgentStatus,
        details: Box::new(details),
    }
}

fn state_for_final_answer(payload: &str) -> CodexSubagentState {
    let message = trim(payload);
    let status = match message {
        "Agent shut down." => CodexSubagentStatus::Shutdown,
        "Agent was not found." => CodexSubagentStatus::NotFound,
        message
            if message.starts_with(AGENT_ERROR_PREFIX) && message.ends_with(AGENT_ERROR_SUFFIX) =>
        {
            CodexSubagentStatus::Errored
        }
        _ => CodexSubagentStatus::Completed,
    };
    CodexSubagentState {
        status,
        message: (!message.is_empty()).then(|| message.into()),
    }
}

fn normalize_legacy_agent_status(value: &Value) -> Option<CodexSubagentState> {
    if let Some(name) = value.as_str() {
        return Some(CodexSubagentState {
            status: normalize_status_name(name)?,
            message: None,
        });
    }
    value.as_object()?.iter().find_map(|(name, message)| {
        Some(CodexSubagentState {
            status: normalize_status_name(name)?,
            message: message
                .as_str()
                .filter(|message| !message.is_empty())
                .map(str::to_owned),
        })
    })
}

fn normalize_status_name(value: &str) -> Option<CodexSubagentStatus> {
    Some(match value {
        "pending_init" => CodexSubagentStatus::PendingInit,
        "running" => CodexSubagentStatus::Running,
        "interrupted" => CodexSubagentStatus::Interrupted,
        "completed" => CodexSubagentStatus::Completed,
        "errored" | "failed" => CodexSubagentStatus::Errored,
        "shutdown" => CodexSubagentStatus::Shutdown,
        "not_found" => CodexSubagentStatus::NotFound,
        _ => return None,
    })
}

fn nonempty_string(value: &Value) -> Option<&str> {
    value.as_str().map(trim).filter(|value| !value.is_empty())
}
