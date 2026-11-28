//! Ports `common/chat-modes.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The permission mode a chat runs an agent in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    ManualBypass,
    BypassPermissions,
    Plan,
}

impl PermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::Default => "default",
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::ManualBypass => "manualBypass",
            PermissionMode::BypassPermissions => "bypassPermissions",
            PermissionMode::Plan => "plan",
        }
    }
}

pub const PERMISSION_MODE_VALUES: &[PermissionMode] = &[
    PermissionMode::Default,
    PermissionMode::AcceptEdits,
    PermissionMode::ManualBypass,
    PermissionMode::BypassPermissions,
    PermissionMode::Plan,
];

pub const DEFAULT_PERMISSION_MODE: PermissionMode = PermissionMode::Default;

/// How much an agent thinks before it answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingMode {
    None,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

impl ThinkingMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ThinkingMode::None => "none",
            ThinkingMode::Low => "low",
            ThinkingMode::Medium => "medium",
            ThinkingMode::High => "high",
            ThinkingMode::Xhigh => "xhigh",
            ThinkingMode::Max => "max",
            ThinkingMode::Ultra => "ultra",
        }
    }
}

pub const THINKING_MODE_VALUES: &[ThinkingMode] = &[
    ThinkingMode::None,
    ThinkingMode::Low,
    ThinkingMode::Medium,
    ThinkingMode::High,
    ThinkingMode::Xhigh,
    ThinkingMode::Max,
    ThinkingMode::Ultra,
];

pub const DEFAULT_THINKING_MODE: ThinkingMode = ThinkingMode::None;

// Pre-effort-label values persisted by older chats and settings. Accepted on
// normalization so stored data keeps working.
fn legacy_thinking_mode_alias(value: &str) -> Option<ThinkingMode> {
    Some(match value {
        "think" => ThinkingMode::Low,
        "think-hard" => ThinkingMode::Medium,
        "think-harder" => ThinkingMode::High,
        "ultrathink" => ThinkingMode::Max,
        _ => return None,
    })
}

/// How the Claude agent decides whether to think.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeThinkingMode {
    Auto,
    On,
    Off,
}

pub const CLAUDE_THINKING_MODE_VALUES: &[ClaudeThinkingMode] = &[
    ClaudeThinkingMode::Auto,
    ClaudeThinkingMode::On,
    ClaudeThinkingMode::Off,
];

/// Whether `value` names a permission mode.
pub fn is_permission_mode(value: &Value) -> Option<PermissionMode> {
    let text = value.as_str()?;
    PERMISSION_MODE_VALUES
        .iter()
        .copied()
        .find(|mode| mode.as_str() == text)
}

/// Whether `value` names a thinking mode.
pub fn is_thinking_mode(value: &Value) -> Option<ThinkingMode> {
    let text = value.as_str()?;
    THINKING_MODE_VALUES
        .iter()
        .copied()
        .find(|mode| mode.as_str() == text)
}

/// The permission mode `value` names, or `fallback` when it names none.
pub fn normalize_permission_mode(value: &Value, fallback: PermissionMode) -> PermissionMode {
    is_permission_mode(value).unwrap_or(fallback)
}

/// The thinking mode `value` names, also through a legacy alias, or `None`
/// for anything else.
pub fn coerce_thinking_mode(value: &Value) -> Option<ThinkingMode> {
    if let Some(mode) = is_thinking_mode(value) {
        return Some(mode);
    }
    // A name every object has is not a legacy alias.
    value.as_str().and_then(legacy_thinking_mode_alias)
}

