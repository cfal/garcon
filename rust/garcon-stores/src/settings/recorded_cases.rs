use garcon_cases::{CaseError, replay, unknown};
use garcon_js::json::{self, Opaque};
use serde::Serialize;
use serde_json::Value;

use super::settings_shared::*;
use super::startup_recents::*;

fn value(output: impl Serialize) -> Value {
    json::from_slice(&serde_json::to_vec(&output).unwrap()).unwrap()
}

#[test]
fn recorded_settings_normalization_matches() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/settings-shared"),
        |function, args| {
            let input = unknown(function, args.first())?;
            Ok(match function {
                "normalizeUiSettings" => value(Opaque::from(normalize_ui_settings(&input))),
                "sanitizeFolderFilter" => value(sanitize_folder_filter(&input)),
                "sanitizeStringArray" => value(sanitize_string_array(&input)),
                "normalizeRemoteSettingsVersion" => {
                    value(normalize_remote_settings_version(&input))
                }
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}

#[derive(Serialize)]
struct SanitizedPathCase {
    paths: Opaque,
    migrated: bool,
}

#[derive(Serialize)]
struct SanitizedRecentsCase {
    entries: Vec<garcon_contract::settings::RecentAgentSetting>,
    migrated: bool,
}

#[derive(Serialize)]
struct SanitizedExecutionCase {
    defaults: garcon_contract::settings::RemoteExecutionDefaults,
    migrated: bool,
}

#[test]
fn recorded_startup_recents_match() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/settings-startup-recents"
        ),
        |function, args| {
            let input = unknown(function, args.first())?;
            Ok(match function {
                "sortedPinnedProjectPaths" => value(sorted_pinned_project_paths(&input)),
                "sanitizePathSettings" => {
                    let (paths, migrated) = sanitize_path_settings(&input);
                    value(SanitizedPathCase {
                        paths: paths.into(),
                        migrated,
                    })
                }
                "sanitizeRecentAgentSettings" => {
                    let (entries, migrated) = sanitize_recent_agent_settings(&input);
                    value(SanitizedRecentsCase { entries, migrated })
                }
                "sanitizeExecutionDefaultsSettings" => {
                    let (defaults, migrated) = sanitize_execution_defaults_settings(&input);
                    value(SanitizedExecutionCase { defaults, migrated })
                }
                "legacyExecutionDefaults" => value(legacy_execution_defaults(&input)),
                "legacyRecentAgentSetting" => value(legacy_recent_agent_setting(&input)),
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}
