//! Ports `server-agents/common/src/acp/errors.ts`.

use std::error::Error;
use std::fmt;

use garcon_base::errors::{ErrorInput, js_string};
use serde_json::Value;

use super::json_values::{is_number, is_truthy};

/// The error the agent answered a request with.
#[derive(Debug, Clone, PartialEq)]
pub struct AcpRpcError {
    /// The `message` of the agent's error; `Error(undefined)` leaves it empty.
    pub message: String,
    /// The `code` of the agent's error, absent where it sent none.
    pub code: Option<Value>,
    /// The `data` of the agent's error, absent where it sent none.
    pub data: Option<Value>,
}

impl AcpRpcError {
    /// `new AcpRpcError(message, code, data)` with the members the agent sent.
    pub fn new(message: Option<&Value>, code: Option<Value>, data: Option<Value>) -> Self {
        Self {
            message: message.map_or_else(String::new, |message| {
                js_string(ErrorInput::Json(message)).into_owned()
            }),
            code,
            data,
        }
    }

    /// Whether `code` is the number `expected`, as `===` compares it.
    pub fn has_code(&self, expected: f64) -> bool {
        self.code
            .as_ref()
            .is_some_and(|code| is_number(code, expected))
    }
}

impl fmt::Display for AcpRpcError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for AcpRpcError {}

fn data_message(data: Option<&Value>) -> &str {
    data.filter(|data| is_truthy(data))
        .and_then(|data| data.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

pub fn is_method_not_found_error(error: &(dyn Error + 'static)) -> bool {
    error
        .downcast_ref::<AcpRpcError>()
        .is_some_and(|error| error.has_code(-32601.0))
}

pub fn is_invalid_params_error(error: &(dyn Error + 'static)) -> bool {
    error
        .downcast_ref::<AcpRpcError>()
        .is_some_and(|error| error.has_code(-32602.0))
}

pub fn is_session_not_found_error(error: &(dyn Error + 'static)) -> bool {
    let Some(error) = error.downcast_ref::<AcpRpcError>() else {
        return false;
    };
    if error.has_code(-32601.0) {
        return true;
    }
    if !error.has_code(-32602.0) {
        return false;
    }
    let message = format!("{} {}", error.message, data_message(error.data.as_ref())).to_lowercase();
    message.contains("session") && message.contains("not found")
}

pub fn is_recoverable_load_failure(error: &(dyn Error + 'static)) -> bool {
    is_method_not_found_error(error) || is_session_not_found_error(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_base::errors::NamedError;
    use serde_json::json;

    #[test]
    fn an_rpc_error_keeps_the_fields_the_agent_sent() {
        // `Error(message)` on Bun 1.4.3: `undefined` leaves the message empty,
        // and every other value is read as its text.
        for (message, expected) in [
            (None, ""),
            (Some(json!(null)), "null"),
            (Some(json!(5)), "5"),
            (Some(json!({})), "[object Object]"),
            (Some(json!([])), ""),
            (Some(json!("")), ""),
            (Some(json!("Method not found")), "Method not found"),
        ] {
            let error = AcpRpcError::new(message.as_ref(), Some(json!(-32601.0)), None);
            assert_eq!(error.message, expected);
            assert_eq!(error.to_string(), expected);
            assert!(error.has_code(-32601.0));
        }
    }

    #[test]
    fn the_code_compares_as_a_javascript_number() {
        // `===` reads another spelling as the same number, and another type as
        // another value.
        assert!(AcpRpcError::new(None, Some(json!(-32602.0)), None).has_code(-32602.0));
        assert!(AcpRpcError::new(None, Some(json!(-0.0)), None).has_code(0.0));
        for code in [json!("-32602"), json!(null), json!(-32603.0), json!(0.0)] {
            assert!(!AcpRpcError::new(None, Some(code), None).has_code(-32602.0));
        }
    }

    #[test]
    fn only_an_rpc_error_answers_the_predicates() {
        // Another error of the same class name and code is still another error.
        let other: Box<dyn Error> = NamedError {
            name: "AcpRpcError".to_owned(),
            message: "Session not found".to_owned(),
            code: Some("-32602".to_owned()),
        }
        .into();
        assert!(!is_method_not_found_error(other.as_ref()));
        assert!(!is_invalid_params_error(other.as_ref()));
        assert!(!is_session_not_found_error(other.as_ref()));
        assert!(!is_recoverable_load_failure(other.as_ref()));
    }
}
