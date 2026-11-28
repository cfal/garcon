use std::collections::HashSet;

use garcon_contract::{
    ask_user_question_response::{
        ASK_USER_QUESTION_MAX_ANSWERS, ASK_USER_QUESTION_MAX_SELECTED_OPTIONS,
        AskUserQuestionDecisionResponse, ask_user_question_decision_validation_error,
        is_ask_user_question_id, normalize_ask_user_question_decision_response,
    },
    chat_command_contracts::{PermissionDecisionPayload, PermissionDecisionResponse},
    chat_types::{AskUserQuestionOption, AskUserQuestionPrompt, ToolUseChatMessage},
};
use garcon_js::{json::parse, trim};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Value, json};

pub const CODEX_USER_INPUT_METHOD: &str = "item/tool/requestUserInput";
const USER_NOTE_PREFIX: &str = "user_note: ";
const OTHER_OPTION_LABEL: &str = "None of the above";

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct CodexUserInputError(String);

impl From<&str> for CodexUserInputError {
    fn from(message: &str) -> Self {
        Self(message.into())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CodexUserInputResponse {
    pub answers: IndexMap<String, CodexQuestionAnswer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CodexQuestionAnswer {
    pub answers: Vec<String>,
}

fn parse_codex_user_input_questions(
    questions: &Value,
) -> Result<Vec<AskUserQuestionPrompt>, CodexUserInputError> {
    let questions = questions
        .as_array()
        .filter(|questions| {
            !questions.is_empty() && questions.len() <= ASK_USER_QUESTION_MAX_ANSWERS
        })
        .ok_or("Invalid Codex questions")?;
    let mut ids = HashSet::new();
    questions
        .iter()
        .map(|question| {
            let raw = question.as_object().ok_or("Invalid Codex question")?;
            let id = raw
                .get("id")
                .filter(|id| is_ask_user_question_id(id))
                .and_then(Value::as_str)
                .filter(|id| ids.insert(*id))
                .ok_or("Invalid Codex question")?;
            let prompt = raw
                .get("question")
                .and_then(Value::as_str)
                .filter(|text| !trim(text).is_empty())
                .ok_or("Invalid Codex question")?;
            let boolean = |key| -> Result<bool, CodexUserInputError> {
                match raw.get(key) {
                    Some(value) => value
                        .as_bool()
                        .ok_or_else(|| "Invalid Codex question".into()),
                    None => Ok(false),
                }
            };
            let allow_free_text = boolean("isOther")?;
            let is_secret = boolean("isSecret")?;
            let options = match raw.get("options") {
                None | Some(Value::Null) => &[][..],
                Some(value) => value
                    .as_array()
                    .filter(|options| options.len() <= ASK_USER_QUESTION_MAX_SELECTED_OPTIONS)
                    .ok_or("Invalid Codex question options")?,
            };
            if options.is_empty() && !allow_free_text {
                return Err("Unanswerable Codex question".into());
            }
            Ok(AskUserQuestionPrompt {
                id: id.into(),
                prompt: prompt.into(),
                options: options
                    .iter()
                    .enumerate()
                    .map(|(index, option)| {
                        let label = option["label"]
                            .as_str()
                            .filter(|label| !trim(label).is_empty())
                            .ok_or_else(|| {
                                CodexUserInputError::from("Invalid Codex question option")
                            })?;
                        Ok(AskUserQuestionOption {
                            id: format!("option-{index}"),
                            label: label.into(),
                            description: option["description"].as_str().map(str::to_owned),
                            preview: None,
                        })
                    })
                    .collect::<Result<_, CodexUserInputError>>()?,
                header: question["header"].as_str().map(str::to_owned),
                allow_multiple: None,
                allow_free_text: Some(allow_free_text),
                allow_notes: Some(!options.is_empty()),
                is_secret: Some(is_secret),
            })
        })
        .collect()
}

pub fn codex_user_input_message(
    timestamp: &str,
    item_id: &Value,
    questions: &Value,
) -> Result<ToolUseChatMessage, CodexUserInputError> {
    let item_id = item_id
        .as_str()
        .filter(|id| !trim(id).is_empty())
        .ok_or("Missing Codex question item ID")?;
    Ok(question_tool(
        timestamp,
        item_id,
        parse_codex_user_input_questions(questions)?,
    ))
}

fn question_tool(
    timestamp: &str,
    id: &str,
    questions: Vec<AskUserQuestionPrompt>,
) -> ToolUseChatMessage {
    ToolUseChatMessage::AskUserQuestion {
        timestamp: timestamp.into(),
        tool_id: id.into(),
        title: None,
        questions,
    }
}

pub fn codex_user_input_response(
    tool: &ToolUseChatMessage,
    decision: &PermissionDecisionPayload,
) -> Result<CodexUserInputResponse, CodexUserInputError> {
    let response = match &decision.response {
        None => None,
        Some(value) => {
            let normalized = match value {
                PermissionDecisionResponse::Structured(value) => {
                    normalize_ask_user_question_decision_response(&json!(value))
                }
                PermissionDecisionResponse::Provider(value) => {
                    normalize_ask_user_question_decision_response(value)
                }
            }
            .ok_or("Invalid Codex question response")?;
            if let Some(error) =
                ask_user_question_decision_validation_error(tool, decision.allow, &normalized)
            {
                return Err(CodexUserInputError(error));
            }
            Some(normalized)
        }
    };
    if !decision.allow {
        return Ok(CodexUserInputResponse {
            answers: IndexMap::new(),
        });
    }
    let (
        Some(AskUserQuestionDecisionResponse::Answered { answers }),
        ToolUseChatMessage::AskUserQuestion { questions, .. },
    ) = (response, tool)
    else {
        return Err("Codex questions require structured answers".into());
    };
    let questions: IndexMap<_, _> = questions.iter().map(|q| (q.id.as_str(), q)).collect();
    let answers = answers
        .into_iter()
        .map(|answer| {
            let native_answer = if answer.selected_option_ids.is_empty() {
                answer.text.into_iter().collect()
            } else {
                let question = questions[answer.question_id.as_str()];
                let mut native_answers = answer
                    .selected_option_ids
                    .iter()
                    .map(|id| {
                        // INFALLIBLE: Validation already resolved every selected option.
                        question
                            .options
                            .iter()
                            .find(|option| &option.id == id)
                            .expect("validated option")
                            .label
                            .clone()
                    })
                    .collect::<Vec<_>>();
                if let Some(text) = answer.text {
                    native_answers.push(format!("{USER_NOTE_PREFIX}{text}"));
                }
                native_answers
            };
            (
                answer.question_id,
                CodexQuestionAnswer {
                    answers: native_answer,
                },
            )
        })
        .collect();
    Ok(CodexUserInputResponse { answers })
}

pub fn codex_historical_user_input(
    timestamp: &str,
    call_id: &str,
    input: &Value,
) -> ToolUseChatMessage {
    let mut questions = input["questions"].clone();
    if let Some(questions) = questions.as_array_mut() {
        for question in questions {
            if let Some(record) = question.as_object_mut() {
                record.insert("isOther".into(), Value::Bool(true));
            }
        }
    }
    codex_user_input_message(timestamp, &json!(call_id), &questions)
        .unwrap_or_else(|_| question_tool(timestamp, call_id, Vec::new()))
}

fn parse_historical_answers(output: &Value) -> Option<IndexMap<String, Vec<String>>> {
    let decoded;
    let value = if let Some(text) = output.as_str() {
        decoded = parse(text).ok()?;
        &decoded
    } else {
        output
    };
    value
        .get("answers")?
        .as_object()?
        .iter()
        .map(|(id, answer)| {
            let values = answer
                .get("answers")?
                .as_array()?
                .iter()
                .map(|text| text.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?;
            Some((id.clone(), values))
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHistoricalQuestionResult {
    pub answers: IndexMap<String, Vec<String>>,
    pub text_answers: IndexMap<String, String>,
}

pub fn codex_historical_question_result(
    output: &Value,
    questions: &[AskUserQuestionPrompt],
) -> Option<CodexHistoricalQuestionResult> {
    let mut answers = parse_historical_answers(output)?;
    let mut text_answers = IndexMap::new();
    for question in questions {
        let Some(values) = answers.get_mut(&question.id) else {
            continue;
        };
        let [label, encoded] = values.as_slice() else {
            continue;
        };
        let Some(note) = encoded.strip_prefix(USER_NOTE_PREFIX) else {
            continue;
        };
        let selected = question.options.iter().any(|option| &option.label == label);
        if !selected && label != OTHER_OPTION_LABEL {
            continue;
        }
        text_answers.insert(question.id.clone(), note.into());
        values.truncate(usize::from(selected));
    }
    Some(CodexHistoricalQuestionResult {
        answers,
        text_answers,
    })
}
