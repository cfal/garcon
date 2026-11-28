//! Ports `agents/cursor/cursor-acp-event-converter.ts`.

use std::{cell::RefCell, rc::Rc};

use garcon_agents_common::acp::event_converter::{
    AcpBlockingRequestToolUse, AcpCustomRequest, AcpEventConverter, AcpSessionUpdateContext,
    as_object, evict_oldest_tool_entry, is_acp_terminal_tool_status,
};
use garcon_contract::{
    chat_command_contracts::{
        AskUserQuestionDecisionResponse, PermissionDecisionPayload, PermissionDecisionResponse,
        normalize_ask_user_question_decision_response,
    },
    chat_message_coercion::{AskUserQuestionOption, AskUserQuestionPrompt},
    chat_plan::{CursorPlanPhase, CursorPlanTodo, CursorPlanTodoStatus},
    chat_types::{
        AssistantMessage, ChatMessage, ThinkingMessage, ToolResultMessage, ToolUseChatMessage,
    },
};
use garcon_js::trim;
use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value, json};

use crate::{
    json_values::{first_value, string},
    tool_result_converter::normalize_cursor_tool_result_content,
    tool_use_converter::convert_cursor_tool_use,
};

const TOOL_ID: &[&str] = &["toolCallId", "tool_call_id", "callId", "id"];

#[derive(Default)]
struct TurnBuffer {
    assistant_text: String,
    thinking_text: String,
    emitted_tool_ids: IndexSet<String>,
}

#[derive(Clone, Default)]
struct ToolCallSnapshot {
    id: String,
    raw_name: Option<String>,
    kind: Option<String>,
    title: Option<String>,
    raw_input: Option<Value>,
    raw_output: Option<Value>,
    content: Vec<Value>,
    locations: Vec<Value>,
    high_level_tool_call_result: Option<Value>,
}

#[derive(Default)]
struct SessionState {
    buffer: TurnBuffer,
    tool_calls: IndexMap<String, ToolCallSnapshot>,
}

#[derive(Default)]
pub struct CursorAcpEventConverter {
    sessions: RefCell<IndexMap<String, SessionState>>,
}

fn array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn canonical_text(value: &str) -> Option<&str> {
    Some(trim(value)).filter(|value| !value.is_empty())
}

fn tool_name_from_identifier(value: &str) -> Option<&str> {
    value
        .split(':')
        .next()?
        .rsplit('.')
        .next()
        .and_then(canonical_text)
}

fn chunk_text(value: &Value) -> &str {
    value
        .as_str()
        .or_else(|| first_value(as_object(value), &["text", "content", "delta"]).as_str())
        .unwrap_or_default()
}

fn normalized_kind(value: &Map<String, Value>) -> Option<String> {
    value
        .get("kind")
        .and_then(Value::as_str)
        .and_then(canonical_text)
        .map(str::to_lowercase)
}

fn raw_tool_name(value: &Map<String, Value>) -> Option<String> {
    first_value(value, &["toolName", "tool_name", "name"])
        .as_str()
        .and_then(canonical_text)
        .map(str::to_owned)
        .or_else(|| normalized_kind(value))
}

