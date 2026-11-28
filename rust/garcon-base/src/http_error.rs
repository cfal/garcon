//! Shared HTTP error status, body, and redaction policy.

use bytes::Bytes;
use garcon_contract::http_error::HttpErrorResponse;
use garcon_interface::errors::{
    AgentDeliveryOutcome, AgentIntegrationError, AgentIntegrationErrorCode,
};
use http::{HeaderValue, Response, StatusCode, header};
use serde::Serialize;

use crate::domain_error::{as_domain_error, transcript_unavailable_message};
use crate::errors::{ErrorInput, js_string};
use crate::executor_disconnect::as_agent_call_error;
use crate::log::{Logger, ScopedLogger, create_logger};

pub const DEFAULT_VALIDATION_ERROR_CODE: &str = "VALIDATION_FAILED";
pub const DEFAULT_INTERNAL_ERROR_CODE: &str = "INTERNAL_ERROR";
const DEFAULT_INTERNAL_ERROR_MESSAGE: &str = "Internal server error";

thread_local! {
    static LOGGER: ScopedLogger = create_logger("http:error");
}

pub fn default_error_code_for_status(status: f64) -> &'static str {
    if default_retryable_for_status(status) {
        DEFAULT_INTERNAL_ERROR_CODE
    } else {
        DEFAULT_VALIDATION_ERROR_CODE
    }
}

pub fn default_retryable_for_status(status: f64) -> bool {
    status >= 500.0
}

#[derive(Debug, thiserror::Error)]
pub enum JsonErrorResponseError {
    #[error("The status provided ({0}) must be 101 or in the range of [200, 599]")]
    InvalidStatus(i64),
    #[error(transparent)]
    Serialize(#[from] serde_json::Error),
}

pub fn json_error(
    error: impl Into<String>,
    status: f64,
    error_code: Option<&str>,
    retryable: Option<bool>,
    details: Option<String>,
) -> Result<Response<Bytes>, JsonErrorResponseError> {
    let payload = HttpErrorResponse::new(
        error,
        error_code.unwrap_or_else(|| default_error_code_for_status(status)),
        retryable.unwrap_or_else(|| default_retryable_for_status(status)),
        details,
    );
    let status = status.trunc();
    if status != 101.0 && !(200.0..=599.0).contains(&status) {
        let status =
            if !(-9_223_372_036_854_775_808.0..9_223_372_036_854_775_808.0).contains(&status) {
                i64::MIN
            } else {
                status as i64
            };
        return Err(JsonErrorResponseError::InvalidStatus(status));
    }
    // INFALLIBLE: the checked statuses are in http's valid range.
    let status = StatusCode::from_u16(status as u16).expect("checked response status");
    Ok(json_response(status, &payload)?)
}

pub(crate) fn json_response(
    status: StatusCode,
    payload: &impl Serialize,
) -> Result<Response<Bytes>, serde_json::Error> {
    let mut response = Response::new(Bytes::from(serde_json::to_vec(payload)?));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json;charset=utf-8"),
    );
    Ok(response)
}

pub fn json_error_from_unknown(
    error: ErrorInput<'_>,
    status: Option<f64>,
    error_code: Option<&str>,
    retryable: Option<bool>,
) -> Result<Response<Bytes>, JsonErrorResponseError> {
    if let Some(error) = error.as_error() {
        if let Some(error) = as_agent_call_error(error) {
            let (status, retryable) = match (error.outcome, error.code) {
                (AgentDeliveryOutcome::NotDispatched, AgentIntegrationErrorCode::EXECUTOR_BUSY) => {
                    (429.0, true)
                }
                (_, AgentIntegrationErrorCode::OPERATION_UNSUPPORTED) => (501.0, false),
                _ => (503.0, false),
            };
            return json_error(
                &error.message,
                status,
                Some(error.code.as_str()),
                Some(retryable),
                None,
            );
        }
        if let Some(error) = error.downcast_ref::<AgentIntegrationError>() {
            let policy = match error.code {
                AgentIntegrationErrorCode::BINARY_NOT_FOUND => {
                    Some((503.0, false, error.message.as_str()))
                }
                AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE => Some((
                    503.0,
                    error.retryable,
                    transcript_unavailable_message(error.retryable),
                )),
                AgentIntegrationErrorCode::INVALID_SETTINGS
                | AgentIntegrationErrorCode::INVALID_ENDPOINT
                | AgentIntegrationErrorCode::OPERATION_UNSUPPORTED => {
                    Some((422.0, false, error.message.as_str()))
                }
                _ => None,
            };
            if let Some((status, retryable, message)) = policy {
                return json_error(
                    message,
                    status,
                    Some(error.code.as_str()),
                    Some(retryable),
                    None,
                );
            }
        }
        if let Some(error) = as_domain_error(error) {
            return json_error(
                &error.message,
                f64::from(error.status),
                Some(error.code.as_str()),
                Some(error.retryable),
                None,
            );
        }
    }
    let status = status.unwrap_or(500.0);
    let message = if status >= 500.0 {
        LOGGER.with(|logger| logger.error(&format!("Unhandled route error: {}", js_string(error))));
        DEFAULT_INTERNAL_ERROR_MESSAGE.into()
    } else {
        js_string(error)
    };
    json_error(message, status, error_code, retryable, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain_error::DomainError;
    use garcon_contract::error_codes::ErrorCode;
    use garcon_js::json::from_slice;
    use serde_json::{Value, json};

    #[test]
    fn emits_the_shared_error_envelope() {
        let response = json_error(
            "Rate limited",
            429.0,
            Some("RATE_LIMITED"),
            Some(true),
            Some("Retry after the current window.".into()),
        )
        .unwrap();
        assert_eq!(response.status(), 429);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/json;charset=utf-8"
        );
        assert_eq!(
            from_slice::<Value>(response.body()).unwrap(),
            json!({
                "success":false, "error":"Rate limited", "errorCode":"RATE_LIMITED", "retryable":true,
                "details":"Retry after the current window.",
            })
        );
    }

    #[test]
    fn keeps_typed_errors_and_does_not_expose_untyped_internal_details() {
        let untyped = std::io::Error::other("/private/fixture failed");
        let response =
            json_error_from_unknown(ErrorInput::Error(&untyped), None, None, None).unwrap();
        assert_eq!(response.status(), 500);
        assert_eq!(
            from_slice::<Value>(response.body()).unwrap()["error"],
            "Internal server error"
        );
        let domain = DomainError::new(ErrorCode::INTERNAL_ERROR, "Operation failed.", 500, false);
        let response =
            json_error_from_unknown(ErrorInput::Error(&domain), None, None, None).unwrap();
        assert_eq!(response.status(), 500);
        assert_eq!(
            from_slice::<Value>(response.body()).unwrap(),
            json!({
                "success":false, "error":"Operation failed.", "errorCode":"INTERNAL_ERROR", "retryable":false,
            })
        );
        for code in [
            AgentIntegrationErrorCode::INVALID_SETTINGS,
            AgentIntegrationErrorCode::INVALID_ENDPOINT,
            AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
        ] {
            let error = AgentIntegrationError::new(code, "Invalid submitted source", false, None);
            let response =
                json_error_from_unknown(ErrorInput::Error(&error), None, None, None).unwrap();
            assert_eq!(response.status(), 422);
            assert_eq!(
                from_slice::<Value>(response.body()).unwrap(),
                json!({
                    "success":false, "error":"Invalid submitted source", "errorCode":code.as_str(), "retryable":false,
                })
            );
        }
    }
}
