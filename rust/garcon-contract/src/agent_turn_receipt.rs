//! Ports `common/agent-turn-receipt.ts`.

use serde::{Serialize, Serializer};
use serde_json::Value;

use crate::error_codes::{ErrorCode, is_error_code};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentTurnOutputCompleteness {
    Complete,
    BestEffort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentTurnOutputUnavailableReason {
    NoFinalResponse,
    TooLarge,
    RetentionPressure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Availability {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentTurnOutputAvailable {
    availability: Availability,
    pub completeness: AgentTurnOutputCompleteness,
    pub text: String,
}

impl AgentTurnOutputAvailable {
    pub fn new(completeness: AgentTurnOutputCompleteness, text: String) -> Self {
        Self {
            availability: Availability::Available,
            completeness,
            text,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AgentTurnOutputUnavailable {
    availability: Availability,
    pub reason: AgentTurnOutputUnavailableReason,
}

impl AgentTurnOutputUnavailable {
    pub fn new(reason: AgentTurnOutputUnavailableReason) -> Self {
        Self {
            availability: Availability::Unavailable,
            reason,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum AgentTurnOutput {
    Available(AgentTurnOutputAvailable),
    Unavailable(AgentTurnOutputUnavailable),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentTurnNoFinalResponse;

impl Serialize for AgentTurnNoFinalResponse {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        AgentTurnOutputUnavailable::new(AgentTurnOutputUnavailableReason::NoFinalResponse)
            .serialize(serializer)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnReceiptBase {
    pub chat_id: String,
    pub turn_id: String,
    pub client_request_id: String,
    pub accepted_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ReceiptState {
    Pending,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingAgentTurnReceipt {
    #[serde(flatten)]
    pub base: AgentTurnReceiptBase,
    state: ReceiptState,
}

impl PendingAgentTurnReceipt {
    pub fn new(base: AgentTurnReceiptBase) -> Self {
        Self {
            base,
            state: ReceiptState::Pending,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedAgentTurnReceipt {
    #[serde(flatten)]
    pub base: AgentTurnReceiptBase,
    state: ReceiptState,
    pub settled_at: String,
    pub output: AgentTurnOutput,
}

impl CompletedAgentTurnReceipt {
    pub fn new(base: AgentTurnReceiptBase, settled_at: String, output: AgentTurnOutput) -> Self {
        Self {
            base,
            state: ReceiptState::Completed,
            settled_at,
            output,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedAgentTurnReceipt {
    #[serde(flatten)]
    pub base: AgentTurnReceiptBase,
    state: ReceiptState,
    pub settled_at: String,
    pub error: String,
    #[serde(serialize_with = "serialize_error_code")]
    pub error_code: ErrorCode,
    pub output: AgentTurnNoFinalResponse,
}

fn serialize_error_code<S: serde::Serializer>(
    code: &ErrorCode,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(code.as_str())
}

impl FailedAgentTurnReceipt {
    pub fn new(
        base: AgentTurnReceiptBase,
        settled_at: String,
        error: String,
        error_code: ErrorCode,
    ) -> Self {
        Self {
            base,
            state: ReceiptState::Failed,
            settled_at,
            error,
            error_code,
            output: AgentTurnNoFinalResponse,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentTurnInterruptionReason {
    UserStop,
    ChatDeleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedAgentTurnReceipt {
    #[serde(flatten)]
    pub base: AgentTurnReceiptBase,
    state: ReceiptState,
    pub settled_at: String,
    pub reason: AgentTurnInterruptionReason,
    pub output: AgentTurnNoFinalResponse,
}

impl InterruptedAgentTurnReceipt {
    pub fn new(
        base: AgentTurnReceiptBase,
        settled_at: String,
        reason: AgentTurnInterruptionReason,
    ) -> Self {
        Self {
            base,
            state: ReceiptState::Interrupted,
            settled_at,
            reason,
            output: AgentTurnNoFinalResponse,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum AgentTurnReceipt {
    Pending(PendingAgentTurnReceipt),
    Completed(CompletedAgentTurnReceipt),
    Failed(FailedAgentTurnReceipt),
    Interrupted(InterruptedAgentTurnReceipt),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct AgentTurnReceiptContractError(String);

impl AgentTurnReceiptContractError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

pub fn parse_agent_turn_receipt(
    value: &Value,
) -> Result<AgentTurnReceipt, AgentTurnReceiptContractError> {
    use AgentTurnReceiptContractError as Error;
    if !value.is_object() {
        return Err(Error::new("turn receipt must be an object"));
    }
    let base = AgentTurnReceiptBase {
        chat_id: required_string(value, "chatId")?,
        turn_id: required_string(value, "turnId")?,
        client_request_id: required_string(value, "clientRequestId")?,
        accepted_at: required_string(value, "acceptedAt")?,
        updated_at: required_string(value, "updatedAt")?,
    };
    let state = value["state"].as_str();
    if state == Some("pending") {
        return Ok(AgentTurnReceipt::Pending(PendingAgentTurnReceipt::new(
            base,
        )));
    }
    let settled_at = required_string(value, "settledAt")?;
    Ok(match state {
        Some("completed") => AgentTurnReceipt::Completed(CompletedAgentTurnReceipt::new(
            base,
            settled_at,
            parse_output(&value["output"])?,
        )),
        Some("failed") => {
            let error_code = is_error_code(&value["errorCode"])
                .ok_or_else(|| Error::new("errorCode must be a registered error code"))?;
            let error = required_string(value, "error")?;
            parse_unsuccessful_output(&value["output"])?;
            AgentTurnReceipt::Failed(FailedAgentTurnReceipt::new(
                base, settled_at, error, error_code,
            ))
        }
        Some("interrupted") => {
            let reason = match value["reason"].as_str() {
                Some("user-stop") => AgentTurnInterruptionReason::UserStop,
                Some("chat-deleted") => AgentTurnInterruptionReason::ChatDeleted,
                _ => return Err(Error::new("interruption reason is invalid")),
            };
            parse_unsuccessful_output(&value["output"])?;
            AgentTurnReceipt::Interrupted(InterruptedAgentTurnReceipt::new(
                base, settled_at, reason,
            ))
        }
        _ => return Err(Error::new("turn receipt state is invalid")),
    })
}

fn parse_output(value: &Value) -> Result<AgentTurnOutput, AgentTurnReceiptContractError> {
    use AgentTurnOutputUnavailableReason as Reason;
    use AgentTurnReceiptContractError as Error;
    if !value.is_object() {
        return Err(Error::new("turn output must be an object"));
    }
    match value["availability"].as_str() {
        Some("unavailable") => {
            let reason = match value["reason"].as_str() {
                Some("too-large") => Reason::TooLarge,
                Some("retention-pressure") => Reason::RetentionPressure,
                Some("no-final-response") => Reason::NoFinalResponse,
                _ => return Err(Error::new("turn output reason is invalid")),
            };
            Ok(AgentTurnOutput::Unavailable(
                AgentTurnOutputUnavailable::new(reason),
            ))
        }
        Some("available") => {
            let completeness = match value["completeness"].as_str() {
                Some("complete") => AgentTurnOutputCompleteness::Complete,
                Some("best-effort") => AgentTurnOutputCompleteness::BestEffort,
                _ => return Err(Error::new("turn output completeness is invalid")),
            };
            let text = value["text"]
                .as_str()
                .ok_or_else(|| Error::new("text must be a string"))?
                .to_owned();
            Ok(AgentTurnOutput::Available(AgentTurnOutputAvailable::new(
                completeness,
                text,
            )))
        }
        _ => Err(Error::new("turn output availability is invalid")),
    }
}

fn parse_unsuccessful_output(value: &Value) -> Result<(), AgentTurnReceiptContractError> {
    if matches!(parse_output(value)?, AgentTurnOutput::Unavailable(output) if output.reason == AgentTurnOutputUnavailableReason::NoFinalResponse)
    {
        return Ok(());
    }
    Err(AgentTurnReceiptContractError::new(
        "unsuccessful turns cannot expose a final response",
    ))
}

fn required_string(value: &Value, field: &str) -> Result<String, AgentTurnReceiptContractError> {
    value[field]
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            AgentTurnReceiptContractError::new(format!("{field} must be a non-empty string"))
        })
}
