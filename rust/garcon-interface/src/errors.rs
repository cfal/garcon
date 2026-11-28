//! Ports `server-agents/interface/src/errors.ts`.

use std::fmt;
use std::ops::Deref;

use garcon_contract::json::{JsonObject, JsonValue};
use garcon_js::json::Opaque;

/// Every code an `AgentIntegrationError` can carry.
pub const AGENT_INTEGRATION_ERROR_CODES: &[AgentIntegrationErrorCode] = &[
    AgentIntegrationErrorCode::AUTH_REQUIRED,
    AgentIntegrationErrorCode::AUTH_LOGIN_SESSION_MISMATCH,
    AgentIntegrationErrorCode::AUTH_LOGIN_CODE_INVALID,
    AgentIntegrationErrorCode::BINARY_NOT_FOUND,
    AgentIntegrationErrorCode::RATE_LIMITED,
    AgentIntegrationErrorCode::TIMEOUT,
    AgentIntegrationErrorCode::UNAVAILABLE,
    AgentIntegrationErrorCode::EXECUTOR_BUSY,
    AgentIntegrationErrorCode::STALE_RESOURCE,
    AgentIntegrationErrorCode::OUTCOME_UNKNOWN,
    AgentIntegrationErrorCode::INVALID_SETTINGS,
    AgentIntegrationErrorCode::INVALID_ENDPOINT,
    AgentIntegrationErrorCode::API_PROVIDER_UNAVAILABLE,
    AgentIntegrationErrorCode::API_PROVIDER_CONFIGURATION_CHANGED,
    AgentIntegrationErrorCode::API_PROVIDER_STORAGE_UNAVAILABLE,
    AgentIntegrationErrorCode::SESSION_NOT_FOUND,
    AgentIntegrationErrorCode::SESSION_BUSY,
    AgentIntegrationErrorCode::PERMISSION_DENIED,
    AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
    AgentIntegrationErrorCode::PROJECT_PATH_DESTINATION_REJECTED,
    AgentIntegrationErrorCode::SEARCH_DISABLED,
    AgentIntegrationErrorCode::SEARCH_UNAVAILABLE,
    AgentIntegrationErrorCode::SOURCE_REVISION_CHANGED,
    AgentIntegrationErrorCode::PROJECTION_HANDOFF_POST_BOUNDARY_EVENT,
    AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
    AgentIntegrationErrorCode::PROVIDER_FAILURE,
];

/// One of `AGENT_INTEGRATION_ERROR_CODES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AgentIntegrationErrorCode(&'static str);

