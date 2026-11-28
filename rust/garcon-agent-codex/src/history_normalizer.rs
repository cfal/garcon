use std::sync::LazyLock;

use garcon_agents_common::shared::{
    normalize_util::normalize_tool_result_content,
    transcript_timestamp::deterministic_transcript_timestamp,
};
use garcon_base::errors::{ErrorInput, js_string};
use garcon_contract::chat_types::{
    AssistantMessage, ChatMessage, CompactionMessage, CompactionTrigger, ThinkingMessage,
    ToolResultMessage, ToolUseChatMessage,
};
use garcon_js::{
    clock::InvalidTimeValue,
    json::{Opaque, as_number},
    trim,
};
use regress::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::{
    async_questions::codex_historical_user_message,
    jsonl_tool_use_converter::{
        ParsedApplyPatch, convert_codex_custom_tool_call, convert_codex_function_call,
    },
    subagent_lifecycle::{
        convert_codex_inter_agent_lifecycle, convert_codex_subagent_activity,
        convert_codex_subagent_lifecycle_text,
    },
};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexJsonlNormalizationResult {
    pub canonical: Vec<ChatMessage>,
    pub fallback_user: Vec<ChatMessage>,
    pub fallback_assistant: Vec<ChatMessage>,
    pub fallback_thinking: Vec<ChatMessage>,
    pub is_canonical_user: bool,
    pub is_canonical_assistant: bool,
    pub is_canonical_thinking: bool,
}

#[derive(Default)]
pub struct CodexJsonlNormalizationContext {
    pub source_byte_offset: Option<f64>,
    pub source_line_number: Option<f64>,
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn nonblank(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !trim(text).is_empty())
}

fn stable_hash(input: &str) -> u32 {
    input.encode_utf16().fold(0x811c9dc5, |hash, unit| {
        (hash ^ u32::from(unit)).wrapping_mul(0x01000193)
    })
}

pub fn extract_text_content(content: &Value) -> String {
    let Some(content) = content.as_array() else {
        return text(content).into();
    };
    content
        .iter()
        .filter(|part| {
            matches!(
                part["type"].as_str(),
                Some("input_text" | "output_text" | "text")
            )
        })
        .map(|part| &part["text"])
        .filter(|part| match part {
            Value::Null => false,
            Value::Bool(value) => *value,
            Value::Number(_) => as_number(part).is_some_and(|n| n != 0.0 && !n.is_nan()),
            Value::String(value) => !value.is_empty(),
            _ => true,
        })
        .map(|part| js_string(ErrorInput::Json(part)))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn parse_apply_patch(input: &str) -> ParsedApplyPatch {
    static FILE: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::new(r"\*\*\* (?:Add|Update|Delete) File: (.+)").expect("Codex patch file header")
    });
    let file_path = FILE
        .find(input)
        .and_then(|matched| matched.group(1))
        .map_or("unknown", |range| trim(&input[range]))
        .into();
    let mut old_lines = Vec::new();
    let mut new_lines = Vec::new();
    for line in input.split('\n') {
        if let Some(old) = line.strip_prefix('-').filter(|_| !line.starts_with("---")) {
            old_lines.push(old);
        } else if let Some(new) = line.strip_prefix('+').filter(|_| !line.starts_with("+++")) {
            new_lines.push(new);
        }
    }
    ParsedApplyPatch {
        file_path,
        old_string: old_lines.join("\n"),
        new_string: new_lines.join("\n"),
    }
}

pub fn normalize_codex_jsonl_entry(
    entry: &Value,
    context: &CodexJsonlNormalizationContext,
) -> Result<Option<CodexJsonlNormalizationResult>, InvalidTimeValue> {
    if entry.as_object().is_none_or(serde_json::Map::is_empty) {
        return Ok(None);
    }
    let fallback;
    let timestamp = if let Some(timestamp) = entry["timestamp"].as_str() {
        timestamp
    } else {
        fallback = deterministic_transcript_timestamp(
            context.source_line_number,
            context.source_byte_offset,
        )?;
        &fallback
    };
    let payload = &entry["payload"];
    Ok(match entry["type"].as_str() {
        Some("event_msg") => normalize_event_msg(payload, timestamp),
        Some("response_item") => normalize_response_item(payload, timestamp, context),
        Some("inter_agent_communication") => {
            let Some(content) = nonblank(&payload["content"]) else {
                return Ok(None);
            };
            let id = format!("subagent-lifecycle-{:08x}", stable_hash(content));
            convert_codex_inter_agent_lifecycle(
                timestamp,
                &id,
                &payload["author"],
                &payload["recipient"],
                content,
            )
            .map(|message| CodexJsonlNormalizationResult {
                canonical: vec![ChatMessage::ToolUse(message)],
                ..Default::default()
            })
        }
        _ => None,
    })
}

