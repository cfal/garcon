//! Questions offered without an active permission prompt and their durable replies.

use std::collections::HashSet;

use garcon_js::{is_safe_integer, json::as_number};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ask_user_question_response::{
        ASK_USER_QUESTION_ID_MAX_BYTES, ASK_USER_QUESTION_RESPONSE_MAX_BYTES,
        ASK_USER_QUESTION_TEXT_MAX_BYTES, bounded_text, json_size,
    },
    chat_message_coercion::AskUserQuestionOption,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsyncQuestionPrompt {
    pub id: String,
    pub prompt: String,
    pub options: Vec<AskUserQuestionOption>,
    pub allow_free_text: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AsyncQuestionSet {
    pub id: String,
    pub questions: Vec<AsyncQuestionPrompt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsyncQuestionReply {
    pub question_id: String,
    pub question: String,
    pub answer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<AsyncQuestionReplySource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsyncQuestionReplySource {
    pub chat_id: String,
    pub transcript_view_id: String,
    pub ordinal: u64,
}

pub fn parse_async_question_set(value: &Value) -> Option<AsyncQuestionSet> {
    let raw = value.as_object()?;
    let id = bounded_text(raw.get("id")?, ASK_USER_QUESTION_ID_MAX_BYTES)?;
    let questions = raw.get("questions")?.as_array()?;
    if questions.is_empty()
        || questions.len() > 100
        || json_size(value)? > ASK_USER_QUESTION_RESPONSE_MAX_BYTES
    {
        return None;
    }
    let mut question_ids = HashSet::new();
    let mut normalized = Vec::with_capacity(questions.len());
    for question in questions {
        let raw = question.as_object()?;
        let id = bounded_text(raw.get("id")?, ASK_USER_QUESTION_ID_MAX_BYTES)?;
        if !question_ids.insert(id) {
            return None;
        }
        let prompt = bounded_text(raw.get("prompt")?, ASK_USER_QUESTION_TEXT_MAX_BYTES)?;
        if question["allowFreeText"] != true {
            return None;
        }
        let options = question["options"].as_array()?;
        if options.len() > 100
            || ["allowMultiple", "allowNotes", "isSecret"]
                .iter()
                .any(|key| question[*key] == true)
        {
            return None;
        }
        let mut option_ids = HashSet::new();
        let mut accepted = Vec::with_capacity(options.len());
        for option in options {
            let raw = option.as_object()?;
            let id = bounded_text(raw.get("id")?, ASK_USER_QUESTION_ID_MAX_BYTES)?;
            if !option_ids.insert(id) {
                return None;
            }
            let label = bounded_text(raw.get("label")?, ASK_USER_QUESTION_TEXT_MAX_BYTES)?;
            accepted.push(AskUserQuestionOption {
                id: id.to_owned(),
                label: label.to_owned(),
                description: None,
                preview: None,
            });
        }
        normalized.push(AsyncQuestionPrompt {
            id: id.to_owned(),
            prompt: prompt.to_owned(),
            options: accepted,
            allow_free_text: true,
        });
    }
    Some(AsyncQuestionSet {
        id: id.to_owned(),
        questions: normalized,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InvalidAsyncQuestionReply {
    #[error("Invalid async question reply")]
    Reply,
    #[error("Invalid async question reply source")]
    Source,
}

pub fn parse_async_question_reply(
    value: Option<&Value>,
) -> Result<Option<AsyncQuestionReply>, InvalidAsyncQuestionReply> {
    let Some(value) = value else { return Ok(None) };
    let invalid = InvalidAsyncQuestionReply::Reply;
    let raw = value.as_object().ok_or(invalid)?;
    let bounded = |field, limit| {
        raw.get(field)
            .and_then(|value| bounded_text(value, limit))
            .ok_or(invalid)
    };
    let question_id = bounded("questionId", ASK_USER_QUESTION_ID_MAX_BYTES)?;
    let question = bounded("question", ASK_USER_QUESTION_TEXT_MAX_BYTES)?;
    let answer = bounded("answer", ASK_USER_QUESTION_TEXT_MAX_BYTES)?;
    if raw
        .keys()
        .any(|key| !["questionId", "question", "answer", "source"].contains(&key.as_str()))
        || json_size(value).ok_or(invalid)? > ASK_USER_QUESTION_RESPONSE_MAX_BYTES
    {
        return Err(invalid);
    }
    let source = raw.get("source").map(parse_reply_source).transpose()?;
    Ok(Some(AsyncQuestionReply {
        question_id: question_id.to_owned(),
        question: question.to_owned(),
        answer: answer.to_owned(),
        source,
    }))
}

fn parse_reply_source(
    value: &Value,
) -> Result<AsyncQuestionReplySource, InvalidAsyncQuestionReply> {
    let invalid = InvalidAsyncQuestionReply::Source;
    let raw = value.as_object().ok_or(invalid)?;
    let chat_id = raw
        .get("chatId")
        .and_then(|s| bounded_text(s, 128))
        .ok_or(invalid)?;
    let transcript_view_id = raw
        .get("transcriptViewId")
        .and_then(|s| bounded_text(s, 128))
        .ok_or(invalid)?;
    let ordinal = raw
        .get("ordinal")
        .and_then(as_number)
        .filter(|&n| is_safe_integer(n) && n >= 1.0)
        .ok_or(invalid)?;
    if raw
        .keys()
        .any(|key| !["chatId", "transcriptViewId", "ordinal"].contains(&key.as_str()))
    {
        return Err(invalid);
    }
    Ok(AsyncQuestionReplySource {
        chat_id: chat_id.to_owned(),
        transcript_view_id: transcript_view_id.to_owned(),
        ordinal: ordinal as u64,
    })
}

pub fn async_question_reply_text(reply: &AsyncQuestionReply) -> String {
    let mut lines = reply.question.split('\n').peekable();
    let mut quoted = String::new();
    while let Some(line) = lines.next() {
        quoted.push_str("> ");
        if lines.peek().is_some() {
            quoted.push_str(line.strip_suffix('\r').unwrap_or(line));
            quoted.push('\n');
        } else {
            quoted.push_str(line);
        }
    }
    format!("{quoted}\n\n{}", reply.answer)
}
