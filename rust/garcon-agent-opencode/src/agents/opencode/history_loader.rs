//! Ports `server-agents/opencode/src/agents/opencode/history-loader.ts`.

use garcon_agents_common::shared::{
    file_mention_context::strip_resolved_file_mention_context,
    normalize_util::normalize_tool_result_content,
};
use garcon_base::event_loop::EventLoopSteps;
use garcon_contract::{
    chat_message_coercion::ChatImage,
    chat_types::{
        AssistantMessage, ChatMessage, CompactionMessage, CompactionTrigger, ErrorMessage,
        ThinkingMessage, ToolResultMessage, UserMessage,
    },
};
use garcon_interface::{
    host::AgentLogger,
    native_message_source::{
        NativeMessageSourceInput, NativeSourced, attach_native_message_source,
    },
    resources::ExecutorResult,
};
use garcon_js::{Clock, clock::to_iso_string, date_parse::date_parse, json::Opaque, trim};
use serde_json::{Map, Value, json};

use super::{
    sdk_client::{OpenCodeClient, OpenCodeRequest},
    sdk_result::{
        create_open_code_request_scope, has_open_code_result_error, is_open_code_not_found_result,
        open_code_result_error_message, with_open_code_request_scope,
    },
    sse_events::is_open_code_compaction_assistant,
    tool_result_converter::normalize_open_code_tool_result_content,
    tool_use_converter::convert_open_code_tool_use,
};
use crate::js::{AbortSignal, error, log_fields, prop, string_of, truthy};

#[cfg(test)]
mod tests;

#[derive(Debug, thiserror::Error)]
#[error("OpenCode transcript session not found")]
pub struct OpenCodeTranscriptNotFoundError;

fn date_to_iso(value: Option<&Value>) -> Option<String> {
    let ms = match value? {
        Value::Null => 0,
        Value::Bool(value) => i64::from(*value),
        Value::Number(value) => value.as_f64()? as i64,
        Value::String(value) => date_parse(value)?,
        value => date_parse(&string_of(Some(value)))?,
    };
    to_iso_string(ms).ok()
}

fn parts(message: &Value) -> &[Value] {
    prop(message, "parts").as_array().map_or(&[], Vec::as_slice)
}

fn user_text(message: &Value) -> String {
    if let Some(text) = prop(message, "parts").as_str() {
        return text.to_owned();
    }
    parts(message)
        .iter()
        .filter(|part| {
            prop(*part, "type").as_str() == Some("text")
                && prop(*part, "synthetic").as_bool() != Some(true)
        })
        .map(|part| prop(part, "text").as_str().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n")
}

fn user_images(message: &Value) -> Vec<ChatImage> {
    parts(message)
        .iter()
        .filter_map(|part| {
            if prop(part, "type").as_str() != Some("file") {
                return None;
            }
            let mime = prop(part, "mime")
                .as_str()
                .filter(|mime| mime.starts_with("image/"))?;
            let data = prop(part, "url")
                .as_str()
                .filter(|url| url.starts_with("data:"))?;
            let name = prop(part, "filename")
                .as_str()
                .filter(|name| !name.is_empty())
                .unwrap_or("image");
            Some(ChatImage {
                data: data.to_owned(),
                name: name.to_owned(),
                mime_type: Some(mime.to_owned()),
            })
        })
        .collect()
}

// Compaction summaries and their continuation prompts are provider bookkeeping.
// A failed summary and a manual boundary retain the summary's message identity.
async fn visible_stored_messages<'a>(
    raw: &'a [Value],
    steps: &mut EventLoopSteps,
) -> Vec<&'a Value> {
    let mut visible = Vec::new();
    let mut overflow_pending = false;
    let mut replay_expected_text = None;
    let mut last_visible_user_text = None;
    let mut manual_boundary = false;
    for message in raw {
        steps.next().await;
        let info = prop(message, "info");
        match prop(info, "role").as_str() {
            Some("user") => {
                if let Some(control) = parts(message)
                    .iter()
                    .find(|part| prop(*part, "type").as_str() == Some("compaction"))
                {
                    overflow_pending = prop(control, "overflow").as_bool() == Some(true);
                    replay_expected_text = None;
                    manual_boundary = prop(control, "auto").as_bool() != Some(true);
                    continue;
                }
                let text = user_text(message);
                if trim(&text).is_empty()
                    && !parts(message)
                        .iter()
                        .any(|part| prop(part, "type").as_str() == Some("file"))
                {
                    if parts(message).iter().any(|part| {
                        prop(part, "type").as_str() == Some("text")
                            && prop(part, "synthetic").as_bool() == Some(true)
                    }) {
                        overflow_pending = false;
                        replay_expected_text = None;
                    }
                    continue;
                }
                overflow_pending = false;
                if replay_expected_text.take().as_ref() == Some(&text) {
                    continue;
                }
                visible.push(message);
                last_visible_user_text = Some(text);
            }
            Some("assistant") if is_open_code_compaction_assistant(info) => {
                let succeeded =
                    prop(info, "error").is_null() && prop(info, "finish").as_str() != Some("error");
                replay_expected_text = (overflow_pending && succeeded)
                    .then(|| last_visible_user_text.clone())
                    .flatten();
                overflow_pending = false;
                if !succeeded || manual_boundary {
                    visible.push(message);
                }
                manual_boundary = false;
            }
            _ => {
                overflow_pending = false;
                replay_expected_text = None;
                visible.push(message);
            }
        }
    }
    visible
}

