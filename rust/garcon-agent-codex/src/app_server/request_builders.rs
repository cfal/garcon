use std::sync::LazyLock;

use garcon_contract::{
    chat_modes::{PermissionMode, ThinkingMode},
    models::{
        GPT_6_1_SOL_MODEL, GPT_6_1_TERRA_MODEL, GPT_6_2_ASTRA_MODEL, GPT_6_2_SOL_MODEL,
        GPT_6_ASTRA_MODEL, GPT_6_LUNA_MODEL, GPT_6_SOL_MODEL,
    },
};
use garcon_js::{json::stringify, trim};
use indexmap::IndexMap;
use regress::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::{
    runtime_types::{CodexConfigObject, CodexProviderConfig},
    service_tier::{
        CodexServiceTier, CodexSpeed, codex_service_tier, normalize_codex_service_tier,
    },
    slash_command_discovery::CodexSkillRef,
};

pub fn codex_source_runtime_identity(
    env_overrides: Option<&IndexMap<String, String>>,
    codex_config: Option<&CodexProviderConfig>,
) -> String {
    let source = stable_stringify(&json!({
        "env": build_codex_env(env_overrides, codex_config),
        "config": codex_config.map(|config| &config.config),
        "modelCatalogPath": codex_config.and_then(|config| config.model_catalog_path.as_ref()),
    }));
    format!("{:x}", Sha256::digest(source))
}

fn stable_stringify(value: &Value) -> String {
    fn write(value: &Value, out: &mut String) {
        match value {
            Value::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index != 0 {
                        out.push(',');
                    }
                    write(item, out);
                }
                out.push(']');
            }
            Value::Object(object) => {
                let mut entries: Vec<_> = object.iter().collect();
                entries.sort_unstable_by(|(left, _), (right, _)| {
                    left.encode_utf16().cmp(right.encode_utf16())
                });
                out.push('{');
                for (index, (key, child)) in entries.into_iter().enumerate() {
                    if index != 0 {
                        out.push(',');
                    }
                    out.push_str(&stringify(&Value::String(key.clone())));
                    out.push(':');
                    write(child, out);
                }
                out.push('}');
            }
            _ => out.push_str(&stringify(value)),
        }
    }
    let mut out = String::new();
    write(value, &mut out);
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeadingSlashCommand<'a> {
    pub name: &'a str,
    pub rest: &'a str,
}

