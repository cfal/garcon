//! Attachment checks are synchronous so queue admission can read the current
//! chat selection under the same lock as dequeue.

use std::rc::Rc;

use garcon_chats::{registry_contracts::ChatRegistryEntry, store::ChatRegistry};
use garcon_contract::{
    attachments::{
        accepts_file_attachment_mime_type, is_image_attachment_mime_type,
        is_text_attachment_mime_type,
    },
    error_codes::ErrorCode,
    ws_requests::AgentCommandImage,
};
use garcon_js::{Number, number_to_string, trim, utf16};

use crate::{
    catalog_service::{AgentCatalogService, ModelImageSupport},
    command_validation_error::CommandValidationError,
    directory::AgentDirectory,
    types::{ExecutionOperationResult, QueuedAttachmentAdmissionPort},
};

pub enum FileAttachmentAdmission {
    Accepted,
    UnsupportedType,
    TextTooLarge { max_bytes: Number },
}

pub trait AttachmentAgentCapabilities {
    fn assert_executor_ready(&self, executor_id: Option<&str>) -> ExecutionOperationResult<()>;
    fn model_supports_images(&self, input: ModelImageSupport<'_>)
    -> ExecutionOperationResult<bool>;
    fn supports_images(&self, agent_id: &str, executor_id: Option<&str>) -> bool;
    fn file_attachment_admission(
        &self,
        agent_id: &str,
        mime_type: &str,
        size_bytes: usize,
        executor_id: Option<&str>,
    ) -> FileAttachmentAdmission;
}

struct CatalogCapabilities {
    directory: Rc<AgentDirectory>,
    catalog: Rc<AgentCatalogService>,
}

impl AttachmentAgentCapabilities for CatalogCapabilities {
    fn assert_executor_ready(&self, executor_id: Option<&str>) -> ExecutionOperationResult<()> {
        Ok(self.directory.require_ready(executor_id)?)
    }

    fn model_supports_images(
        &self,
        input: ModelImageSupport<'_>,
    ) -> ExecutionOperationResult<bool> {
        self.catalog.model_supports_images(input)
    }

    fn supports_images(&self, agent_id: &str, executor_id: Option<&str>) -> bool {
        self.directory
            .get(agent_id, executor_id)
            .is_some_and(|integration| integration.descriptor.supports_images)
    }

    fn file_attachment_admission(
        &self,
        agent_id: &str,
        mime_type: &str,
        size_bytes: usize,
        executor_id: Option<&str>,
    ) -> FileAttachmentAdmission {
        let Some(integration) = self.directory.get(agent_id, executor_id) else {
            return FileAttachmentAdmission::UnsupportedType;
        };
        let Some(attachments) = &integration.attachments else {
            return FileAttachmentAdmission::UnsupportedType;
        };
        if !accepts_file_attachment_mime_type(&attachments.file_mime_types, mime_type) {
            return FileAttachmentAdmission::UnsupportedType;
        }
        if let Some(max_bytes) = attachments.inline_text_max_bytes
            && is_text_attachment_mime_type(mime_type)
            && size_bytes as f64 > max_bytes.0
        {
            return FileAttachmentAdmission::TextTooLarge { max_bytes };
        }
        FileAttachmentAdmission::Accepted
    }
}

pub struct QueuedAttachmentAdmission {
    chats: Rc<ChatRegistry>,
    agents: CatalogCapabilities,
}

impl QueuedAttachmentAdmission {
    pub fn new(
        chats: Rc<ChatRegistry>,
        directory: Rc<AgentDirectory>,
        catalog: Rc<AgentCatalogService>,
    ) -> Self {
        Self {
            chats,
            agents: CatalogCapabilities { directory, catalog },
        }
    }
}

impl QueuedAttachmentAdmissionPort for QueuedAttachmentAdmission {
    fn assert_supported(
        &self,
        chat_id: &str,
        images: &[AgentCommandImage],
    ) -> ExecutionOperationResult<()> {
        let chat = self
            .chats
            .get_chat(chat_id)
            .ok_or_else(|| format!("Session not initialized: {chat_id}"))?;
        assert_attachments_supported(
            &self.agents,
            AttachmentSupportInput::from_chat(&chat, images),
        )
    }
}

pub struct AttachmentSupportInput<'a> {
    pub agent_id: &'a str,
    pub executor_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub api_provider_id: Option<&'a str>,
    pub model_endpoint_id: Option<&'a str>,
    pub attachments: &'a [AgentCommandImage],
}