fn stored_abort(failure: &Value) -> bool {
    prop(failure, "name").as_str() == Some("MessageAbortedError")
}

fn stored_error_message(failure: &Value) -> Option<&str> {
    if failure.is_null() || stored_abort(failure) {
        return None;
    }
    failure
        .as_str()
        .into_iter()
        .chain(prop(prop(failure, "data"), "message").as_str())
        .chain(prop(failure, "name").as_str())
        .map(trim)
        .find(|text| !text.is_empty())
        .or(Some("OpenCode session failed"))
}

pub struct HistoryLoadOptions<'a> {
    pub directory: Option<&'a str>,
    pub signal: &'a AbortSignal,
    pub throw_on_error: bool,
    pub logger: &'a dyn AgentLogger,
    pub limit: Option<u64>,
}

fn session_params(id: &str) -> Map<String, Value> {
    Map::from_iter([("sessionID".to_owned(), json!(id))])
}

async fn request_stored_messages(
    id: Option<&str>,
    client: &dyn OpenCodeClient,
    options: &HistoryLoadOptions<'_>,
) -> ExecutorResult<Option<Vec<Value>>> {
    let Some(id) = id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let scope = create_open_code_request_scope(options.directory);
    let mut params = session_params(id);
    if let Some(limit) = options.limit {
        params.insert("limit".to_owned(), json!(limit));
    }
    let response = client
        .request(
            OpenCodeRequest::SessionMessages,
            with_open_code_request_scope(params, &scope),
            options.signal,
        )
        .await?;
    if is_open_code_not_found_result(&response) {
        return Ok(None);
    }
    if has_open_code_result_error(&response) {
        return Err(error(
            "Error",
            open_code_result_error_message(&response, "OpenCode message fetch failed"),
        ));
    }
    match response.into_data() {
        Some(Value::Array(messages)) => Ok(Some(messages)),
        _ => Err(error(
            "Error",
            "OpenCode message fetch returned an invalid payload",
        )),
    }
}

pub async fn fetch_open_code_stored_messages(
    id: Option<&str>,
    client: &dyn OpenCodeClient,
    options: &HistoryLoadOptions<'_>,
) -> ExecutorResult<Vec<Value>> {
    match request_stored_messages(id, client, options).await {
        Ok(messages) => Ok(messages.unwrap_or_default()),
        Err(failure) if options.throw_on_error => Err(failure),
        Err(failure) => {
            options.logger.error(
                "OpenCode chat message load failed",
                Some(&log_fields([
                    ("sessionId", json!(id)),
                    ("error", json!(failure.to_string())),
                ])),
            );
            Ok(Vec::new())
        }
    }
}

