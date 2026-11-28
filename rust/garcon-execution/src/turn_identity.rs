//! Ports the controller's turn identity and receipt owner.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_request_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnCommandType {
    ChatStart,
    AgentRun,
    ForkRun,
    AgentCompact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnReceiptOwner {
    pub agent_ownership_epoch: String,
    pub command_type: TurnCommandType,
    pub client_request_id: String,
    pub turn_id: String,
}

pub fn matches_turn_identity(
    expected: Option<&TurnIdentity>,
    actual: Option<&TurnIdentity>,
) -> bool {
    let expected_turn_id = expected.and_then(|identity| identity.turn_id.as_deref());
    let expected_request_id = expected.and_then(|identity| identity.client_request_id.as_deref());
    let actual_turn_id = actual.and_then(|identity| identity.turn_id.as_deref());
    let actual_request_id = actual.and_then(|identity| identity.client_request_id.as_deref());
    if let Some(turn_id) = expected_turn_id.filter(|value| !value.is_empty()) {
        return actual_turn_id == Some(turn_id);
    }
    if let Some(request_id) = expected_request_id.filter(|value| !value.is_empty()) {
        return actual_request_id == Some(request_id);
    }
    actual_turn_id.is_none_or(str::is_empty) && actual_request_id.is_none_or(str::is_empty)
}