fn tool_call_text_content(parts: &[Value]) -> String {
    parts
        .iter()
        .filter_map(|entry| {
            let raw = as_object(entry);
            match raw.get("type").and_then(Value::as_str) {
                Some("content") => entry
                    .get("content")?
                    .get("text")?
                    .as_str()
                    .map(str::to_owned),
                Some("diff") => {
                    let diff = as_object(raw.get("diff").unwrap_or(&Value::Null));
                    let old = first_value(diff, &["oldText", "old_text"]).as_str();
                    let new = first_value(diff, &["newText", "new_text"]).as_str();
                    Some(
                        [old, new]
                            .into_iter()
                            .flatten()
                            .filter(|text| !text.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n"),
                    )
                }
                _ => raw.get("text").and_then(Value::as_str).map(str::to_owned),
            }
        })
        .filter(|part| !trim(part).is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

impl ToolCallSnapshot {
    fn input(&self) -> Value {
        if let Some(input) = &self.raw_input {
            return input.clone();
        }
        let mut inferred = Map::new();
        let first = self
            .locations
            .iter()
            .find_map(|entry| entry.get("path").and_then(Value::as_str));
        for (key, value) in [
            ("path", first),
            ("title", self.title.as_deref()),
            ("kind", self.kind.as_deref()),
        ] {
            if let Some(value) = value.filter(|value| !value.is_empty()) {
                inferred.insert(key.into(), Value::from(value));
            }
        }
        let text = tool_call_text_content(&self.content);
        if !text.is_empty()
            && let Some(key) = match self.kind.as_deref() {
                Some("execute") => Some("command"),
                Some("search") => Some("pattern"),
                Some("fetch") => Some("prompt"),
                _ => None,
            }
        {
            inferred.insert(key.into(), Value::from(text.clone()));
        }
        if !self.locations.is_empty() {
            inferred.insert("locations".into(), Value::Array(self.locations.clone()));
        }
        if !text.is_empty() {
            inferred.insert("content".into(), Value::from(text));
        }
        inferred.into()
    }

    fn output(&self) -> Option<Value> {
        self.raw_output.clone().or_else(|| {
            let text = tool_call_text_content(&self.content);
            (!text.is_empty()).then(|| Value::from(text))
        })
    }
}

// A final null in an alias chain is evidence of a supplied value, unlike an omitted field.
fn snapshot_value(raw: &Map<String, Value>, keys: &[&str]) -> Option<Value> {
    let (last, leading) = keys.split_last()?;
    leading
        .iter()
        .find_map(|key| raw.get(*key).filter(|value| !value.is_null()))
        .or_else(|| raw.get(*last))
        .cloned()
}

impl SessionState {
    fn capture_tool_snapshot(&mut self, update: &Map<String, Value>) -> Option<ToolCallSnapshot> {
        let id = string(update, TOOL_ID).filter(|id| !id.is_empty())?;
        let existing = self.tool_calls.get(&id);
        let content = array(update.get("content"));
        let locations = array(update.get("locations"));
        let mut snapshot = ToolCallSnapshot {
            id: id.clone(),
            raw_name: raw_tool_name(update).or_else(|| existing?.raw_name.clone()),
            kind: normalized_kind(update).or_else(|| existing?.kind.clone()),
            title: update
                .get("title")
                .and_then(Value::as_str)
                .and_then(canonical_text)
                .map(str::to_owned)
                .or_else(|| existing?.title.clone()),
            raw_input: snapshot_value(update, &["rawInput", "raw_input", "input", "args"])
                .or_else(|| existing?.raw_input.clone()),
            raw_output: snapshot_value(update, &["rawOutput", "raw_output", "output", "result"])
                .or_else(|| existing?.raw_output.clone()),
            content: if content.is_empty() {
                existing.map_or_else(Vec::new, |snapshot| snapshot.content.clone())
            } else {
                content.to_vec()
            },
            locations: if locations.is_empty() {
                existing.map_or_else(Vec::new, |snapshot| snapshot.locations.clone())
            } else {
                locations.to_vec()
            },
            high_level_tool_call_result: snapshot_value(
                update,
                &["highLevelToolCallResult", "high_level_tool_call_result"],
            )
            .filter(|value| !value.is_null())
            .or_else(|| existing?.high_level_tool_call_result.clone()),
        };
        if snapshot.raw_name.is_none() {
            snapshot.raw_name = Some(
                snapshot
                    .kind
                    .clone()
                    .or_else(|| snapshot.title.clone())
                    .or_else(|| tool_name_from_identifier(&id).map(str::to_owned))
                    .unwrap_or_else(|| "Unknown".into()),
            );
        }
        self.tool_calls.insert(id, snapshot.clone());
        evict_oldest_tool_entry(&mut self.tool_calls);
        Some(snapshot)
    }
}

impl TurnBuffer {
    fn flush_chunks(&mut self, timestamp: &str) -> Vec<ChatMessage> {
        let mut messages = Vec::new();
        if let Some(content) = canonical_text(&self.thinking_text) {
            messages.push(ChatMessage::Thinking(ThinkingMessage {
                timestamp: timestamp.into(),
                content: content.into(),
            }));
            self.thinking_text.clear();
        }
        if let Some(content) = canonical_text(&self.assistant_text) {
            messages.push(ChatMessage::Assistant(AssistantMessage {
                timestamp: timestamp.into(),
                content: content.into(),
                questions: None,
            }));
            self.assistant_text.clear();
        }
        messages
    }
}

fn questions(raw: &[Value]) -> Vec<AskUserQuestionPrompt> {
    raw.iter()
        .filter_map(|item| {
            let text = |key| {
                item.get(key)
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .map(str::to_owned)
            };
            let options = array(item.get("options"))
                .iter()
                .filter_map(|option| {
                    let text = |key| {
                        option
                            .get(key)
                            .and_then(Value::as_str)
                            .filter(|text| !text.is_empty())
                            .map(str::to_owned)
                    };
                    Some(AskUserQuestionOption {
                        id: text("id")?,
                        label: text("label")?,
                        description: None,
                        preview: None,
                    })
                })
                .collect();
            Some(AskUserQuestionPrompt {
                id: text("id")?,
                prompt: text("prompt")?,
                options,
                header: None,
                allow_multiple: item.get("allowMultiple").and_then(Value::as_bool),
                allow_free_text: None,
                allow_notes: None,
                is_secret: None,
            })
        })
        .collect()
}

fn todos(raw: &[Value]) -> Vec<CursorPlanTodo> {
    raw.iter()
        .filter_map(|item| {
            Some(CursorPlanTodo {
                content: item
                    .get("content")?
                    .as_str()
                    .filter(|text| !text.is_empty())?
                    .into(),
                status: match item.get("status").and_then(Value::as_str) {
                    Some("completed") => CursorPlanTodoStatus::Completed,
                    Some("in_progress") => CursorPlanTodoStatus::InProgress,
                    Some("cancelled") => CursorPlanTodoStatus::Cancelled,
                    _ => CursorPlanTodoStatus::Pending,
                },
                id: item
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .map(str::to_owned),
            })
        })
        .collect()
}

fn phases(raw: &[Value]) -> Option<Vec<CursorPlanPhase>> {
    let phases: Vec<_> = raw
        .iter()
        .filter_map(|item| {
            Some(CursorPlanPhase {
                name: item
                    .get("name")?
                    .as_str()
                    .filter(|text| !text.is_empty())?
                    .into(),
                todos: todos(array(item.get("todos"))),
            })
        })
        .collect();
    (!phases.is_empty()).then_some(phases)
}

fn reply_value(response: &PermissionDecisionResponse) -> Value {
    match response {
        PermissionDecisionResponse::Provider(value) => value.as_value().clone(),
        PermissionDecisionResponse::Structured(value) => json!(value),
    }
}

fn ask_question_response(decision: &PermissionDecisionPayload) -> Value {
    if let Some(response) = &decision.response {
        let raw = reply_value(response);
        return match normalize_ask_user_question_decision_response(&raw) {
            Some(AskUserQuestionDecisionResponse::Answered { answers }) => {
                json!({"outcome":{"outcome":"answered","answers":answers}})
            }
            Some(AskUserQuestionDecisionResponse::Skipped {
                reason: Some(reason),
            }) if !reason.is_empty() => json!({"outcome":{"outcome":"skipped","reason":reason}}),
            Some(AskUserQuestionDecisionResponse::Skipped { .. }) => {
                json!({"outcome":{"outcome":"skipped"}})
            }
            None => raw,
        };
    }
    let reason = if decision.allow {
        "No answer was provided"
    } else {
        "User skipped question"
    };
    json!({"outcome":{"outcome":"skipped","reason":reason}})
}

fn create_plan_response(decision: &PermissionDecisionPayload) -> Value {
    if let Some(response) = &decision.response {
        return reply_value(response);
    }
    if decision.allow {
        json!({"outcome":{"outcome":"accepted"}})
    } else {
        json!({"outcome":{"outcome":"rejected","reason":"User rejected plan"}})
    }
}

impl AcpEventConverter for CursorAcpEventConverter {
    fn release_session(&self, session_id: &str) {
        self.sessions.borrow_mut().shift_remove(session_id);
    }

    fn begin_turn(&self, session_id: &str) {
        self.sessions
            .borrow_mut()
            .entry(session_id.into())
            .or_default()
            .buffer = TurnBuffer::default();
    }

    fn permission_tool_use(
        &self,
        raw: &Map<String, Value>,
        context: &AcpSessionUpdateContext,
    ) -> Option<ToolUseChatMessage> {
        let mut sessions = self.sessions.borrow_mut();
        let session = sessions.entry(context.session_id.clone()).or_default();
        let snapshot = session.capture_tool_snapshot(raw)?;
        let name = snapshot.raw_name.as_deref().unwrap_or("Permission");
        Some(convert_cursor_tool_use(
            &context.timestamp,
            &json!({"id":snapshot.id,"name":name,"input":snapshot.input()}),
        ))
    }

    fn custom_request_tool_use(
        &self,
        request: &AcpCustomRequest<'_>,
        context: &AcpSessionUpdateContext,
    ) -> Option<AcpBlockingRequestToolUse> {
        let params = as_object(request.params);
        let tool_id =
            string(params, TOOL_ID).unwrap_or_else(|| request.permission_occurrence_id.into());
        let text = |key| params.get(key).and_then(Value::as_str).map(str::to_owned);
        let timestamp = context.timestamp.clone();
        let (tool, respond): (_, fn(&PermissionDecisionPayload) -> Value) = match request.method {
            "cursor/ask_question" => (
                ToolUseChatMessage::AskUserQuestion {
                    timestamp,
                    tool_id,
                    title: text("title"),
                    questions: questions(array(params.get("questions"))),
                },
                ask_question_response,
            ),
            "cursor/create_plan" => (
                ToolUseChatMessage::CursorCreatePlan {
                    timestamp,
                    tool_id,
                    plan: text("plan").unwrap_or_default(),
                    name: text("name"),
                    overview: text("overview"),
                    todos: Some(todos(array(params.get("todos")))),
                    is_project: params.get("isProject").and_then(Value::as_bool),
                    phases: phases(array(params.get("phases"))),
                },
                create_plan_response,
            ),
            _ => return None,
        };
        Some(AcpBlockingRequestToolUse {
            tool,
            response_for_decision: Rc::new(respond),
            response_for_cancellation: Rc::new(|_| json!({"outcome":{"outcome":"cancelled"}})),
        })
    }

    fn from_session_update(
        &self,
        notification: &Map<String, Value>,
        context: &AcpSessionUpdateContext,
    ) -> Vec<ChatMessage> {
        let update = as_object(notification.get("update").unwrap_or(&Value::Null));
        let Some(update_type) = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .filter(|kind| !kind.is_empty())
        else {
            return vec![];
        };
        let mut sessions = self.sessions.borrow_mut();
        let session = sessions.entry(context.session_id.clone()).or_default();
        let timestamp = &context.timestamp;
        match update_type {
            "agent_thought_chunk" | "agent_thought" => {
                session
                    .buffer
                    .thinking_text
                    .push_str(chunk_text(update.get("content").unwrap_or(&Value::Null)));
            }
            "agent_message_chunk" | "agent_message" => {
                session
                    .buffer
                    .assistant_text
                    .push_str(chunk_text(update.get("content").unwrap_or(&Value::Null)));
            }
            "tool_call" => {
                let snapshot = session.capture_tool_snapshot(update);
                let id = snapshot
                    .as_ref()
                    .map_or("", |snapshot| snapshot.id.as_str());
                let mut messages = session.buffer.flush_chunks(timestamp);
                if !id.is_empty() && !session.buffer.emitted_tool_ids.insert(id.to_owned()) {
                    return messages;
                }
                let name = snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.raw_name.as_deref())
                    .or_else(|| tool_name_from_identifier(id))
                    .unwrap_or("Unknown");
                let input = snapshot.as_ref().map_or_else(
                    || first_value(update, &["rawInput", "input", "args"]).clone(),
                    ToolCallSnapshot::input,
                );
                messages.push(ChatMessage::ToolUse(convert_cursor_tool_use(
                    timestamp,
                    &json!({"id":id,"name":name,"input":input}),
                )));
                return messages;
            }
            "tool_call_update" => {
                let snapshot = session.capture_tool_snapshot(update);
                let status = update.get("status").and_then(Value::as_str);
                let terminal = status.is_some_and(is_acp_terminal_tool_status);
                let raw = snapshot.as_ref().and_then(ToolCallSnapshot::output);
                if !terminal && raw.is_none() {
                    return vec![];
                }
                let id = snapshot
                    .as_ref()
                    .map(|snapshot| snapshot.id.clone())
                    .or_else(|| string(update, TOOL_ID))
                    .unwrap_or_default();
                let name = snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.raw_name.as_deref())
                    .or_else(|| tool_name_from_identifier(&id))
                    .unwrap_or("Unknown");
                let result = match raw {
                    Some(raw) => normalize_cursor_tool_result_content(
                        &Value::from(name),
                        Some(&raw.into()),
                        snapshot
                            .as_ref()
                            .and_then(|snapshot| snapshot.high_level_tool_call_result.as_ref()),
                    ),
                    None => json!({"status":status.unwrap_or("unknown")}).into(),
                };
                if terminal && snapshot.is_some() {
                    session.tool_calls.shift_remove(&id);
                }
                let is_error = matches!(status, Some("failed" | "errored" | "rejected"))
                    || ["isError", "is_error", "error"]
                        .into_iter()
                        .any(|key| update.get(key).and_then(Value::as_bool) == Some(true));
                return vec![ChatMessage::ToolResult(ToolResultMessage::new(
                    (*timestamp).clone(),
                    id,
                    result,
                    is_error,
                    None,
                ))];
            }
            _ => (),
        }
        vec![]
    }

    fn end_turn(&self, session_id: &str, context: &AcpSessionUpdateContext) -> Vec<ChatMessage> {
        self.sessions
            .borrow_mut()
            .entry(session_id.into())
            .or_default()
            .buffer
            .flush_chunks(&context.timestamp)
    }
}
