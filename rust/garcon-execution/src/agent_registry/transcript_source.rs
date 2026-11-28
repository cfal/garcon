use garcon_chats::registry_contracts::ChatRegistryEntry;
use garcon_interface::{
    native_history::AgentHistoryImportRequest, transcript::AgentTranscriptSourceLocation,
};
use tokio_util::sync::CancellationToken;

use crate::{integration_chat_reference::to_agent_chat_reference, types::ExecutionOperationResult};

use super::AgentRegistry;

impl AgentRegistry {
    pub async fn describe_transcript_source(
        &self,
        session: &ChatRegistryEntry,
        chat_id: &str,
    ) -> Option<AgentTranscriptSourceLocation> {
        let integration = self
            .directory
            .get(&session.agent_id, session.executor_id.as_deref())?;
        let native_sessions = integration.native_sessions.as_ref()?;
        let source: ExecutionOperationResult<_> = async {
            let revision = (self.get_carry_over_revision)(session);
            let chat = to_agent_chat_reference(
                &integration.descriptor.id,
                integration.settings.as_ref(),
                chat_id,
                session,
                &revision,
            )?;
            let source = native_sessions
                .describe_source(AgentHistoryImportRequest {
                    chat,
                    signal: CancellationToken::new(),
                })
                .await?;
            match &source {
                Some(
                    AgentTranscriptSourceLocation::FilesystemPath { value }
                    | AgentTranscriptSourceLocation::ProviderReference { value },
                ) if value.is_empty() => Err("INVALID_TRANSCRIPT_SOURCE_DESCRIPTION".into()),
                _ => Ok(source),
            }
        }
        .await;
        match source {
            Ok(source) => source,
            Err(_) => {
                self.logger.warn(&format!("Transcript source description failed. (TRANSCRIPT_SOURCE_DESCRIPTION_FAILED, {})", session.agent_id));
                None
            }
        }
    }
}
