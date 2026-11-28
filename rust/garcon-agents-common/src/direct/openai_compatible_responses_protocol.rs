//! Ports `server-agents/common/src/direct/openai-compatible-responses-protocol.ts`.

use std::error::Error;

use garcon_base::errors::{DiagnosticError, ErrorMetadata};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{json, trim};
use reqwest::Response;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::shared::json_response::read_json_response;
use crate::shared::provider_http::{content_type, read_sse, response_has_body, text_body};

use super::response_media_type::is_json_response;
use super::strip_think_blocks::strip_think_blocks;

pub const PREVIOUS_RESPONSE_NOT_FOUND: &str = "previous_response_not_found";

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponsesCompletion {
    pub text: String,
    pub response_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResponsesTerminal {
    Completed,
    Failed,
    Incomplete,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponsesStreamState {
    pub text: String,
    pub error_message: Option<String>,
    pub error_code: Option<String>,
    pub output_accepted: bool,
    pub response_id: Option<String>,
    pub terminal: Option<ResponsesTerminal>,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ResponsesRequestError {
    pub message: String,
    pub response_code: Option<String>,
    pub output_accepted: bool,
}

impl DiagnosticError for ResponsesRequestError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "ResponsesRequestError",
            code: None,
        }
    }
}

fn output_text_parts(data: &Value) -> impl Iterator<Item = &str> {
    data["output"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter(|part| part["type"].as_str() == Some("output_text"))
        .filter_map(|part| part["text"].as_str())
}

pub fn extract_responses_output_text(data: &Value) -> String {
    if let Some(text) = data["output_text"].as_str() {
        return trim(text).to_owned();
    }
    trim(&output_text_parts(data).collect::<String>()).to_owned()
}

fn has_responses_output_text(data: &Value) -> bool {
    data["output_text"].as_str().map_or_else(
        || output_text_parts(data).any(|part| !part.is_empty()),
        |text| !text.is_empty(),
    )
}

fn error_field<'a>(response: &'a Value, field: &str) -> Option<&'a str> {
    response["error"][field]
        .as_str()
        .or_else(|| response["status_details"]["error"][field].as_str())
}

fn incomplete_reason(fields: &Value) -> Option<&str> {
    fields["incomplete_details"]["reason"].as_str()
}

fn response_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|value| !trim(value).is_empty())
        .map(str::to_owned)
}

pub fn consume_responses_stream_event(state: &mut ResponsesStreamState, event: &Value) {
    match event["type"].as_str() {
        Some("response.output_text.delta") => {
            if let Some(delta) = event["delta"].as_str() {
                state.text.push_str(delta);
                state.output_accepted |= !delta.is_empty();
            }
        }
        Some("response.completed") => {
            state.terminal = Some(ResponsesTerminal::Completed);
            state.response_id = response_id(&event["response"]["id"]);
        }
        Some("error") => {
            state.error_message = Some(
                event["error"]["message"]
                    .as_str()
                    .unwrap_or("Responses stream returned an error.")
                    .to_owned(),
            );
            state.error_code = event["error"]["code"].as_str().map(str::to_owned);
        }
        Some(kind @ ("response.failed" | "response.incomplete")) => {
            let response = &event["response"];
            state.terminal = Some(if kind == "response.failed" {
                ResponsesTerminal::Failed
            } else {
                ResponsesTerminal::Incomplete
            });
            state.error_message = Some(
                error_field(response, "message")
                    .or_else(|| incomplete_reason(response))
                    .map_or_else(
                        || format!("Responses stream ended with {kind}."),
                        str::to_owned,
                    ),
            );
            state.error_code = error_field(response, "code").map(str::to_owned);
        }
        _ => {}
    }
}

pub async fn read_open_ai_responses_response(
    response: Response,
    label: &str,
) -> ExecutorResult<ResponsesCompletion> {
    let (text, id) = if is_json_response(content_type(&response).as_deref()) {
        let data = read_json_response(response, label).await?;
        let response_error = error_field(&data, "message");
        let status = data["status"].as_str();
        if matches!(status, Some("failed" | "incomplete"))
            || response_error.is_some_and(|error| !error.is_empty())
        {
            let detail = response_error
                .or_else(|| incomplete_reason(&data))
                .map_or_else(
                    || {
                        format!(
                            "Responses API returned status {}.",
                            status.unwrap_or("undefined")
                        )
                    },
                    str::to_owned,
                );
            return Err(ResponsesRequestError {
                message: format!("{label} response error: {detail}"),
                response_code: error_field(&data, "code").map(str::to_owned),
                output_accepted: has_responses_output_text(&data),
            }
            .into());
        }
        (
            extract_responses_output_text(&data),
            response_id(&data["id"]),
        )
    } else {
        if !response_has_body(response.status()) {
            return Err(format!("{label} response did not include a stream body.").into());
        }
        let mut state = ResponsesStreamState::default();
        read_sse(response, |data| {
            if let Ok(event) = json::parse(data) {
                consume_responses_stream_event(&mut state, &event);
            }
            Ok(())
        })
        .await?;
        if let Some(error) = state.error_message.filter(|error| !error.is_empty()) {
            return Err(ResponsesRequestError {
                message: format!("{label} stream error: {error}"),
                response_code: state.error_code,
                output_accepted: state.output_accepted,
            }
            .into());
        }
        if state.terminal != Some(ResponsesTerminal::Completed) {
            return Err(ResponsesRequestError {
                message: format!("{label} stream ended before response.completed."),
                response_code: None,
                output_accepted: state.output_accepted,
            }
            .into());
        }
        (state.text, state.response_id)
    };
    Ok(ResponsesCompletion {
        text: strip_think_blocks(&text),
        response_id: id,
    })
}

pub async fn throw_responses_http_error<T>(response: Response, label: &str) -> ExecutorResult<T> {
    let status = response.status().as_u16();
    let text = text_body(response).await?;
    let parsed = json::parse(&text).ok();
    let error = parsed.as_ref().map(|data| &data["error"]);
    let message = error
        .and_then(|error| error["message"].as_str())
        .unwrap_or(&text);
    let code = error
        .and_then(|error| error["code"].as_str())
        .map(str::to_owned);
    Err(ResponsesRequestError {
        message: format!("{label} API error {status}: {message}"),
        response_code: code,
        output_accepted: false,
    }
    .into())
}

pub fn is_unresolved_checkpoint(error: &(dyn Error + 'static)) -> bool {
    error
        .downcast_ref::<ResponsesRequestError>()
        .is_some_and(|error| {
            error.response_code.as_deref() == Some(PREVIOUS_RESPONSE_NOT_FOUND)
                && !error.output_accepted
        })
}