fn normalize_event_msg(payload: &Value, timestamp: &str) -> Option<CodexJsonlNormalizationResult> {
    let mut result = CodexJsonlNormalizationResult::default();
    match payload["type"].as_str()? {
        "user_message" => {
            if let Some(content) = nonblank(&payload["message"]) {
                result.is_canonical_user = true;
                let client_id = payload["client_id"].as_str().map(trim);
                result
                    .canonical
                    .push(ChatMessage::User(codex_historical_user_message(
                        timestamp, content, client_id,
                    )));
            }
        }
        "agent_message" => {
            if let Some(content) = nonblank(&payload["message"]) {
                result
                    .fallback_assistant
                    .push(assistant(timestamp, content));
            }
        }
        "agent_reasoning" => {
            let content = payload["message"]
                .as_str()
                .filter(|message| !message.is_empty())
                .unwrap_or_else(|| text(&payload["text"]));
            if !trim(content).is_empty() {
                result.fallback_thinking.push(thinking(timestamp, content));
            }
        }
        "context_compacted" => result
            .canonical
            .push(ChatMessage::Compaction(CompactionMessage {
                timestamp: timestamp.into(),
                trigger: CompactionTrigger::Manual,
                summary: String::new(),
                pre_tokens: None,
                post_tokens: None,
            })),
        "sub_agent_activity" => {
            let (event_id, kind, agent_thread_id, agent_path) = (
                text(&payload["event_id"]),
                text(&payload["kind"]),
                text(&payload["agent_thread_id"]),
                text(&payload["agent_path"]),
            );
            if !event_id.is_empty()
                && !agent_thread_id.is_empty()
                && !agent_path.is_empty()
                && matches!(kind, "started" | "interacted" | "interrupted")
            {
                result
                    .canonical
                    .push(ChatMessage::ToolUse(convert_codex_subagent_activity(
                        timestamp,
                        event_id,
                        kind,
                        agent_thread_id,
                        agent_path,
                    )));
            }
        }
        _ => return None,
    }
    Some(result)
}