/// The thinking mode `value` names, or `fallback` when it names none.
pub fn normalize_thinking_mode(value: &Value, fallback: ThinkingMode) -> ThinkingMode {
    coerce_thinking_mode(value).unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exposes_effort_level_values() {
        let names: Vec<&str> = THINKING_MODE_VALUES
            .iter()
            .map(|mode| mode.as_str())
            .collect();
        assert_eq!(
            names,
            ["none", "low", "medium", "high", "xhigh", "max", "ultra"]
        );
        for (mode, name) in [
            (PermissionMode::Default, "default"),
            (PermissionMode::AcceptEdits, "acceptEdits"),
            (PermissionMode::ManualBypass, "manualBypass"),
            (PermissionMode::BypassPermissions, "bypassPermissions"),
            (PermissionMode::Plan, "plan"),
        ] {
            assert_eq!(serde_json::to_value(mode).unwrap(), json!(name));
        }
        for (mode, name) in [
            (ClaudeThinkingMode::Auto, "auto"),
            (ClaudeThinkingMode::On, "on"),
            (ClaudeThinkingMode::Off, "off"),
        ] {
            assert_eq!(serde_json::to_value(mode).unwrap(), json!(name));
        }
        assert_eq!(
            serde_json::to_value(ThinkingMode::Xhigh).unwrap(),
            json!("xhigh")
        );
        assert_eq!(
            PERMISSION_MODE_VALUES
                .iter()
                .map(|mode| mode.as_str())
                .collect::<Vec<_>>(),
            [
                "default",
                "acceptEdits",
                "manualBypass",
                "bypassPermissions",
                "plan"
            ]
        );
        assert_eq!(CLAUDE_THINKING_MODE_VALUES.len(), 3);
        assert_eq!(DEFAULT_PERMISSION_MODE, PermissionMode::Default);
        assert_eq!(DEFAULT_THINKING_MODE, ThinkingMode::None);
    }

    #[test]
    fn accepts_canonical_values_unchanged() {
        for mode in THINKING_MODE_VALUES {
            assert_eq!(
                normalize_thinking_mode(&json!(mode.as_str()), ThinkingMode::High),
                *mode
            );
            assert_eq!(is_thinking_mode(&json!(mode.as_str())), Some(*mode));
        }
        for mode in PERMISSION_MODE_VALUES {
            assert_eq!(
                normalize_permission_mode(&json!(mode.as_str()), PermissionMode::Plan),
                *mode
            );
            assert_eq!(is_permission_mode(&json!(mode.as_str())), Some(*mode));
        }
    }

    #[test]
    fn maps_legacy_persisted_values_to_effort_levels() {
        assert_eq!(
            normalize_thinking_mode(&json!("think"), ThinkingMode::None),
            ThinkingMode::Low
        );
        assert_eq!(
            normalize_thinking_mode(&json!("think-hard"), ThinkingMode::None),
            ThinkingMode::Medium
        );
        assert_eq!(
            normalize_thinking_mode(&json!("think-harder"), ThinkingMode::None),
            ThinkingMode::High
        );
        assert_eq!(
            normalize_thinking_mode(&json!("ultrathink"), ThinkingMode::None),
            ThinkingMode::Max
        );
    }

    #[test]
    fn legacy_values_are_not_valid_canonical_modes() {
        assert_eq!(is_thinking_mode(&json!("ultrathink")), None);
        assert_eq!(is_thinking_mode(&json!("max")), Some(ThinkingMode::Max));
    }

    #[test]
    fn coerce_thinking_mode_returns_none_for_unknown_values() {
        assert_eq!(coerce_thinking_mode(&json!("mega")), None);
        assert_eq!(coerce_thinking_mode(&Value::Null), None);
        assert_eq!(
            normalize_thinking_mode(&json!("mega"), DEFAULT_THINKING_MODE),
            DEFAULT_THINKING_MODE
        );
    }

    #[test]
    fn rejects_prototype_property_names_as_legacy_aliases() {
        assert_eq!(coerce_thinking_mode(&json!("constructor")), None);
        assert_eq!(coerce_thinking_mode(&json!("toString")), None);
        assert_eq!(coerce_thinking_mode(&json!("hasOwnProperty")), None);
        assert_eq!(
            normalize_thinking_mode(&json!("constructor"), DEFAULT_THINKING_MODE),
            DEFAULT_THINKING_MODE
        );
    }

    #[test]
    fn reads_a_mode_only_from_its_exact_name() {
        for value in [
            json!("Default"),
            json!("plan "),
            json!(""),
            json!(5),
            json!(null),
            json!(true),
            json!([]),
        ] {
            assert!(is_permission_mode(&value).is_none(), "{value}");
        }
        for value in [
            json!("None"),
            json!("HIGH"),
            json!(" high"),
            json!([]),
            json!("high "),
            json!(""),
            json!(5),
            json!(null),
            json!(true),
        ] {
            assert!(is_thinking_mode(&value).is_none(), "{value}");
            assert!(coerce_thinking_mode(&value).is_none(), "{value}");
        }
        // The comparison is exact: a padded name is no name.
        assert_eq!(
            normalize_permission_mode(&json!(" plan "), PermissionMode::Default),
            PermissionMode::Default
        );
        assert_eq!(
            normalize_permission_mode(&json!(null), PermissionMode::AcceptEdits),
            PermissionMode::AcceptEdits
        );
        assert_eq!(
            normalize_thinking_mode(&json!("Think"), ThinkingMode::Ultra),
            ThinkingMode::Ultra
        );
        assert_eq!(
            normalize_thinking_mode(&json!("think "), ThinkingMode::Ultra),
            ThinkingMode::Ultra
        );
    }
}
