//! Ports `common/chat-input-command-parsing.ts`.

use serde_json::{Map, Value};

use crate::async_user_questions::{
    AsyncQuestionReply, async_question_reply_text, parse_async_question_reply,
};
use crate::command_request_validation::{CommandRequestValidationError, optional_non_empty_string};
use crate::user_message_presentation::{UserMessagePresentation, parse_user_message_presentation};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandQuestionReplyField {
    Command,
    Content,
}

pub fn parse_command_question_reply(
    body: &Map<String, Value>,
    field: CommandQuestionReplyField,
) -> Result<Option<AsyncQuestionReply>, CommandRequestValidationError> {
    let reply = parse_async_question_reply(body.get("questionReply"))
        .map_err(|_| CommandRequestValidationError::new("Invalid async question reply"))?;
    let Some(reply) = reply else { return Ok(None) };
    let content_field = match field {
        CommandQuestionReplyField::Command => "command",
        CommandQuestionReplyField::Content => "content",
    };
    let invalid = || {
        CommandRequestValidationError::new(
            "Question replies require their source view, ownership, and exact text without queueing or handoff",
        )
    };
    let source = reply.source.as_ref().ok_or_else(invalid)?;
    if body.get("chatId").and_then(Value::as_str) != Some(source.chat_id.as_str())
        || body.get("transcriptViewId").and_then(Value::as_str)
            != Some(source.transcript_view_id.as_str())
        || body.get(content_field).and_then(Value::as_str)
            != Some(async_question_reply_text(&reply).as_str())
        || optional_non_empty_string(body, "expectedAgentId")?.is_none()
        || optional_non_empty_string(body, "expectedAgentOwnershipEpoch")?.is_none()
        || body.get("whenTurnUnavailable").and_then(Value::as_str) == Some("queue")
        || body.contains_key("handoff")
        || body.contains_key("userMessagePresentation")
        || body
            .get("images")
            .and_then(Value::as_array)
            .is_some_and(|images| !images.is_empty())
    {
        return Err(invalid());
    }
    Ok(Some(reply))
}

pub fn reject_question_reply(
    body: &Map<String, Value>,
) -> Result<(), CommandRequestValidationError> {
    if body.contains_key("questionReply") {
        Err(CommandRequestValidationError::new(
            "Question replies require direct run or steer admission",
        ))
    } else {
        Ok(())
    }
}

pub fn parse_command_user_message_presentation(
    value: Option<&Value>,
) -> Result<Option<UserMessagePresentation>, CommandRequestValidationError> {
    parse_user_message_presentation(value)
        .map_err(|error| CommandRequestValidationError::new(error.to_string()))
}
