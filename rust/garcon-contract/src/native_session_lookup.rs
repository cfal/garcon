//! Ports `common/native-session-lookup.ts`.

use garcon_js::trim;
use serde::Serialize;
use serde_json::Value;

use crate::agents::{AgentId, is_agent_id};
use crate::chat_id::{ChatId, InvalidChatIdError, parse_chat_id_input};
use crate::executors::{ExecutorId, parse_executor_id};

pub const NATIVE_SESSION_ID_MAX_BYTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionLookupRequest {
    pub native_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<ExecutorId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionLookupResponse {
    pub chat_id: ChatId,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum NativeSessionLookupValidationError {
    #[error("{0}")]
    Field(String),
    #[error(transparent)]
    ChatId(#[from] InvalidChatIdError),
}

impl NativeSessionLookupValidationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self::Field(message.into())
    }
}

pub fn parse_native_session_id(value: &Value) -> Result<&str, NativeSessionLookupValidationError> {
    use NativeSessionLookupValidationError as Error;
    let id = value
        .as_str()
        .filter(|id| !trim(id).is_empty())
        .ok_or_else(|| Error::new("nativeSessionId is required"))?;
    if id.len() > NATIVE_SESSION_ID_MAX_BYTES {
        return Err(Error::new(format!(
            "nativeSessionId must be at most {NATIVE_SESSION_ID_MAX_BYTES} bytes"
        )));
    }
    if id
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, '\u{2028}' | '\u{2029}'))
    {
        return Err(Error::new(
            "nativeSessionId must not contain control characters",
        ));
    }
    Ok(id)
}

pub fn parse_native_session_lookup_request(
    value: &Value,
) -> Result<NativeSessionLookupRequest, NativeSessionLookupValidationError> {
    use NativeSessionLookupValidationError as Error;
    let raw = value
        .as_object()
        .ok_or_else(|| Error::new("request body must be an object"))?;
    let native_session_id = parse_native_session_id(&value["nativeSessionId"])?.to_owned();
    let executor_id = raw
        .get("executorId")
        .map(|executor| {
            parse_executor_id(executor)
                .ok_or_else(|| Error::new("executorId must be a valid executor ID"))
        })
        .transpose()?;
    let agent = raw
        .get("agent")
        .map(|agent| {
            agent
                .as_str()
                .filter(|_| is_agent_id(agent))
                .map(str::to_owned)
                .ok_or_else(|| Error::new("agent must be a valid agent ID"))
        })
        .transpose()?;
    Ok(NativeSessionLookupRequest {
        native_session_id,
        executor_id,
        agent,
    })
}

pub fn parse_native_session_lookup_response(
    value: &Value,
) -> Result<NativeSessionLookupResponse, NativeSessionLookupValidationError> {
    let raw = value.as_object().ok_or_else(|| {
        NativeSessionLookupValidationError::new("response body must be an object")
    })?;
    let chat_id = parse_chat_id_input(raw.get("chatId"))?;
    Ok(NativeSessionLookupResponse { chat_id })
}
