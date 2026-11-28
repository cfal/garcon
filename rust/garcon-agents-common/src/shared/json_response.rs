//! Ports `server-agents/common/src/shared/json-response.ts`.

use std::borrow::Cow;

use garcon_base::errors::{ErrorInput, js_string};
use garcon_interface::resources::ExecutorResult;
use garcon_js::json;
use reqwest::Response;
use serde_json::Value;

use super::provider_http::text_body;

pub async fn read_json_response(response: Response, source: &str) -> ExecutorResult<Value> {
    let body = text_body(response).await?;
    json::parse(&body).map_err(|_| format!("{source} response is not valid JSON.").into())
}
pub(crate) fn truthy_message(value: &Value) -> Option<Cow<'_, str>> {
    let truthy = match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    };
    truthy.then(|| js_string(ErrorInput::Json(value)))
}
