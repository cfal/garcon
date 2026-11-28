//! Ports `server-agents/common/src/direct/openai-compatible-responses-runtime.ts`.

use std::time::Duration;

use async_trait::async_trait;
use garcon_contract::agent_execution::AgentAttachment;
use garcon_contract::chat_modes::ThinkingMode;
use garcon_interface::resources::ExecutorResult;
use serde::Serialize;

use crate::shared::attachments::{append_text_attachment_context, image_attachments};
use crate::shared::provider_http::{ProviderHttpEndpoint, post_json, until_done};

use super::direct_chat_runtime_base::{
    DirectChatProtocol, DirectStreamSession, DirectTurnCompletion,
};
use super::openai_compatible_chat_runtime::headers;
use super::openai_compatible_responses_protocol::{
    ResponsesCompletion, is_unresolved_checkpoint, read_open_ai_responses_response,
    throw_responses_http_error,
};
use super::runtime_types::DirectMessageRole;
use super::session_store::DirectResponsesCheckpointV1;
use super::single_query_options::{DirectSingleQueryOptions, direct_single_query_timeout};

const STREAM_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponsesInputPart {
    InputText {
        text: String,
    },
    InputImage {
        image_url: String,
        detail: &'static str,
    },
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum ResponsesInputContent {
    Text(String),
    Parts(Vec<ResponsesInputPart>),
}

#[derive(Serialize)]
pub struct ResponsesInputMessage {
    role: DirectMessageRole,
    content: ResponsesInputContent,
}

#[derive(Serialize)]
struct Reasoning {
    effort: ThinkingMode,
}

#[derive(Serialize)]
struct ResponsesRequest<'a> {
    model: &'a str,
    input: &'a [ResponsesInputMessage],
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_response_id: Option<Option<&'a str>>,
    stream: bool,
    store: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<Reasoning>,
}

#[derive(Clone)]
pub struct OpenAiCompatibleResponsesProtocol {
    pub endpoint: ProviderHttpEndpoint,
    pub endpoint_id: String,
    pub endpoint_fingerprint: String,
}

pub fn build_open_ai_responses_user_content(
    text: &str,
    attachments: &[AgentAttachment],
) -> ResponsesInputContent {
    let prompt =
        append_text_attachment_context(text, attachments.iter().map(Into::into)).into_owned();
    let images = image_attachments(attachments.iter().map(Into::into));
    if images.is_empty() {
        return ResponsesInputContent::Text(prompt);
    }
    let mut parts = vec![ResponsesInputPart::InputText { text: prompt }];
    for image in images.into_iter().filter(|image| !image.data.is_empty()) {
        parts.push(ResponsesInputPart::InputImage {
            image_url: image.data.into(),
            detail: "auto",
        });
    }
    ResponsesInputContent::Parts(parts)
}

pub fn extract_open_ai_responses_text_content(content: &ResponsesInputContent) -> String {
    match content {
        ResponsesInputContent::Text(text) => text.clone(),
        ResponsesInputContent::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                ResponsesInputPart::InputText { text } => Some(text.as_str()),
                ResponsesInputPart::InputImage { .. } => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

impl OpenAiCompatibleResponsesProtocol {
    async fn request(&self, request: &ResponsesRequest<'_>) -> ExecutorResult<ResponsesCompletion> {
        let endpoint = &self.endpoint;
        let response = post_json(
            &format!("{}/responses", endpoint.base_url),
            headers(endpoint.credential.as_deref())?,
            request,
        )
        .await?;
        if !response.status().is_success() {
            return throw_responses_http_error(response, &endpoint.runtime_label).await;
        }
        read_open_ai_responses_response(response, &endpoint.runtime_label).await
    }

    async fn turn(
        &self,
        session: &DirectStreamSession<ResponsesInputMessage>,
    ) -> ExecutorResult<DirectTurnCompletion> {
        let previous = session.previous_checkpoint.as_ref().filter(|checkpoint| {
            checkpoint.endpoint_id == self.endpoint_id
                && checkpoint.endpoint_fingerprint == self.endpoint_fingerprint
                && checkpoint.model == session.model
        });
        let last = session
            .messages
            .last()
            .filter(|last| last.role == DirectMessageRole::User)
            .ok_or_else(|| {
                format!(
                    "{} session is missing its current user input.",
                    self.endpoint.runtime_label
                )
            })?;
        let request = ResponsesRequest {
            model: &session.model,
            input: if previous.is_some() {
                std::slice::from_ref(last)
            } else {
                &session.messages
            },
            previous_response_id: Some(previous.map(|checkpoint| checkpoint.response_id.as_str())),
            stream: true,
            store: true,
            reasoning: reasoning(session.thinking_mode),
        };
        let completion = match self.request(&request).await {
            Err(error) if previous.is_some() && is_unresolved_checkpoint(error.as_ref()) => {
                self.request(&ResponsesRequest {
                    input: &session.messages,
                    previous_response_id: Some(None),
                    ..request
                })
                .await?
            }
            result => result?,
        };
        let checkpoint = completion
            .response_id
            .map(|response_id| DirectResponsesCheckpointV1 {
                response_id,
                endpoint_id: self.endpoint_id.clone(),
                endpoint_fingerprint: self.endpoint_fingerprint.clone(),
                model: session.model.clone(),
            });
        Ok(DirectTurnCompletion {
            content: completion.text,
            checkpoint,
        })
    }
}

fn reasoning(effort: ThinkingMode) -> Option<Reasoning> {
    (effort != ThinkingMode::None).then_some(Reasoning { effort })
}

pub async fn run_open_ai_responses_single_query(
    protocol: &OpenAiCompatibleResponsesProtocol,
    prompt: String,
    options: DirectSingleQueryOptions,
) -> ExecutorResult<String> {
    let model = if options.model.is_empty() {
        &protocol.endpoint.default_model
    } else {
        &options.model
    };
    let input = [ResponsesInputMessage {
        role: DirectMessageRole::User,
        content: ResponsesInputContent::Text(prompt),
    }];
    let request = ResponsesRequest {
        model,
        input: &input,
        previous_response_id: None,
        stream: true,
        store: false,
        reasoning: reasoning(options.thinking_mode),
    };
    Ok(until_done(
        &options.signal,
        direct_single_query_timeout(options.timeout_ms),
        protocol.request(&request),
    )
    .await?
    .text)
}

#[async_trait(?Send)]
impl DirectChatProtocol for OpenAiCompatibleResponsesProtocol {
    type Message = ResponsesInputMessage;

    fn build_user_message(&self, command: &str, attachments: &[AgentAttachment]) -> Self::Message {
        ResponsesInputMessage {
            role: DirectMessageRole::User,
            content: build_open_ai_responses_user_content(command, attachments),
        }
    }

    fn build_assistant_message(&self, content: &str) -> Self::Message {
        ResponsesInputMessage {
            role: DirectMessageRole::Assistant,
            content: ResponsesInputContent::Text(content.into()),
        }
    }

    async fn stream_session(
        &self,
        session: DirectStreamSession<Self::Message>,
    ) -> ExecutorResult<DirectTurnCompletion> {
        until_done(&session.signal, STREAM_TIMEOUT, self.turn(&session)).await
    }
}
