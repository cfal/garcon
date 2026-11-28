use std::cmp::Ordering;

use futures::TryStreamExt;
use garcon_agents_common::{
    jsonl::{JsonlLineResult, parse_first_jsonl_value},
    shared::{
        history_loader_utils::{JsonlLineReadOptions, read_jsonl_line_entries},
        transcript_order::compare_transcript_timestamps,
        transcript_timestamp::deterministic_transcript_timestamp,
    },
};
use garcon_base::event_loop::EventLoopSteps;
use garcon_contract::{
    chat_message_coercion::ChatMessageMetadata,
    chat_types::{
        AssistantMessage, ChatMessage, CompactionMessage, CompactionTrigger, ErrorMessage,
        ThinkingMessage, UserMessage,
    },
    file_mention_context::strip_resolved_file_mention_context,
    tool_result_message::ToolResultMessage,
};
use garcon_interface::{
    host::AgentLogger,
    native_message_source::{
        NativeMessageSourceInput, NativeSourced, attach_native_message_source,
        get_native_message_source,
    },
    resources::ExecutorResult,
};
use garcon_js::{
    date_parse::date_parse,
    json::{Opaque, stringify},
    trim,
};
use indexmap::IndexSet;
use serde_json::Value;

use crate::{
    cli_protocol::truthy,
    compaction::{CompactionInfo, extract_compaction_summary, parse_compact_metadata},
    tool_result_converter::claude_tool_result_content,
    tool_use_converter::convert_claude_tool_use,
    user_input::claude_steering_inputs_from_native_content,
};

pub fn parse_claude_jsonl_entry_with_source(
    line: &str,
    line_number: f64,
) -> Option<NativeSourced<Opaque>> {
    let JsonlLineResult::Value { value, .. } = parse_first_jsonl_value(line) else {
        return None;
    };
    truthy(&value["sessionId"]).then(|| sourced_entry(value, line_number))
}

fn parse_strict_claude_jsonl_entry_with_source(
    line: &str,
    line_number: u64,
) -> ExecutorResult<Option<NativeSourced<Opaque>>> {
    let value = match parse_first_jsonl_value(line) {
        JsonlLineResult::Empty => return Ok(None),
        JsonlLineResult::Value {
            value,
            discarded_suffix: false,
            ..
        } => value,
        _ => return Err(format!("Claude transcript record {line_number} is invalid").into()),
    };
    if !truthy(&value["sessionId"]) {
        return Ok(None);
    }
    assert_importable_claude_entry(&value, line_number)?;
    Ok(Some(sourced_entry(value, line_number as f64)))
}

fn sourced_entry(entry: Opaque, line_number: f64) -> NativeSourced<Opaque> {
    let mut entry = NativeSourced::new(entry);
    let id = ["uuid", "id", "messageId"]
        .into_iter()
        .find_map(|key| nonempty_string(&entry.value[key]))
        .map(str::to_owned);
    attach_native_message_source(
        &mut entry,
        Some(NativeMessageSourceInput {
            entry_id: id.as_deref(),
            line_number: Some(line_number),
            ..Default::default()
        }),
    );
    entry
}

fn assert_importable_claude_entry(entry: &Value, line_number: u64) -> ExecutorResult<()> {
    let Some(kind @ ("user" | "assistant")) = entry["type"].as_str() else {
        return Ok(());
    };
    let message = &entry["message"];
    let content = &message["content"];
    if message["role"] != kind || (!content.is_string() && !content.is_array()) {
        return Err(
            format!("Claude transcript record {line_number} has an invalid message").into(),
        );
    }
    for part in parts(content) {
        if nonempty_string(&part["type"]).is_none()
            || (part["type"] == "text" && !part["text"].is_string())
            || (part["type"] == "thinking" && !part["thinking"].is_string())
        {
            return Err(format!(
                "Claude transcript record {line_number} has an invalid message part"
            )
            .into());
        }
    }
    Ok(())
}

struct ClaudeSortKey {
    entry: NativeSourced<Opaque>,
    index: usize,
    time: f64,
}

fn claude_sort_key(entry: NativeSourced<Opaque>, index: usize) -> ClaudeSortKey {
    let time = entry.value["timestamp"]
        .as_str()
        .and_then(date_parse)
        .unwrap_or(0) as f64;
    ClaudeSortKey { entry, index, time }
}

