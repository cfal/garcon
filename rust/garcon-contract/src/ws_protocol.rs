//! Ports `common/ws-protocol.ts`.

use serde::Serialize;
use serde_json::Value;

use crate::terminal::{
    TerminalStreamClientMessage, TerminalStreamServerMessage, parse_terminal_stream_client_message,
    parse_terminal_stream_server_message,
};
use crate::ws_events::{ServerWsMessage, ServerWsMessageError, parse_server_ws_message};
use crate::ws_requests::{ClientWsMessage, NullClientWsMessage, parse_client_ws_message};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PrimaryWsClientMessage {
    Client(ClientWsMessage),
    Terminal(TerminalStreamClientMessage),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PrimaryWsServerMessage {
    Server(ServerWsMessage),
    Terminal(TerminalStreamServerMessage),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalStreamClientMessageType {
    TerminalAttach,
    TerminalInput,
    TerminalResize,
    TerminalDetach,
}

pub const TERMINAL_STREAM_CLIENT_MESSAGE_TYPES: &[TerminalStreamClientMessageType] = &[
    TerminalStreamClientMessageType::TerminalAttach,
    TerminalStreamClientMessageType::TerminalInput,
    TerminalStreamClientMessageType::TerminalResize,
    TerminalStreamClientMessageType::TerminalDetach,
];

pub fn is_terminal_stream_client_message_type(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("terminal-attach" | "terminal-input" | "terminal-resize" | "terminal-detach")
    )
}

pub fn parse_primary_ws_client_message(
    data: &Value,
) -> Result<Option<PrimaryWsClientMessage>, NullClientWsMessage> {
    if is_terminal_stream_client_message_type(&data["type"]) {
        return Ok(parse_terminal_stream_client_message(data).map(PrimaryWsClientMessage::Terminal));
    }
    Ok(parse_client_ws_message(data)?.map(PrimaryWsClientMessage::Client))
}

pub fn parse_primary_ws_server_message(
    data: &Value,
) -> Result<Option<PrimaryWsServerMessage>, ServerWsMessageError> {
    if let Some(terminal) = parse_terminal_stream_server_message(data) {
        return Ok(Some(PrimaryWsServerMessage::Terminal(terminal)));
    }
    Ok(parse_server_ws_message(data)?.map(PrimaryWsServerMessage::Server))
}
