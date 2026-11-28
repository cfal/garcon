//! Shared HTTP error payload.

use serde::Serialize;

/// Standard HTTP error envelope shared by routes and API clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpErrorResponse {
    success: bool,
    pub error: String,
    pub error_code: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl HttpErrorResponse {
    pub fn new(
        error: impl Into<String>,
        error_code: impl Into<String>,
        retryable: bool,
        details: Option<String>,
    ) -> Self {
        Self {
            success: false,
            error: error.into(),
            error_code: error_code.into(),
            retryable,
            details,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_error_envelope_in_wire_order() {
        let error = HttpErrorResponse::new("Invalid input", "VALIDATION_FAILED", false, None);
        assert_eq!(
            serde_json::to_string(&error).unwrap(),
            r#"{"success":false,"error":"Invalid input","errorCode":"VALIDATION_FAILED","retryable":false}"#
        );
        let error = HttpErrorResponse::new("Busy", "EXECUTOR_BUSY", true, Some("Try later".into()));
        assert_eq!(
            serde_json::to_string(&error).unwrap(),
            r#"{"success":false,"error":"Busy","errorCode":"EXECUTOR_BUSY","retryable":true,"details":"Try later"}"#
        );
    }
}
