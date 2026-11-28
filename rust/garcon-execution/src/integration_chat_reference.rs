//! Builds the integration-facing reference from one captured registry entry.

use garcon_chats::registry_contracts::ChatRegistryEntry;
use garcon_interface::{services::AgentSettings, transcript::AgentChatReference};

use crate::types::ExecutionOperationResult;

pub fn to_agent_chat_reference(
    agent_id: &str,
    settings: &dyn AgentSettings,
    chat_id: &str,
    entry: &ChatRegistryEntry,
    carry_over_revision: &str,
) -> ExecutionOperationResult<AgentChatReference> {
    let saved = match entry.agent_settings_by_id.get(agent_id) {
        Some(saved) => saved.clone(),
        None => settings.defaults()?,
    };
    let settings = settings.parse(saved)?;
    if entry
        .native_session
        .as_ref()
        .is_some_and(|session| session.owner_id != agent_id)
    {
        return Err(
            std::io::Error::other(format!("Native session owner mismatch for {chat_id}")).into(),
        );
    }
    Ok(AgentChatReference {
        chat_id: chat_id.into(),
        agent_id: agent_id.into(),
        agent_session_id: entry.agent_session_id.clone(),
        project_path: entry.project_path.clone(),
        model: entry.model.clone(),
        native_session: entry.native_session.clone(),
        carry_over_revision: carry_over_revision.into(),
        native_seed_receipt: entry.native_seed_receipt.clone(),
        settings,
    })
}