async fn request_scoped_stored_messages(
    id: Option<&str>,
    client: &dyn OpenCodeClient,
    options: &HistoryLoadOptions<'_>,
) -> ExecutorResult<Option<Vec<Value>>> {
    let Some(id) = id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let scope = create_open_code_request_scope(options.directory);
    let session = client
        .request(
            OpenCodeRequest::SessionGet,
            with_open_code_request_scope(session_params(id), &scope),
            options.signal,
        )
        .await;
    options.signal.throw_if_aborted()?;
    let session = session?;
    if is_open_code_not_found_result(&session) {
        return Ok(None);
    }
    if has_open_code_result_error(&session) {
        return Err(error(
            "Error",
            open_code_result_error_message(&session, "OpenCode session fetch failed"),
        ));
    }
    let data = prop(&*session, "data");
    if !truthy(data) {
        return Err(error(
            "Error",
            "OpenCode session fetch returned an invalid payload",
        ));
    }
    if let Some(directory) = &scope.directory {
        let stored = prop(data, "directory")
            .as_str()
            .filter(|directory| !directory.is_empty())
            .ok_or_else(|| {
                error(
                    "Error",
                    "OpenCode session fetch returned a session without a directory",
                )
            })?;
        let cwd = std::env::current_dir()?;
        #[cfg(not(windows))]
        use garcon_js::path::posix as path;
        #[cfg(windows)]
        use garcon_js::path::win32 as path;
        if path::resolve(&cwd.to_string_lossy(), &[stored])
            != path::resolve(&cwd.to_string_lossy(), &[directory])
        {
            return Ok(None);
        }
    }
    let messages = request_stored_messages(Some(id), client, options).await?;
    if messages.is_none() {
        return Err(error(
            "Error",
            "OpenCode transcript messages disappeared during import",
        ));
    }
    Ok(messages)
}

pub async fn convert_open_code_stored_messages(
    raw: &[Value],
    steps: &mut EventLoopSteps,
    clock: &dyn Clock,
) -> Vec<NativeSourced<ChatMessage>> {
    let mut rows = Vec::new();
    for message in visible_stored_messages(raw, steps).await {
        steps.next().await;
        let info = prop(message, "info");
        let time = prop(info, "time");
        // INFALLIBLE: a wall-clock reading fits a JavaScript Date.
        let ts = date_to_iso(time.get("created"))
            .unwrap_or_else(|| to_iso_string(clock.now_ms()).expect("valid wall clock time"));
        let mut push = |message, entry: &Value, ordinal| {
            let mut row = NativeSourced::new(message);
            if let Some(entry) = entry.as_str().filter(|entry| !entry.is_empty()) {
                attach_native_message_source(
                    &mut row,
                    Some(NativeMessageSourceInput {
                        entry_id: Some(entry),
                        within_source_ordinal: Some(ordinal),
                        ..Default::default()
                    }),
                );
            }
            rows.push(row);
        };
        let id = prop(info, "id");
        match prop(info, "role").as_str() {
            Some("user") => {
                let text = user_text(message);
                let images = user_images(message);
                if !trim(&text).is_empty() || !images.is_empty() {
                    push(
                        ChatMessage::User(UserMessage {
                            timestamp: ts,
                            content: strip_resolved_file_mention_context(&text).to_owned(),
                            images: (!images.is_empty()).then_some(images),
                            metadata: None,
                            presentation: None,
                        }),
                        id,
                        0.0,
                    );
                }
            }
            Some("assistant") => {
                let failure = prop(info, "error");
                let provider_error = stored_error_message(failure);
                if is_open_code_compaction_assistant(info) {
                    let finish = prop(info, "finish").as_str();
                    if let Some(message) = provider_error.or_else(|| {
                        (failure.is_null() && finish == Some("error"))
                            .then_some("OpenCode session failed")
                    }) {
                        push(
                            ChatMessage::Error(ErrorMessage {
                                timestamp: ts,
                                content: message.to_owned(),
                            }),
                            id,
                            0.0,
                        );
                    } else if failure.is_null()
                        && finish.is_some_and(|finish| {
                            !finish.is_empty() && !matches!(finish, "tool-calls" | "unknown")
                        })
                        && let Some(completed) =
                            time.get("completed").filter(|value| value.is_number())
                    {
                        push(
                            ChatMessage::Compaction(CompactionMessage {
                                timestamp: date_to_iso(Some(completed)).unwrap_or(ts),
                                trigger: CompactionTrigger::Manual,
                                summary: String::new(),
                                pre_tokens: None,
                                post_tokens: None,
                            }),
                            id,
                            0.0,
                        );
                    }
                    continue;
                }
                for part in parts(message) {
                    let id = prop(part, "id");
                    match prop(part, "type").as_str() {
                        Some("reasoning") => {
                            if let Some(content) = prop(part, "reasoning")
                                .as_str()
                                .or_else(|| prop(part, "text").as_str())
                                .filter(|text| !trim(text).is_empty())
                            {
                                push(
                                    ChatMessage::Thinking(ThinkingMessage {
                                        timestamp: ts.clone(),
                                        content: content.to_owned(),
                                    }),
                                    id,
                                    0.0,
                                );
                            }
                        }
                        Some("text") => {
                            if let Some(content) = prop(part, "text")
                                .as_str()
                                .filter(|text| !trim(text).is_empty())
                            {
                                push(
                                    ChatMessage::Assistant(AssistantMessage {
                                        timestamp: ts.clone(),
                                        content: content.to_owned(),
                                        questions: None,
                                    }),
                                    id,
                                    0.0,
                                );
                            }
                        }
                        Some("tool") => {
                            let state = prop(part, "state");
                            let status = prop(state, "status").as_str();
                            if !matches!(status, Some("completed" | "error")) {
                                continue;
                            }
                            let tool = convert_open_code_tool_use(&ts, part);
                            let tool_id = tool.tool_id().to_owned();
                            push(ChatMessage::ToolUse(tool), id, 0.0);
                            let is_error = status == Some("error");
                            let content = if is_error {
                                let failure = prop(state, "error");
                                let failure = if truthy(failure) {
                                    failure.clone()
                                } else {
                                    json!("Error")
                                };
                                normalize_tool_result_content(Some(&Opaque::from_value(failure)))
                            } else {
                                normalize_open_code_tool_result_content(prop(part, "tool"), state)
                            };
                            push(
                                ChatMessage::ToolResult(ToolResultMessage::new(
                                    ts.clone(),
                                    tool_id,
                                    content,
                                    is_error,
                                    None,
                                )),
                                id,
                                1.0,
                            );
                        }
                        _ => {}
                    }
                }
                if let Some(message) = provider_error {
                    push(
                        ChatMessage::Error(ErrorMessage {
                            timestamp: ts,
                            content: message.to_owned(),
                        }),
                        id,
                        0.0,
                    );
                }
            }
            _ => {}
        }
    }
    rows
}