fn compare_claude_sort_keys(a: &ClaudeSortKey, b: &ClaudeSortKey) -> Ordering {
    let comparison = compare_transcript_timestamps(a.time, b.time);
    if comparison < 0.0 {
        Ordering::Less
    } else if comparison > 0.0 {
        Ordering::Greater
    } else {
        a.index.cmp(&b.index)
    }
}

pub fn sort_claude_entries(entries: Vec<NativeSourced<Opaque>>) -> Vec<NativeSourced<Opaque>> {
    let mut keys: Vec<_> = entries
        .into_iter()
        .enumerate()
        .map(|(index, entry)| claude_sort_key(entry, index))
        .collect();
    keys.sort_by(compare_claude_sort_keys);
    keys.into_iter().map(|key| key.entry).collect()
}

pub async fn sort_claude_entries_in_steps(
    entries: Vec<NativeSourced<Opaque>>,
    steps: &mut EventLoopSteps,
) -> Vec<NativeSourced<Opaque>> {
    let mut keys = Vec::with_capacity(entries.len());
    steps
        .for_each(entries.into_iter().enumerate(), |(index, entry)| {
            keys.push(claude_sort_key(entry, index));
        })
        .await;
    keys.sort_by(compare_claude_sort_keys);
    let mut sorted = Vec::with_capacity(keys.len());
    steps.for_each(keys, |key| sorted.push(key.entry)).await;
    sorted
}

#[derive(Default)]
struct CollectedClaudeEntries<'a> {
    entries: Vec<&'a NativeSourced<Opaque>>,
    compactions: Vec<CompactionInfo>,
    seen_uuids: IndexSet<&'a str>,
}

impl<'a> CollectedClaudeEntries<'a> {
    fn add(&mut self, entry: &'a NativeSourced<Opaque>) {
        let value = &entry.value;
        if let Some(uuid) = nonempty_string(&value["uuid"])
            && !self.seen_uuids.insert(uuid)
        {
            return;
        }
        self.entries.push(entry);
        if value["type"] == "system" && value["subtype"] == "compact_boundary" {
            self.compactions.push(parse_compact_metadata(
                value
                    .get("compactMetadata")
                    .filter(|value| !value.is_null())
                    .unwrap_or(&value["compact_metadata"]),
            ));
        }
    }
}

pub fn convert_claude_entries(
    entries: &[NativeSourced<Opaque>],
) -> ExecutorResult<Vec<NativeSourced<ChatMessage>>> {
    let mut collected = CollectedClaudeEntries::default();
    for entry in entries {
        collected.add(entry);
    }
    let mut converter = ClaudeEntryConverter::new(collected.compactions);
    for entry in collected.entries {
        converter.convert(entry)?;
    }
    Ok(converter.messages)
}

pub async fn convert_claude_entries_in_steps(
    entries: &[NativeSourced<Opaque>],
    steps: &mut EventLoopSteps,
) -> ExecutorResult<Vec<NativeSourced<ChatMessage>>> {
    let mut collected = CollectedClaudeEntries::default();
    steps.for_each(entries, |entry| collected.add(entry)).await;
    let mut converter = ClaudeEntryConverter::new(collected.compactions);
    steps
        .try_for_each(collected.entries, |entry| converter.convert(entry))
        .await?;
    Ok(converter.messages)
}

struct ClaudeEntryConverter {
    messages: Vec<NativeSourced<ChatMessage>>,
    compactions: std::vec::IntoIter<CompactionInfo>,
}

impl ClaudeEntryConverter {
    fn new(compactions: Vec<CompactionInfo>) -> Self {
        Self {
            messages: Vec::new(),
            compactions: compactions.into_iter(),
        }
    }