impl AgentIntegrationErrorCode {
    pub const AUTH_REQUIRED: Self = Self("AUTH_REQUIRED");
    pub const AUTH_LOGIN_SESSION_MISMATCH: Self = Self("AUTH_LOGIN_SESSION_MISMATCH");
    pub const AUTH_LOGIN_CODE_INVALID: Self = Self("AUTH_LOGIN_CODE_INVALID");
    pub const BINARY_NOT_FOUND: Self = Self("BINARY_NOT_FOUND");
    pub const RATE_LIMITED: Self = Self("RATE_LIMITED");
    pub const TIMEOUT: Self = Self("TIMEOUT");
    pub const UNAVAILABLE: Self = Self("UNAVAILABLE");
    pub const EXECUTOR_BUSY: Self = Self("EXECUTOR_BUSY");
    pub const STALE_RESOURCE: Self = Self("STALE_RESOURCE");
    pub const OUTCOME_UNKNOWN: Self = Self("OUTCOME_UNKNOWN");
    pub const INVALID_SETTINGS: Self = Self("INVALID_SETTINGS");
    pub const INVALID_ENDPOINT: Self = Self("INVALID_ENDPOINT");
    pub const API_PROVIDER_UNAVAILABLE: Self = Self("API_PROVIDER_UNAVAILABLE");
    pub const API_PROVIDER_CONFIGURATION_CHANGED: Self = Self("API_PROVIDER_CONFIGURATION_CHANGED");
    pub const API_PROVIDER_STORAGE_UNAVAILABLE: Self = Self("API_PROVIDER_STORAGE_UNAVAILABLE");
    pub const SESSION_NOT_FOUND: Self = Self("SESSION_NOT_FOUND");
    pub const SESSION_BUSY: Self = Self("SESSION_BUSY");
    pub const PERMISSION_DENIED: Self = Self("PERMISSION_DENIED");
    pub const TRANSCRIPT_UNAVAILABLE: Self = Self("TRANSCRIPT_UNAVAILABLE");
    pub const PROJECT_PATH_DESTINATION_REJECTED: Self = Self("PROJECT_PATH_DESTINATION_REJECTED");
    pub const SEARCH_DISABLED: Self = Self("SEARCH_DISABLED");
    pub const SEARCH_UNAVAILABLE: Self = Self("SEARCH_UNAVAILABLE");
    pub const SOURCE_REVISION_CHANGED: Self = Self("SOURCE_REVISION_CHANGED");
    pub const PROJECTION_HANDOFF_POST_BOUNDARY_EVENT: Self =
        Self("PROJECTION_HANDOFF_POST_BOUNDARY_EVENT");
    pub const OPERATION_UNSUPPORTED: Self = Self("OPERATION_UNSUPPORTED");
    pub const PROVIDER_FAILURE: Self = Self("PROVIDER_FAILURE");

    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

impl fmt::Display for AgentIntegrationErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

/// Whether `value` is one of `AGENT_INTEGRATION_ERROR_CODES`.
pub fn is_agent_integration_error_code(value: &JsonValue) -> Option<AgentIntegrationErrorCode> {
    let text = value.as_str()?;
    AGENT_INTEGRATION_ERROR_CODES
        .iter()
        .copied()
        .find(|code| code.as_str() == text)
}

/// An error an integration reports with a structured code.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentIntegrationError {
    pub code: AgentIntegrationErrorCode,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Opaque>,
}

impl AgentIntegrationError {
    pub fn new(
        code: AgentIntegrationErrorCode,
        message: impl Into<String>,
        retryable: bool,
        details: Option<JsonObject>,
    ) -> AgentIntegrationError {
        AgentIntegrationError {
            code,
            message: message.into(),
            retryable,
            details: details.map(|details| Opaque::from_value(JsonValue::Object(details))),
        }
    }
}

impl fmt::Display for AgentIntegrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AgentIntegrationError {}

/// Whether a call reached the integration, and whether its answer can be known.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentDeliveryOutcome {
    /// The call was not sent, or was lost with the connection before it was.
    NotDispatched,
    /// The integration refused the call.
    Rejected,
    /// The call may have run; its answer was lost.
    Unknown,
}

impl AgentDeliveryOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentDeliveryOutcome::NotDispatched => "not-dispatched",
            AgentDeliveryOutcome::Rejected => "rejected",
            AgentDeliveryOutcome::Unknown => "unknown",
        }
    }
}

impl fmt::Display for AgentDeliveryOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// An `AgentIntegrationError` for a call, which also says whether the call
/// was delivered. It is not retryable and carries no details. Where the
/// original takes an `AgentIntegrationError`, this converts through
/// `Deref`; `is_unsupported_single_query_thinking_mode` and every function
/// that takes `&AgentIntegrationError` accept it.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentCallError {
    pub outcome: AgentDeliveryOutcome,
    integration: AgentIntegrationError,
}

impl AgentCallError {
    /// Creates the error with the code the outcome implies: `OUTCOME_UNKNOWN`
    /// for an unknown outcome, `UNAVAILABLE` otherwise.
    pub fn new(outcome: AgentDeliveryOutcome, message: impl Into<String>) -> AgentCallError {
        let code = if outcome == AgentDeliveryOutcome::Unknown {
            AgentIntegrationErrorCode::OUTCOME_UNKNOWN
        } else {
            AgentIntegrationErrorCode::UNAVAILABLE
        };
        AgentCallError::with_code(outcome, message, code)
    }

    pub fn with_code(
        outcome: AgentDeliveryOutcome,
        message: impl Into<String>,
        code: AgentIntegrationErrorCode,
    ) -> AgentCallError {
        AgentCallError {
            outcome,
            integration: AgentIntegrationError::new(code, message, false, None),
        }
    }
}

