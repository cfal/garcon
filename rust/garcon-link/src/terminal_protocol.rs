//! Ports `server/remote/transport/terminal-protocol.ts`.

use garcon_contract::terminal::{
    TerminalErrorCode, TerminalStreamServerMessage, parse_terminal_create_request,
    parse_terminal_rename_request, parse_terminal_stream_client_message,
    parse_terminal_stream_server_message, parse_terminal_terminate_request,
};
use garcon_contract::terminal_error::TerminalError;
use garcon_js::{is_safe_integer, json::as_number, utf16};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename = "terminal", rename_all = "camelCase", tag = "type")]
pub struct TerminalNotification {
    pub attachment_id: String,
    pub message: TerminalStreamServerMessage,
}

pub fn validate_terminal_rpc(method: &str, input: &Value) -> Result<(), TerminalError> {
    let authority = input
        .get("authority")
        .ok_or_else(invalid_terminal_request)?;
    let expires = authority
        .get("expiresAtMs")
        .ok_or_else(invalid_terminal_request)?;
    if !valid_id(authority.get("key"))
        || !(expires.is_null()
            || as_number(expires).is_some_and(|value| is_safe_integer(value) && value > 0.0))
    {
        return Err(invalid_terminal_request());
    }
    let valid = match method {
        "terminals.list" => true,
        "terminals.create" => parse_terminal_create_request(input).is_some(),
        "terminals.rename" => parse_terminal_rename_request(input).is_some(),
        "terminals.terminate" => parse_terminal_terminate_request(input).is_some(),
        _ => parse_terminal_stream_client_message(input).is_some_and(|message| {
            message
                .attachment_id
                .as_deref()
                .is_some_and(|id| !id.is_empty())
                && input
                    .get("type")
                    .and_then(Value::as_str)
                    .and_then(|kind| kind.strip_prefix("terminal-"))
                    .is_some_and(|kind| {
                        method
                            .encode_utf16()
                            .skip(utf16::len("terminals."))
                            .eq(kind.encode_utf16())
                    })
        }),
    };
    if valid {
        Ok(())
    } else {
        Err(invalid_terminal_request())
    }
}

pub fn parse_terminal_notification(value: &Value) -> Result<TerminalNotification, TerminalError> {
    let message = value
        .get("message")
        .and_then(parse_terminal_stream_server_message);
    let attachment_id = value
        .get("attachmentId")
        .filter(|id| valid_id(Some(id)))
        .and_then(Value::as_str)
        .ok_or_else(invalid_terminal_request)?;
    Ok(TerminalNotification {
        attachment_id: attachment_id.to_owned(),
        message: message.ok_or_else(invalid_terminal_request)?,
    })
}

fn valid_id(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty() && utf16::len(value) <= 256)
}

fn invalid_terminal_request() -> TerminalError {
    TerminalError::new(
        TerminalErrorCode::TERMINAL_VALIDATION,
        "Invalid terminal RPC request.",
    )
}
