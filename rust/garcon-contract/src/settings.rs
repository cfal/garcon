//! Ports common/settings.ts.

use garcon_js::{OptionalNullable, trim, utf16};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::agent_integration::{AgentSettingsEnvelope, parse_agent_settings_by_id};
use crate::agents::{AgentId, is_agent_id};
use crate::api_providers::{ApiProtocol, is_api_provider_id};
use crate::chat_modes::{
    DEFAULT_PERMISSION_MODE, DEFAULT_THINKING_MODE, PermissionMode, ThinkingMode,
    coerce_thinking_mode, is_permission_mode, normalize_thinking_mode,
};
use crate::executors::{ExecutorId, LOCAL_EXECUTOR_ID, is_remote_executor_id, parse_executor_id};
use crate::generation_prompts::GENERATION_PROMPT_TEMPLATE_MAX_LENGTH;
use crate::handoff_sizing::{
    AgentSwitchContextWindowTokens, parse_agent_switch_context_window_tokens,
};
use crate::hidden_bash_command_patterns::{
    HiddenBashCommandPattern, parse_hidden_bash_command_patterns,
};
use crate::ws_value_parsing::non_negative_int;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PinnedInsertPosition {
    Top,
    Bottom,
}

pub const DEFAULT_APP_TITLE: &str = "Garcon";
pub const APP_TITLE_MAX_LENGTH: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationSelectionUiSettings {
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub executor_id: OptionalNullable<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub api_provider_id: OptionalNullable<String>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub model_endpoint_id: OptionalNullable<String>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub model_protocol: OptionalNullable<ApiProtocol>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_mode: Option<ThinkingMode>,
}

