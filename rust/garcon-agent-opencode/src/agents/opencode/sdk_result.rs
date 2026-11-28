//! Ports `server-agents/opencode/src/agents/opencode/sdk-result.ts`.

use std::{fmt, ops::Deref};

use garcon_contract::chat_message_coercion::as_record;
use serde_json::{Map, Value};

use crate::js::{prop, strictly_equal, to_lowercase_includes, truthy};

/// The project directory a provider request is scoped to; absent for a chat
/// without one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpenCodeRequestScope {
    pub directory: Option<String>,
}

pub fn create_open_code_request_scope(project_path: Option<&str>) -> OpenCodeRequestScope {
    let directory = project_path
        .map(garcon_js::trim)
        .filter(|directory| !directory.is_empty())
        .map(str::to_owned);
    OpenCodeRequestScope { directory }
}

/// Adds the scope's directory after the request's own parameters, which is
/// where the SDK reads it into the query.
pub fn with_open_code_request_scope(
    mut parameters: Map<String, Value>,
    scope: &OpenCodeRequestScope,
) -> Map<String, Value> {
    if let Some(directory) = scope
        .directory
        .as_ref()
        .filter(|directory| !directory.is_empty())
    {
        parameters.insert("directory".to_owned(), Value::String(directory.clone()));
    }
    parameters
}

/// What one call through the OpenCode SDK returned. The SDK never rejects:
/// it answers `{ data, response }` or `{ error, response }`, and the original
/// reads both as an untyped object.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OpenCodeSdkResult(Value);

impl OpenCodeSdkResult {
    /// A response the server accepted, with `data` as its decoded body.
    pub fn success(data: Value, status: u16) -> Self {
        Self(Value::Object(
            [
                ("data".to_owned(), data),
                ("response".to_owned(), Value::Object(response(status))),
            ]
            .into_iter()
            .collect(),
        ))
    }

    /// A response the server refused, with the body the SDK decoded for
    /// `error`.
    pub fn failure(error: Value, status: u16) -> Self {
        Self(Value::Object(
            [
                ("error".to_owned(), error),
                ("response".to_owned(), Value::Object(response(status))),
            ]
            .into_iter()
            .collect(),
        ))
    }

    /// A request that threw before it had a response, such as an aborted or a
    /// refused connection.
    pub fn thrown(error: Value) -> Self {
        Self(Value::Object(
            [("error".to_owned(), error)].into_iter().collect(),
        ))
    }
}

fn response(status: u16) -> Map<String, Value> {
    [("status".to_owned(), Value::from(status))]
        .into_iter()
        .collect()
}

impl From<Value> for OpenCodeSdkResult {
    fn from(value: Value) -> Self {
        Self(value)
    }
}

impl Deref for OpenCodeSdkResult {
    type Target = Value;

    fn deref(&self) -> &Value {
        &self.0
    }
}

/// The error `throwOpenCodeResultError` raises for a result that carries one.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct OpenCodeSdkResultError {
    pub message: String,
    pub status: Option<f64>,
}

impl OpenCodeSdkResultError {
    pub fn new(message: impl Into<String>, status: Option<f64>) -> Self {
        Self {
            message: message.into(),
            status,
        }
    }
}

pub fn open_code_result_error_message(result: &Value, fallback: &str) -> String {
    let record = as_record(result);
    let error = as_record(prop(record, "error"));
    let data = as_record(prop(error, "data"));
    let data_message = trimmed(prop(data, "message"));
    let error_message = trimmed(prop(error, "message"));
    if !data_message.is_empty() {
        data_message
    } else if !error_message.is_empty() {
        error_message
    } else {
        fallback.to_owned()
    }
}

fn trimmed(value: &Value) -> String {
    value
        .as_str()
        .map(|value| garcon_js::trim(value).to_owned())
        .unwrap_or_default()
}

pub fn has_open_code_result_error(result: &Value) -> bool {
    truthy(prop(as_record(result), "error"))
}

pub fn is_open_code_not_found_result(result: &Value) -> bool {
    let record = as_record(result);
    let error = as_record(prop(record, "error"));
    if prop(error, "name").as_str() == Some("NotFoundError") {
        return true;
    }
    let response = as_record(prop(record, "response"));
    if !strictly_equal(prop(response, "status"), &Value::from(404u16)) {
        return false;
    }
    to_lowercase_includes(&open_code_result_error_message(result, ""), "not found")
}

/// Raises the `error` of a result that carries one.
pub fn throw_open_code_result_error(
    result: &Value,
    fallback: &str,
) -> Result<(), OpenCodeSdkResultError> {
    if !has_open_code_result_error(result) {
        return Ok(());
    }
    let status = as_record(prop(as_record(result), "response"))
        .get("status")
        .filter(|status| status.is_number())
        .and_then(garcon_js::json::as_number);
    Err(OpenCodeSdkResultError::new(
        open_code_result_error_message(result, fallback),
        status,
    ))
}

impl fmt::Display for OpenCodeSdkResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}
