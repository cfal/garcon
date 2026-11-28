use garcon_cases::{CaseError, markers, replay, round_tripped, text, unknown};
use garcon_js::json::{Opaque, as_number};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use garcon_contract::{
    ask_user_question_response, async_user_questions, chat_message_coercion, chat_types,
    tool_result_content, tool_result_message,
};

fn json_value(value: impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(&value).unwrap()).unwrap()
}

fn optional_value(value: Option<impl Serialize>) -> Value {
    value.map_or_else(markers::undefined, json_value)
}

fn typed<T: DeserializeOwned>(function: &str, value: Option<&Value>) -> Result<T, CaseError> {
    let value = unknown(function, value)?;
    serde_json::from_value(value.into_owned()).map_err(|_| CaseError::unhandled(function))
}

fn run(suite: &str, dispatch: impl Fn(&str, &[Value]) -> Result<Value, CaseError>) {
    let cases = format!("{}/tests/cases/common/{suite}", env!("CARGO_MANIFEST_DIR"));
    let stats = replay(cases, dispatch);
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn chat_tool_use_cases_match() {
    use chat_types::*;
    run("chat-types-tool-use", |function, args| match function {
        "parseChatMessage" => {
            let value = unknown(function, args.first())?;
            let parsed = parse_tool_use_message(&value);
            Ok(json!(serde_json::to_string(&parsed).unwrap()))
        }
        "isToolUseMessage" => {
            let value = unknown(function, args.first())?;
            Ok(json!(
                value["type"]
                    .as_str()
                    .is_some_and(ToolUseChatMessage::has_type)
            ))
        }
        "codexSubagentSourceFingerprint" => {
            if let Some(value) = args.first()
                && markers::kind(value) == Some("utf16")
            {
                let units: Vec<u16> = serde_json::from_value(value["value"].clone())
                    .map_err(|_| CaseError::unhandled(function))?;
                return Ok(json!(codex_subagent_source_fingerprint_utf16(&units)));
            }
            let content =
                text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
            Ok(json!(codex_subagent_source_fingerprint(content)))
        }
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn chat_message_coercion_cases_match() {
    use chat_message_coercion::*;
    run("chat-message-coercion", |function, args| {
        let value = unknown(function, args.first())?;
        Ok(match function {
            "str" => json!(str(&value)),
            "asCodexSubagentInputItems" => optional_value(as_codex_subagent_input_items(&value)),
            "asOptionalString" => optional_value(as_optional_string(&value)),
            "asOptionalStringArray" => optional_value(as_optional_string_array(&value)),
            "asOptionalNumber" => as_optional_number(&value)
                .map_or_else(markers::undefined, |number| markers::number(number.0)),
            "asRecord" => json_value(Opaque::from_value(Value::Object(as_record(&value).clone()))),
            "parseChatMessageMetadata" => optional_value(
                parse_chat_message_metadata(&value)
                    .map_err(|error| CaseError::new("TypeError", error.to_string()))?,
            ),
            "asStringArray" => optional_value(as_string_array(&value)),
            "asChatImages" => optional_value(as_chat_images(&value)),
            "asAllowedPrompts" => optional_value(as_allowed_prompts(&value)),
            "asOptionalBoolean" => optional_value(as_optional_boolean(&value)),
            "asAskUserQuestions" => json_value(as_ask_user_questions(&value)),
            "asOptionalChanges" => optional_value(as_optional_changes(&value)),
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn async_user_question_cases_match() {
    use async_user_questions::*;
    run("async-user-questions", |function, args| match function {
        "parseAsyncQuestionSet" => {
            let value = unknown(function, args.first())?;
            Ok(optional_value(parse_async_question_set(&value)))
        }
        "parseAsyncQuestionReply" => {
            let value = round_tripped(function, args.first())?;
            parse_async_question_reply(value.as_deref())
                .map(optional_value)
                .map_err(|error| CaseError::new("TypeError", error.to_string()))
        }
        "asyncQuestionReplyText" => {
            let reply: AsyncQuestionReply = typed(function, args.first())?;
            Ok(json!(async_question_reply_text(&reply)))
        }
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn ask_user_question_response_cases_match() {
    use ask_user_question_response::*;
    run(
        "ask-user-question-response",
        |function, args| match function {
            "normalizeAskUserQuestionDecisionResponse" => {
                let value = unknown(function, args.first())?;
                Ok(json_value(normalize_ask_user_question_decision_response(
                    &value,
                )))
            }
            "isAskUserQuestionId" => {
                let value = unknown(function, args.first())?;
                Ok(json!(is_ask_user_question_id(&value)))
            }
            "askUserQuestionAnswersValidationError" => {
                let questions: Vec<chat_message_coercion::AskUserQuestionPrompt> =
                    typed(function, args.first())?;
                let answers: Vec<AskUserQuestionAnswerPayload> = typed(function, args.get(1))?;
                Ok(json!(ask_user_question_answers_validation_error(
                    &questions, &answers
                )))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn ask_user_question_decisions_match() {
    use ask_user_question_response::*;

    #[derive(Deserialize)]
    #[serde(tag = "outcome", rename_all = "lowercase")]
    enum Decision {
        Answered {
            answers: Vec<AskUserQuestionAnswerPayload>,
        },
        Skipped {
            reason: Option<String>,
        },
    }

    run(
        "ask-user-question-decisions",
        |function, args| match function {
            "askUserQuestionDecisionValidationError" => {
                let raw = unknown(function, args.first())?;
                let tool = chat_types::parse_tool_use_message(&raw)
                    .ok_or_else(|| CaseError::unhandled(function))?;
                let allow = args
                    .get(1)
                    .and_then(Value::as_bool)
                    .ok_or_else(|| CaseError::unhandled(function))?;
                let decision = match typed(function, args.get(2))? {
                    Decision::Answered { answers } => {
                        AskUserQuestionDecisionResponse::Answered { answers }
                    }
                    Decision::Skipped { reason } => {
                        AskUserQuestionDecisionResponse::Skipped { reason }
                    }
                };
                Ok(json!(ask_user_question_decision_validation_error(
                    &tool, allow, &decision
                )))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn tool_result_content_cases_match() {
    use tool_result_content::*;
    run("tool-result-content", |function, args| {
        let value = unknown(function, args.first())?;
        Ok(match function {
            "isPlainTextPart" => json!(is_plain_text_part(&value)),
            "toolResultTextPart" => json_value(tool_result_text_part(&value).map(|part| part.raw)),
            "plainToolResultTextPart" => {
                json_value(plain_tool_result_text_part(&value).map(|part| part.raw))
            }
            "isEmptyToolResult" => {
                let limits = round_tripped(function, args.get(1))?;
                let limits = limits.as_deref().map(|value| ToolResultLimits {
                    max_chars: as_number(&value["maxChars"]).unwrap_or(f64::INFINITY),
                    max_blocks: as_number(&value["maxBlocks"]).unwrap_or(f64::INFINITY),
                });
                json!(is_empty_tool_result(&value, limits))
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn tool_result_message_cases_match() {
    use tool_result_message::*;
    run("tool-result-message", |function, args| {
        let value = unknown(function, args.first())?;
        Ok(match function {
            "isTextPart" => json!(is_text_part(&value)),
            "toolResultTextPart" => json_value(tool_result_text_part(&value).map(|part| part.raw)),
            "ToolResultMessage.fromData" => {
                let data = value
                    .as_object()
                    .ok_or_else(|| CaseError::unhandled(function))?;
                let result = json_value(ToolResultMessage::from_data(data));
                markers::instance("ToolResultMessage", result.as_object().unwrap().clone())
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}