pub fn parse_leading_slash_command(command: &str) -> Option<LeadingSlashCommand<'_>> {
    static LEADING_SLASH: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::new(r"^/([a-zA-Z0-9:_-]+)(?:\s+([\s\S]*))?$").expect("Codex slash command pattern")
    });
    let parsed = LEADING_SLASH.find(command)?;
    Some(LeadingSlashCommand {
        name: &command[parsed.group(1)?],
        rest: parsed.group(2).map_or("", |range| &command[range]),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexSandboxMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexApprovalPolicy {
    Never,
    OnRequest,
}

impl CodexApprovalPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Never => "never",
            Self::OnRequest => "on-request",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSandboxSettings {
    pub sandbox: CodexSandboxMode,
    pub approval_policy: CodexApprovalPolicy,
}

pub fn codex_sandbox_settings(permission_mode: PermissionMode) -> CodexSandboxSettings {
    let sandbox = match permission_mode {
        PermissionMode::BypassPermissions => CodexSandboxMode::DangerFullAccess,
        _ => CodexSandboxMode::WorkspaceWrite,
    };
    let approval_policy = match permission_mode {
        PermissionMode::ManualBypass => CodexApprovalPolicy::OnRequest,
        _ => CodexApprovalPolicy::Never,
    };
    CodexSandboxSettings {
        sandbox,
        approval_policy,
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct CodexThreadSettingsSandboxPolicy {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

impl CodexThreadSettingsSandboxPolicy {
    fn danger_full_access() -> Self {
        Self {
            kind: "dangerFullAccess".into(),
            fields: Map::new(),
        }
    }

    fn workspace_write(fields: &Map<String, Value>) -> Self {
        let mut normalized = Map::new();
        normalized.insert("writableRoots".into(), json!([]));
        for key in ["networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"] {
            normalized.insert(
                key.into(),
                fields
                    .get(key)
                    .filter(|value| !value.is_null())
                    .cloned()
                    .unwrap_or(Value::Bool(false)),
            );
        }
        Self {
            kind: "workspaceWrite".into(),
            fields: normalized,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadConfiguration {
    pub model: String,
    pub permission_mode: PermissionMode,
    pub thinking_mode: Option<ThinkingMode>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadSettingsTarget {
    pub model: String,
    pub effort: Option<String>,
    pub approval_policy: CodexApprovalPolicy,
    pub approvals_reviewer: String,
    pub sandbox_policy: CodexThreadSettingsSandboxPolicy,
    pub permission_mode: PermissionMode,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConfirmedThreadSettings {
    pub model: String,
    pub service_tier: String,
    pub effort: Option<String>,
    pub approval_policy: Value,
    pub approvals_reviewer: String,
    pub sandbox_policy: CodexThreadSettingsSandboxPolicy,
    pub permission_mode: PermissionMode,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadSettings {
    pub model: String,
    pub service_tier: Option<String>,
    pub effort: Option<String>,
    pub approval_policy: Value,
    pub approvals_reviewer: String,
    pub sandbox_policy: CodexThreadSettingsSandboxPolicy,
}

pub fn codex_thread_settings_target(
    configuration: &CodexThreadConfiguration,
) -> CodexThreadSettingsTarget {
    let settings = codex_sandbox_settings(configuration.permission_mode);
    CodexThreadSettingsTarget {
        model: configuration.model.clone(),
        effort: map_thinking_mode_to_codex_effort(
            configuration.thinking_mode,
            Some(&configuration.model),
        )
        .map(str::to_owned),
        approval_policy: settings.approval_policy,
        approvals_reviewer: "user".into(),
        sandbox_policy: if settings.sandbox == CodexSandboxMode::DangerFullAccess {
            CodexThreadSettingsSandboxPolicy::danger_full_access()
        } else {
            CodexThreadSettingsSandboxPolicy::workspace_write(&Map::new())
        },
        permission_mode: configuration.permission_mode,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSettingsUpdateParams<'a> {
    pub thread_id: &'a str,
    pub model: &'a str,
    pub approval_policy: CodexApprovalPolicy,
    pub approvals_reviewer: &'a str,
    pub sandbox_policy: &'a CodexThreadSettingsSandboxPolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<&'a str>,
}

pub fn build_thread_settings_update_params<'a>(
    thread_id: &'a str,
    target: &'a CodexThreadSettingsTarget,
) -> ThreadSettingsUpdateParams<'a> {
    ThreadSettingsUpdateParams {
        thread_id,
        model: &target.model,
        approval_policy: target.approval_policy,
        approvals_reviewer: &target.approvals_reviewer,
        sandbox_policy: &target.sandbox_policy,
        effort: target.effort.as_deref(),
    }
}

pub fn thread_settings_match(
    settings: &CodexConfirmedThreadSettings,
    target: &CodexThreadSettingsTarget,
) -> bool {
    settings.model == target.model
        && (target.effort.is_none() || settings.effort == target.effort)
        && settings.approval_policy.as_str() == Some(target.approval_policy.as_str())
        && settings.approvals_reviewer == target.approvals_reviewer
        && sandbox_policy_matches(&settings.sandbox_policy, &target.sandbox_policy)
}

pub fn thread_settings_target_from_snapshot(
    settings: &CodexThreadSettings,
    current: PermissionMode,
) -> CodexConfirmedThreadSettings {
    let permission_mode = if settings.sandbox_policy.kind == "dangerFullAccess" {
        PermissionMode::BypassPermissions
    } else if settings.approval_policy.as_str() == Some("on-request") {
        PermissionMode::ManualBypass
    } else {
        match current {
            PermissionMode::ManualBypass | PermissionMode::BypassPermissions => {
                PermissionMode::Default
            }
            current => current,
        }
    };
    CodexConfirmedThreadSettings {
        model: settings.model.clone(),
        service_tier: normalize_codex_service_tier(settings.service_tier.as_deref()).into(),
        effort: settings.effort.clone(),
        approval_policy: settings.approval_policy.clone(),
        approvals_reviewer: settings.approvals_reviewer.clone(),
        sandbox_policy: match settings.sandbox_policy.kind.as_str() {
            "dangerFullAccess" => CodexThreadSettingsSandboxPolicy::danger_full_access(),
            "workspaceWrite" => {
                CodexThreadSettingsSandboxPolicy::workspace_write(&settings.sandbox_policy.fields)
            }
            _ => settings.sandbox_policy.clone(),
        },
        permission_mode,
    }
}

fn sandbox_policy_matches(
    left: &CodexThreadSettingsSandboxPolicy,
    right: &CodexThreadSettingsSandboxPolicy,
) -> bool {
    left.kind == right.kind
        && (left.kind != "workspaceWrite"
            || ["networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"]
                .into_iter()
                .all(|key| {
                    let default = &Value::Bool(false);
                    let left = left
                        .fields
                        .get(key)
                        .filter(|value| !value.is_null())
                        .unwrap_or(default);
                    let right = right
                        .fields
                        .get(key)
                        .filter(|value| !value.is_null())
                        .unwrap_or(default);
                    left == right
                }))
}

pub fn map_thinking_mode_to_codex_effort(
    thinking_mode: Option<ThinkingMode>,
    model: Option<&str>,
) -> Option<&'static str> {
    match thinking_mode? {
        ThinkingMode::None => None,
        ThinkingMode::Max => Some(if codex_model_supports_max_effort(model) {
            "max"
        } else {
            "xhigh"
        }),
        mode => Some(mode.as_str()),
    }
}

fn codex_model_supports_max_effort(model: Option<&str>) -> bool {
    model.is_some_and(|model| {
        [
            GPT_6_2_SOL_MODEL,
            GPT_6_2_ASTRA_MODEL,
            GPT_6_ASTRA_MODEL,
            GPT_6_1_SOL_MODEL,
            GPT_6_1_TERRA_MODEL,
            GPT_6_SOL_MODEL,
            GPT_6_LUNA_MODEL,
            "gpt-5.6",
        ]
        .into_iter()
        .any(|value| {
            model == value
                || model
                    .strip_suffix(value)
                    .is_some_and(|prefix| prefix.ends_with(':'))
        }) || model.starts_with("gpt-5.6-")
    })
}

pub fn build_codex_env(
    env_overrides: Option<&IndexMap<String, String>>,
    codex_config: Option<&CodexProviderConfig>,
) -> Option<IndexMap<String, String>> {
    let mut env = env_overrides.cloned().unwrap_or_default();
    if let Some(config_env) = codex_config.and_then(|config| config.env.as_ref()) {
        env.extend(
            config_env
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
    }
    (!env.is_empty()).then_some(env)
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadActivationSettings {
    pub model: String,
    pub project_path: String,
    pub permission_mode: PermissionMode,
    pub speed: Option<CodexSpeed>,
    pub codex_config: Option<CodexProviderConfig>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommonThreadParams<'a> {
    model: &'a str,
    service_tier: CodexServiceTier,
    cwd: &'a str,
    sandbox: CodexSandboxMode,
    approval_policy: CodexApprovalPolicy,
    approvals_reviewer: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    config: Option<&'a CodexConfigObject>,
}

fn common_thread_params(settings: &ThreadActivationSettings) -> CommonThreadParams<'_> {
    let sandbox = codex_sandbox_settings(settings.permission_mode);
    CommonThreadParams {
        model: &settings.model,
        service_tier: codex_service_tier(settings.speed),
        cwd: &settings.project_path,
        sandbox: sandbox.sandbox,
        approval_policy: sandbox.approval_policy,
        approvals_reviewer: "user",
        config: settings.codex_config.as_ref().map(|config| &config.config),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartParams<'a> {
    ephemeral: bool,
    history_mode: &'static str,
    #[serde(flatten)]
    common: CommonThreadParams<'a>,
}

pub fn build_thread_start_params(settings: &ThreadActivationSettings) -> ThreadStartParams<'_> {
    ThreadStartParams {
        ephemeral: false,
        history_mode: "paginated",
        common: common_thread_params(settings),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeParams<'a> {
    thread_id: &'a str,
    exclude_turns: bool,
    #[serde(flatten)]
    common: CommonThreadParams<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
}

pub fn build_thread_resume_params<'a>(
    settings: &'a ThreadActivationSettings,
    session_id: &'a str,
    native_path: Option<&'a str>,
) -> ThreadResumeParams<'a> {
    ThreadResumeParams {
        thread_id: session_id,
        exclude_turns: true,
        common: common_thread_params(settings),
        path: nonempty(native_path),
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadForkSource {
    pub agent_session_id: String,
    pub native_path: Option<String>,
    pub model: Option<String>,
    pub speed: Option<CodexSpeed>,
    pub project_path: String,
    pub codex_config: Option<CodexProviderConfig>,
    pub last_turn_id: Option<String>,
    pub model_provider: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadForkParams<'a> {
    thread_id: &'a str,
    cwd: &'a str,
    model: Option<&'a str>,
    service_tier: CodexServiceTier,
    ephemeral: bool,
    exclude_turns: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    config: Option<&'a CodexConfigObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_turn_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_provider: Option<&'a str>,
}

pub fn build_thread_fork_params(source: &ThreadForkSource) -> ThreadForkParams<'_> {
    ThreadForkParams {
        thread_id: &source.agent_session_id,
        cwd: &source.project_path,
        model: source.model.as_deref(),
        service_tier: codex_service_tier(source.speed),
        ephemeral: false,
        exclude_turns: true,
        path: nonempty(source.native_path.as_deref()),
        config: source.codex_config.as_ref().map(|config| &config.config),
        last_turn_id: nonempty(source.last_turn_id.as_deref()),
        model_provider: nonempty(source.model_provider.as_deref()),
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartRequest {
    pub thread_id: String,
    pub command: String,
    pub image_paths: Option<Vec<String>>,
    pub file_paths: Option<Vec<String>>,
    pub model: String,
    pub project_path: String,
    pub permission_mode: PermissionMode,
    pub thinking_mode: Option<ThinkingMode>,
    pub speed: Option<CodexSpeed>,
    pub client_message_id: Option<String>,
    pub skills: Option<Vec<CodexSkillRef>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams<'a> {
    thread_id: &'a str,
    input: Vec<CodexUserInput>,
    cwd: &'a str,
    approval_policy: CodexApprovalPolicy,
    approvals_reviewer: &'static str,
    model: &'a str,
    service_tier: CodexServiceTier,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_user_message_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<&'static str>,
}

pub fn build_turn_start_params(request: &TurnStartRequest) -> TurnStartParams<'_> {
    let command = command_with_attachment_paths(
        &request.command,
        request.file_paths.as_deref().unwrap_or_default(),
    );
    TurnStartParams {
        thread_id: &request.thread_id,
        input: build_user_input(
            &command,
            request.image_paths.as_deref().unwrap_or_default(),
            request.skills.as_deref().unwrap_or_default(),
        ),
        cwd: &request.project_path,
        approval_policy: codex_sandbox_settings(request.permission_mode).approval_policy,
        approvals_reviewer: "user",
        model: &request.model,
        service_tier: codex_service_tier(request.speed),
        client_user_message_id: nonempty(request.client_message_id.as_deref()),
        effort: map_thinking_mode_to_codex_effort(request.thinking_mode, Some(&request.model)),
    }
}

fn command_with_attachment_paths(command: &str, file_paths: &[String]) -> String {
    if file_paths.is_empty() {
        return command.into();
    }
    let files = file_paths
        .iter()
        .map(|path| format!("- {path}"))
        .collect::<Vec<_>>()
        .join("\n");
    [command, "Attached files are available on disk:", &files]
        .into_iter()
        .filter(|part| !trim(part).is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CodexUserInput {
    Text {
        text: String,
        text_elements: [(); 0],
    },
    Skill {
        name: String,
        path: String,
    },
    LocalImage {
        path: String,
    },
}

pub fn build_user_input(
    command: &str,
    image_paths: &[String],
    skills: &[CodexSkillRef],
) -> Vec<CodexUserInput> {
    let mut input = Vec::new();
    let mut text = command;
    if !skills.is_empty()
        && let Some(parsed) = parse_leading_slash_command(command)
        && let Some(skill) = skills.iter().find(|skill| skill.name == parsed.name)
    {
        input.push(CodexUserInput::Skill {
            name: skill.name.clone(),
            path: skill.path.clone(),
        });
        text = parsed.rest;
    }
    if !trim(text).is_empty() {
        input.push(CodexUserInput::Text {
            text: text.into(),
            text_elements: [],
        });
    }
    input.extend(
        image_paths
            .iter()
            .cloned()
            .map(|path| CodexUserInput::LocalImage { path }),
    );
    input
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}