impl GenerationSelectionUiSettings {
    fn is_empty(&self) -> bool {
        self.executor_id.is_absent()
            && self.agent_id.is_none()
            && self.model.is_none()
            && self.api_provider_id.is_absent()
            && self.model_endpoint_id.is_absent()
            && self.model_protocol.is_absent()
            && self.thinking_mode.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTitleUiSettings {
    #[serde(flatten)]
    pub selection: GenerationSelectionUiSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptGenerationUiSettings {
    #[serde(flatten)]
    pub selection: GenerationSelectionUiSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessageUiSettings {
    #[serde(flatten)]
    pub prompt: PromptGenerationUiSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_common_dir_prefix: Option<bool>,
}

pub type PromptRefinementUiSettings = PromptGenerationUiSettings;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketChatUiSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSwitchCompactionUiSettings {
    #[serde(flatten)]
    pub selection: GenerationSelectionUiSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<AgentSwitchContextWindowTokens>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TelegramNotificationSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppIdentityUiSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTelegramStatus {
    pub bot_token_available: bool,
    pub bot_username: Option<String>,
    pub bot_first_name: Option<String>,
    pub recipient_username: Option<String>,
    pub recipient_display_name: Option<String>,
    pub recipient_linked: bool,
    pub pending_link: bool,
    pub link_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteNotificationSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub telegram: Option<TelegramNotificationSettings>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUiSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_insert_position: Option<PinnedInsertPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_bash_command_patterns: Option<Vec<HiddenBashCommandPattern>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_title: Option<ChatTitleUiSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_switch_compaction: Option<AgentSwitchCompactionUiSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_message: Option<CommitMessageUiSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_refinement: Option<PromptRefinementUiSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket_chat: Option<TicketChatUiSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_identity: Option<AppIdentityUiSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notifications: Option<RemoteNotificationSettings>,
}

pub const GENERATION_UI_SETTING_KEYS: [&str; 4] = [
    "chatTitle",
    "agentSwitchCompaction",
    "commitMessage",
    "promptRefinement",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveGenerationSelection {
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub executor_id: OptionalNullable<ExecutorId>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub api_provider_id: OptionalNullable<String>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub model_endpoint_id: OptionalNullable<String>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub model_protocol: OptionalNullable<ApiProtocol>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectivePromptGenerationExtras {
    #[serde(flatten)]
    pub selection: EffectiveGenerationSelection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveCommitMessageExtras {
    #[serde(flatten)]
    pub prompt: EffectivePromptGenerationExtras,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_common_dir_prefix: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectivePromptRefinementUiSettings {
    pub agent_id: AgentId,
    pub model: String,
    pub thinking_mode: ThinkingMode,
    #[serde(flatten)]
    pub extras: EffectivePromptGenerationExtras,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveChatTitleUiSettings {
    pub enabled: bool,
    pub agent_id: AgentId,
    pub model: String,
    pub thinking_mode: ThinkingMode,
    #[serde(flatten)]
    pub selection: EffectiveGenerationSelection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveAgentSwitchCompactionUiSettings {
    pub enabled: bool,
    pub agent_id: AgentId,
    pub model: String,
    pub thinking_mode: ThinkingMode,
    pub context_window_tokens: AgentSwitchContextWindowTokens,
    #[serde(flatten)]
    pub selection: EffectiveGenerationSelection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveCommitMessageUiSettings {
    pub agent_id: AgentId,
    pub model: String,
    pub thinking_mode: ThinkingMode,
    #[serde(flatten)]
    pub extras: EffectiveCommitMessageExtras,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUiEffectiveSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_title: Option<EffectiveChatTitleUiSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_switch_compaction: Option<EffectiveAgentSwitchCompactionUiSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_message: Option<EffectiveCommitMessageUiSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_refinement: Option<EffectivePromptRefinementUiSettings>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePathSettings {
    pub pinned_project_paths: Vec<String>,
    pub browse_start_path: String,
    pub recent_project_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by_executor: Option<IndexMap<ExecutorId, ExecutorProjectPreferences>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorProjectPreferences {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_path: Option<String>,
    pub recent_paths: Vec<String>,
    pub pinned_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorProjectPreferencesPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePathSettingsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_project_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browse_start_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recent_project_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by_executor: Option<IndexMap<ExecutorId, ExecutorProjectPreferencesPatch>>,
}

pub fn parse_executor_project_preferences_patch(
    value: &Value,
) -> Option<IndexMap<ExecutorId, ExecutorProjectPreferencesPatch>> {
    let raw = value.as_object()?;
    raw.iter()
        .map(|(id, candidate)| {
            let entry = candidate.as_object()?;
            if !is_remote_executor_id(&Value::String(id.clone()))
                || entry
                    .keys()
                    .any(|key| !matches!(key.as_str(), "defaultPath" | "pinnedPaths"))
            {
                return None;
            }
            let default_path = optional_string(entry.get("defaultPath"))?;
            let pinned_paths = match entry.get("pinnedPaths") {
                None => None,
                Some(value) => Some(string_array(value)?),
            };
            Some((
                id.clone(),
                ExecutorProjectPreferencesPatch {
                    default_path,
                    pinned_paths,
                },
            ))
        })
        .collect()
}

pub fn parse_executor_project_preferences(
    value: &Value,
) -> Option<IndexMap<ExecutorId, ExecutorProjectPreferences>> {
    let raw = value.as_object()?;
    raw.iter()
        .map(|(id, candidate)| {
            let entry = candidate.as_object()?;
            if !is_remote_executor_id(&Value::String(id.clone())) {
                return None;
            }
            Some((
                id.clone(),
                ExecutorProjectPreferences {
                    default_path: optional_string(entry.get("defaultPath"))?,
                    recent_paths: string_array(field(entry, "recentPaths"))?,
                    pinned_paths: string_array(field(entry, "pinnedPaths"))?,
                },
            ))
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TranscriptSearchFeatureSettings {
    pub enabled: bool,
}

pub const AGENT_COMMAND_SETTING_KEYS: [&str; 7] = [
    "enabled",
    "chatIdDiscovery",
    "sendMessage",
    "startAgent",
    "resumeAgent",
    "schedule",
    "tickets",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentCommandSettingKey {
    Enabled,
    ChatIdDiscovery,
    SendMessage,
    StartAgent,
    ResumeAgent,
    Schedule,
    Tickets,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandsFeatureSettings {
    pub enabled: bool,
    pub chat_id_discovery: bool,
    pub send_message: bool,
    pub start_agent: bool,
    pub resume_agent: bool,
    pub schedule: bool,
    pub tickets: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFeatureSettings {
    pub transcript_search: TranscriptSearchFeatureSettings,
    pub agent_commands: AgentCommandsFeatureSettings,
}

pub const DEFAULT_REMOTE_FEATURE_SETTINGS: RemoteFeatureSettings = RemoteFeatureSettings {
    transcript_search: TranscriptSearchFeatureSettings { enabled: false },
    agent_commands: AgentCommandsFeatureSettings {
        enabled: true,
        chat_id_discovery: true,
        send_message: true,
        start_agent: true,
        resume_agent: true,
        schedule: true,
        tickets: true,
    },
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentAgentSetting {
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub executor_id: OptionalNullable<ExecutorId>,
    pub agent_id: AgentId,
    pub model: String,
    pub api_provider_id: Option<String>,
    pub model_endpoint_id: Option<String>,
    pub model_protocol: Option<ApiProtocol>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionDefaults {
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub agent_settings_by_id: IndexMap<String, AgentSettingsEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionDefaultsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_mode: Option<ThinkingMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_settings_by_id: Option<IndexMap<String, AgentSettingsEnvelope>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteExecutionDefaults {
    pub global: ExecutionDefaults,
    pub by_agent: IndexMap<AgentId, ExecutionDefaultsPatch>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettingsSnapshot {
    pub version: u64,
    pub features: RemoteFeatureSettings,
    pub ui: RemoteUiSettings,
    pub ui_effective: RemoteUiEffectiveSettings,
    pub paths: RemotePathSettings,
    pub pinned_chat_ids: Vec<String>,
    pub recent_agent_settings: Vec<RecentAgentSetting>,
    pub execution_defaults: RemoteExecutionDefaults,
    pub project_base_path: String,
    pub telegram: RemoteTelegramStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFeatureSettingsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_search: Option<TranscriptSearchFeatureSettingsPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_commands: Option<IndexMap<AgentCommandSettingKey, bool>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TranscriptSearchFeatureSettingsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateRemoteSettingsInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub features: Option<RemoteFeatureSettingsPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui: Option<RemoteUiSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths: Option<RemotePathSettingsPatch>,
}

fn field<'a>(object: &'a Map<String, Value>, key: &str) -> &'a Value {
    object.get(key).unwrap_or(&Value::Null)
}

fn string_array(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|entry| entry.as_str().map(str::to_owned))
        .collect()
}

fn optional_string(value: Option<&Value>) -> Option<Option<String>> {
    match value {
        None => Some(None),
        Some(value) => value.as_str().map(|text| Some(text.to_owned())),
    }
}

fn safe_optional_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|_| is_api_provider_id(value))
        .map(str::to_owned)
}

fn safe_optional_protocol(value: &Value) -> Option<ApiProtocol> {
    match value.as_str()? {
        "openai-compatible" => Some(ApiProtocol::OpenAiCompatible),
        "anthropic-messages" => Some(ApiProtocol::AnthropicMessages),
        _ => None,
    }
}

fn optional_nullable<T>(
    value: Option<&Value>,
    parse: impl FnOnce(&Value) -> Option<T>,
) -> OptionalNullable<T> {
    value.map_or(OptionalNullable::ABSENT, |value| {
        OptionalNullable::from(parse(value))
    })
}

fn agent_id(value: &Value) -> Option<AgentId> {
    value
        .as_str()
        .filter(|_| is_agent_id(value))
        .map(str::to_owned)
}

pub fn generation_selection_executor_error(value: &Value) -> Option<&'static str> {
    let raw = value.as_object()?;
    let Some(executor_id) = parse_executor_id(field(raw, "executorId")) else {
        return Some("Invalid executor ID");
    };
    if executor_id != LOCAL_EXECUTOR_ID
        && (!is_agent_id(field(raw, "agentId"))
            || !field(raw, "model")
                .as_str()
                .is_some_and(|model| !trim(model).is_empty()))
    {
        return Some("An explicit executor requires an agent and model");
    }
    None
}

fn normalize_generation_selection(raw: &Map<String, Value>) -> GenerationSelectionUiSettings {
    GenerationSelectionUiSettings {
        executor_id: optional_nullable(raw.get("executorId"), |value| {
            // An invalid explicit target stays unavailable instead of becoming Local.
            (!value.is_null()).then(|| value.as_str().unwrap_or("").to_owned())
        }),
        agent_id: agent_id(field(raw, "agentId")),
        model: field(raw, "model").as_str().map(str::to_owned),
        api_provider_id: optional_nullable(raw.get("apiProviderId"), safe_optional_id),
        model_endpoint_id: optional_nullable(raw.get("modelEndpointId"), safe_optional_id),
        model_protocol: optional_nullable(raw.get("modelProtocol"), safe_optional_protocol),
        thinking_mode: coerce_thinking_mode(field(raw, "thinkingMode")),
    }
}

pub fn normalize_chat_title_ui_settings(value: &Value) -> Option<ChatTitleUiSettings> {
    let raw = value.as_object()?;
    let normalized = ChatTitleUiSettings {
        selection: normalize_generation_selection(raw),
        enabled: field(raw, "enabled").as_bool(),
    };
    (!normalized.selection.is_empty() || normalized.enabled.is_some()).then_some(normalized)
}

pub fn normalize_agent_switch_compaction_ui_settings(
    value: &Value,
) -> Option<AgentSwitchCompactionUiSettings> {
    let raw = value.as_object()?;
    let normalized = AgentSwitchCompactionUiSettings {
        selection: normalize_generation_selection(raw),
        enabled: field(raw, "enabled").as_bool(),
        context_window_tokens: parse_agent_switch_context_window_tokens(field(
            raw,
            "contextWindowTokens",
        )),
    };
    (!normalized.selection.is_empty()
        || normalized.enabled.is_some()
        || normalized.context_window_tokens.is_some())
    .then_some(normalized)
}

fn normalize_generation_prompt_template(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (utf16::len(text) <= GENERATION_PROMPT_TEMPLATE_MAX_LENGTH).then(|| text.to_owned())
}

fn normalize_prompt_generation_ui_settings(raw: &Map<String, Value>) -> PromptGenerationUiSettings {
    PromptGenerationUiSettings {
        selection: normalize_generation_selection(raw),
        custom_prompt: normalize_generation_prompt_template(field(raw, "customPrompt")),
    }
}

pub fn normalize_commit_message_ui_settings(value: &Value) -> Option<CommitMessageUiSettings> {
    let raw = value.as_object()?;
    let normalized = CommitMessageUiSettings {
        prompt: normalize_prompt_generation_ui_settings(raw),
        use_common_dir_prefix: field(raw, "useCommonDirPrefix").as_bool(),
    };
    (!normalized.prompt.selection.is_empty()
        || normalized.prompt.custom_prompt.is_some()
        || normalized.use_common_dir_prefix.is_some())
    .then_some(normalized)
}

pub fn normalize_prompt_refinement_ui_settings(
    value: &Value,
) -> Option<PromptRefinementUiSettings> {
    let normalized = normalize_prompt_generation_ui_settings(value.as_object()?);
    (!normalized.selection.is_empty() || normalized.custom_prompt.is_some()).then_some(normalized)
}

pub fn normalize_ticket_chat_ui_settings(value: &Value) -> Option<TicketChatUiSettings> {
    let raw = value.as_object()?;
    Some(TicketChatUiSettings {
        custom_prompt: Some(field(raw, "customPrompt").as_str()?.to_owned()),
    })
}

fn normalize_app_identity_ui_settings(value: &Value) -> Option<AppIdentityUiSettings> {
    let raw = value.as_object()?;
    let title = trim(field(raw, "title").as_str()?);
    (!title.is_empty() && utf16::len(title) <= APP_TITLE_MAX_LENGTH).then(|| {
        AppIdentityUiSettings {
            title: Some(title.to_owned()),
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Invalid executor ID")]
pub struct InvalidExecutorId;

fn normalize_effective_generation_selection(
    raw: &Map<String, Value>,
) -> Result<EffectiveGenerationSelection, InvalidExecutorId> {
    let executor_id = match raw.get("executorId") {
        None => OptionalNullable::ABSENT,
        Some(id) => OptionalNullable::some(parse_executor_id(id).ok_or(InvalidExecutorId)?),
    };
    Ok(EffectiveGenerationSelection {
        executor_id,
        api_provider_id: optional_nullable(raw.get("apiProviderId"), safe_optional_id),
        model_endpoint_id: optional_nullable(raw.get("modelEndpointId"), safe_optional_id),
        model_protocol: optional_nullable(raw.get("modelProtocol"), safe_optional_protocol),
    })
}

fn normalize_effective_prompt_generation_extras(
    raw: &Map<String, Value>,
) -> Result<EffectivePromptGenerationExtras, InvalidExecutorId> {
    Ok(EffectivePromptGenerationExtras {
        selection: normalize_effective_generation_selection(raw)?,
        custom_prompt: normalize_generation_prompt_template(field(raw, "customPrompt")),
    })
}

fn normalize_effective_commit_message_extras(
    raw: &Map<String, Value>,
) -> Result<EffectiveCommitMessageExtras, InvalidExecutorId> {
    Ok(EffectiveCommitMessageExtras {
        prompt: normalize_effective_prompt_generation_extras(raw)?,
        use_common_dir_prefix: field(raw, "useCommonDirPrefix").as_bool(),
    })
}

fn normalize_prompt_refinement_ui_effective_settings(
    value: &Value,
) -> Result<Option<EffectivePromptRefinementUiSettings>, InvalidExecutorId> {
    let Some(raw) = value.as_object() else {
        return Ok(None);
    };
    let (Some(agent_id), Some(model)) = (
        agent_id(field(raw, "agentId")),
        field(raw, "model").as_str(),
    ) else {
        return Ok(None);
    };
    Ok(Some(EffectivePromptRefinementUiSettings {
        agent_id,
        model: model.to_owned(),
        thinking_mode: normalize_thinking_mode(field(raw, "thinkingMode"), DEFAULT_THINKING_MODE),
        extras: normalize_effective_prompt_generation_extras(raw)?,
    }))
}

fn normalize_chat_title_ui_effective_settings(
    value: &Value,
) -> Result<Option<EffectiveChatTitleUiSettings>, InvalidExecutorId> {
    let Some(raw) = value.as_object() else {
        return Ok(None);
    };
    let (Some(enabled), Some(agent_id), Some(model)) = (
        field(raw, "enabled").as_bool(),
        agent_id(field(raw, "agentId")),
        field(raw, "model").as_str(),
    ) else {
        return Ok(None);
    };
    Ok(Some(EffectiveChatTitleUiSettings {
        enabled,
        agent_id,
        model: model.to_owned(),
        thinking_mode: normalize_thinking_mode(field(raw, "thinkingMode"), DEFAULT_THINKING_MODE),
        selection: normalize_effective_generation_selection(raw)?,
    }))
}

fn normalize_agent_switch_compaction_ui_effective_settings(
    value: &Value,
) -> Result<Option<EffectiveAgentSwitchCompactionUiSettings>, InvalidExecutorId> {
    let Some(raw) = value.as_object() else {
        return Ok(None);
    };
    let (Some(enabled), Some(agent_id), Some(model), Some(context_window_tokens)) = (
        field(raw, "enabled").as_bool(),
        agent_id(field(raw, "agentId")),
        field(raw, "model").as_str(),
        parse_agent_switch_context_window_tokens(field(raw, "contextWindowTokens")),
    ) else {
        return Ok(None);
    };
    Ok(Some(EffectiveAgentSwitchCompactionUiSettings {
        enabled,
        agent_id,
        model: model.to_owned(),
        thinking_mode: normalize_thinking_mode(field(raw, "thinkingMode"), DEFAULT_THINKING_MODE),
        context_window_tokens,
        selection: normalize_effective_generation_selection(raw)?,
    }))
}

fn normalize_commit_message_ui_effective_settings(
    value: &Value,
) -> Result<Option<EffectiveCommitMessageUiSettings>, InvalidExecutorId> {
    let Some(raw) = value.as_object() else {
        return Ok(None);
    };
    let (Some(agent_id), Some(model)) = (
        agent_id(field(raw, "agentId")),
        field(raw, "model").as_str(),
    ) else {
        return Ok(None);
    };
    Ok(Some(EffectiveCommitMessageUiSettings {
        agent_id,
        model: model.to_owned(),
        thinking_mode: normalize_thinking_mode(field(raw, "thinkingMode"), DEFAULT_THINKING_MODE),
        extras: normalize_effective_commit_message_extras(raw)?,
    }))
}

fn normalize_remote_ui_settings(value: &Value) -> Option<RemoteUiSettings> {
    let raw = value.as_object()?;
    let pinned_insert_position = match field(raw, "pinnedInsertPosition").as_str() {
        Some("top") => Some(PinnedInsertPosition::Top),
        Some("bottom") => Some(PinnedInsertPosition::Bottom),
        _ => None,
    };
    let hidden_bash_command_patterns = raw
        .get("hiddenBashCommandPatterns")
        .and_then(parse_hidden_bash_command_patterns);
    let chat_title = normalize_chat_title_ui_settings(field(raw, "chatTitle"));
    let agent_switch_compaction =
        normalize_agent_switch_compaction_ui_settings(field(raw, "agentSwitchCompaction"));
    let commit_message = normalize_commit_message_ui_settings(field(raw, "commitMessage"));
    let prompt_refinement = normalize_prompt_refinement_ui_settings(field(raw, "promptRefinement"));
    let ticket_chat = normalize_ticket_chat_ui_settings(field(raw, "ticketChat"));
    let app_identity = normalize_app_identity_ui_settings(field(raw, "appIdentity"));
    let notifications = field(raw, "notifications")
        .as_object()
        .and_then(|settings| field(settings, "telegram").as_object())
        .and_then(|settings| field(settings, "enabled").as_bool())
        .map(|enabled| RemoteNotificationSettings {
            telegram: Some(TelegramNotificationSettings {
                enabled: Some(enabled),
            }),
        });
    Some(RemoteUiSettings {
        pinned_insert_position,
        hidden_bash_command_patterns,
        chat_title,
        agent_switch_compaction,
        commit_message,
        prompt_refinement,
        ticket_chat,
        app_identity,
        notifications,
    })
}

fn normalize_remote_ui_effective_settings(
    value: &Value,
) -> Result<Option<RemoteUiEffectiveSettings>, InvalidExecutorId> {
    let Some(raw) = value.as_object() else {
        return Ok(None);
    };
    Ok(Some(RemoteUiEffectiveSettings {
        chat_title: normalize_chat_title_ui_effective_settings(field(raw, "chatTitle"))?,
        agent_switch_compaction: normalize_agent_switch_compaction_ui_effective_settings(field(
            raw,
            "agentSwitchCompaction",
        ))?,
        commit_message: normalize_commit_message_ui_effective_settings(field(
            raw,
            "commitMessage",
        ))?,
        prompt_refinement: normalize_prompt_refinement_ui_effective_settings(field(
            raw,
            "promptRefinement",
        ))?,
    }))
}

fn normalize_remote_path_settings(value: &Value) -> Option<RemotePathSettings> {
    let raw = value.as_object()?;
    let pinned_project_paths = string_array(field(raw, "pinnedProjectPaths"))?;
    let browse_start_path = field(raw, "browseStartPath").as_str()?.to_owned();
    let recent_project_paths = string_array(field(raw, "recentProjectPaths"))?;
    let by_executor = match raw.get("byExecutor") {
        None => None,
        Some(value) => Some(parse_executor_project_preferences(value)?),
    };
    Some(RemotePathSettings {
        pinned_project_paths,
        browse_start_path,
        recent_project_paths,
        by_executor,
    })
}

pub fn normalize_remote_feature_settings(value: &Value) -> RemoteFeatureSettings {
    let raw = value.as_object();
    let object = |key| {
        raw.and_then(|value| value.get(key))
            .and_then(Value::as_object)
    };
    let transcript_search = object("transcriptSearch");
    let agent_commands = object("agentCommands");
    let legacy_chat_id_discovery = object("chatIdDiscovery");
    let chat_id_discovery = match agent_commands {
        Some(commands) => commands.get("chatIdDiscovery"),
        None => legacy_chat_id_discovery.and_then(|discovery| discovery.get("enabled")),
    };
    let enabled = |key| {
        agent_commands
            .and_then(|commands| commands.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(true)
    };
    RemoteFeatureSettings {
        transcript_search: TranscriptSearchFeatureSettings {
            enabled: transcript_search
                .and_then(|search| search.get("enabled"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        agent_commands: AgentCommandsFeatureSettings {
            enabled: enabled("enabled"),
            chat_id_discovery: chat_id_discovery.and_then(Value::as_bool).unwrap_or(true),
            send_message: enabled("sendMessage"),
            start_agent: enabled("startAgent"),
            resume_agent: enabled("resumeAgent"),
            schedule: enabled("schedule"),
            tickets: enabled("tickets"),
        },
    }
}

fn normalize_recent_agent_setting(value: &Value) -> Option<RecentAgentSetting> {
    let raw = value.as_object()?;
    let model = field(raw, "model").as_str()?;
    let agent_id = agent_id(field(raw, "agentId"))?;
    if trim(model).is_empty() {
        return None;
    }
    let executor_id = parse_executor_id(field(raw, "executorId"))?;
    Some(RecentAgentSetting {
        executor_id: if raw.contains_key("executorId") {
            OptionalNullable::some(executor_id)
        } else {
            OptionalNullable::ABSENT
        },
        agent_id,
        model: model.to_owned(),
        api_provider_id: safe_optional_id(field(raw, "apiProviderId")),
        model_endpoint_id: safe_optional_id(field(raw, "modelEndpointId")),
        model_protocol: safe_optional_protocol(field(raw, "modelProtocol")),
    })
}

fn normalize_recent_agent_settings(value: &Value) -> Option<Vec<RecentAgentSetting>> {
    value
        .as_array()?
        .iter()
        .map(normalize_recent_agent_setting)
        .collect()
}

fn normalize_execution_defaults(value: &Value) -> Option<ExecutionDefaults> {
    let raw = value.as_object()?;
    Some(ExecutionDefaults {
        permission_mode: is_permission_mode(field(raw, "permissionMode"))?,
        thinking_mode: coerce_thinking_mode(field(raw, "thinkingMode"))?,
        agent_settings_by_id: parse_agent_settings_by_id(field(raw, "agentSettingsById"))?,
    })
}

fn normalize_execution_defaults_patch(value: &Value) -> Option<ExecutionDefaultsPatch> {
    let raw = value.as_object()?;
    Some(ExecutionDefaultsPatch {
        permission_mode: match raw.get("permissionMode") {
            None => None,
            Some(value) => Some(is_permission_mode(value)?),
        },
        thinking_mode: match raw.get("thinkingMode") {
            None => None,
            Some(value) => Some(coerce_thinking_mode(value)?),
        },
        agent_settings_by_id: match raw.get("agentSettingsById") {
            None => None,
            Some(value) => Some(parse_agent_settings_by_id(value)?),
        },
    })
}

fn normalize_remote_execution_defaults(value: &Value) -> Option<RemoteExecutionDefaults> {
    let raw = value.as_object()?;
    let global = normalize_execution_defaults(field(raw, "global"))?;
    let raw_by_agent = field(raw, "byAgent").as_object()?;
    let by_agent = raw_by_agent
        .iter()
        .map(|(id, defaults)| {
            let agent_id = agent_id(&Value::String(id.clone()))?;
            let patch = normalize_execution_defaults_patch(defaults)?;
            Some((agent_id, patch))
        })
        .collect::<Option<_>>()?;
    Some(RemoteExecutionDefaults { global, by_agent })
}

pub fn default_execution_defaults() -> ExecutionDefaults {
    ExecutionDefaults {
        permission_mode: DEFAULT_PERMISSION_MODE,
        thinking_mode: DEFAULT_THINKING_MODE,
        agent_settings_by_id: IndexMap::new(),
    }
}

fn normalize_remote_telegram_status(value: &Value) -> Option<RemoteTelegramStatus> {
    let raw = value.as_object()?;
    let bot_token_available = field(raw, "botTokenAvailable").as_bool()?;
    let recipient_linked = field(raw, "recipientLinked").as_bool()?;
    let pending_link = field(raw, "pendingLink").as_bool()?;
    let nullable = |key| match field(raw, key) {
        Value::Null => Some(None),
        Value::String(value) => Some(Some(value.clone())),
        _ => None,
    };
    Some(RemoteTelegramStatus {
        bot_token_available,
        bot_username: nullable("botUsername")?,
        bot_first_name: nullable("botFirstName")?,
        recipient_username: nullable("recipientUsername")?,
        recipient_display_name: nullable("recipientDisplayName")?,
        recipient_linked,
        pending_link,
        link_url: nullable("linkUrl")?,
    })
}

pub fn normalize_remote_settings_snapshot(
    value: &Value,
) -> Result<Option<RemoteSettingsSnapshot>, InvalidExecutorId> {
    let Some(raw) = value.as_object() else {
        return Ok(None);
    };
    let version = non_negative_int(field(raw, "version"));
    let features = normalize_remote_feature_settings(field(raw, "features"));
    let ui = normalize_remote_ui_settings(field(raw, "ui"));
    // Invalid effective targets throw even if another field makes the snapshot incomplete.
    let ui_effective = normalize_remote_ui_effective_settings(field(raw, "uiEffective"))?;
    let paths = normalize_remote_path_settings(field(raw, "paths"));
    let pinned_chat_ids = string_array(field(raw, "pinnedChatIds"));
    let project_base_path = field(raw, "projectBasePath").as_str();
    let recent_agent_settings = normalize_recent_agent_settings(field(raw, "recentAgentSettings"));
    let execution_defaults = normalize_remote_execution_defaults(field(raw, "executionDefaults"));
    let telegram = normalize_remote_telegram_status(field(raw, "telegram"));
    let (
        Some(version),
        Some(ui),
        Some(ui_effective),
        Some(paths),
        Some(pinned_chat_ids),
        Some(project_base_path),
        Some(recent_agent_settings),
        Some(execution_defaults),
        Some(telegram),
    ) = (
        version,
        ui,
        ui_effective,
        paths,
        pinned_chat_ids,
        project_base_path,
        recent_agent_settings,
        execution_defaults,
        telegram,
    )
    else {
        return Ok(None);
    };
    Ok(Some(RemoteSettingsSnapshot {
        version,
        features,
        ui,
        ui_effective,
        paths,
        pinned_chat_ids,
        recent_agent_settings,
        execution_defaults,
        project_base_path: project_base_path.to_owned(),
        telegram,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(ui: Value) -> Value {
        json!({
            "version": 1,
            "features": {"transcriptSearch": {"enabled": false}},
            "ui": ui,
            "uiEffective": {},
            "paths": {"pinnedProjectPaths": [], "browseStartPath": "", "recentProjectPaths": []},
            "pinnedChatIds": [],
            "recentAgentSettings": [],
            "executionDefaults": {
                "global": {"permissionMode": "default", "thinkingMode": "none", "agentSettingsById": {}},
                "byAgent": {},
            },
            "projectBasePath": "",
            "telegram": {"botTokenAvailable": false, "recipientLinked": false, "pendingLink": false},
        })
    }

    #[test]
    fn normalizes_the_independent_ticket_command_gate() {
        for value in [
            json!(true),
            json!(false),
            json!("false"),
            Value::Null,
            json!(0),
        ] {
            let commands = normalize_remote_feature_settings(
                &json!({"agentCommands":{"tickets":value,"schedule":false}}),
            )
            .agent_commands;
            assert_eq!(commands.tickets, value.as_bool().unwrap_or(true));
            assert!(!commands.schedule);
        }
    }

    #[test]
    fn normalizes_the_independent_resume_gate_without_changing_start_or_send_authority() {
        for value in [
            json!(true),
            json!(false),
            json!("false"),
            Value::Null,
            json!(0),
        ] {
            let commands = normalize_remote_feature_settings(&json!({"agentCommands":{
                "resumeAgent":value,"startAgent":false,"sendMessage":false
            }}))
            .agent_commands;
            assert_eq!(commands.resume_agent, value.as_bool().unwrap_or(true));
            assert!(!commands.start_agent);
            assert!(!commands.send_message);
        }
    }

    #[test]
    fn defaults_agent_commands_to_enabled_and_normalizes_partial_command_settings() {
        assert_eq!(
            normalize_remote_feature_settings(&Value::Null),
            DEFAULT_REMOTE_FEATURE_SETTINGS
        );
        let normalized = normalize_remote_feature_settings(
            &json!({"agentCommands":{"enabled":false,"sendMessage":false}}),
        );
        assert_eq!(
            normalized.agent_commands,
            AgentCommandsFeatureSettings {
                enabled: false,
                send_message: false,
                ..DEFAULT_REMOTE_FEATURE_SETTINGS.agent_commands
            }
        );
    }

    #[test]
    fn migrates_legacy_discovery_only_when_the_agent_command_object_is_absent_or_invalid() {
        for (commands, expected) in [
            (None, false),
            (Some(json!({"enabled":true})), true),
            (Some(json!("invalid")), false),
        ] {
            let mut features = json!({"chatIdDiscovery":{"enabled":false}});
            if let Some(commands) = commands {
                features["agentCommands"] = commands;
            }
            assert_eq!(
                normalize_remote_feature_settings(&features)
                    .agent_commands
                    .chat_id_discovery,
                expected
            );
        }
    }

    #[test]
    fn accepts_only_supported_compaction_context_window_presets() {
        for choice in [200_000, 500_000, 1_000_000] {
            assert_eq!(
                json!(normalize_agent_switch_compaction_ui_settings(
                    &json!({"contextWindowTokens":choice})
                )),
                json!({"contextWindowTokens":choice})
            );
        }
        for rejected in [
            json!("500000"),
            json!(500_000.5),
            json!(250_000),
            Value::Null,
        ] {
            let input = json!({"enabled":true,"contextWindowTokens":rejected});
            assert_eq!(
                json!(normalize_agent_switch_compaction_ui_settings(&input)),
                json!({"enabled":true})
            );
        }
    }

    #[test]
    fn keeps_title_settings_limited_to_title_generation_fields() {
        let input = json!({
            "enabled":true,"agentId":"codex","model":"gpt-5.5","thinkingMode":"medium",
            "customPrompt":"Unsupported title prompt","useCommonDirPrefix":true,
        });
        assert_eq!(
            json!(normalize_chat_title_ui_settings(&input)),
            json!({
                "enabled":true,"agentId":"codex","model":"gpt-5.5","thinkingMode":"medium"
            })
        );
    }

    #[test]
    fn keeps_commit_only_prompt_fields_while_dropping_title_only_enabled_state() {
        let input = json!({
            "enabled":false,"agentId":"codex","model":"gpt-5.5","customPrompt":"Summarize the diff","useCommonDirPrefix":true,
        });
        assert_eq!(
            json!(normalize_commit_message_ui_settings(&input)),
            json!({
                "agentId":"codex","model":"gpt-5.5","customPrompt":"Summarize the diff","useCommonDirPrefix":true
            })
        );
    }

    #[test]
    fn keeps_refinement_prompt_fields_while_dropping_unrelated_target_fields() {
        let input = json!({
            "enabled":false,"agentId":"codex","model":"gpt-5.5","customPrompt":"Refine {{USER_PROMPT}}","useCommonDirPrefix":true,
        });
        assert_eq!(
            json!(normalize_prompt_refinement_ui_settings(&input)),
            json!({
                "agentId":"codex","model":"gpt-5.5","customPrompt":"Refine {{USER_PROMPT}}"
            })
        );
    }

    #[test]
    fn drops_oversized_prompt_templates_without_losing_valid_selection_fields() {
        let oversize = json!({"agentId":"codex","customPrompt":"\u{1f600}".repeat(16_001)});
        assert_eq!(
            json!(normalize_commit_message_ui_settings(&oversize)),
            json!({"agentId":"codex"})
        );
        assert_eq!(
            json!(normalize_prompt_refinement_ui_settings(&oversize)),
            json!({"agentId":"codex"})
        );
    }

    #[test]
    fn strips_commit_only_fields_from_persisted_and_effective_title_snapshots() {
        let generator = json!({
            "enabled":true,"agentId":"codex","model":"gpt-5.5","thinkingMode":"medium",
            "customPrompt":"test prompt","useCommonDirPrefix":true,
        });
        let ui =
            json!({"chatTitle":generator,"commitMessage":generator,"promptRefinement":generator});
        let mut input = snapshot(ui.clone());
        input["uiEffective"] = ui;
        let parsed = json!(normalize_remote_settings_snapshot(&input).unwrap().unwrap());
        for branch in ["ui", "uiEffective"] {
            let title = parsed[branch]["chatTitle"].as_object().unwrap();
            assert!(!title.contains_key("customPrompt"));
            assert!(!title.contains_key("useCommonDirPrefix"));
            assert_eq!(
                parsed[branch]["commitMessage"]["customPrompt"],
                json!("test prompt")
            );
            assert_eq!(
                parsed[branch]["commitMessage"]["useCommonDirPrefix"],
                json!(true)
            );
            assert_eq!(
                parsed[branch]["promptRefinement"],
                json!({
                    "agentId":"codex","model":"gpt-5.5","thinkingMode":"medium","customPrompt":"test prompt"
                })
            );
        }
    }

    #[test]
    fn requires_a_supported_context_window_in_effective_compaction_settings() {
        let mut input = snapshot(json!({}));
        for value in [
            json!(200_000),
            json!(500_000),
            json!(1_000_000),
            json!("500000"),
            json!(500_000.5),
            json!(250_000),
            Value::Null,
        ] {
            input["uiEffective"] = json!({"agentSwitchCompaction":{
                "enabled":true,"agentId":"codex","model":"m","thinkingMode":"medium","contextWindowTokens":value,
            }});
            let parsed = normalize_remote_settings_snapshot(&input).unwrap().unwrap();
            let actual = parsed
                .ui_effective
                .agent_switch_compaction
                .map(|settings| settings.context_window_tokens);
            assert_eq!(actual, parse_agent_switch_context_window_tokens(&value));
        }
        input["uiEffective"]["agentSwitchCompaction"]
            .as_object_mut()
            .unwrap()
            .remove("contextWindowTokens");
        assert!(
            normalize_remote_settings_snapshot(&input)
                .unwrap()
                .unwrap()
                .ui_effective
                .agent_switch_compaction
                .is_none()
        );
    }

    #[test]
    fn normalizes_and_deduplicates_the_canonical_list() {
        let input = snapshot(json!({"hiddenBashCommandPatterns":[
            {"pattern":"git *","mode":"glob"},{"pattern":"^cargo","mode":"regex"},{"pattern":"git *","mode":"glob"},
        ]}));
        let normalized = normalize_remote_settings_snapshot(&input).unwrap().unwrap();
        assert_eq!(
            json!(normalized.ui.hidden_bash_command_patterns),
            json!([
                {"pattern":"git *","mode":"glob"},{"pattern":"^cargo","mode":"regex"},
            ])
        );
    }

    #[test]
    fn drops_a_malformed_optional_list_without_rejecting_the_snapshot() {
        let input = snapshot(json!({
            "pinnedInsertPosition":"bottom","hiddenBashCommandPatterns":[{"pattern":"([unclosed","mode":"regex"}],
        }));
        let normalized = normalize_remote_settings_snapshot(&input).unwrap().unwrap();
        assert_eq!(
            json!(normalized.ui),
            json!({"pinnedInsertPosition":"bottom"})
        );
    }

    #[test]
    fn preserves_invalid_explicit_targets_in_persisted_ui_and_rejects_them_in_effective_ui() {
        let mut input = snapshot(json!({"promptRefinement":{"executorId":false,"model":"m"}}));
        let normalized = normalize_remote_settings_snapshot(&input).unwrap().unwrap();
        assert_eq!(
            json!(normalized.ui.prompt_refinement),
            json!({"executorId":"","model":"m"})
        );
        input["version"] = json!(-1);
        input["uiEffective"]["promptRefinement"] =
            json!({"agentId":"codex","model":"m","executorId":false});
        assert_eq!(
            normalize_remote_settings_snapshot(&input),
            Err(InvalidExecutorId)
        );
    }
}
