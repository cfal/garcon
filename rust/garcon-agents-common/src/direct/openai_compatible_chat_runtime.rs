//! Ports `server-agents/common/src/direct/openai-compatible-chat-runtime.ts`.

use std::time::Duration;

use async_trait::async_trait;
use garcon_contract::agent_execution::AgentAttachment;
use garcon_contract::chat_modes::ThinkingMode;
use garcon_interface::resources::ExecutorResult;
use garcon_js::json;
use reqwest::Response;
use reqwest::header::{AUTHORIZATION, HeaderMap};
use serde::Serialize;
use serde_json::Value;

use crate::shared::attachments::{append_text_attachment_context, image_attachments};
use crate::shared::json_response::{read_json_response, truthy_message};
use crate::shared::provider_http::{
    ProviderHttpEndpoint, content_type, json_headers, post_json, read_sse, response_has_body,
    sensitive_header, text_body, until_done,
};

use super::direct_chat_runtime_base::{
    DirectChatProtocol, DirectStreamSession, DirectTurnCompletion,
};
use super::response_media_type::is_json_response;
use super::runtime_types::DirectMessageRole;
use super::single_query_options::{DirectSingleQueryOptions, direct_single_query_timeout};
use super::strip_think_blocks::strip_think_blocks;

const STREAM_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OpenAiCompatibleContentPart {
    Text { text: String },
    ImageUrl { image_url: OpenAiCompatibleImageUrl },
}

#[derive(Serialize)]
pub struct OpenAiCompatibleImageUrl {
    url: String,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum OpenAiCompatibleContent {
    Text(String),
    Parts(Vec<OpenAiCompatibleContentPart>),
}

#[derive(Serialize)]
pub struct OpenAiCompatibleMessage {
    role: DirectMessageRole,
    content: OpenAiCompatibleContent,
}

#[derive(Serialize)]
struct CompletionRequest<'a> {
    model: &'a str,
    messages: &'a [OpenAiCompatibleMessage],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<ThinkingMode>,
}

#[derive(Clone)]
pub struct OpenAiCompatibleChatProtocol(pub ProviderHttpEndpoint);

pub fn build_open_ai_compatible_user_content(
    text: &str,
    attachments: &[AgentAttachment],
) -> OpenAiCompatibleContent {
    let prompt =
        append_text_attachment_context(text, attachments.iter().map(Into::into)).into_owned();
    let images = image_attachments(attachments.iter().map(Into::into));
    if images.is_empty() {
        return OpenAiCompatibleContent::Text(prompt);
    }
    let mut parts = vec![OpenAiCompatibleContentPart::Text { text: prompt }];
    for image in images.into_iter().filter(|image| !image.data.is_empty()) {
        parts.push(OpenAiCompatibleContentPart::ImageUrl {
            image_url: OpenAiCompatibleImageUrl {
                url: image.data.into(),
            },
        });
    }
    OpenAiCompatibleContent::Parts(parts)
}

pub(crate) fn headers(credential: Option<&str>) -> ExecutorResult<HeaderMap> {
    let mut headers = json_headers();
    if let Some(credential) = credential.filter(|value| !value.is_empty()) {
        headers.insert(
            AUTHORIZATION,
            sensitive_header(&format!("Bearer {credential}"))?,
        );
    }
    Ok(headers)
}

fn append_delta_text(text: &mut String, delta: &Value) {
    if let Some(value) = delta.as_str() {
        text.push_str(value);
    } else if let Some(parts) = delta.as_array() {
        for part in parts {
            if let Some(value) = part.get("text").and_then(Value::as_str) {
                text.push_str(value);
            }
        }
    }
}

async fn read_open_ai_compatible_text_stream(
    response: Response,
    label: &str,
) -> ExecutorResult<String> {
    if !response_has_body(response.status()) {
        return Err(format!("{label} response did not include a stream body.").into());
    }
    let mut text = String::new();
    let mut error = None;
    let mut saw_done = false;
    read_sse(response, |data| {
        if data == "[DONE]" {
            saw_done = true;
            return Ok(());
        }
        if let Ok(value) = json::parse(data) {
            if let Some(message) = truthy_message(&value["error"]["message"]) {
                error = Some(message.into_owned());
            } else {
                append_delta_text(&mut text, &value["choices"][0]["delta"]["content"]);
            }
        }
        Ok(())
    })
    .await?;
    if let Some(error) = error {
        return Err(format!("{label} stream error: {error}").into());
    }
    if !saw_done {
        return Err(format!("{label} stream ended before [DONE]").into());
    }
    Ok(text)
}

async fn read_open_ai_compatible_response(
    response: Response,
    label: &str,
) -> ExecutorResult<String> {
    let text = if is_json_response(content_type(&response).as_deref()) {
        let value = read_json_response(response, label).await?;
        if let Some(error) = truthy_message(&value["error"]["message"]) {
            return Err(format!("{label} response error: {error}").into());
        }
        let mut text = String::new();
        append_delta_text(&mut text, &value["choices"][0]["message"]["content"]);
        text
    } else {
        read_open_ai_compatible_text_stream(response, label).await?
    };
    Ok(strip_think_blocks(&text))
}

impl OpenAiCompatibleChatProtocol {
    async fn request(
        &self,
        model: &str,
        messages: &[OpenAiCompatibleMessage],
        thinking_mode: ThinkingMode,
    ) -> ExecutorResult<String> {
        let endpoint = &self.0;
        let response = post_json(
            &format!("{}/chat/completions", endpoint.base_url),
            headers(endpoint.credential.as_deref())?,
            &CompletionRequest {
                model,
                messages,
                stream: true,
                reasoning_effort: (thinking_mode != ThinkingMode::None).then_some(thinking_mode),
            },
        )
        .await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            return Err(format!(
                "{} API error {status}: {}",
                endpoint.runtime_label,
                text_body(response).await?
            )
            .into());
        }
        read_open_ai_compatible_response(response, &endpoint.runtime_label).await
    }
}

pub async fn run_open_ai_compatible_single_query(
    protocol: &OpenAiCompatibleChatProtocol,
    prompt: String,
    options: DirectSingleQueryOptions,
) -> ExecutorResult<String> {
    let model = if options.model.is_empty() {
        &protocol.0.default_model
    } else {
        &options.model
    };
    let messages = [OpenAiCompatibleMessage {
        role: DirectMessageRole::User,
        content: OpenAiCompatibleContent::Text(prompt),
    }];
    until_done(
        &options.signal,
        direct_single_query_timeout(options.timeout_ms),
        protocol.request(model, &messages, options.thinking_mode),
    )
    .await
}

#[async_trait(?Send)]
impl DirectChatProtocol for OpenAiCompatibleChatProtocol {
    type Message = OpenAiCompatibleMessage;

    fn build_user_message(&self, command: &str, attachments: &[AgentAttachment]) -> Self::Message {
        OpenAiCompatibleMessage {
            role: DirectMessageRole::User,
            content: build_open_ai_compatible_user_content(command, attachments),
        }
    }

    fn build_assistant_message(&self, content: &str) -> Self::Message {
        OpenAiCompatibleMessage {
            role: DirectMessageRole::Assistant,
            content: OpenAiCompatibleContent::Text(content.into()),
        }
    }

    async fn stream_session(
        &self,
        session: DirectStreamSession<Self::Message>,
    ) -> ExecutorResult<DirectTurnCompletion> {
        let content = until_done(
            &session.signal,
            STREAM_TIMEOUT,
            self.request(&session.model, &session.messages, session.thinking_mode),
        )
        .await?;
        Ok(DirectTurnCompletion {
            content,
            checkpoint: None,
        })
    }
}
