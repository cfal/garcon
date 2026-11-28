use std::error::Error;

use garcon_contract::settings::{
    AgentCommandsFeatureSettings, RemoteFeatureSettings, TranscriptSearchFeatureSettings,
};

use super::store::Mutation;
use super::{SettingsChange, SettingsStore};

#[derive(Debug, Clone, Copy, Default)]
pub struct SettingsFeaturePatch {
    pub transcript_search: Option<TranscriptSearchFeatureSettings>,
    pub agent_commands: Option<AgentCommandsFeatureSettings>,
}

impl SettingsStore {
    pub fn feature_settings(&self) -> RemoteFeatureSettings {
        self.snapshot().features
    }

    /// Stores the transcript search preference without starting or stopping the search runtime.
    pub async fn set_feature_settings(
        &self,
        patch: SettingsFeaturePatch,
    ) -> Result<RemoteFeatureSettings, Box<dyn Error>> {
        self.mutate(|settings| {
            if let Some(transcript_search) = patch.transcript_search {
                settings.features.transcript_search = transcript_search;
            }
            if let Some(agent_commands) = patch.agent_commands {
                settings.features.agent_commands = agent_commands;
            }
            settings.remote_settings_version += 1;
            Ok(Mutation::Save(
                settings.features,
                vec![SettingsChange::RemoteSettings],
            ))
        })
        .await
    }
}
