//! Ports `server-agents/common/src/migration/version-1-record-migration.ts`.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_contract::agent_integration::AgentSettingsEnvelope;
use garcon_interface::resources::ExecutorResult;
use garcon_interface::services::{
    AgentMigration, AgentSettings, AgentTranslateLegacyModelRequest,
    AgentTranslateLegacyNativeSessionRequest, AgentTranslateLegacySettingsRequest,
};
use garcon_interface::transcript::AgentNativeSessionRef;
use indexmap::IndexMap;

use crate::native_session::path_native_session::{PathNativeSessionCodec, PathNativeSessionValue};

pub type TranslateLegacyModel = Box<dyn Fn(&str) -> String>;

pub struct Version1RecordMigration {
    pub settings: Rc<dyn AgentSettings>,
    pub native_sessions: Option<PathNativeSessionCodec>,
    pub translate_model: Option<TranslateLegacyModel>,
}

#[async_trait(?Send)]
impl AgentMigration for Version1RecordMigration {
    async fn translate_legacy_model(
        &self,
        request: AgentTranslateLegacyModelRequest,
    ) -> ExecutorResult<String> {
        Ok(match &self.translate_model {
            Some(translate) => translate(&request.model),
            None => request.model,
        })
    }

    async fn translate_legacy_native_session(
        &self,
        request: AgentTranslateLegacyNativeSessionRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        Ok(self.native_sessions.as_ref().and_then(|codec| {
            codec.encode(PathNativeSessionValue {
                path: request.legacy_native_path,
                agent_session_id: request.agent_session_id,
                model_endpoint_id: request
                    .legacy_values
                    .get("modelEndpointId")
                    .and_then(|value| value.as_str())
                    .map(str::to_owned),
            })
        }))
    }

    async fn translate_legacy_settings(
        &self,
        request: AgentTranslateLegacySettingsRequest,
    ) -> ExecutorResult<Option<AgentSettingsEnvelope>> {
        let defaults = self.settings.defaults()?;
        let known: IndexMap<_, _> = self
            .settings
            .describe()
            .iter()
            .filter_map(|entry| {
                Some((
                    entry.key.clone(),
                    request.legacy_values.get(&entry.key)?.clone(),
                ))
            })
            .collect();
        if defaults
            .values
            .as_object()
            .is_some_and(serde_json::Map::is_empty)
            && known.is_empty()
        {
            return Ok(None);
        }
        self.settings.apply_patch(defaults, known).map(Some)
    }
}

#[cfg(test)]
mod tests;
