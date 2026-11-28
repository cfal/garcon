//! Ports `server-agents/opencode/src/agents/opencode/questions.ts`.

use std::error::Error;

use garcon_contract::chat_command_contracts::{
    PermissionDecisionPayload, PermissionDecisionResponse,
};
use garcon_contract::chat_message_coercion::AskUserQuestionPrompt;
use indexmap::IndexMap;
use serde_json::Value;

use super::sse_events::SseEvent;
use crate::js::{error, own, prop};

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeQuestionRequest {
    pub request_id: String,
    pub tool_call_id: String,
    pub questions: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenCodeQuestionDecision {
    Reply { answers: Vec<Vec<String>> },
    Reject,
}

pub fn extract_open_code_question_request(event: &SseEvent) -> Option<OpenCodeQuestionRequest> {
    if event.kind != "question.asked" {
        return None;
    }
    let properties = &event.properties;
    let tool = prop(properties, "tool").as_object();
    let request_id = prop(properties, "id")
        .as_str()
        .filter(|id| !id.is_empty())?;
    let tool_call_id = tool
        .and_then(|tool| prop(tool, "callID").as_str())
        .filter(|id| !id.is_empty())?
        .to_owned();
    let questions = prop(properties, "questions");
    questions.is_array().then(|| OpenCodeQuestionRequest {
        request_id: request_id.to_owned(),
        tool_call_id,
        questions: questions.clone(),
    })
}

// The decision's response as the record the original validates and reads.
fn response_json(response: &PermissionDecisionResponse) -> Value {
    match response {
        PermissionDecisionResponse::Provider(opaque) => opaque.as_value().clone(),
        // INFALLIBLE: a struct of strings and vectors always serializes.
        PermissionDecisionResponse::Structured(response) => {
            serde_json::to_value(response).expect("a question response serializes")
        }
    }
}

// A response is returned when it has the shape of a skipped or an answered
// question response; anything else is `None`.
fn parse_question_response(response: Option<&Value>) -> Option<&Value> {
    let response = response?;
    let object = response.as_object()?;
    if prop(object, "type").as_str() != Some("ask-user-question-response") {
        return None;
    }
    match prop(object, "outcome").as_str() {
        Some("skipped") => {
            if own(object, "reason").is_some_and(|reason| !reason.is_string()) {
                return None;
            }
            Some(response)
        }
        Some("answered") => {
            for answer in prop(object, "answers").as_array()? {
                let answer = answer.as_object()?;
                let option_ids = prop(answer, "selectedOptionIds").as_array()?;
                if prop(answer, "questionId").as_str().is_none()
                    || option_ids.iter().any(|option_id| !option_id.is_string())
                {
                    return None;
                }
            }
            Some(response)
        }
        _ => None,
    }
}

pub fn map_open_code_question_decision(
    questions: &[AskUserQuestionPrompt],
    decision: &PermissionDecisionPayload,
) -> Result<OpenCodeQuestionDecision, Box<dyn Error>> {
    let json = decision.response.as_ref().map(response_json);
    let response = parse_question_response(json.as_ref());
    let skipped =
        response.is_some_and(|response| prop(response, "outcome").as_str() == Some("skipped"));
    if !decision.allow || skipped {
        return Ok(OpenCodeQuestionDecision::Reject);
    }
    let Some(response) = response else {
        return Err(error(
            "Error",
            "OpenCode question decision is missing an answered response",
        ));
    };
    // INFALLIBLE: an answered response was validated to hold an array of answers.
    let answers = prop(response, "answers")
        .as_array()
        .expect("validated answers");
    let mut answers_by_question: IndexMap<String, Vec<String>> = IndexMap::new();
    for answer in answers {
        // INFALLIBLE: every answer was validated to be a record with a string question ID.
        let answer = answer.as_object().expect("validated answer");
        let question_id = prop(answer, "questionId")
            .as_str()
            .expect("validated question ID");
        // A later question with the same ID replaces an earlier one, as in the original's Map.
        let Some(question) = questions
            .iter()
            .rev()
            .find(|question| question.id == question_id)
        else {
            return Err(error(
                "Error",
                "OpenCode question decision contains an unknown question ID",
            ));
        };
        // INFALLIBLE: every answer was validated to hold an array of option IDs.
        let option_ids = prop(answer, "selectedOptionIds")
            .as_array()
            .expect("validated option IDs");
        let labels = option_ids
            .iter()
            .map(|option_id| {
                option_id
                    .as_str()
                    .and_then(|option_id| {
                        // A later option with the same ID labels as the original's Map keeps.
                        question
                            .options
                            .iter()
                            .rev()
                            .find(|option| option.id == option_id)
                            .map(|option| option.label.clone())
                    })
                    .ok_or_else(|| {
                        error(
                            "Error",
                            "OpenCode question decision contains an unknown option ID",
                        )
                    })
            })
            .collect::<Result<Vec<String>, Box<dyn Error>>>()?;
        answers_by_question.insert(question_id.to_owned(), labels);
    }
    Ok(OpenCodeQuestionDecision::Reply {
        answers: questions
            .iter()
            .map(|question| {
                answers_by_question
                    .get(&question.id)
                    .cloned()
                    .unwrap_or_default()
            })
            .collect(),
    })
}