    fn convert(&mut self, entry: &NativeSourced<Opaque>) -> ExecutorResult<()> {
        let source = get_native_message_source(entry);
        let value = &entry.value;
        let timestamp = if let Some(timestamp) = nonempty_string(&value["timestamp"]) {
            timestamp.to_owned()
        } else {
            deterministic_transcript_timestamp(
                source
                    .as_ref()
                    .and_then(|source| source.line_number.map(|number| number.0)),
                source
                    .as_ref()
                    .and_then(|source| source.byte_offset.map(|offset| offset as f64)),
            )?
        };
        let kind = value["type"].as_str();
        let message = &value["message"];
        let content = &message["content"];
        let mut ordinal = 0_u64;
        let mut push = |message| {
            let mut row = NativeSourced::new(message);
            attach_native_message_source(
                &mut row,
                Some(NativeMessageSourceInput {
                    entry_id: source
                        .as_ref()
                        .and_then(|source| source.entry_id.as_deref()),
                    line_number: source
                        .as_ref()
                        .and_then(|source| source.line_number.map(|number| number.0)),
                    byte_offset: source
                        .as_ref()
                        .and_then(|source| source.byte_offset.map(|offset| offset as f64)),
                    within_source_ordinal: Some(ordinal as f64),
                }),
            );
            ordinal += 1;
            self.messages.push(row);
        };
        let user = |timestamp: &str, content: &str| {
            ChatMessage::User(UserMessage {
                timestamp: timestamp.to_owned(),
                content: strip_resolved_file_mention_context(content).to_owned(),
                images: None,
                metadata: source
                    .as_ref()
                    .and_then(|source| source.entry_id.as_ref())
                    .map(|id| {
                        let mut metadata = ChatMessageMetadata::default();
                        metadata.upstream_request_id = Some(id.clone());
                        metadata
                    }),
                presentation: None,
            })
        };
        let assistant = |content: &str| {
            ChatMessage::Assistant(AssistantMessage {
                timestamp: timestamp.clone(),
                content: content.to_owned(),
                questions: None,
            })
        };
        let thinking = |content: &str| {
            ChatMessage::Thinking(ThinkingMessage {
                timestamp: timestamp.clone(),
                content: content.to_owned(),
            })
        };

        // Request-cache blobs repeat model input, not conversational transcript rows.
        // https://github.com/anthropics/claude-agent-sdk-python/blob/0e89b298e771259378a6cd3734e00d323dff5703/src/claude_agent_sdk/_internal/sessions.py#L893-L928
        if matches!(
            kind,
            Some(
                "api-request-blob"
                    | "progress"
                    | "queue-operation"
                    | "file-history-snapshot"
                    | "summary"
            )
        ) {
            return Ok(());
        }
        if kind == Some("attachment") {
            let attachment = &value["attachment"];
            if attachment["type"] == "queued_command" && attachment["commandMode"] == "prompt" {
                let origin = attachment
                    .get("origin")
                    .filter(|origin| !origin.is_null())
                    .unwrap_or(&value["origin"]);
                let timestamp = nonempty_string(&attachment["timestamp"]).unwrap_or(&timestamp);
                for (text, steering) in claude_user_texts(&attachment["prompt"]) {
                    if steering
                        || (attachment["isMeta"] != true
                            && value["isMeta"] != true
                            && !is_provider_owned_user_message(origin, &text))
                    {
                        push(user(timestamp, &text));
                    }
                }
            }
            return Ok(());
        }
        if kind == Some("system") {
            return Ok(());
        }
        if truthy(&value["isCompactSummary"]) {
            let text = get_message_text(content);
            if !text.is_empty() {
                let info = self.compactions.next().unwrap_or(CompactionInfo {
                    trigger: CompactionTrigger::Manual,
                    pre_tokens: None,
                    post_tokens: None,
                });
                push(ChatMessage::Compaction(CompactionMessage {
                    timestamp: timestamp.clone(),
                    trigger: info.trigger,
                    summary: extract_compaction_summary(&text).to_owned(),
                    pre_tokens: info.pre_tokens,
                    post_tokens: info.post_tokens,
                }));
            }
            return Ok(());
        }
        if truthy(&value["isMeta"]) {
            return Ok(());
        }
        if truthy(&value["isApiErrorMessage"]) {
            let error = &value["error"];
            let text = if truthy(error) {
                error
                    .as_str()
                    .map_or_else(|| stringify(error), str::to_owned)
            } else {
                let text = get_message_text(content);
                if text.is_empty() {
                    "API error".to_owned()
                } else {
                    text
                }
            };
            push(ChatMessage::Error(ErrorMessage {
                timestamp: timestamp.clone(),
                content: text,
            }));
            return Ok(());
        }
        if message["role"] == "user" {
            for part in parts(content) {
                if part["type"] == "tool_result" {
                    let metadata = value
                        .get("toolUseResult")
                        .filter(|value| !value.is_null())
                        .or_else(|| value.get("tool_use_result"));
                    push(ChatMessage::ToolResult(ToolResultMessage::new(
                        timestamp.clone(),
                        part["tool_use_id"].as_str().unwrap_or_default().to_owned(),
                        claude_tool_result_content(
                            part.get("content")
                                .cloned()
                                .map(Opaque::from_value)
                                .as_ref(),
                            metadata.cloned().map(Opaque::from_value).as_ref(),
                        ),
                        truthy(&part["is_error"]),
                        None,
                    )));
                }
            }
            for (text, steering) in claude_user_texts(content) {
                if steering || !is_provider_owned_user_message(&value["origin"], &text) {
                    push(user(&timestamp, &text));
                }
            }
        } else if message["role"] == "assistant" && truthy(content) {
            if let Some(content) = content.as_str() {
                if !trim(content).is_empty() && !is_system_assistant_message(content) {
                    push(assistant(content));
                }
            } else {
                for part in parts(content) {
                    match part["type"].as_str() {
                        Some("thinking") => {
                            if let Some(content) = nonempty_string(&part["thinking"]) {
                                push(thinking(content));
                            }
                        }
                        Some("text") => {
                            if let Some(text) = part["text"].as_str()
                                && !trim(text).is_empty()
                                && !is_system_assistant_message(text)
                            {
                                push(assistant(text));
                            }
                        }
                        Some("tool_use") => push(ChatMessage::ToolUse(convert_claude_tool_use(
                            &timestamp, part,
                        ))),
                        _ => {}
                    }
                }
            }
        } else if kind == Some("thinking")
            && let Some(content) = nonempty_string(content)
        {
            push(thinking(content));
        }
        Ok(())
    }
}

