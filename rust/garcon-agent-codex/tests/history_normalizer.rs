use garcon_agent_codex::history_normalizer::{
    CodexJsonlNormalizationContext, extract_text_content, normalize_codex_jsonl_entry,
    parse_apply_patch,
};
use garcon_cases::{
    CaseError, ReplayOptions, ResultOrderException, markers, replay_with_options, text, unknown,
};
use garcon_js::json::{as_number, from_slice};
use serde_json::{Value, json};

#[test]
fn recorded_history_normalizer_matches() {
    replay_with_options(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/history-normalizer"
        ),
        ReplayOptions {
            result_order_exceptions: &[ResultOrderException {
                function: "normalizeCodexJsonlEntry",
                path: "$.result.canonical[*].fields.questions[*]",
                reason: "Codex creates question options last; the shared parser writes them before header",
            }],
            ..Default::default()
        },
        |function, args| match function {
            "extractTextContent" => Ok(json!(extract_text_content(
                unknown(function, args.first())?.as_ref()
            ))),
            "parseApplyPatch" => {
                let patch = parse_apply_patch(text(function, args.first())?.unwrap());
                Ok(
                    json!({"file_path":patch.file_path,"old_string":patch.old_string,"new_string":patch.new_string}),
                )
            }
            "normalizeCodexJsonlEntry" => {
                let entry = unknown(function, args.first())?;
                let context = unknown(function, args.get(1))?;
                let context = CodexJsonlNormalizationContext {
                    source_byte_offset: as_number(&context["sourceByteOffset"]),
                    source_line_number: as_number(&context["sourceLineNumber"]),
                };
                let result = match normalize_codex_jsonl_entry(&entry, &context) {
                    Ok(result) => result,
                    Err(error) => {
                        return Ok(
                            json!({"$":"error","name":"RangeError","message":error.to_string(),"properties":{}}),
                        );
                    }
                };
                let Some(result) = result else {
                    return Ok(Value::Null);
                };
                let mut wire: Value = from_slice(&serde_json::to_vec(&result).unwrap()).unwrap();
                for member in [
                    "canonical",
                    "fallbackUser",
                    "fallbackAssistant",
                    "fallbackThinking",
                ] {
                    for row in wire[member].as_array_mut().unwrap() {
                        let class_name = match row["type"].as_str().unwrap() {
                            "assistant-message" => "AssistantMessage",
                            "user-message" => "UserMessage",
                            "thinking" => "ThinkingMessage",
                            "compaction" => "CompactionMessage",
                            "bash-tool-use" => "BashToolUseMessage",
                            "exec-tool-use" => "ExecToolUseMessage",
                            "edit-tool-use" => "EditToolUseMessage",
                            "update-plan-tool-use" => "UpdatePlanToolUseMessage",
                            "write-stdin-tool-use" => "WriteStdinToolUseMessage",
                            "ask-user-question-tool-use" => "AskUserQuestionToolUseMessage",
                            "codex-subagent-tool-use" => "CodexSubagentToolUseMessage",
                            "wait-tool-use" => "WaitToolUseMessage",
                            "unknown-tool-use" => "UnknownToolUseMessage",
                            "web-search-tool-use" => "WebSearchToolUseMessage",
                            "tool-result" => "ToolResultMessage",
                            _ => return Err(CaseError::unhandled(function)),
                        };
                        let Value::Object(mut fields) = row.take() else {
                            unreachable!()
                        };
                        // Instance recordings include constructor parameters omitted from JSON.
                        let optional_tail: &[&str] = match class_name {
                            "AskUserQuestionToolUseMessage" => &["title", "questions"],
                            "AssistantMessage" => &["questions"],
                            "BashToolUseMessage" => &["description"],
                            "CompactionMessage" => &["preTokens", "postTokens"],
                            "EditToolUseMessage" => &["changes"],
                            "ToolResultMessage" => &["primaryTextItems"],
                            "UserMessage" => &["images", "metadata", "presentation"],
                            "WaitToolUseMessage" => &["terminate"],
                            _ => &[],
                        };
                        if optional_tail.iter().any(|key| !fields.contains_key(*key)) {
                            let kind = fields.shift_remove("type").unwrap();
                            for key in optional_tail {
                                let value =
                                    fields.shift_remove(*key).unwrap_or_else(markers::undefined);
                                fields.insert((*key).into(), value);
                            }
                            fields.insert("type".into(), kind);
                        }
                        *row = markers::instance(class_name, fields);
                    }
                }
                Ok(wire)
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}
