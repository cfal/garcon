use garcon_agents_common::shared::file_mention_context::strip_resolved_file_mention_context;
use garcon_contract::{
    async_user_questions::{
        AsyncQuestionReply, AsyncQuestionSet, async_question_reply_text,
        parse_async_question_reply, parse_async_question_set,
    },
    chat_message_coercion::ChatMessageMetadata,
    chat_types::UserMessage,
};
use garcon_js::{
    json::{from_str, stringify},
    trim,
};
use serde_json::{Value, json};

// https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/context-fragments/src/answered_question.rs#L18-L44
const REPLY_START: &str = "<send_user_message_question_reply>";
const REPLY_END: &str = "</send_user_message_question_reply>";
const NATIVE_REPLY_FIELD_MAX_BYTES: usize = 512;

#[derive(Debug, thiserror::Error)]
#[error("Question reply does not match its input")]
pub struct CodexQuestionReplyMismatch;

pub fn codex_async_questions(
    id: &str,
    delivery: &Value,
    value: &Value,
) -> Option<AsyncQuestionSet> {
    if delivery.as_str() != Some("async") {
        return None;
    }
    let questions = value
        .as_array()
        .filter(|questions| questions.len() <= 100)?;
    let questions = questions
        .iter()
        .enumerate()
        .map(|(index, question)| {
            let question = question.as_object()?;
            let options = match question.get("options") {
                None | Some(Value::Null) => &[][..],
                Some(options) => options
                    .as_array()
                    .filter(|options| !options.is_empty() && options.len() <= 100)?,
            };
            let options = options
                .iter()
                .enumerate()
                .map(|(index, label)| json!({"id":format!("option-{index}"),"label":label}))
                .collect::<Vec<_>>();
            Some(json!({
                "id":stringify(&json!(["request_user_input_async",id,index])),
                "prompt":question.get("title"),"options":options,"allowFreeText":true,
            }))
        })
        .collect::<Option<Vec<_>>>()?;
    parse_async_question_set(&json!({"id":id,"questions":questions}))
}

pub fn codex_question_reply_input(
    content: &str,
    reply: Option<&AsyncQuestionReply>,
) -> Result<String, CodexQuestionReplyMismatch> {
    let Some(reply) = reply else {
        return Ok(content.into());
    };
    let readable = async_question_reply_text(reply);
    let Some(position) = strip_resolved_file_mention_context(content).rfind(&readable) else {
        return if content.contains(&readable) {
            Ok(content.into())
        } else {
            Err(CodexQuestionReplyMismatch)
        };
    };
    if reply.question_id.len() > NATIVE_REPLY_FIELD_MAX_BYTES {
        return Ok(content.into());
    }
    let mut boundary = reply.question.len().min(NATIVE_REPLY_FIELD_MAX_BYTES);
    while !reply.question.is_char_boundary(boundary) {
        boundary -= 1;
    }
    let native = stringify(&json!([{
        "questionItemId":reply.question_id,
        "question":reply.question[..boundary].replace(['\r','\n'], " "),
        "answer":reply.answer
    }]));
    Ok(format!(
        "{}{REPLY_START}\n{native}\n{REPLY_END}{}",
        &content[..position],
        &content[position + readable.len()..],
    ))
}

pub fn codex_historical_user_message(
    timestamp: &str,
    text: &str,
    upstream_request_id: Option<&str>,
) -> UserMessage {
    let content = strip_resolved_file_mention_context(text);
    codex_historical_question_reply(timestamp, content, upstream_request_id).unwrap_or_else(|| {
        UserMessage {
            timestamp: timestamp.into(),
            content: content.into(),
            images: None,
            metadata: upstream_request_id.filter(|id| !id.is_empty()).map(|id| {
                let mut metadata = ChatMessageMetadata::default();
                metadata.upstream_request_id = Some(id.into());
                metadata
            }),
            presentation: None,
        }
    })
}

pub fn codex_historical_question_reply(
    timestamp: &str,
    content: &str,
    upstream_request_id: Option<&str>,
) -> Option<UserMessage> {
    let envelope = trim(content)
        .strip_prefix(REPLY_START)?
        .strip_suffix(REPLY_END)?;
    let parsed: Value = from_str(envelope).ok()?;
    let values = parsed
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_else(|| std::slice::from_ref(&parsed));
    if values.is_empty() || values.len() > 100 {
        return None;
    }
    let mut replies = Vec::with_capacity(values.len());
    for value in values {
        if !value.is_object() {
            return None;
        }
        replies.push(parse_async_question_reply(Some(&json!({
            "questionId":value["questionItemId"],"question":value["question"],"answer":value["answer"]
        }))).ok()??);
    }
    let content = replies
        .iter()
        .map(async_question_reply_text)
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut metadata = ChatMessageMetadata::default();
    metadata.upstream_request_id = upstream_request_id
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    if replies.len() == 1 {
        metadata.question_reply = replies.pop();
    }
    Some(UserMessage {
        timestamp: timestamp.into(),
        content,
        images: None,
        metadata: Some(metadata),
        presentation: None,
    })
}