fn parts(content: &Value) -> &[Value] {
    content.as_array().map_or(&[], Vec::as_slice)
}

fn nonempty_string(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

fn get_message_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return trim(text).to_owned();
    }
    parts(content)
        .iter()
        .filter_map(|part| {
            part["text"]
                .as_str()
                .map(trim)
                .filter(|text| !text.is_empty())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn claude_user_texts(content: &Value) -> Vec<(std::borrow::Cow<'_, str>, bool)> {
    if let Some(inputs) = claude_steering_inputs_from_native_content(content) {
        return inputs
            .into_iter()
            .filter(|text| !trim(text).is_empty())
            .map(|text| (text.into(), true))
            .collect();
    }
    let text = get_message_text(content);
    if text.is_empty() {
        Vec::new()
    } else {
        vec![(text.into(), false)]
    }
}

fn is_system_assistant_message(text: &str) -> bool {
    text.starts_with("Invalid API key")
        || text.contains("{\"subtasks\":")
        || text.contains("CRITICAL: You MUST respond with ONLY a JSON")
}

fn is_provider_owned_user_message(origin: &Value, text: &str) -> bool {
    // The SDK treats every present origin except "human" as provider-injected.
    // https://github.com/anthropics/claude-agent-sdk-python/blob/99a734c94ff4f41e08a9edb05371003538a366b2/src/claude_agent_sdk/types.py#L1049-L1120
    origin["kind"].as_str().is_some_and(|kind| kind != "human")
        || [
            "<command-name>",
            "<command-message>",
            "<command-args>",
            "<local-command-stdout>",
            "<system-reminder>",
            "<task-notification>",
            "Caveat:",
            "This session is being continued from a previous",
        ]
        .into_iter()
        .any(|prefix| text.starts_with(prefix))
        || is_system_assistant_message(text)
        || text == "Warmup"
}

pub async fn load_claude_chat_messages(
    native_path: Option<&str>,
    logger: Option<&dyn AgentLogger>,
    throw_on_error: bool,
) -> ExecutorResult<Vec<NativeSourced<ChatMessage>>> {
    let Some(native_path) = native_path.filter(|path| !path.is_empty()) else {
        return Ok(Vec::new());
    };
    if let Err(error) = tokio::fs::metadata(native_path).await {
        return if throw_on_error {
            Err(error.into())
        } else {
            Ok(Vec::new())
        };
    }

    match parse_claude_jsonl_file(native_path, throw_on_error).await {
        Err(error) if !throw_on_error => {
            if let Some(logger) = logger {
                logger.error(
                    "Claude transcript load failed",
                    Some(&indexmap::IndexMap::from([
                        (
                            "nativePath".into(),
                            Value::String(native_path.to_owned()).into(),
                        ),
                        ("error".into(), Value::String(error.to_string()).into()),
                    ])),
                );
            }
            Ok(Vec::new())
        }
        result => result,
    }
}

async fn parse_claude_jsonl_file(
    native_path: &str,
    strict: bool,
) -> ExecutorResult<Vec<NativeSourced<ChatMessage>>> {
    let mut steps = EventLoopSteps::new("claude-history-load");
    let mut entries = Vec::new();
    let mut lines = read_jsonl_line_entries(native_path, JsonlLineReadOptions::default());
    while let Some(line) = lines.try_next().await? {
        // INFALLIBLE: The JSONL reader associates each physical line with its number.
        let line_number = line.line_number.expect("physical line number");
        let entry = if strict {
            parse_strict_claude_jsonl_entry_with_source(&line.line, line_number)?
        } else {
            parse_claude_jsonl_entry_with_source(&line.line, line_number as f64)
        };
        if let Some(entry) = entry {
            entries.push(entry);
        }
        if steps.due() {
            steps.next().await;
        }
    }
    convert_claude_entries_in_steps(
        &sort_claude_entries_in_steps(entries, &mut steps).await,
        &mut steps,
    )
    .await
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, javascript_number, replay, text, unknown};
    use garcon_interface::native_message_source::get_native_message_revision_source;
    use serde_json::json;
    use tokio::fs;

    use super::*;

    #[test]
    fn recorded_native_entries_and_rendered_positions_match() {
        replay(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/history-loader"),
            |function, args| match function {
                "parseHistoryEntry" => {
                    let line = text(function, args.first())?.expect("recorded line");
                    let number = javascript_number(function, args.get(1))?;
                    Ok(parse_claude_jsonl_entry_with_source(line, number).map_or(
                        Value::Null,
                        |entry| {
                            let source = encoded(&get_native_message_revision_source(&entry));
                            json!({"entry":encoded(&entry), "source":source})
                        },
                    ))
                }
                "convertHistoryLines" => {
                    let lines = unknown(function, args.first())?;
                    let entries = lines
                        .as_array()
                        .expect("recorded lines")
                        .iter()
                        .enumerate()
                        .filter_map(|(ordinal, line)| {
                            parse_claude_jsonl_entry_with_source(
                                line.as_str().expect("recorded line"),
                                (ordinal + 1) as f64,
                            )
                        })
                        .collect();
                    let result = convert_claude_entries(&sort_claude_entries(entries)).unwrap();
                    Ok(Value::Array(result.iter().map(|row| {
                        json!({"message":encoded(row), "source":encoded(&get_native_message_revision_source(row))})
                    }).collect()))
                }
                _ => Err(CaseError::unhandled(function)),
            },
        );
    }

    fn encoded(value: &impl serde::Serialize) -> Value {
        garcon_js::json::from_slice(&serde_json::to_vec(value).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn rejects_incomplete_records_and_recognized_content_payloads_before_retry() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let native_path = path.to_str();
        fs::write(&path, "\n{\"sessionId\":").await.unwrap();
        let error = load_claude_chat_messages(native_path, None, true)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Claude transcript record 2 is invalid");
        assert!(
            load_claude_chat_messages(native_path, None, false)
                .await
                .unwrap()
                .is_empty()
        );

        for role in ["user", "assistant"] {
            for part in [
                Value::Null,
                json!(17),
                json!([]),
                json!({}),
                json!({"type": ""}),
                json!({"type": 17}),
                json!({"type":"text"}),
                json!({"type":"text","text":17}),
                json!({"type":"thinking"}),
                json!({"type":"thinking","thinking":false}),
            ] {
                fs::write(&path, serde_json::to_vec(&json!({
                    "sessionId":"synthetic-session",
                    "type":role,
                    "message":{"role":role,"content":[{"type":"text","text":"synthetic valid prefix"},part]},
                })).unwrap()).await.unwrap();
                let error = load_claude_chat_messages(native_path, None, true)
                    .await
                    .unwrap_err();
                assert_eq!(
                    error.to_string(),
                    "Claude transcript record 1 has an invalid message part"
                );
            }
        }
        fs::write(&path, r#"{"sessionId":"synthetic-session","type":"user"}"#)
            .await
            .unwrap();
        let error = load_claude_chat_messages(native_path, None, true)
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Claude transcript record 1 has an invalid message"
        );

        fs::write(&path, concat!(
            "{\"type\":\"api-request-blob\",\"sessionId\":\"synthetic-session\",\"message\":{\"role\":\"user\",\"content\":\"synthetic prompt\"}}\n",
            "{\"type\":\"user\",\"sessionId\":\"synthetic-session\",\"uuid\":\"synthetic-id\",\"message\":{\"role\":\"user\",\"content\":\"synthetic prompt\"}}\n",
            "{\"type\":\"assistant\",\"sessionId\":\"synthetic-session\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"future-hidden\"}]}}\n",
        )).await.unwrap();
        let rows = load_claude_chat_messages(native_path, None, true)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert!(
            matches!(&rows[0].value, ChatMessage::User(user) if user.content == "synthetic prompt")
        );
        let source = get_native_message_revision_source(&rows[0]).unwrap();
        assert_eq!(source.entry_id.as_deref(), Some("synthetic-id"));
        assert_eq!(source.line_number.map(|number| number.0), Some(2.0));
    }

    #[tokio::test]
    async fn streaming_file_read_matches_the_whole_native_history_conversion() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("history.jsonl");
        let lines: Vec<_> = (0..4_000)
            .map(|index| {
                serde_json::to_string(&json!({
                "type":"user","sessionId":"synthetic-session","uuid":format!("synthetic-{index}"),
                "message":{"role":"user","content": if index == 2_000 {
                    "x".repeat(65_540)
                } else {
                    format!("synthetic prompt {index}")
                }},
            })).unwrap()
            })
            .collect();
        fs::write(&path, lines.join("\n")).await.unwrap();
        let mut loading = Box::pin(load_claude_chat_messages(path.to_str(), None, true));
        assert!(futures::poll!(&mut loading).is_pending());
        let rows = loading.await.unwrap();
        let entries = lines
            .iter()
            .enumerate()
            .filter_map(|(index, line)| {
                parse_claude_jsonl_entry_with_source(line, (index + 1) as f64)
            })
            .collect();
        let expected = convert_claude_entries(&sort_claude_entries(entries)).unwrap();
        assert_eq!(rows.len(), lines.len());
        assert_eq!(rows, expected);
    }

    #[tokio::test]
    async fn matches_native_history_and_strict_recovery_errors_from_the_same_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("history.jsonl");
        fs::write(&path, concat!(
            "{\"sessionId\":\"synthetic-session\",\"uuid\":\"later\",\"type\":\"assistant\",\"timestamp\":\"2026-07-21T14:00:02.000Z\",\"message\":{\"role\":\"assistant\",\"content\":\"synthetic result\"}}\r\n",
            "\n",
            "{\"sessionId\":\"synthetic-session\",\"uuid\":\"earlier\",\"type\":\"user\",\"timestamp\":\"2026-07-21T14:00:01.000Z\",\"message\":{\"role\":\"user\",\"content\":\"synthetic prompt\"}}\n",
            "{\"sessionId\":",
        )).await.unwrap();
        for (mode, strict) in [("lenient", false), ("strict", true)] {
            let original = tokio::process::Command::new("bun")
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/oracles/history-loader.ts"
                ))
                .arg(&path)
                .arg(mode)
                .output()
                .await
                .unwrap();
            assert!(
                original.status.success(),
                "{}",
                String::from_utf8_lossy(&original.stderr)
            );
            let encoded = match load_claude_chat_messages(path.to_str(), None, strict).await {
                Ok(rows) => serde_json::to_string(&rows.iter().map(|row| {
                    json!({"message":encoded(row), "source":encoded(&get_native_message_revision_source(row))})
                }).collect::<Vec<_>>()).unwrap(),
                Err(error) => serde_json::to_string(&json!({"error":error.to_string()})).unwrap(),
            };
            assert_eq!(encoded, String::from_utf8(original.stdout).unwrap());
        }
    }
}
