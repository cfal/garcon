//! Extraction of messages and diagnostic codes from typed or structural errors.

use std::borrow::Cow;
use std::error::Error;

use garcon_interface::errors::{AgentCallError, AgentIntegrationError};
use garcon_js::{json::as_number, number_to_string};
use serde_json::Value;

use crate::{domain_error::as_domain_error, executor_disconnect::ExecutorSessionLostError};

#[derive(Clone, Copy)]
pub enum ErrorInput<'a> {
    Error(&'a (dyn Error + 'static)),
    Json(&'a Value),
    Undefined,
}

/// A foreign error with an explicit name and optional structured code.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct NamedError {
    pub name: String,
    pub message: String,
    pub code: Option<String>,
}

pub fn error_message<'a>(error: ErrorInput<'a>, fallback: Option<&'a str>) -> Cow<'a, str> {
    match error {
        ErrorInput::Error(error) => Cow::Owned(error.to_string()),
        ErrorInput::Json(value) => value
            .get("message")
            .and_then(Value::as_str)
            .or(fallback)
            .map(Cow::Borrowed)
            .unwrap_or_else(|| js_string(error)),
        ErrorInput::Undefined => Cow::Borrowed(fallback.unwrap_or("undefined")),
    }
}

pub fn has_node_error_code(error: ErrorInput<'_>, code: &str) -> bool {
    structured_error_code(error) == Some(code)
}

pub fn diagnostic_error_code(error: ErrorInput<'_>) -> &str {
    if let Some(code) = structured_error_code(error) {
        return code;
    }
    match error {
        ErrorInput::Error(error) => error
            .downcast_ref::<NamedError>()
            .map_or("Error", |error| error.name.as_str()),
        _ => "UNKNOWN",
    }
}

fn structured_error_code(error: ErrorInput<'_>) -> Option<&str> {
    match error {
        ErrorInput::Json(value) => value.get("code").and_then(Value::as_str),
        ErrorInput::Error(error) => {
            if let Some(error) = error.downcast_ref::<NamedError>() {
                return error.code.as_deref();
            }
            if let Some(error) = as_agent_call_error(error) {
                return Some(error.code.as_str());
            }
            if let Some(error) = error.downcast_ref::<AgentIntegrationError>() {
                return Some(error.code.as_str());
            }
            as_domain_error(error).map(|error| error.code.as_str())
        }
        ErrorInput::Undefined => None,
    }
}

pub(crate) fn as_agent_call_error<'a>(
    error: &'a (dyn Error + 'static),
) -> Option<&'a AgentCallError> {
    error.downcast_ref::<AgentCallError>().or_else(|| {
        error
            .downcast_ref::<ExecutorSessionLostError>()
            .map(|error| &**error)
    })
}

pub(crate) fn js_string(error: ErrorInput<'_>) -> Cow<'_, str> {
    match error {
        ErrorInput::Error(error) => Cow::Owned(error.to_string()),
        ErrorInput::Undefined => Cow::Borrowed("undefined"),
        ErrorInput::Json(Value::Null) => Cow::Borrowed("null"),
        ErrorInput::Json(Value::Bool(value)) => {
            Cow::Borrowed(if *value { "true" } else { "false" })
        }
        ErrorInput::Json(Value::String(value)) => Cow::Borrowed(value),
        ErrorInput::Json(value @ Value::Number(_)) => {
            // INFALLIBLE: every JSON number held by Value has a double representation.
            Cow::Owned(number_to_string(as_number(value).expect("JSON number")))
        }
        ErrorInput::Json(Value::Object(_)) => Cow::Borrowed("[object Object]"),
        ErrorInput::Json(Value::Array(values)) => Cow::Owned(
            values
                .iter()
                .map(|value| {
                    if value.is_null() {
                        Cow::Borrowed("")
                    } else {
                        js_string(ErrorInput::Json(value))
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_native_and_structural_messages_and_only_then_falls_back() {
        let native = std::io::Error::other("native failure");
        assert_eq!(
            error_message(ErrorInput::Error(&native), Some("unused")),
            "native failure"
        );
        let value = json!({"message":"structured failure"});
        assert_eq!(
            error_message(ErrorInput::Json(&value), None),
            "structured failure"
        );
        let code_only = json!({"code":"FAILED"});
        assert_eq!(
            error_message(ErrorInput::Json(&code_only), Some("Operation failed.")),
            "Operation failed."
        );
        assert_eq!(
            error_message(ErrorInput::Json(&code_only), None),
            "[object Object]"
        );
    }

    #[test]
    fn uses_string_codes_and_falls_back_to_the_error_kind() {
        let value = json!({"code":"FAILED"});
        assert!(has_node_error_code(ErrorInput::Json(&value), "FAILED"));
        assert_eq!(diagnostic_error_code(ErrorInput::Json(&value)), "FAILED");
        let value = json!({"code":35});
        assert!(!has_node_error_code(ErrorInput::Json(&value), "35"));
        assert_eq!(diagnostic_error_code(ErrorInput::Json(&value)), "UNKNOWN");
        assert_eq!(
            diagnostic_error_code(ErrorInput::Error(&std::io::Error::other("failed"))),
            "Error"
        );
    }
}
