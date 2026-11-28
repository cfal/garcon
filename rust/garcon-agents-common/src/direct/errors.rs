//! Ports `server-agents/common/src/direct/errors.ts`.

use std::error::Error;

use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};

use crate::execution::resolve_endpoint::call_error;

pub fn classify_direct_integration_error(error: Box<dyn Error>) -> Box<dyn Error> {
    if error.is::<AgentIntegrationError>() || call_error(error.as_ref()).is_some() {
        return error;
    }
    let message = error.to_string();
    let normalized = message.to_lowercase();
    let matches = |needles: &[&str]| needles.iter().any(|needle| normalized.contains(needle));
    let code = if matches(&["401", "unauthorized", "forbidden", "auth", "api key"]) {
        AgentIntegrationErrorCode::AUTH_REQUIRED
    } else if matches(&["429", "rate limit", "quota", "too many requests"]) {
        AgentIntegrationErrorCode::RATE_LIMITED
    } else if matches(&["timed out", "timeout", "deadline", "etimedout"]) {
        AgentIntegrationErrorCode::TIMEOUT
    } else if matches(&[
        "service unavailable",
        "unavailable",
        "econnrefused",
        "enotfound",
        "network",
    ]) {
        AgentIntegrationErrorCode::UNAVAILABLE
    } else {
        AgentIntegrationErrorCode::PROVIDER_FAILURE
    };
    AgentIntegrationError::new(
        code,
        message,
        code != AgentIntegrationErrorCode::AUTH_REQUIRED,
        None,
    )
    .into()
}
