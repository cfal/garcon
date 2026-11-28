//! Structured replies to a pending user question.
//!
//! The JSON boundary replaces an unpaired surrogate with U+FFFD. Bun
//! rejects `{"questionId":"q","selectedOptionIds":[],"text":"\uD800"}`
//! as an answer; the port accepts the projected text.

use std::collections::{HashMap, HashSet};

use garcon_js::{json::Opaque, trim};
use serde::{Deserialize, Serialize, Serializer, ser::SerializeMap};
use serde_json::{Map, Value};

use crate::chat_message_coercion::AskUserQuestionPrompt;
use crate::chat_types::ToolUseChatMessage;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserQuestionAnswerPayload {
    pub question_id: String,
    pub selected_option_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

pub const ASK_USER_QUESTION_MAX_ANSWERS: usize = 100;
pub const ASK_USER_QUESTION_MAX_SELECTED_OPTIONS: usize = 100;
pub const ASK_USER_QUESTION_ID_MAX_BYTES: usize = 1_024;
pub const ASK_USER_QUESTION_REASON_MAX_BYTES: usize = 4_096;
pub const ASK_USER_QUESTION_TEXT_MAX_BYTES: usize = 16 * 1_024;
pub const ASK_USER_QUESTION_RESPONSE_MAX_BYTES: usize = 64 * 1_024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskUserQuestionDecisionResponse {
    Answered {
        answers: Vec<AskUserQuestionAnswerPayload>,
    },
    Skipped {
        reason: Option<String>,
    },
}

const RESPONSE_KIND: &str = "ask-user-question-response";

impl Serialize for AskUserQuestionDecisionResponse {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("type", RESPONSE_KIND)?;
        match self {
            Self::Answered { answers } => {
                map.serialize_entry("outcome", "answered")?;
                map.serialize_entry("answers", answers)?;
            }
            Self::Skipped { reason } => {
                map.serialize_entry("outcome", "skipped")?;
                if let Some(reason) = reason {
                    map.serialize_entry("reason", reason)?;
                }
            }
        }
        map.end()
    }
}

pub fn normalize_ask_user_question_decision_response(
    value: &Value,
) -> Option<AskUserQuestionDecisionResponse> {
    let response = value.as_object()?;
    if value["type"] != RESPONSE_KIND {
        return None;
    }
    let normalized = match value["outcome"].as_str()? {
        "answered" => AskUserQuestionDecisionResponse::Answered {
            answers: normalize_answers(response)?,
        },
        "skipped" => {
            if !has_exact_keys(response, &["type", "outcome"], &["reason"]) {
                return None;
            }
            let reason = match response.get("reason") {
                Some(value) => {
                    Some(bounded_text(value, ASK_USER_QUESTION_REASON_MAX_BYTES)?.to_owned())
                }
                None => None,
            };
            AskUserQuestionDecisionResponse::Skipped { reason }
        }
        _ => return None,
    };
    (serde_json::to_vec(&normalized).ok()?.len() <= ASK_USER_QUESTION_RESPONSE_MAX_BYTES)
        .then_some(normalized)
}

pub fn ask_user_question_decision_validation_error(
    requested_tool: &ToolUseChatMessage,
    allow: bool,
    response: &AskUserQuestionDecisionResponse,
) -> Option<String> {
    let ToolUseChatMessage::AskUserQuestion { questions, .. } = requested_tool else {
        return Some("Structured answers require a pending question request".into());
    };
    match response {
        AskUserQuestionDecisionResponse::Skipped { .. } => {
            allow.then(|| "A skipped question response must deny the request".into())
        }
        AskUserQuestionDecisionResponse::Answered { .. } if !allow => {
            Some("An answered question response must allow the request".into())
        }
        AskUserQuestionDecisionResponse::Answered { answers } => {
            ask_user_question_answers_validation_error(questions, answers)
        }
    }
}

