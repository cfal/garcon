pub mod active_turn;
pub mod claude_auth;
pub mod claude_auth_login;
pub mod claude_cli;
pub mod cli_control;
pub mod cli_environment;
pub mod cli_invocation;
pub mod cli_process_transport;
pub mod cli_protocol;
pub mod cli_session_state;
pub mod cli_version;
pub mod compaction;
pub mod config;
pub mod context_window_control;
pub mod disk_attachments;
pub mod endpoint_runtime;
pub mod execution;
pub mod history_loader;
pub mod interrupt_receipt;
pub mod model_context;
pub mod native_path;
pub mod permission_response;
pub mod permission_tool_converter;
pub mod process_retirements;
pub mod runtime_state;
pub mod runtime_types;
pub mod session_model;
pub mod session_options;
pub mod single_query_process;
pub mod slash_command_discovery;
pub mod steering;
pub mod tool_result_converter;
pub mod tool_use_converter;
pub mod turn_publisher;
pub mod usage_format;
pub mod user_input;

use std::rc::Rc;

use garcon_agents_common::{
    catalog::model_catalog::ModelCatalog, settings::versioned_settings::VersionedSettings,
};
use garcon_contract::{
    agent_integration::{
        AgentConfigurationDescriptor, AgentConfigurationSource, AgentDescriptor, AgentOption,
        AgentSettingDescriptor, AgentSettingKind, AgentSettingLabelKey,
        AgentSettingOptionDescriptionKey, AgentSettingOptionLabelKey, AgentSettingsEnvelope,
    },
    agents::AgentModelOption,
    api_providers::ApiProtocol,
    chat_modes::{PERMISSION_MODE_VALUES, THINKING_MODE_VALUES},
    models::CLAUDE_MODELS,
};
use garcon_interface::{host::AgentLogger, services::AgentGenerationModel};
use garcon_js::Number;
use serde_json::json;

pub fn claude_descriptor() -> AgentDescriptor {
    AgentDescriptor {
        id: "claude".into(),
        label: "Claude".into(),
        icon: None,
        supported_permission_modes: PERMISSION_MODE_VALUES.to_vec(),
        supported_thinking_modes: THINKING_MODE_VALUES.to_vec(),
        supports_images: true,
        supports_project_path_update: true,
        requires_native_path_for_project_path_update: false,
        supported_endpoint_protocols: vec![ApiProtocol::AnthropicMessages],
        configuration: [
            ("CLAUDE_BINARY", "Claude CLI binary."),
            ("ANTHROPIC_API_KEY", "Anthropic API key."),
            ("ANTHROPIC_BASE_URL", "Anthropic API base URL."),
            ("CLAUDE_CONFIG_DIR", "Claude configuration directory."),
        ]
        .into_iter()
        .map(|(key, description)| AgentConfigurationDescriptor {
            key: key.into(),
            source: AgentConfigurationSource::Environment,
            description: description.into(),
        })
        .collect(),
    }
}

pub fn claude_settings() -> VersionedSettings {
    use AgentSettingOptionDescriptionKey::{ThinkingAutomatic, ThinkingDisabled, ThinkingEnabled};
    use AgentSettingOptionLabelKey::{Automatic, Disabled, Enabled};

    let options = [
        (
            "auto",
            "Auto",
            Automatic,
            "Lets Claude decide when extended thinking is useful.",
            ThinkingAutomatic,
        ),
        (
            "on",
            "On",
            Enabled,
            "Uses extended thinking for every response.",
            ThinkingEnabled,
        ),
        (
            "off",
            "Off",
            Disabled,
            "Answers without extended thinking.",
            ThinkingDisabled,
        ),
    ]
    .into_iter()
    .map(
        |(value, label, label_key, description, description_key)| AgentOption {
            value: value.into(),
            label: label.into(),
            label_key: Some(label_key),
            description: Some(description.into()),
            description_key: Some(description_key),
        },
    )
    .collect();
    VersionedSettings::new(
        AgentSettingsEnvelope {
            owner_id: "claude".into(),
            schema_version: 1,
            values: json!({"claudeThinkingMode":"auto"}).into(),
        },
        vec![AgentSettingDescriptor {
            key: "claudeThinkingMode".into(),
            label: "Thinking".into(),
            label_key: Some(AgentSettingLabelKey::Thinking),
            kind: AgentSettingKind::Enum { options },
        }],
        None,
    )
}

pub fn claude_catalog(logger: Rc<dyn AgentLogger>) -> ModelCatalog {
    ModelCatalog {
        logger,
        default_model: CLAUDE_MODELS.default.into(),
        fallback_models: CLAUDE_MODELS
            .options
            .iter()
            .map(|model| AgentModelOption {
                value: model.value.into(),
                label: model.label.into(),
                supports_images: model.supports_images,
                is_local: None,
                api_provider_id: None,
                endpoint_id: None,
                raw_model: None,
                protocol: None,
            })
            .collect(),
        requires_strict_model_discovery: false,
        generation: Some(AgentGenerationModel {
            priority: Number(10.0),
            model: "haiku".into(),
        }),
        discover: None,
    }
}
