//! Ports `common/chat-fork-command-parsing.ts`.

use serde_json::{Map, Value};

use crate::{
    chat_command_contracts::{DeleteChatCommandRequest, ForkChatCommandRequest, safe_integer},
    command_request_validation::{
        CommandRequestValidationError as ValidationError, optional_non_empty_string,
        request_record, required_chat_id, required_command_correlation_id,
    },
};

pub fn parse_fork_chat_command_request(
    value: &Value,
) -> Result<ForkChatCommandRequest, ValidationError> {
    let body = request_record(value)?;
    let up_to_ordinal = body.get("upToOrdinal");
    let transcript_view_id = optional_non_empty_string(body, "transcriptViewId")?;
    let up_to_ordinal = up_to_ordinal
        .map(|value| {
            safe_integer(Some(value), 1)
                .ok_or_else(|| ValidationError::new("upToOrdinal must be a positive integer"))
        })
        .transpose()?;
    if transcript_view_id.is_some() && up_to_ordinal.is_none() {
        return Err(ValidationError::new(
            "transcriptViewId requires upToOrdinal",
        ));
    }
    if up_to_ordinal.is_some() && transcript_view_id.is_none() {
        return Err(ValidationError::new(
            "upToOrdinal requires transcriptViewId",
        ));
    }
    let allow_handoff_fork = parse_handoff_fork_consent(body)?;
    let client_request_id = body
        .contains_key("clientRequestId")
        .then(|| required_command_correlation_id(body, "clientRequestId"))
        .transpose()?
        .map(str::to_owned);
    Ok(ForkChatCommandRequest {
        source_chat_id: required_chat_id(body, "sourceChatId")?,
        chat_id: required_chat_id(body, "chatId")?,
        up_to_ordinal,
        allow_handoff_fork,
        transcript_view_id: transcript_view_id.map(str::to_owned),
        client_request_id,
    })
}

pub fn parse_handoff_fork_consent(
    body: &Map<String, Value>,
) -> Result<Option<bool>, ValidationError> {
    match body.get("allowHandoffFork") {
        Some(Value::Bool(true)) => Ok(Some(true)),
        None | Some(Value::Bool(false)) => Ok(None),
        _ => Err(ValidationError::new("allowHandoffFork must be a boolean")),
    }
}

pub fn parse_delete_chat_command_request(
    value: &Value,
) -> Result<DeleteChatCommandRequest, ValidationError> {
    Ok(DeleteChatCommandRequest {
        chat_id: required_chat_id(request_record(value)?, "chatId")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_the_cutoff_before_parsing_ids() {
        let value = json!({"chatId":"bad","upToOrdinal":2,"allowHandoffFork":"yes"});
        assert_eq!(
            parse_fork_chat_command_request(&value).unwrap_err().message,
            "upToOrdinal requires transcriptViewId"
        );
        let value = json!({"chatId":"bad","upToOrdinal":2,"transcriptViewId":"view","allowHandoffFork":"yes"});
        assert_eq!(
            parse_fork_chat_command_request(&value).unwrap_err().message,
            "allowHandoffFork must be a boolean"
        );
    }
}
