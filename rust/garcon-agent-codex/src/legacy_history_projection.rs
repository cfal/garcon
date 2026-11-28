use garcon_contract::chat_types::{AskUserQuestionPrompt, ChatMessage, ToolUseChatMessage};
use garcon_js::{
    clock::InvalidTimeValue,
    json::{Opaque, from_str},
    trim,
};
use indexmap::{IndexMap, IndexSet};
use serde_json::{Value, json};

use crate::{
    code_mode_command_projection::{
        codex_code_mode_result_tool_id, create_codex_code_mode_bash_messages,
        project_codex_code_mode_commands, remember_codex_code_mode_result,
    },
    history_normalizer::{
        CodexJsonlNormalizationContext, CodexJsonlNormalizationResult, normalize_codex_jsonl_entry,
    },
    user_input::codex_historical_question_result,
};

const MAX_PENDING_CALLS: usize = 10_000;

#[derive(Default)]
pub struct LegacyCodexProjection {
    hidden_wait_calls: IndexSet<String>,
    question_calls: IndexMap<String, Vec<AskUserQuestionPrompt>>,
    async_question_calls: IndexSet<String>,
    code_mode_result_ids: IndexMap<String, String>,
}

impl LegacyCodexProjection {
    pub fn project(
        &mut self,
        entry: &Value,
        context: &CodexJsonlNormalizationContext,
    ) -> Result<Option<CodexJsonlNormalizationResult>, InvalidTimeValue> {
        let payload = if entry["type"] == "response_item" {
            &entry["payload"]
        } else {
            &Value::Null
        };
        let call_id = payload["call_id"].as_str().filter(|id| !id.is_empty());
        let kind = payload["type"].as_str();
        let name = payload["name"].as_str();
        if let Some(call_id) = call_id
            && matches!(kind, Some("function_call" | "custom_tool_call"))
        {
            self.question_calls.shift_remove(call_id);
            self.async_question_calls.shift_remove(call_id);
            if kind == Some("function_call") {
                match name {
                    Some("request_user_input_async") => {
                        remember_call(&mut self.async_question_calls, call_id);
                        return Ok(Some(CodexJsonlNormalizationResult::default()));
                    }
                    Some("request_user_input") => {
                        let normalized = normalize_codex_jsonl_entry(entry, context)?;
                        let questions = normalized
                            .as_ref()
                            .and_then(|result| result.canonical.first())
                            .and_then(|tool| match tool {
                                ChatMessage::ToolUse(ToolUseChatMessage::AskUserQuestion {
                                    questions,
                                    ..
                                }) => Some(questions.clone()),
                                _ => None,
                            })
                            .unwrap_or_default();
                        self.question_calls.insert(call_id.into(), questions);
                        if self.question_calls.len() > MAX_PENDING_CALLS {
                            self.question_calls.shift_remove_index(0);
                        }
                        return Ok(normalized);
                    }
                    Some("wait")
                        if parse_arguments(&payload["arguments"])["cell_id"]
                            .as_str()
                            .is_some_and(|id| !trim(id).is_empty()) =>
                    {
                        remember_call(&mut self.hidden_wait_calls, call_id);
                        return Ok(Some(CodexJsonlNormalizationResult::default()));
                    }
                    _ => {}
                }
            }
        }
        if let Some(call_id) = call_id
            && matches!(
                kind,
                Some("custom_tool_call_output" | "function_call_output")
            )
        {
            if self.async_question_calls.shift_remove(call_id) {
                let acknowledgement = parse_arguments(&payload["output"]);
                if acknowledgement
                    .as_object()
                    .is_some_and(|fields| fields.len() == 1)
                    && acknowledgement["accepted"] == true
                {
                    return Ok(Some(CodexJsonlNormalizationResult::default()));
                }
            }
            if self.hidden_wait_calls.shift_remove(call_id) {
                return Ok(Some(CodexJsonlNormalizationResult::default()));
            }
            if let Some(questions) = self.question_calls.shift_remove(call_id) {
                let mut normalized = normalize_codex_jsonl_entry(entry, context)?;
                let answer = codex_historical_question_result(&payload["output"], &questions);
                if let Some(normalized) = &mut normalized {
                    for message in &mut normalized.canonical {
                        if let ChatMessage::ToolResult(message) = message {
                            message.is_error = answer.is_none();
                            if let Some(answer) = &answer {
                                let mut fields =
                                    message.content.as_object().cloned().unwrap_or_default();
                                fields.insert("toolUseResult".into(), json!(answer));
                                message.content = Opaque::from_value(Value::Object(fields));
                            }
                        }
                    }
                }
                return Ok(normalized);
            }
            if let Some(result_tool_id) = self.code_mode_result_ids.shift_remove(call_id) {
                let mut rewritten = entry.clone();
                rewritten["payload"]["call_id"] = Value::String(result_tool_id);
                return normalize_codex_jsonl_entry(&rewritten, context);
            }
        }
        let mut normalized = normalize_codex_jsonl_entry(entry, context)?;
        if kind == Some("custom_tool_call")
            && name == Some("exec")
            && let Some(call_id) = call_id
            && let Some(text) = payload["input"].as_str()
            && let Some(result) = &mut normalized
            && let [ChatMessage::ToolUse(ToolUseChatMessage::Exec { timestamp, .. })] =
                result.canonical.as_slice()
            && let Some(projection) = project_codex_code_mode_commands(text)
        {
            remember_codex_code_mode_result(
                &mut self.code_mode_result_ids,
                call_id.into(),
                codex_code_mode_result_tool_id(call_id, &projection),
            );
            result.canonical =
                create_codex_code_mode_bash_messages(timestamp, call_id, &projection)
                    .into_iter()
                    .map(ChatMessage::ToolUse)
                    .collect();
        }
        Ok(normalized)
    }
}

fn remember_call(calls: &mut IndexSet<String>, call_id: &str) {
    calls.insert(call_id.into());
    if calls.len() > MAX_PENDING_CALLS {
        calls.shift_remove_index(0);
    }
}

fn parse_arguments(value: &Value) -> Value {
    let parsed = if let Some(text) = value.as_str() {
        from_str::<Value>(text).unwrap_or(Value::Null)
    } else {
        value.clone()
    };
    if parsed.is_object() {
        parsed
    } else {
        Value::Null
    }
}
