//! Adapts the controller's registry and directory to genesis adoption.

use std::rc::Rc;

use garcon_chats::{
    registry_contracts::CarryOverSegmentRef,
    store::{ChatRegistry, ChatRegistryPatch},
};
use garcon_ledger::{
    adoption::{
        CarryoverQuarantine, LegacyHistoryIntegration, RegisteredTranscriptChat,
        TranscriptAdoptionIntegrations, TranscriptAdoptionRegistry, TranscriptSessionCache,
    },
    sqlite_operations::LedgerResult,
};

use crate::directory::AgentDirectory;

pub struct AdoptionChatRegistry(Rc<ChatRegistry>);

impl AdoptionChatRegistry {
    pub fn new(registry: Rc<ChatRegistry>) -> Self {
        Self(registry)
    }
}

impl TranscriptAdoptionRegistry<Vec<CarryOverSegmentRef>> for AdoptionChatRegistry {
    fn get_chat(
        &self,
        chat_id: &str,
    ) -> Option<RegisteredTranscriptChat<Vec<CarryOverSegmentRef>>> {
        let entry = self.0.get_chat(chat_id)?;
        Some(RegisteredTranscriptChat {
            agent_id: entry.agent_id,
            executor_id: entry.executor_id.as_option().cloned(),
            ownership_epoch: entry.agent_ownership_epoch,
            project_path: entry.project_path,
            model: entry.model,
            settings_by_agent: entry.agent_settings_by_id,
            session: TranscriptSessionCache {
                agent_session_id: entry.agent_session_id,
                native_session: entry.native_session,
                native_seed_receipt: entry.native_seed_receipt,
            },
            carryover: entry.carry_over_segments,
            quarantine: entry.carry_over_migration_quarantine.map(|quarantine| {
                CarryoverQuarantine {
                    artifact_id: quarantine.artifact_id,
                    error_code: quarantine.error_code,
                }
            }),
        })
    }

    fn update_session_cache(
        &self,
        chat_id: &str,
        value: TranscriptSessionCache,
    ) -> LedgerResult<()> {
        let _ = self.0.update_chat(
            chat_id,
            ChatRegistryPatch {
                agent_session_id: Some(value.agent_session_id),
                native_session: Some(value.native_session),
                native_seed_receipt: Some(value.native_seed_receipt),
                ..Default::default()
            },
        )?;
        Ok(())
    }
}

impl TranscriptAdoptionIntegrations for AgentDirectory {
    fn require(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> LedgerResult<LegacyHistoryIntegration> {
        let integration = AgentDirectory::require(self, agent_id, executor_id)?;
        Ok(LegacyHistoryIntegration {
            agent_id: integration.descriptor.id.clone(),
            settings: integration.settings.clone(),
            importer: integration.legacy_history_import.clone(),
        })
    }
}
