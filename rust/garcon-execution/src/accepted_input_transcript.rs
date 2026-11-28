//! The queued adapter validates and commits synchronously under the drainer's
//! selection/admission lock. It must not call direct admission or async raw append.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_base::errors::{DiagnosticError, ErrorMetadata};
use garcon_contract::{
    chat_message_coercion::{ChatImage, ChatMessageMetadata},
    chat_types::UserMessage,
    ws_requests::AgentCommandImage,
};
use garcon_js::clock::{Clock, InvalidTimeValue, to_iso_string};

use crate::types::{ExecutionOperationResult, UserInputAdmissionOptions};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcceptedInputTranscriptResult {
    pub inserted: bool,
}

pub struct IdentifiedUserInput<'a> {
    pub client_request_id: &'a str,
    pub options: &'a UserInputAdmissionOptions,
}

#[async_trait(?Send)]
pub trait AcceptedInputTranscriptPort {
    fn has_matching_input(
        &self,
        chat_id: &str,
        message: &UserMessage,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool>;
    async fn admit_input(
        &self,
        chat_id: &str,
        message: UserMessage,
        options: IdentifiedUserInput<'_>,
    ) -> ExecutionOperationResult<AcceptedInputTranscriptResult>;
    fn admit_queued_input(
        &self,
        chat_id: &str,
        message: UserMessage,
        options: IdentifiedUserInput<'_>,
    ) -> ExecutionOperationResult<AcceptedInputTranscriptResult>;
    fn discard_prepared_input(
        &self,
        chat_id: &str,
        client_message_id: Option<&str>,
    ) -> ExecutionOperationResult<()>;
}

#[derive(Debug, thiserror::Error)]
#[error("Accepted input is missing a client request ID")]
pub struct MissingAcceptedInputRequestId;

impl DiagnosticError for MissingAcceptedInputRequestId {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "TypeError",
            code: None,
        }
    }
}

pub struct AcceptedInputTranscript {
    transcript: Rc<dyn AcceptedInputTranscriptPort>,
    clock: Rc<dyn Clock>,
}

impl AcceptedInputTranscript {
    pub fn new(transcript: Rc<dyn AcceptedInputTranscriptPort>, clock: Rc<dyn Clock>) -> Self {
        Self { transcript, clock }
    }

    pub fn has_matching(
        &self,
        chat_id: &str,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool> {
        if is_empty_input(content, options) {
            return Ok(false);
        }
        self.transcript
            .has_matching_input(chat_id, &self.input_message(content, options)?, options)
    }

    pub async fn register(
        &self,
        chat_id: &str,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool> {
        if is_empty_input(content, options) {
            return Ok(true);
        }
        let identified = identified(options)?;
        let message = self.input_message(content, options)?;
        Ok(self
            .transcript
            .admit_input(chat_id, message, identified)
            .await?
            .inserted)
    }

    pub fn register_queued(
        &self,
        chat_id: &str,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool> {
        if is_empty_input(content, options) {
            return Ok(true);
        }
        let identified = identified(options)?;
        let images = normalize_chat_images(options.images.as_deref());
        let message = UserMessage {
            timestamp: self.timestamp(options)?,
            content: content.into(),
            images,
            metadata: None,
            presentation: None,
        };
        Ok(self
            .transcript
            .admit_queued_input(chat_id, message, identified)?
            .inserted)
    }

    pub fn discard(
        &self,
        chat_id: &str,
        client_message_id: Option<&str>,
    ) -> ExecutionOperationResult<()> {
        self.transcript
            .discard_prepared_input(chat_id, client_message_id)
    }

    fn timestamp(&self, options: &UserInputAdmissionOptions) -> Result<String, InvalidTimeValue> {
        match &options.created_at {
            Some(created_at) => Ok(created_at.clone()),
            None => to_iso_string(self.clock.now_ms()),
        }
    }

    fn input_message(
        &self,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> Result<UserMessage, InvalidTimeValue> {
        Ok(UserMessage {
            timestamp: self.timestamp(options)?,
            content: content.into(),
            images: normalize_chat_images(options.images.as_deref()),
            metadata: options
                .question_reply
                .as_ref()
                .map(|reply| ChatMessageMetadata {
                    question_reply: Some(reply.clone()),
                    ..ChatMessageMetadata::default()
                }),
            presentation: options.user_message_presentation.clone(),
        })
    }
}

fn is_empty_input(content: &str, options: &UserInputAdmissionOptions) -> bool {
    content.is_empty() && options.images.as_ref().is_none_or(Vec::is_empty)
}

fn identified(
    options: &UserInputAdmissionOptions,
) -> Result<IdentifiedUserInput<'_>, MissingAcceptedInputRequestId> {
    let client_request_id = options
        .client_request_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or(MissingAcceptedInputRequestId)?;
    Ok(IdentifiedUserInput {
        client_request_id,
        options,
    })
}

fn normalize_chat_images(images: Option<&[AgentCommandImage]>) -> Option<Vec<ChatImage>> {
    let images = images.filter(|images| !images.is_empty())?;
    Some(
        images
            .iter()
            .enumerate()
            .map(|(index, image)| ChatImage {
                data: image.data.clone(),
                name: image
                    .name
                    .as_ref()
                    .filter(|name| !name.is_empty())
                    .cloned()
                    .unwrap_or_else(|| format!("image-{}", index + 1)),
                mime_type: image
                    .mime_type
                    .as_ref()
                    .filter(|mime| !mime.is_empty())
                    .cloned(),
            })
            .collect(),
    )
}
