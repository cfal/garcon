//! Ports `server-agents/common/src/direct/anthropic-compatible-chat-runtime.ts`.

use std::time::Duration;

use async_trait::async_trait;
use garcon_contract::agent_execution::AgentAttachment;
use garcon_contract::chat_modes::ThinkingMode;
use garcon_interface::resources::ExecutorResult;
use garcon_js::json;
use reqwest::Response;
use reqwest::header::{HeaderMap, HeaderValue};
use serde::Serialize;

use crate::shared::attachments::{
    AttachmentDocumentBlock, append_text_attachment_context, attachment_document_block,
    document_attachments, image_attachments, parse_attachment_data_url,
};
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
const DEFAULT_MAX_TOKENS: u64 = 4096;
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Serialize)]
#[serde(tag = "type", rename = "base64")]
pub struct AnthropicImageSource {
    media_type: String,
    data: String,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AnthropicContentBlock {
    Text {
        text: String,
    },
    Image {
        source: AnthropicImageSource,
    },
    #[serde(untagged)]
    Document(AttachmentDocumentBlock),
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum AnthropicContent {
    Text(String),
    Blocks(Vec<AnthropicContentBlock>),
}

#[derive(Serialize)]
pub struct AnthropicConversationMessage {
    role: DirectMessageRole,
    content: AnthropicContent,
}

#[derive(Serialize)]
struct OutputConfig {
    effort: ThinkingMode,
}

#[derive(Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u64,
    messages: &'a [AnthropicConversationMessage],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_config: Option<OutputConfig>,
}

#[derive(Clone)]
pub struct AnthropicCompatibleChatProtocol {
    pub endpoint: ProviderHttpEndpoint,
    pub max_tokens: Option<u64>,
}

pub fn anthropic_messages_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let suffix = if base.ends_with("/v1") {
        "/messages"
    } else {
        "/v1/messages"
    };
    format!("{base}{suffix}")
}

pub fn build_anthropic_compatible_headers(credential: Option<&str>) -> ExecutorResult<HeaderMap> {
    let mut headers = json_headers();
    headers.insert(
        "anthropic-version",
        HeaderValue::from_static(ANTHROPIC_VERSION),
    );
    if let Some(credential) = credential.filter(|value| !value.is_empty()) {
        headers.insert("x-api-key", sensitive_header(credential)?);
    }
    Ok(headers)
}

pub fn build_anthropic_compatible_user_content(
    text: &str,
    attachments: &[AgentAttachment],
) -> AnthropicContent {
    let prompt =
        append_text_attachment_context(text, attachments.iter().map(Into::into)).into_owned();
    let images = image_attachments(attachments.iter().map(Into::into));
    let documents = document_attachments(attachments.iter().map(Into::into));
    if images.is_empty() && documents.is_empty() {
        return AnthropicContent::Text(prompt);
    }
    let mut blocks = images
        .into_iter()
        .filter_map(|image| {
            let parts = parse_attachment_data_url(Some(image.data))?;
            Some(AnthropicContentBlock::Image {
                source: AnthropicImageSource {
                    media_type: parts.mime_type,
                    data: parts.base64.to_owned(),
                },
            })
        })
        .collect::<Vec<_>>();
    blocks.extend(
        documents
            .into_iter()
            .filter_map(attachment_document_block)
            .map(AnthropicContentBlock::Document),
    );
    blocks.push(AnthropicContentBlock::Text { text: prompt });
    AnthropicContent::Blocks(blocks)
}

#[derive(Default)]
struct AnthropicStreamState {
    text: String,
    error_message: Option<String>,
    saw_message_stop: bool,
}

fn consume_anthropic_event(state: &mut AnthropicStreamState, data: &str) {
    let Ok(parsed) = json::parse(data) else {
        return;
    };
    match parsed["type"].as_str() {
        Some("message_stop") => state.saw_message_stop = true,
        Some("error") => {
            if let Some(error) = truthy_message(&parsed["error"]["message"]) {
                state.error_message = Some(error.into_owned());
            }
        }
        Some("content_block_delta") if parsed["delta"]["type"].as_str() == Some("text_delta") => {
            if let Some(text) = parsed["delta"]["text"].as_str() {
                state.text.push_str(text);
            }
        }
        _ => {}
    }
}

async fn read_anthropic_compatible_response(
    response: Response,
    label: &str,
) -> ExecutorResult<String> {
    let text = if is_json_response(content_type(&response).as_deref()) {
        let data = read_json_response(response, label).await?;
        data["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|part| part["type"].as_str() == Some("text"))
            .filter_map(|part| part["text"].as_str())
            .collect()
    } else {
        if !response_has_body(response.status()) {
            return Err(format!("{label} response did not include a stream body.").into());
        }
        let mut state = AnthropicStreamState::default();
        read_sse(response, |data| {
            consume_anthropic_event(&mut state, data);
            Ok(())
        })
        .await?;
        if let Some(error) = state.error_message {
            return Err(format!("{label} stream error: {error}").into());
        }
        if !state.saw_message_stop {
            return Err(format!("{label} stream ended before message_stop.").into());
        }
        state.text
    };
    Ok(strip_think_blocks(&text))
}

impl AnthropicCompatibleChatProtocol {
    async fn request(
        &self,
        model: &str,
        messages: &[AnthropicConversationMessage],
        thinking_mode: ThinkingMode,
    ) -> ExecutorResult<String> {
        let endpoint = &self.endpoint;
        let response = post_json(
            &anthropic_messages_url(&endpoint.base_url),
            build_anthropic_compatible_headers(endpoint.credential.as_deref())?,
            &AnthropicRequest {
                model,
                messages,
                stream: true,
                max_tokens: self.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
                output_config: (thinking_mode != ThinkingMode::None).then_some(OutputConfig {
                    effort: thinking_mode,
                }),
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
        read_anthropic_compatible_response(response, &endpoint.runtime_label).await
    }
}

pub async fn run_anthropic_compatible_single_query(
    protocol: &AnthropicCompatibleChatProtocol,
    prompt: String,
    options: DirectSingleQueryOptions,
) -> ExecutorResult<String> {
    let model = if options.model.is_empty() {
        &protocol.endpoint.default_model
    } else {
        &options.model
    };
    let messages = [AnthropicConversationMessage {
        role: DirectMessageRole::User,
        content: AnthropicContent::Text(prompt),
    }];
    until_done(
        &options.signal,
        direct_single_query_timeout(options.timeout_ms),
        protocol.request(model, &messages, options.thinking_mode),
    )
    .await
}

#[async_trait(?Send)]
impl DirectChatProtocol for AnthropicCompatibleChatProtocol {
    type Message = AnthropicConversationMessage;

    fn build_user_message(&self, command: &str, attachments: &[AgentAttachment]) -> Self::Message {
        AnthropicConversationMessage {
            role: DirectMessageRole::User,
            content: build_anthropic_compatible_user_content(command, attachments),
        }
    }

    fn build_assistant_message(&self, content: &str) -> Self::Message {
        AnthropicConversationMessage {
            role: DirectMessageRole::Assistant,
            content: AnthropicContent::Text(content.into()),
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