impl<'a> AttachmentSupportInput<'a> {
    pub fn from_chat(chat: &'a ChatRegistryEntry, attachments: &'a [AgentCommandImage]) -> Self {
        Self {
            agent_id: &chat.agent_id,
            executor_id: chat.executor_id.as_deref(),
            model: Some(&chat.model),
            api_provider_id: chat.api_provider_id.as_deref(),
            model_endpoint_id: chat.model_endpoint_id.as_deref(),
            attachments,
        }
    }
}

pub fn assert_attachments_supported(
    agents: &impl AttachmentAgentCapabilities,
    input: AttachmentSupportInput<'_>,
) -> ExecutionOperationResult<()> {
    if input.attachments.is_empty() {
        return Ok(());
    }
    let Some(model) = input.model.filter(|model| !model.is_empty()) else {
        return Err(CommandValidationError::new(
            ErrorCode::INCOMPLETE_EXECUTION_CONFIG,
            "The chat has no model to receive attachments",
            422,
            false,
        )
        .into());
    };
    agents.assert_executor_ready(input.executor_id)?;
    let mime_types = input
        .attachments
        .iter()
        .map(|attachment| {
            attachment
                .mime_type
                .as_deref()
                .map(trim)
                .filter(|mime_type| !mime_type.is_empty())
                .map(str::to_lowercase)
                .ok_or_else(|| {
                    CommandValidationError::new(
                        ErrorCode::VALIDATION_FAILED,
                        "Attachment MIME type is required",
                        400,
                        false,
                    )
                })
        })
        .collect::<Result<Vec<_>, _>>()?;

    if mime_types
        .iter()
        .any(|kind| is_image_attachment_mime_type(kind))
    {
        let model_supports_images = agents
            .model_supports_images(ModelImageSupport {
                executor_id: input.executor_id,
                agent_id: input.agent_id,
                model,
                api_provider_id: input.api_provider_id,
                model_endpoint_id: input.model_endpoint_id,
            })
            .unwrap_or(false);
        let has_backend_selection = input.api_provider_id.is_some_and(|id| !id.is_empty())
            && input.model_endpoint_id.is_some_and(|id| !id.is_empty());
        let supports_images = if has_backend_selection {
            model_supports_images
        } else {
            agents.supports_images(input.agent_id, input.executor_id)
        };
        if !supports_images {
            return Err(unsupported(format!(
                "Attachments unsupported for agent: {}",
                input.agent_id
            ))
            .into());
        }
    }

    for (attachment, mime_type) in input.attachments.iter().zip(mime_types) {
        if is_image_attachment_mime_type(&mime_type) {
            continue;
        }
        let size_bytes = attachment_size_bytes(&attachment.data);
        match agents.file_attachment_admission(
            input.agent_id,
            &mime_type,
            size_bytes,
            input.executor_id,
        ) {
            FileAttachmentAdmission::Accepted => {}
            FileAttachmentAdmission::UnsupportedType => {
                return Err(unsupported(format!(
                    "{mime_type} attachments unsupported for agent: {}",
                    input.agent_id
                ))
                .into());
            }
            FileAttachmentAdmission::TextTooLarge { max_bytes } => {
                let name = attachment.name.as_deref().unwrap_or(&mime_type);
                let limit = number_to_string((max_bytes.0 / 1000.0).floor());
                return Err(unsupported(format!("{name} is too large for agent {} to read; the limit for text attachments is {limit} KB", input.agent_id)).into());
            }
        }
    }
    Ok(())
}

fn unsupported(message: String) -> CommandValidationError {
    CommandValidationError::new(ErrorCode::UNSUPPORTED_AGENT, message, 422, false)
}

fn attachment_size_bytes(data: &str) -> usize {
    let base64 = data.split_once(',').map_or(data, |(_, rest)| rest);
    let unpadded = base64
        .strip_suffix('=')
        .map_or(base64, |rest| rest.strip_suffix('=').unwrap_or(rest));
    utf16::len(unpadded) * 3 / 4
}

#[cfg(test)]
mod tests;
