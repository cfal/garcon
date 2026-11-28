//! Ports common/execution-defaults.ts.

use garcon_js::array_index;
use serde_json::Value;

use crate::chat_modes::{
    DEFAULT_PERMISSION_MODE, DEFAULT_THINKING_MODE, PermissionMode, ThinkingMode,
    normalize_permission_mode, normalize_thinking_mode,
};
use crate::settings::{ExecutionDefaults, RemoteExecutionDefaults, default_execution_defaults};

pub fn normalize_supported_permission_mode(
    value: &Value,
    supported: &[PermissionMode],
) -> PermissionMode {
    let normalized = normalize_permission_mode(value, DEFAULT_PERMISSION_MODE);
    if supported.contains(&normalized) {
        normalized
    } else {
        supported
            .first()
            .copied()
            .unwrap_or(DEFAULT_PERMISSION_MODE)
    }
}

pub fn normalize_supported_thinking_mode(
    value: &Value,
    supported: &[ThinkingMode],
) -> ThinkingMode {
    let normalized = normalize_thinking_mode(value, DEFAULT_THINKING_MODE);
    if supported.contains(&normalized) {
        normalized
    } else {
        supported.first().copied().unwrap_or(DEFAULT_THINKING_MODE)
    }
}

pub fn is_thinking_mode_supported(value: ThinkingMode, supported: &[ThinkingMode]) -> bool {
    supported.contains(&value) || (value == DEFAULT_THINKING_MODE && supported.is_empty())
}

pub fn is_permission_mode_supported(value: PermissionMode, supported: &[PermissionMode]) -> bool {
    supported.contains(&value) || (value == DEFAULT_PERMISSION_MODE && supported.is_empty())
}

pub fn execution_defaults_for_agent(
    defaults: Option<&RemoteExecutionDefaults>,
    agent_id: &str,
) -> ExecutionDefaults {
    let Some(defaults) = defaults else {
        return default_execution_defaults();
    };
    let mut resolved = defaults.global.clone();
    if let Some(overrides) = defaults.by_agent.get(agent_id) {
        resolved.permission_mode = overrides
            .permission_mode
            .unwrap_or(resolved.permission_mode);
        resolved.thinking_mode = overrides.thinking_mode.unwrap_or(resolved.thinking_mode);
        if let Some(settings) = &overrides.agent_settings_by_id {
            resolved.agent_settings_by_id.extend(settings.clone());
        }
    }
    let key_order = |key: &str| array_index(key).map_or(u64::MAX, u64::from);
    resolved
        .agent_settings_by_id
        .sort_by(|a, _, b, _| key_order(a).cmp(&key_order(b)));
    resolved
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_integration::AgentSettingsEnvelope;
    use crate::settings::ExecutionDefaultsPatch;
    use garcon_js::json::Opaque;
    use indexmap::IndexMap;
    use serde_json::json;

    fn settings(owner_id: &str, source: &str) -> AgentSettingsEnvelope {
        AgentSettingsEnvelope {
            owner_id: owner_id.to_owned(),
            schema_version: 1,
            values: Opaque::from_value(json!({"source":source})),
        }
    }

    #[test]
    fn merges_one_agent_override_onto_global_defaults() {
        let defaults = RemoteExecutionDefaults {
            global: ExecutionDefaults {
                permission_mode: PermissionMode::Default,
                thinking_mode: ThinkingMode::Low,
                agent_settings_by_id: IndexMap::from([
                    ("codex".to_owned(), settings("codex", "global")),
                    ("10".to_owned(), settings("10", "global")),
                    ("claude".to_owned(), settings("claude", "global")),
                ]),
            },
            by_agent: IndexMap::from([(
                "codex".to_owned(),
                ExecutionDefaultsPatch {
                    permission_mode: Some(PermissionMode::AcceptEdits),
                    thinking_mode: None,
                    agent_settings_by_id: Some(IndexMap::from([
                        ("codex".to_owned(), settings("codex", "agent")),
                        ("2".to_owned(), settings("2", "agent")),
                    ])),
                },
            )]),
        };
        let selected = execution_defaults_for_agent(Some(&defaults), "codex");
        assert_eq!(selected.permission_mode, PermissionMode::AcceptEdits);
        assert_eq!(selected.thinking_mode, ThinkingMode::Low);
        assert_eq!(
            selected.agent_settings_by_id["codex"],
            settings("codex", "agent")
        );
        assert_eq!(
            selected
                .agent_settings_by_id
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["2", "10", "codex", "claude"]
        );
    }

    #[test]
    fn falls_back_to_canonical_modes_without_configured_defaults() {
        assert_eq!(
            execution_defaults_for_agent(None, "codex"),
            default_execution_defaults()
        );
    }

    #[test]
    fn selects_the_first_supported_mode_when_a_configured_mode_is_unavailable() {
        assert_eq!(
            normalize_supported_permission_mode(
                &json!("plan"),
                &[PermissionMode::Default, PermissionMode::AcceptEdits]
            ),
            PermissionMode::Default
        );
        assert_eq!(
            normalize_supported_thinking_mode(
                &json!("ultra"),
                &[ThinkingMode::Low, ThinkingMode::High]
            ),
            ThinkingMode::Low
        );
    }

    #[test]
    fn accepts_only_the_neutral_value_when_modes_are_not_configurable() {
        assert!(is_thinking_mode_supported(ThinkingMode::None, &[]));
        assert!(!is_thinking_mode_supported(ThinkingMode::High, &[]));
        assert!(is_thinking_mode_supported(
            ThinkingMode::High,
            &[ThinkingMode::None, ThinkingMode::High]
        ));
        assert!(is_permission_mode_supported(PermissionMode::Default, &[]));
        assert!(!is_permission_mode_supported(
            PermissionMode::AcceptEdits,
            &[]
        ));
    }
}
