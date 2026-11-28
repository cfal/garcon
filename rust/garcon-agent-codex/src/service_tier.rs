use garcon_contract::agent_integration::{
    AgentOption, AgentSettingDescriptor, AgentSettingKind, AgentSettingLabelKey,
    AgentSettingsEnvelope,
};
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CodexSpeed {
    #[default]
    Standard,
    Fast,
    Ultrafast,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CodexServiceTier {
    Default,
    Priority,
    Ultrafast,
}

const SPEED_OPTIONS: [(CodexSpeed, &str, &str, &str); 3] = [
    (
        CodexSpeed::Standard,
        "standard",
        "Standard",
        "Normal speed and usage.",
    ),
    (
        CodexSpeed::Fast,
        "fast",
        "Fast",
        "Faster responses with increased usage, where available.",
    ),
    (
        CodexSpeed::Ultrafast,
        "ultrafast",
        "Ultrafast",
        "Fastest responses with higher usage. Availability depends on the model and workspace.",
    ),
];

pub fn codex_speed_setting() -> AgentSettingDescriptor {
    AgentSettingDescriptor {
        key: "speed".into(),
        label: "Speed".into(),
        label_key: Some(AgentSettingLabelKey::Speed),
        kind: AgentSettingKind::Enum {
            options: SPEED_OPTIONS
                .into_iter()
                .map(|(_, value, label, description)| AgentOption {
                    value: value.into(),
                    label: label.into(),
                    label_key: None,
                    description: Some(description.into()),
                    description_key: None,
                })
                .collect(),
        },
    }
}

pub fn codex_speed(settings: &AgentSettingsEnvelope) -> Result<CodexSpeed, AgentIntegrationError> {
    let Some(speed) = settings.values.get("speed") else {
        return Ok(CodexSpeed::Standard);
    };
    SPEED_OPTIONS
        .into_iter()
        .find_map(|(option, value, _, _)| (speed.as_str() == Some(value)).then_some(option))
        .ok_or_else(|| invalid_settings("Invalid value for setting speed"))
}

pub fn codex_service_tier(speed: Option<CodexSpeed>) -> CodexServiceTier {
    match speed.unwrap_or_default() {
        CodexSpeed::Standard => CodexServiceTier::Default,
        CodexSpeed::Fast => CodexServiceTier::Priority,
        CodexSpeed::Ultrafast => CodexServiceTier::Ultrafast,
    }
}

impl CodexServiceTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Priority => "priority",
            Self::Ultrafast => "ultrafast",
        }
    }
}

pub fn normalize_codex_service_tier(tier: Option<&str>) -> &str {
    match tier {
        Some("fast") => "priority",
        Some(tier) => tier,
        None => "default",
    }
}

pub fn assert_effective_tier(
    requested: CodexServiceTier,
    effective: Option<&str>,
    model: &str,
) -> Result<(), AgentIntegrationError> {
    if normalize_codex_service_tier(effective) == requested.as_str() {
        return Ok(());
    }
    let label = match requested {
        CodexServiceTier::Default => "Standard",
        CodexServiceTier::Priority => "Fast",
        CodexServiceTier::Ultrafast => "Ultrafast",
    };
    Err(invalid_settings(format!(
        "Codex {label} speed is unavailable for {model} on this executor. Check the model and workspace settings or choose Standard."
    )))
}

fn invalid_settings(message: impl Into<String>) -> AgentIntegrationError {
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::INVALID_SETTINGS,
        message,
        false,
        None,
    )
}