fn normalize_response_item(
    payload: &Value,
    timestamp: &str,
    context: &CodexJsonlNormalizationContext,
) -> Option<CodexJsonlNormalizationResult> {
    let mut result = CodexJsonlNormalizationResult::default();
    match payload["type"].as_str()? {
        "agent_message" => {
            let content = extract_text_content(&payload["content"]);
            let fallback = format!("subagent-lifecycle-{:08x}", stable_hash(&content));
            let id = payload["id"].as_str().unwrap_or(&fallback);
            result.canonical.extend(
                convert_codex_inter_agent_lifecycle(
                    timestamp,
                    id,
                    &payload["author"],
                    &payload["recipient"],
                    &content,
                )
                .map(ChatMessage::ToolUse),
            );
        }
        "message" => match payload["role"].as_str() {
            Some("developer") => return None,
            Some("assistant" | "user") => {
                let content = extract_text_content(&payload["content"]);
                if !trim(&content).is_empty() {
                    if payload["role"] == "assistant" {
                        result.is_canonical_assistant = true;
                        result.canonical.push(assistant(timestamp, &content));
                    } else {
                        let fallback = format!("subagent-lifecycle-{:08x}", stable_hash(&content));
                        let id = payload["id"].as_str().unwrap_or(&fallback);
                        if let Some(message) =
                            convert_codex_subagent_lifecycle_text(timestamp, id, &content)
                        {
                            result.canonical.push(ChatMessage::ToolUse(message));
                        } else {
                            result.fallback_user.push(ChatMessage::User(
                                codex_historical_user_message(timestamp, &content, None),
                            ));
                        }
                    }
                }
            }
            _ => {}
        },
        "reasoning" => {
            let summary = payload["summary"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| text(&item["text"]))
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            if !trim(&summary).is_empty() {
                result.is_canonical_thinking = true;
                result.canonical.push(thinking(timestamp, &summary));
            }
        }
        "function_call" => {
            result
                .canonical
                .push(ChatMessage::ToolUse(convert_codex_function_call(
                    timestamp,
                    &Opaque::from_value(payload.clone()),
                )))
        }
        "custom_tool_call" => {
            result
                .canonical
                .push(ChatMessage::ToolUse(convert_codex_custom_tool_call(
                    timestamp,
                    &Opaque::from_value(payload.clone()),
                    parse_apply_patch,
                )))
        }
        "function_call_output" | "custom_tool_call_output" => {
            let mut output = payload.get("output").cloned().map(Opaque::from_value);
            let mut failed = false;
            if payload["type"] == "function_call_output"
                && let Some((content, is_error)) =
                    payload["output"].as_str().and_then(parse_exec_output)
            {
                output = Some(Opaque::from_value(Value::String(content.into())));
                failed = is_error;
            }
            result.canonical.push(tool_result(
                timestamp,
                text(&payload["call_id"]),
                output.as_ref(),
                failed,
            ));
        }
        "web_search_call" => {
            let action = &payload["action"];
            let queries: Vec<_> = action["queries"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let query = match text(&action["type"]) {
                "search" => std::iter::once(text(&action["query"]))
                    .chain(queries.iter().copied())
                    .map(trim)
                    .find(|query| !query.is_empty()),
                "open_page" | "openPage" => nonblank(&action["url"]).map(trim),
                "find_in_page" | "findInPage" => nonblank(&action["pattern"])
                    .or_else(|| nonblank(&action["url"]))
                    .map(trim),
                _ => None,
            };
            if let Some(query) = query {
                let tool_id = payload["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .map_or_else(
                        || {
                            let source_position = if let Some(offset) = context.source_byte_offset {
                                format!("byte:{}", garcon_js::number_to_string(offset))
                            } else {
                                format!(
                                    "line:{}",
                                    context
                                        .source_line_number
                                        .map_or_else(String::new, garcon_js::number_to_string)
                                )
                            };
                            let fingerprint =
                                [timestamp, text(&action["type"]), &source_position, query]
                                    .into_iter()
                                    .chain(queries)
                                    .collect::<Vec<_>>()
                                    .join("\u{1f}");
                            format!("web-search-{:08x}", stable_hash(&fingerprint))
                        },
                        str::to_owned,
                    );
                result
                    .canonical
                    .push(ChatMessage::ToolUse(ToolUseChatMessage::WebSearch {
                        timestamp: timestamp.into(),
                        tool_id: tool_id.clone(),
                        query: query.into(),
                    }));
                if matches!(payload["status"].as_str(), Some("completed" | "searching")) {
                    let output = Opaque::from_value(Value::String(format!("Searched: {query}")));
                    result
                        .canonical
                        .push(tool_result(timestamp, &tool_id, Some(&output), false));
                }
            }
        }
        _ => return None,
    }
    Some(result)
}

fn assistant(timestamp: &str, text: &str) -> ChatMessage {
    ChatMessage::Assistant(AssistantMessage {
        timestamp: timestamp.into(),
        content: text.into(),
        questions: None,
    })
}

fn thinking(timestamp: &str, text: &str) -> ChatMessage {
    ChatMessage::Thinking(ThinkingMessage {
        timestamp: timestamp.into(),
        content: text.into(),
    })
}

fn tool_result(timestamp: &str, id: &str, output: Option<&Opaque>, failed: bool) -> ChatMessage {
    ChatMessage::ToolResult(ToolResultMessage::new(
        timestamp.into(),
        id.into(),
        normalize_tool_result_content(output),
        failed,
        None,
    ))
}

fn parse_exec_output(output: &str) -> Option<(&str, bool)> {
    static WRAPPER: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::new(r"^Chunk ID: \S+\nWall time: [\d.]+ seconds\nProcess exited with code (\d+)\n(?:Original token count: \d+\n)?Output:\n")
            .expect("Codex exec output wrapper")
    });
    let matched = WRAPPER.find(output)?;
    Some((
        &output[matched.range().end..],
        &output[matched.group(1)?] != "0",
    ))
}
