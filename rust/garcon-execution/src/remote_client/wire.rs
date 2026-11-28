use std::{error::Error, rc::Rc};

use garcon_base::{
    domain_error::{DomainError, as_domain_error},
    errors::{SharedDiagnosticError, error_metadata},
    executor_disconnect::{ExecutorSessionLostError, as_agent_call_error},
};
use garcon_contract::{
    chat_types::{ChatMessage, parse_chat_message},
    git_error::GitServiceError,
    terminal_error::TerminalError,
};
use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome, AgentIntegrationError},
    native_history::AgentImportedTranscriptRow,
    resources::ExecutorResult,
};
use garcon_js::json::{Opaque, from_slice};
use garcon_link::message_session::SessionError;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

pub(crate) fn encode(value: impl Serialize) -> ExecutorResult<Opaque> {
    Ok(from_slice(&serde_json::to_vec(&value)?)?)
}

pub(crate) fn decode<T: DeserializeOwned>(value: Option<&Opaque>) -> ExecutorResult<T> {
    match value {
        // Integral JavaScript numbers in Opaque serialize without a decimal point.
        Some(value) => Ok(from_slice(&serde_json::to_vec(value)?)?),
        None => Ok(T::deserialize(Value::Null)?),
    }
}

pub(crate) fn own_rpc_error(error: SessionError) -> Box<dyn Error> {
    // The public services expose owned errors. Preserve the classes consumers
    // inspect rather than replacing transport failures with their display text.
    if let Some(error) = error.downcast_ref::<ExecutorSessionLostError>() {
        return error.clone().into();
    }
    if let Some(error) = error.downcast_ref::<AgentCallError>() {
        return error.clone().into();
    }
    if let Some(error) = error.downcast_ref::<AgentIntegrationError>() {
        return error.clone().into();
    }
    if let Some(error) = error.downcast_ref::<GitServiceError>() {
        return error.clone().into();
    }
    if let Some(error) = error.downcast_ref::<TerminalError>() {
        return error.clone().into();
    }
    if let Some(error) = as_domain_error(error.as_ref()) {
        // The link's domain errors carry no cause; RPC does not transmit one.
        return DomainError {
            kind: error.kind.clone(),
            ..DomainError::new(
                error.code,
                error.message.clone(),
                error.status,
                error.retryable,
            )
        }
        .into();
    }
    let metadata = error_metadata(error.as_ref());
    Box::new(SharedDiagnosticError::new(Rc::clone(&error), metadata))
}

pub(crate) fn unknown_outcome(error: &(dyn Error + 'static)) -> bool {
    as_agent_call_error(error).is_some_and(|error| error.outcome == AgentDeliveryOutcome::Unknown)
}

pub(crate) fn decode_message(value: &Value) -> ExecutorResult<ChatMessage> {
    if !value.is_object() {
        return Err("Invalid normalized message".into());
    }
    parse_chat_message(value)?.ok_or_else(|| "Unknown normalized message".into())
}

pub(crate) fn decode_rows(value: &Value) -> ExecutorResult<Vec<AgentImportedTranscriptRow>> {
    let rows = value.as_array().ok_or("Invalid imported rows")?;
    rows.iter()
        .map(|row| {
            let message = decode_message(&row["message"])?;
            let provider_meta = match row.get("providerMeta") {
                None | Some(Value::Null) => None,
                Some(value) if value.is_object() => Some(Opaque::from_value(value.clone())),
                Some(_) => return Err("providerMeta must be an object".into()),
            };
            Ok(AgentImportedTranscriptRow {
                message,
                provider_meta,
            })
        })
        .collect()
}
