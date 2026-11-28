//! Controller adapters for ledger Clear and Reload. Both use the same
//! adoption service, chat lock, and registry-owned producer when composed.

use std::{future::ready, rc::Rc};

use futures::future::LocalBoxFuture;
use garcon_chats::{
    registry_contracts::{CarryOverSegmentRef, ChatRegistryEntry},
    store::{ChatRegistry, ChatRegistryPatch, RegistryError, ResolvedChat},
};
use garcon_contract::chat_clear::ClearChatResponse;
use garcon_ledger::{
    clear::{
        ClearChatEntry, PromoteClearedView, TranscriptClearExecution, TranscriptClearRegistry,
    },
    reload::{
        NativeHistoryIntegration, ReloadChatEntry, TranscriptReloadIntegrations,
        TranscriptReloadRegistry,
    },
    sqlite_operations::LedgerResult,
    view_mutation::{ReleaseTranscriptSnapshot, TranscriptMutationExecution},
};

use crate::{
    agent_registry::registered_transcript_chat,
    chat_execution_coordinator::ChatExecutionCoordinator, control_state::has_pending_turn_input,
    directory::AgentDirectory, types::ChatExecutionCommands,
};

type Carryover = Vec<CarryOverSegmentRef>;

pub struct TranscriptMutationRegistry(Rc<ChatRegistry>);

impl TranscriptMutationRegistry {
    pub fn new(registry: Rc<ChatRegistry>) -> Self {
        Self(registry)
    }

    fn clear_boundary(&self, chat_id: &str) -> LedgerResult<Option<ResolvedChat>> {
        self.0
            .update_chat(
                chat_id,
                ChatRegistryPatch {
                    pending_preamble_boundary: Some(None),
                    ..Default::default()
                },
            )
            .map_err(registry_error)
    }

    fn flush(&self) -> LocalBoxFuture<'_, LedgerResult<()>> {
        Box::pin(async { self.0.flush().await.map_err(registry_error) })
    }
}

impl TranscriptClearRegistry for TranscriptMutationRegistry {
    fn get_chat(&self, chat_id: &str) -> Option<ClearChatEntry> {
        let chat = self.0.get_chat(chat_id)?;
        Some(ClearChatEntry {
            agent_id: chat.agent_id,
            executor_id: chat.executor_id.as_option().cloned(),
            pending_preamble_boundary: chat.pending_preamble_boundary,
        })
    }

    fn clear_pending_preamble_boundary(&self, chat_id: &str) -> LedgerResult<()> {
        self.clear_boundary(chat_id).map(|_| ())
    }

    fn flush(&self) -> LocalBoxFuture<'_, LedgerResult<()>> {
        Self::flush(self)
    }
}

impl TranscriptReloadRegistry<Carryover> for TranscriptMutationRegistry {
    fn get_chat(&self, chat_id: &str) -> Option<ReloadChatEntry<Carryover>> {
        self.0.get_chat(chat_id).map(reload_entry)
    }

    fn clear_pending_preamble_boundary(
        &self,
        chat_id: &str,
    ) -> LedgerResult<Option<ReloadChatEntry<Carryover>>> {
        Ok(self
            .clear_boundary(chat_id)?
            .map(|updated| reload_entry(updated.entry)))
    }

    fn flush(&self) -> LocalBoxFuture<'_, LedgerResult<()>> {
        Self::flush(self)
    }
}

fn reload_entry(chat: ChatRegistryEntry) -> ReloadChatEntry<Carryover> {
    let pending_preamble_boundary = chat.pending_preamble_boundary.clone();
    ReloadChatEntry {
        transcript: registered_transcript_chat(chat),
        pending_preamble_boundary,
    }
}

fn registry_error(error: RegistryError) -> Box<dyn std::error::Error> {
    match error {
        RegistryError::Reference(error) | RegistryError::Listener(error) => error,
        RegistryError::Domain(error) => Box::new(error),
        RegistryError::Write(error) => error.cause,
        error => Box::new(error),
    }
}

impl TranscriptReloadIntegrations for AgentDirectory {
    fn require(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> LedgerResult<NativeHistoryIntegration> {
        let integration = AgentDirectory::require(self, agent_id, executor_id)?;
        Ok(NativeHistoryIntegration {
            agent_id: integration.descriptor.id.clone(),
            settings: integration.settings.clone(),
            native_history_import: integration.native_history_import.clone(),
        })
    }
}

pub struct TranscriptMutationCoordinator(Rc<ChatExecutionCoordinator>);

impl TranscriptMutationCoordinator {
    pub fn new(coordinator: Rc<ChatExecutionCoordinator>) -> Self {
        Self(coordinator)
    }
}

impl TranscriptMutationExecution for TranscriptMutationCoordinator {
    fn reserve_transcript_snapshot(
        &self,
        chat_id: &str,
    ) -> LedgerResult<ReleaseTranscriptSnapshot> {
        let reservation = self.0.reserve_transcript_snapshot(chat_id)?;
        let coordinator = self.0.clone();
        Ok(Box::new(move || {
            Box::pin(async move { coordinator.release_transcript_snapshot(&reservation).await })
        }))
    }

    fn has_pending_turn_input<'a>(
        &'a self,
        chat_id: &'a str,
    ) -> LocalBoxFuture<'a, LedgerResult<bool>> {
        Box::pin(async move {
            Ok(has_pending_turn_input(
                &self.0.read_chat_execution_control(chat_id).await?,
            ))
        })
    }
}

impl TranscriptClearExecution for TranscriptMutationCoordinator {
    fn with_chat_execution_control<'a>(
        &'a self,
        chat_id: &'a str,
        promote: PromoteClearedView<'a>,
    ) -> LocalBoxFuture<'a, LedgerResult<ClearChatResponse>> {
        self.0.with_chat_execution_control(chat_id, move |control| {
            Box::pin(ready(promote(has_pending_turn_input(&control))))
        })
    }
}