pub async fn load_required_open_code_chat_messages(
    id: Option<&str>,
    client: &dyn OpenCodeClient,
    options: &HistoryLoadOptions<'_>,
    clock: &dyn Clock,
) -> ExecutorResult<Vec<NativeSourced<ChatMessage>>> {
    let messages = request_scoped_stored_messages(id, client, options)
        .await?
        .ok_or(OpenCodeTranscriptNotFoundError)?;
    let mut steps = EventLoopSteps::new("opencode-history-conversion");
    for message in &messages {
        steps.next().await;
        let info = prop(message, "info");
        let valid_info = prop(info, "id").as_str().is_some_and(|id| !id.is_empty())
            && matches!(prop(info, "role").as_str(), Some("user" | "assistant"));
        let Some(parts) = prop(message, "parts").as_array().filter(|_| valid_info) else {
            return Err(error(
                "Error",
                "OpenCode stored transcript message is invalid",
            ));
        };
        for part in parts {
            let kind = prop(part, "type").as_str();
            if kind.is_none_or(str::is_empty)
                || (kind == Some("text") && !prop(part, "text").is_string())
                || (kind == Some("reasoning")
                    && !prop(part, "reasoning").is_string()
                    && !prop(part, "text").is_string())
            {
                return Err(error("Error", "OpenCode stored transcript part is invalid"));
            }
        }
    }
    Ok(convert_open_code_stored_messages(&messages, &mut steps, clock).await)
}

pub async fn latest_open_code_stored_activity_at(
    raw: &[Value],
    clock: &dyn Clock,
) -> Option<String> {
    let mut steps = EventLoopSteps::new("opencode-activity-check");
    for message in visible_stored_messages(raw, &mut steps)
        .await
        .into_iter()
        .rev()
    {
        if !convert_open_code_stored_messages(std::slice::from_ref(message), &mut steps, clock)
            .await
            .is_empty()
        {
            return date_to_iso(prop(prop(message, "info"), "time").get("created"));
        }
    }
    None
}
