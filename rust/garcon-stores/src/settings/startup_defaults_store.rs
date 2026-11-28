use std::error::Error;

use garcon_base::log::{Logger, create_logger};
use garcon_contract::settings::{ExecutionDefaultsPatch, parse_executor_project_preferences};
use garcon_js::trim;
use serde_json::{Map, Value, json};

use super::settings_shared::{optional_string, record};
use super::startup_recents::{
    dedupe_recent_agent_settings, full_execution_defaults_patch, record_recent_project_path,
    sanitize_execution_defaults, sanitize_recent_agent_setting,
};
use super::store::Mutation;
use super::{SettingsChange, SettingsStore};

impl SettingsStore {
    pub async fn forget_executor(&self, executor_id: &str) -> Result<(), Box<dyn Error>> {
        self.mutate(|settings| {
            if let Some(mut by_executor) =
                parse_executor_project_preferences(&settings.paths["byExecutor"])
            {
                by_executor.shift_remove(executor_id);
                let mut paths = record(&settings.paths);
                paths.insert("byExecutor".into(), json!(by_executor));
                settings.paths = Value::Object(paths).into();
            }
            settings
                .recent_agent_settings
                .retain(|entry| entry.executor_id.as_deref() != Some(executor_id));
            settings.remote_settings_version += 1;
            Ok(Mutation::Save((), vec![SettingsChange::RemoteSettings]))
        })
        .await
    }

    pub async fn record_chat_startup(&self, input: &Value) {
        let result = self
            .mutate(|settings| {
                if let Some(recent) = sanitize_recent_agent_setting(input) {
                    settings.recent_agent_settings.insert(0, recent);
                    settings.recent_agent_settings = dedupe_recent_agent_settings(std::mem::take(
                        &mut settings.recent_agent_settings,
                    ));
                }
                settings.paths = record_recent_project_path(
                    &settings.paths,
                    &input["projectPath"],
                    &input["executorId"],
                )?
                .into();

                if let Some(agent_id) = optional_string(&input["agentId"]) {
                    let mut defaults = Map::new();
                    defaults.insert("permissionMode".into(), input["permissionMode"].clone());
                    defaults.insert("thinkingMode".into(), input["thinkingMode"].clone());
                    let by_id = &input["agentSettingsById"];
                    if !by_id.is_null() {
                        defaults.insert("agentSettingsById".into(), by_id.clone());
                    } else if input["agentSettings"].is_object() {
                        let envelope = [(agent_id.into(), input["agentSettings"].clone())]
                            .into_iter()
                            .collect();
                        defaults.insert("agentSettingsById".into(), Value::Object(envelope));
                    }
                    let defaults = sanitize_execution_defaults(&Value::Object(defaults));
                    settings
                        .execution_defaults
                        .by_agent
                        .insert(agent_id.into(), full_execution_defaults_patch(&defaults));
                }
                settings.remote_settings_version += 1;
                Ok(Mutation::Save((), vec![SettingsChange::RemoteSettings]))
            })
            .await;
        if let Err(error) = result {
            // Startup preferences are advisory, after the chat has been dispatched.
            create_logger("settings:startup-defaults").warn(&format!(
                "settings: failed to record chat startup preferences: {error}"
            ));
        }
    }

    pub async fn update_execution_defaults_for_agent(
        &self,
        agent_id: &str,
        patch: ExecutionDefaultsPatch,
    ) -> Result<(), Box<dyn Error>> {
        let agent_id = trim(agent_id);
        if agent_id.is_empty() {
            return Ok(());
        }
        self.mutate(|settings| {
            let defaults = &mut settings.execution_defaults;
            let previous = defaults.by_agent.get(agent_id);
            let merged = ExecutionDefaultsPatch {
                permission_mode: patch
                    .permission_mode
                    .or_else(|| previous.and_then(|p| p.permission_mode))
                    .or(Some(defaults.global.permission_mode)),
                thinking_mode: patch
                    .thinking_mode
                    .or_else(|| previous.and_then(|p| p.thinking_mode))
                    .or(Some(defaults.global.thinking_mode)),
                agent_settings_by_id: patch
                    .agent_settings_by_id
                    .or_else(|| previous.and_then(|p| p.agent_settings_by_id.clone()))
                    .or_else(|| Some(defaults.global.agent_settings_by_id.clone())),
            };
            defaults.by_agent.insert(agent_id.into(), merged);
            settings.remote_settings_version += 1;
            Ok(Mutation::Save((), vec![SettingsChange::RemoteSettings]))
        })
        .await
    }
}
