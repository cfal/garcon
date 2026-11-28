use std::error::Error;

use garcon_base::domain_error::DomainError;
use garcon_contract::error_codes::ErrorCode;
use garcon_contract::settings::{
    ExecutorProjectPreferences, GENERATION_UI_SETTING_KEYS, generation_selection_executor_error,
    parse_executor_project_preferences, parse_executor_project_preferences_patch,
};
use garcon_js::json::Opaque;
use serde_json::{Map, Value, json};

use super::settings_shared::{normalize_ui_settings, record};
use super::startup_recents::normalize_path_settings;
use super::store::Mutation;
use super::{SettingsChange, SettingsStore};

impl SettingsStore {
    pub fn ui_settings(&self) -> Opaque {
        self.snapshot().ui.clone()
    }

    pub async fn set_ui_settings(
        &self,
        patch: &Map<String, Value>,
    ) -> Result<Opaque, Box<dyn Error>> {
        for key in GENERATION_UI_SETTING_KEYS {
            if let Some(error) = patch.get(key).and_then(generation_selection_executor_error) {
                return Err(Box::new(DomainError::new(
                    ErrorCode::VALIDATION_FAILED,
                    error,
                    400,
                    false,
                )));
            }
        }
        self.mutate(|settings| {
            let mut updated = record(&settings.ui);
            updated.extend(patch.clone());
            settings.ui = normalize_ui_settings(&Value::Object(updated)).into();
            settings.remote_settings_version += 1;
            Ok(Mutation::Save(
                settings.ui.clone(),
                vec![SettingsChange::RemoteSettings],
            ))
        })
        .await
    }

    pub fn path_settings(&self) -> Opaque {
        self.snapshot().paths.clone()
    }

    pub async fn set_path_settings(
        &self,
        patch: &Map<String, Value>,
    ) -> Result<Opaque, Box<dyn Error>> {
        let executor_patches = patch
            .get("byExecutor")
            .map(|raw| {
                parse_executor_project_preferences_patch(raw)
                    .ok_or("Invalid executor project preferences")
            })
            .transpose()?;
        self.mutate(|settings| {
            let mut updated = record(&settings.paths);
            updated.extend(patch.clone());
            if let Some(executor_patches) = executor_patches {
                let mut by_executor =
                    parse_executor_project_preferences(&settings.paths["byExecutor"])
                        .unwrap_or_default();
                for (id, patch) in executor_patches {
                    let preferences =
                        by_executor
                            .entry(id)
                            .or_insert_with(|| ExecutorProjectPreferences {
                                default_path: None,
                                recent_paths: Vec::new(),
                                pinned_paths: Vec::new(),
                            });
                    if let Some(path) = patch.default_path {
                        preferences.default_path = Some(path);
                    }
                    if let Some(paths) = patch.pinned_paths {
                        preferences.pinned_paths = paths;
                    }
                }
                updated.insert("byExecutor".into(), json!(by_executor));
            }
            settings.paths = normalize_path_settings(&Value::Object(updated))?.into();
            settings.remote_settings_version += 1;
            Ok(Mutation::Save(
                settings.paths.clone(),
                vec![SettingsChange::RemoteSettings],
            ))
        })
        .await
    }
}
