//! Ports `common/self-handoff-contracts.ts`.

use serde::Serialize;
use serde_json::Value;

use crate::chat_command_contracts::parse_fork_run_command_request;
use crate::chat_id::ChatId;
use crate::command_request_validation::CommandRequestValidationError;
use crate::ws_requests::AgentCommandImage;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfHandoffRunCommandRequest {
    pub client_request_id: String,
    pub client_message_id: String,
    pub source_chat_id: ChatId,
    pub chat_id: ChatId,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<AgentCommandImage>>,
}

pub fn parse_self_handoff_run_command_request(
    value: &Value,
) -> Result<SelfHandoffRunCommandRequest, CommandRequestValidationError> {
    let parsed = parse_fork_run_command_request(value)?;
    Ok(SelfHandoffRunCommandRequest {
        client_request_id: parsed.client_request_id,
        client_message_id: parsed.client_message_id,
        source_chat_id: parsed.source_chat_id,
        chat_id: parsed.chat_id,
        command: parsed.command,
        images: parsed.images,
    })
}
