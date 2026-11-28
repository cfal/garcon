//! Identifies a launch for both receipts and execution events.

use serde::Serialize;

use crate::{
    event_bus::TurnEventMetadata,
    turn_identity::{TurnCommandType, TurnReceiptOwner},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnOperation {
    pub agent_ownership_epoch: String,
    pub command_type: TurnCommandType,
    pub client_request_id: String,
    pub client_message_id: Option<String>,
    pub turn_id: String,
    pub turn_owner: TurnReceiptOwner,
}

#[derive(Default)]
pub struct TurnOperationIds<'a> {
    pub client_request_id: Option<&'a str>,
    pub client_message_id: Option<&'a str>,
    pub turn_id: Option<&'a str>,
}

#[derive(Debug, thiserror::Error)]
#[error("Agent ownership epoch is required")]
pub struct MissingAgentOwnershipEpoch;

pub fn operation_identity(
    agent_ownership_epoch: Option<&str>,
    ids: TurnOperationIds<'_>,
    command_type: TurnCommandType,
    mut new_id: impl FnMut() -> String,
) -> Result<TurnOperation, MissingAgentOwnershipEpoch> {
    let epoch = agent_ownership_epoch
        .filter(|epoch| !epoch.is_empty())
        .ok_or(MissingAgentOwnershipEpoch)?;
    let client_request_id = ids
        .client_request_id
        .map_or_else(&mut new_id, str::to_owned);
    let turn_id = ids.turn_id.map_or_else(new_id, str::to_owned);
    let turn_owner = TurnReceiptOwner {
        agent_ownership_epoch: epoch.into(),
        command_type,
        client_request_id: client_request_id.clone(),
        turn_id: turn_id.clone(),
    };
    Ok(TurnOperation {
        agent_ownership_epoch: epoch.into(),
        command_type,
        client_request_id,
        client_message_id: ids.client_message_id.map(str::to_owned),
        turn_id,
        turn_owner,
    })
}

pub fn operation_metadata(operation: &TurnOperation) -> TurnEventMetadata {
    TurnEventMetadata {
        command_type: Some(operation.command_type),
        client_request_id: (!operation.client_request_id.is_empty())
            .then(|| operation.client_request_id.clone()),
        turn_id: Some(operation.turn_id.clone()),
        agent_ownership_epoch: Some(operation.agent_ownership_epoch.clone()),
        turn_owner: Some(operation.turn_owner.clone()),
        ..TurnEventMetadata::default()
    }
}
