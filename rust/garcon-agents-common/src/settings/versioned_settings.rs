//! Ports `server-agents/common/src/settings/versioned-settings.ts`.

use async_trait::async_trait;
use futures::future::LocalBoxFuture;
use garcon_contract::agent_integration::{
    AgentSettingDescriptor, AgentSettingKind, AgentSettingsEnvelope,
};
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::resources::ExecutorResult;
use garcon_interface::services::AgentSettings;
use garcon_js::json::{self, Opaque};
use indexmap::IndexMap;
use serde_json::Value;

pub type MigrateSettingValues =
    Box<dyn Fn(i64, Opaque) -> LocalBoxFuture<'static, ExecutorResult<Opaque>>>;

pub struct VersionedSettings {
    defaults: AgentSettingsEnvelope,
    descriptors: Vec<AgentSettingDescriptor>,
    migrate_values: Option<MigrateSettingValues>,
}

impl VersionedSettings {
    pub fn new(
        defaults: AgentSettingsEnvelope,
        descriptors: Vec<AgentSettingDescriptor>,
        migrate_values: Option<MigrateSettingValues>,
    ) -> Self {
        Self {
            defaults,
            descriptors,
            migrate_values,
        }
    }

    fn envelope(&self, values: Opaque) -> ExecutorResult<AgentSettingsEnvelope> {
        self.validate_values(&values)?;
        Ok(AgentSettingsEnvelope {
            owner_id: self.defaults.owner_id.clone(),
            schema_version: self.defaults.schema_version,
            values,
        })
    }

    fn validate_values(&self, values: &Opaque) -> ExecutorResult<()> {
        let object = values.as_object().ok_or_else(|| self.invalid_settings())?;
        for (key, value) in object {
            let descriptor = self
                .descriptors
                .iter()
                .rfind(|descriptor| descriptor.key == *key)
                .ok_or_else(|| invalid(format!("Unknown setting {key}")))?;
            let valid = match &descriptor.kind {
                AgentSettingKind::Boolean => value.is_boolean(),
                AgentSettingKind::Number { min, max, .. } => json::as_number(value)
                    .is_some_and(|value| value.is_finite() && value >= min.0 && value <= max.0),
                AgentSettingKind::Enum { options } => value
                    .as_str()
                    .is_some_and(|value| options.iter().any(|option| option.value == value)),
                AgentSettingKind::String | AgentSettingKind::CredentialRef { .. } => {
                    value.is_string()
                }
            };
            if !valid {
                return Err(invalid(format!("Invalid value for setting {key}")).into());
            }
        }
        Ok(())
    }

    fn invalid_settings(&self) -> AgentIntegrationError {
        invalid(format!("Invalid settings for {}", self.defaults.owner_id))
    }
}

fn invalid(message: String) -> AgentIntegrationError {
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::INVALID_SETTINGS,
        message,
        false,
        None,
    )
}

#[async_trait(?Send)]
impl AgentSettings for VersionedSettings {
    fn describe(&self) -> &[AgentSettingDescriptor] {
        &self.descriptors
    }

    fn defaults(&self) -> ExecutorResult<AgentSettingsEnvelope> {
        self.envelope(self.defaults.values.clone())
    }

    fn parse(&self, input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope> {
        if input.owner_id != self.defaults.owner_id
            || input.schema_version != self.defaults.schema_version
        {
            return Err(self.invalid_settings().into());
        }
        self.envelope(input.values)
    }

    async fn migrate(&self, input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope> {
        if input.owner_id != self.defaults.owner_id
            || input.schema_version < 1
            || input.schema_version > self.defaults.schema_version
        {
            return Err(self.invalid_settings().into());
        }
        if input.schema_version == self.defaults.schema_version {
            return self.parse(input);
        }
        let migrate = self
            .migrate_values
            .as_ref()
            .ok_or_else(|| self.invalid_settings())?;
        self.envelope(migrate(input.schema_version, input.values).await?)
    }

    fn apply_patch(
        &self,
        current: AgentSettingsEnvelope,
        patch: IndexMap<String, Opaque>,
    ) -> ExecutorResult<AgentSettingsEnvelope> {
        let Value::Object(mut merged) = self.parse(current)?.values.into_value() else {
            return Err(self.invalid_settings().into());
        };
        merged.extend(
            patch
                .into_iter()
                .map(|(key, value)| (key, value.into_value())),
        );
        self.envelope(Value::Object(merged).into())
    }
}

#[cfg(test)]
mod tests;
