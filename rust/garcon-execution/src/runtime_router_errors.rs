use std::error::Error;

use garcon_base::executor_disconnect::as_agent_call_error;
use garcon_contract::error_codes::{ErrorCode, is_error_code};
use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome, AgentIntegrationError},
    producer::AgentRunFailureDetail,
};
use serde_json::Value;

use crate::execution_errors::execution_domain_error;

pub fn execution_setup_failure(error: Box<dyn Error>) -> Box<dyn Error> {
    if is_lost_launch_reply(error.as_ref()) {
        Box::new(AgentCallError::new(
            AgentDeliveryOutcome::NotDispatched,
            format!("The turn did not start: {error}"),
        ))
    } else {
        error
    }
}

pub fn is_lost_launch_reply(error: &(dyn Error + 'static)) -> bool {
    as_agent_call_error(error).is_some_and(|error| error.outcome == AgentDeliveryOutcome::Unknown)
}

pub fn dispatch_failure_detail(error: &(dyn Error + 'static)) -> AgentRunFailureDetail {
    let code = error
        .downcast_ref::<AgentIntegrationError>()
        .map(|error| error.code.as_str())
        .or_else(|| as_agent_call_error(error).map(|error| error.code.as_str()))
        .or_else(|| execution_domain_error(error).map(|error| error.code.as_str()))
        .unwrap_or("DISPATCH_FAILED");
    let message = error.to_string();
    AgentRunFailureDetail {
        code: code.into(),
        message: (!message.is_empty()).then_some(message),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicDispatchFailure {
    pub error: String,
    pub error_code: ErrorCode,
}

pub fn public_dispatch_failure(error: &(dyn Error + 'static)) -> PublicDispatchFailure {
    let detail = dispatch_failure_detail(error);
    PublicDispatchFailure {
        error: detail.message.unwrap_or_default(),
        error_code: is_error_code(&Value::String(detail.code)).unwrap_or(ErrorCode::INTERNAL_ERROR),
    }
}