impl Deref for AgentCallError {
    type Target = AgentIntegrationError;

    fn deref(&self) -> &AgentIntegrationError {
        &self.integration
    }
}

impl From<AgentCallError> for AgentIntegrationError {
    fn from(error: AgentCallError) -> AgentIntegrationError {
        error.integration
    }
}

impl fmt::Display for AgentCallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.integration, formatter)
    }
}

impl std::error::Error for AgentCallError {}

/// The details of the `OPERATION_UNSUPPORTED` error that refuses to run a
/// one-shot in a thinking mode.
pub fn agent_unsupported_single_query_thinking_mode() -> JsonObject {
    let mut details = JsonObject::new();
    details.insert(
        "operation".to_owned(),
        JsonValue::String("single-query".to_owned()),
    );
    details.insert(
        "setting".to_owned(),
        JsonValue::String("thinkingMode".to_owned()),
    );
    details
}

/// Whether `error` refuses a single query in a thinking mode.
pub fn is_unsupported_single_query_thinking_mode(error: &AgentIntegrationError) -> bool {
    error.code == AgentIntegrationErrorCode::OPERATION_UNSUPPORTED
        && error
            .details
            .as_ref()
            .and_then(|details| details.get("operation"))
            .and_then(JsonValue::as_str)
            == Some("single-query")
        && error
            .details
            .as_ref()
            .and_then(|details| details.get("setting"))
            .and_then(JsonValue::as_str)
            == Some("thinkingMode")
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_contract::json::stable_json_stringify;
    use serde_json::json;

    #[test]
    fn recognizes_registered_codes() {
        assert_eq!(AGENT_INTEGRATION_ERROR_CODES.len(), 26);
        assert_eq!(
            is_agent_integration_error_code(&json!("OPERATION_UNSUPPORTED")),
            Some(AgentIntegrationErrorCode::OPERATION_UNSUPPORTED)
        );
        assert_eq!(
            is_agent_integration_error_code(&json!("PROJECTION_HANDOFF_POST_BOUNDARY_EVENT")),
            Some(AgentIntegrationErrorCode::PROJECTION_HANDOFF_POST_BOUNDARY_EVENT)
        );
        for value in [
            json!("operation_unsupported"),
            json!("UNKNOWN"),
            JsonValue::Null,
            json!(1),
            json!([]),
        ] {
            assert_eq!(is_agent_integration_error_code(&value), None, "{value}");
        }
        // Every registered code reads back.
        for code in AGENT_INTEGRATION_ERROR_CODES {
            assert_eq!(
                is_agent_integration_error_code(&json!(code.as_str())),
                Some(*code)
            );
            assert_eq!(code.to_string(), code.as_str());
        }
    }

    #[test]
    fn an_integration_error_keeps_its_fields() {
        let error = AgentIntegrationError::new(
            AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
            "Transcript unavailable",
            true,
            None,
        );
        assert_eq!(
            error.code,
            AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE
        );
        assert_eq!(error.message, "Transcript unavailable");
        assert!(error.retryable);
        assert_eq!(error.details, None);
        assert_eq!(error.to_string(), "Transcript unavailable");
    }

    #[test]
    fn integration_error_details_serialize_js_numbers() {
        let fields =
            garcon_js::json::from_str(r#"{"n":1.0,"big":9007199254740993,"exp21":1e21,"zero":-0}"#)
                .unwrap();
        let error = AgentIntegrationError::new(
            AgentIntegrationErrorCode::INVALID_SETTINGS,
            "synthetic",
            false,
            Some(fields),
        );
        assert_eq!(
            serde_json::to_string(&error.details).unwrap(),
            r#"{"n":1,"big":9007199254740992,"exp21":1e+21,"zero":0}"#,
        );
    }

    #[test]
    fn a_call_error_is_an_integration_error_that_is_never_retryable() {
        let unavailable = AgentCallError::new(AgentDeliveryOutcome::NotDispatched, "Not sent");
        assert_eq!(unavailable.code, AgentIntegrationErrorCode::UNAVAILABLE);
        assert_eq!(unavailable.message, "Not sent");
        assert!(!unavailable.retryable);
        assert_eq!(unavailable.details, None);
        assert_eq!(unavailable.outcome, AgentDeliveryOutcome::NotDispatched);

        let unknown = AgentCallError::new(AgentDeliveryOutcome::Unknown, "Lost");
        assert_eq!(unknown.code, AgentIntegrationErrorCode::OUTCOME_UNKNOWN);

        let rejected = AgentCallError::new(AgentDeliveryOutcome::Rejected, "Refused");
        assert_eq!(rejected.code, AgentIntegrationErrorCode::UNAVAILABLE);

        let busy = AgentCallError::with_code(
            AgentDeliveryOutcome::NotDispatched,
            "Executor busy",
            AgentIntegrationErrorCode::EXECUTOR_BUSY,
        );
        assert_eq!(busy.code, AgentIntegrationErrorCode::EXECUTOR_BUSY);
        assert!(!busy.retryable);

        // It reads as an `AgentIntegrationError` wherever one is taken.
        let integration: &AgentIntegrationError = &busy;
        assert_eq!(integration.code, AgentIntegrationErrorCode::EXECUTOR_BUSY);
        let owned: AgentIntegrationError = busy.clone().into();
        assert_eq!(owned.code, AgentIntegrationErrorCode::EXECUTOR_BUSY);
        assert_eq!(busy.to_string(), "Executor busy");
    }

    #[test]
    fn outcomes_keep_their_names() {
        for (outcome, name) in [
            (AgentDeliveryOutcome::NotDispatched, "not-dispatched"),
            (AgentDeliveryOutcome::Rejected, "rejected"),
            (AgentDeliveryOutcome::Unknown, "unknown"),
        ] {
            assert_eq!(outcome.as_str(), name);
            assert_eq!(outcome.to_string(), name);
        }
    }

    #[test]
    fn names_the_error_that_refuses_a_thinking_single_query() {
        let thinking = agent_unsupported_single_query_thinking_mode();
        assert_eq!(
            stable_json_stringify(&JsonValue::Object(thinking.clone())),
            r#"{"operation":"single-query","setting":"thinkingMode"}"#
        );
        let mut other_details = JsonObject::new();
        other_details.insert(
            "operation".to_owned(),
            JsonValue::String("single-query".to_owned()),
        );
        other_details.insert("setting".to_owned(), JsonValue::String("effort".to_owned()));
        let mut object_details = JsonObject::new();
        object_details.insert("operation".to_owned(), json!({ "nested": true }));
        object_details.insert(
            "setting".to_owned(),
            JsonValue::String("thinkingMode".to_owned()),
        );
        for (error, expected) in [
            (
                AgentIntegrationError::new(
                    AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
                    "Unsupported",
                    false,
                    Some(thinking.clone()),
                ),
                true,
            ),
            // Another code with the same details is another error.
            (
                AgentIntegrationError::new(
                    AgentIntegrationErrorCode::INVALID_SETTINGS,
                    "Unsupported",
                    false,
                    Some(thinking.clone()),
                ),
                false,
            ),
            // No details, other details, or a non-text detail do not match.
            (
                AgentIntegrationError::new(
                    AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
                    "Unsupported",
                    false,
                    None,
                ),
                false,
            ),
            (
                AgentIntegrationError::new(
                    AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
                    "Unsupported",
                    false,
                    Some(other_details),
                ),
                false,
            ),
            (
                AgentIntegrationError::new(
                    AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
                    "Unsupported",
                    false,
                    Some(object_details),
                ),
                false,
            ),
        ] {
            assert_eq!(
                is_unsupported_single_query_thinking_mode(&error),
                expected,
                "{error:?}"
            );
        }
        // A call error passes as the integration error it extends.
        let call = AgentCallError::with_code(
            AgentDeliveryOutcome::Rejected,
            "Unsupported",
            AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
        );
        assert!(!is_unsupported_single_query_thinking_mode(&call));
    }
}