pub fn ask_user_question_answers_validation_error(
    questions: &[AskUserQuestionPrompt],
    answers: &[AskUserQuestionAnswerPayload],
) -> Option<String> {
    let question_ids: HashSet<_> = questions.iter().map(|question| &question.id).collect();
    if question_ids.len() != questions.len() {
        return Some("The pending question request contains duplicate question IDs".into());
    }
    let answers_by_id: HashMap<_, _> = answers
        .iter()
        .map(|answer| (&answer.question_id, answer))
        .collect();
    for answer in answers {
        if !question_ids.contains(&answer.question_id) {
            return Some(format!(
                "Structured answers contain an unknown question ID: {}",
                answer.question_id
            ));
        }
    }
    if answers_by_id.len() != questions.len() || answers_by_id.len() != answers.len() {
        return Some("Structured answers must answer every pending question exactly once".into());
    }
    for question in questions {
        let answer = answers_by_id[&question.id];
        let id = &question.id;
        if let Some(text) = &answer.text {
            let has_selections = !answer.selected_option_ids.is_empty();
            if !has_selections && question.allow_free_text != Some(true) {
                return Some(format!("Question {id} does not accept free text"));
            }
            if trim(text).is_empty() || text.len() > ASK_USER_QUESTION_TEXT_MAX_BYTES {
                return Some(format!("Question {id} requires valid nonblank text"));
            }
            if has_selections && question.allow_notes != Some(true) {
                return Some(format!(
                    "Question {id} accepts either text or option selections"
                ));
            }
            if !has_selections {
                continue;
            }
        }
        if question.allow_free_text == Some(true) && question.options.is_empty() {
            return Some(format!("Question {id} requires text"));
        }
        if let Some(error) =
            selected_options_validation_error(question, &answer.selected_option_ids)
        {
            return Some(error);
        }
    }
    None
}

fn selected_options_validation_error(
    question: &AskUserQuestionPrompt,
    selected: &[String],
) -> Option<String> {
    let id = &question.id;
    let options: HashSet<_> = question.options.iter().map(|option| &option.id).collect();
    if options.len() != question.options.len() {
        return Some(format!(
            "Pending question {id} contains duplicate option IDs"
        ));
    }
    for option in selected {
        if !options.contains(option) {
            return Some(format!(
                "Structured answers contain an unknown option ID for {id}: {option}"
            ));
        }
    }
    if options.is_empty() {
        return (!selected.is_empty())
            .then(|| format!("Question {id} does not accept option selections"));
    }
    if selected.is_empty() {
        return Some(format!("Question {id} requires an option selection"));
    }
    if question.allow_multiple != Some(true) && selected.len() != 1 {
        return Some(format!("Question {id} accepts exactly one option"));
    }
    None
}

fn normalize_answers(response: &Map<String, Value>) -> Option<Vec<AskUserQuestionAnswerPayload>> {
    if !has_exact_keys(response, &["type", "outcome", "answers"], &[]) {
        return None;
    }
    let answers = response.get("answers")?.as_array()?;
    if answers.len() > ASK_USER_QUESTION_MAX_ANSWERS {
        return None;
    }
    let mut question_ids = HashSet::new();
    let mut normalized = Vec::with_capacity(answers.len());
    for value in answers {
        let answer = value.as_object()?;
        if !has_exact_keys(answer, &["questionId", "selectedOptionIds"], &["text"]) {
            return None;
        }
        let text = match answer.get("text") {
            Some(value) => Some(bounded_text(value, ASK_USER_QUESTION_TEXT_MAX_BYTES)?.to_owned()),
            None => None,
        };
        let question_id = bounded_text(&value["questionId"], ASK_USER_QUESTION_ID_MAX_BYTES)?;
        if !question_ids.insert(question_id) {
            return None;
        }
        let chosen = value["selectedOptionIds"].as_array()?;
        if chosen.len() > ASK_USER_QUESTION_MAX_SELECTED_OPTIONS {
            return None;
        }
        let mut option_ids = HashSet::new();
        let mut selected_option_ids = Vec::with_capacity(chosen.len());
        for option in chosen {
            let option_id = bounded_text(option, ASK_USER_QUESTION_ID_MAX_BYTES)?;
            if !option_ids.insert(option_id) {
                return None;
            }
            selected_option_ids.push(option_id.to_owned());
        }
        normalized.push(AskUserQuestionAnswerPayload {
            question_id: question_id.to_owned(),
            selected_option_ids,
            text,
        });
    }
    Some(normalized)
}

pub fn is_ask_user_question_id(value: &Value) -> bool {
    bounded_text(value, ASK_USER_QUESTION_ID_MAX_BYTES).is_some()
}

pub(crate) fn bounded_text(value: &Value, max_bytes: usize) -> Option<&str> {
    value
        .as_str()
        .filter(|s| !trim(s).is_empty() && s.len() <= max_bytes)
}

pub(crate) fn json_size(value: &Value) -> Option<usize> {
    serde_json::to_vec(&Opaque::from_value(value.clone()))
        .ok()
        .map(|bytes| bytes.len())
}

fn has_exact_keys(value: &Map<String, Value>, required: &[&str], optional: &[&str]) -> bool {
    required.iter().all(|key| value.contains_key(*key))
        && value
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}
