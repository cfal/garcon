//! Ports `common/scheduled-prompts.ts`.

use std::sync::LazyLock;

use garcon_js::{
    Number, OptionalNullable,
    clock::to_iso_string,
    date_parse::date_parse,
    is_safe_integer,
    json::{Opaque, as_number},
    trim, trim_start, utf16,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::{
    agent_integration::parse_agent_settings_by_id,
    api_providers::ApiProtocol,
    chat_modes::{PermissionMode, ThinkingMode, is_permission_mode, is_thinking_mode},
    chat_title_contracts::{CHAT_TITLE_MAX_BYTES, is_chat_title_within_limit},
    executors::{ExecutorId, LOCAL_EXECUTOR_ID, parse_executor_id},
    json::stable_json_stringify,
    preambles::{PreambleSelectionChoice, normalize_preamble_selection_choice},
    tags::normalize_tags,
    template_tokens::{
        CHAT_ID_TEMPLATE_TOKEN, RUNTIME_TEMPLATE_VARIABLES, RuntimeTemplateValues,
        TEMPLATE_VALIDATION_VALUES, TemplateExpansionError, expand_template,
    },
};

pub const SCHEDULED_PROMPT_INTERVAL_MINUTES_MIN: u64 = 1;
pub const SCHEDULED_PROMPT_INTERVAL_MINUTES_MAX: u64 = 3650 * 24 * 60;
pub const SCHEDULED_PROMPT_MAX_LENGTH: usize = 32_000;
pub const SCHEDULED_PROMPT_RUN_LOG_LIMIT: usize = 200;
pub const SCHEDULED_PROMPT_LABEL_MAX_LENGTH: usize = 200;
pub const SCHEDULED_PROMPT_MAX_COUNT: usize = 500;
pub const SCHEDULED_PROMPT_NAME_MAX_CODE_POINTS: usize = 120;
pub const SCHEDULED_PROMPT_CHAT_ID_TOKEN: &str = CHAT_ID_TEMPLATE_TOKEN;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ScheduleForChatFirstRun {
    After { minutes: Number },
    AfterInterval,
    At { at_utc: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleForChatRequest {
    pub chat_id: String,
    pub first_run: ScheduleForChatFirstRun,
    pub interval_minutes: Option<u64>,
    pub end_at_utc: Option<String>,
    pub busy_behavior: ScheduledPromptBusyBehavior,
    pub prompt: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduledPromptBusyBehavior {
    Queue,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneOffScheduledPromptSchedule {
    pub next_run_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringScheduledPromptSchedule {
    pub interval_minutes: u64,
    pub next_run_at: String,
    pub end_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ScheduledPromptSchedule {
    Once(OneOffScheduledPromptSchedule),
    Recurring(RecurringScheduledPromptSchedule),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewChatScheduledPromptTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_title_template: Option<String>,
    #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
    pub executor_id: OptionalNullable<ExecutorId>,
    pub agent_id: String,
    pub project_path: String,
    pub model: String,
    pub api_provider_id: Option<String>,
    pub model_endpoint_id: Option<String>,
    pub model_protocol: Option<ApiProtocol>,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    // The original validates the settings map, then returns the supplied JSON unchanged.
    pub agent_settings_by_id: Opaque,
    pub tags: Vec<String>,
    pub preamble_choice: PreambleSelectionChoice,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingChatScheduledPromptTarget {
    pub chat_id: String,
    pub busy_behavior: ScheduledPromptBusyBehavior,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_selection: Option<ScheduledPromptExecutionSelection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledPromptExecutionSelection {
    pub agent_id: String,
    pub agent_ownership_epoch: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ScheduledPromptTarget {
    NewChat(Box<NewChatScheduledPromptTarget>),
    ExistingChat(ExistingChatScheduledPromptTarget),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledPrompt {
    pub id: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub schedule: ScheduledPromptSchedule,
    pub target: ScheduledPromptTarget,
    pub prompt: String,
    pub created_at: String,
    pub updated_at: String,
}

pub const SCHEDULED_PROMPT_RUN_OUTCOMES: &[&str] = &[
    "created-chat",
    "sent",
    "queued",
    "skipped-busy",
    "missed",
    "failed",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScheduledPromptRunOutcome {
    CreatedChat,
    Sent,
    Queued,
    SkippedBusy,
    Missed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledPromptRunLogEntry {
    pub at: String,
    pub scheduled_prompt_id: Option<String>,
    pub prompt_label: Option<String>,
    pub outcome: ScheduledPromptRunOutcome,
    pub chat_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledPromptsSnapshot {
    pub revision: u64,
    pub prompts: Vec<ScheduledPrompt>,
    pub run_log: Vec<ScheduledPromptRunLogEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneOffScheduleInput {
    pub run_at_utc: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringScheduleInput {
    pub first_run_at_utc: String,
    pub interval_minutes: u64,
    pub end_at_utc: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ScheduledPromptScheduleInput {
    Once(OneOffScheduleInput),
    Recurring(RecurringScheduleInput),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScheduledPromptDefinitionInput {
    pub schedule: ScheduledPromptScheduleInput,
    pub target: ScheduledPromptTarget,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateScheduledPromptRequest {
    pub expected_revision: u64,
    pub scheduled_prompt: ScheduledPromptDefinitionInput,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateScheduledPromptRequest {
    #[serde(flatten)]
    pub request: CreateScheduledPromptRequest,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetScheduledPromptEnabledRequest {
    pub expected_revision: u64,
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveScheduledPromptRequest {
    pub expected_revision: u64,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderScheduledPromptsRequest {
    pub expected_revision: u64,
    pub ordered_prompt_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScheduledPromptsMutationResponse {
    pub success: bool,
    pub snapshot: ScheduledPromptsSnapshot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateScheduledPromptResponse {
    pub success: bool,
    pub scheduled_prompt: ScheduledPrompt,
    pub snapshot: ScheduledPromptsSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleInPromptRequest {
    pub chat_id: String,
    pub duration: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_selection: Option<ScheduledPromptExecutionSelection>,
}

pub type ScheduleInPromptResponse = CreateScheduledPromptResponse;

pub const SCHEDULED_PROMPTS_INVALIDATION_REASONS: &[&str] = &[
    "created",
    "updated",
    "removed",
    "reordered",
    "executed",
    "missed",
    "log-appended",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScheduledPromptsInvalidationReason {
    Created,
    Updated,
    Removed,
    Reordered,
    Executed,
    Missed,
    LogAppended,
}

pub fn has_leading_slash_command(value: &str) -> bool {
    let Some(text) = trim_start(value).strip_prefix('/') else {
        return false;
    };
    let end = text
        .bytes()
        .take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
        .count();
    end != 0 && (end == text.len() || trim_start(&text[end..]).len() != text[end..].len())
}

pub fn render_scheduled_prompt<S: AsRef<str>>(
    prompt: &str,
    values: &RuntimeTemplateValues<S>,
) -> Result<String, TemplateExpansionError> {
    expand_template(
        prompt,
        RUNTIME_TEMPLATE_VARIABLES,
        |name| values.get(name),
        SCHEDULED_PROMPT_MAX_LENGTH as f64,
    )
}

pub fn scheduled_prompt_fits_rendered_limit(
    prompt: &str,
    chat_id: Option<&str>,
) -> Result<bool, TemplateExpansionError> {
    let values = RuntimeTemplateValues {
        chat_id: chat_id.unwrap_or(TEMPLATE_VALIDATION_VALUES.chat_id),
        ..TEMPLATE_VALIDATION_VALUES
    };
    match render_scheduled_prompt(prompt, &values) {
        Ok(_) => Ok(true),
        Err(TemplateExpansionError::TooLong(_)) => Ok(false),
        Err(other) => Err(other),
    }
}

static SINGLE_LINE_CONTROL: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the regex contains supported Unicode general categories.
    Regex::new(r"[\p{Cc}\p{Zl}\p{Zp}]").expect("single-line control pattern")
});

pub fn normalize_scheduled_prompt_name(value: Option<&Value>) -> OptionalNullable<String> {
    let Some(value) = value else {
        return OptionalNullable::ABSENT;
    };
    let Some(name) = value.as_str().map(trim) else {
        return OptionalNullable::NULL;
    };
    if name.is_empty() {
        return OptionalNullable::ABSENT;
    }
    if SINGLE_LINE_CONTROL.is_match(name)
        || name.chars().count() > SCHEDULED_PROMPT_NAME_MAX_CODE_POINTS
    {
        return OptionalNullable::NULL;
    }
    OptionalNullable::some(name.to_owned())
}

fn scheduled_chat_title(value: &str) -> Option<&str> {
    let title = trim(value);
    (!title.is_empty() && !SINGLE_LINE_CONTROL.is_match(title) && is_chat_title_within_limit(title))
        .then_some(title)
}

pub fn normalize_scheduled_chat_title(value: &Value) -> Option<String> {
    scheduled_chat_title(value.as_str()?).map(str::to_owned)
}

#[derive(Debug, Clone, Copy, PartialEq, Error)]
pub enum ScheduledChatTitleError {
    #[error(transparent)]
    Expansion(#[from] TemplateExpansionError),
    #[error("Invalid scheduled chat title after variable expansion")]
    InvalidTitle,
}

pub fn render_scheduled_chat_title<S: AsRef<str>>(
    template: &str,
    values: &RuntimeTemplateValues<S>,
) -> Result<String, ScheduledChatTitleError> {
    let expanded = expand_template(
        template,
        RUNTIME_TEMPLATE_VARIABLES,
        |name| values.get(name),
        CHAT_TITLE_MAX_BYTES as f64,
    )?;
    scheduled_chat_title(&expanded)
        .map(str::to_owned)
        .ok_or(ScheduledChatTitleError::InvalidTitle)
}

pub fn normalize_scheduled_chat_title_template(value: &Value) -> Option<String> {
    let template = normalize_scheduled_chat_title(value)?;
    render_scheduled_chat_title(&template, &TEMPLATE_VALIDATION_VALUES).ok()?;
    Some(template)
}

pub fn is_scheduled_prompts_invalidation_reason(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|name| SCHEDULED_PROMPTS_INVALIDATION_REASONS.contains(&name))
}

pub fn is_minute_aligned_iso(value: &Value) -> bool {
    minute_aligned_iso(value).is_some()
}

fn minute_aligned_iso(value: &Value) -> Option<&str> {
    let text = value.as_str()?;
    if trim(text).is_empty() {
        return None;
    }
    let at = date_parse(text)?;
    (at % 60_000 == 0 && to_iso_string(at).ok()?.as_str() == text).then_some(text)
}

fn required_string(value: &Value) -> Option<&str> {
    value.as_str().map(trim).filter(|text| !text.is_empty())
}

fn prompt_source(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !trim(text).is_empty())
}

fn nullable_string(value: &Value) -> Option<Option<String>> {
    if value.is_null() {
        return Some(None);
    }
    let text = trim(value.as_str()?);
    Some((!text.is_empty()).then(|| text.to_owned()))
}

fn normalize_api_protocol(value: &Value) -> Option<Option<ApiProtocol>> {
    if value.is_null() {
        return Some(None);
    }
    Some(Some(match value.as_str()? {
        "openai-compatible" => ApiProtocol::OpenAiCompatible,
        "anthropic-messages" => ApiProtocol::AnthropicMessages,
        _ => return None,
    }))
}

pub fn parse_scheduled_prompt_execution_selection(
    value: &Value,
) -> Option<ScheduledPromptExecutionSelection> {
    let raw = value.as_object()?;
    let agent_id = prompt_source(raw.get("agentId")?)?.to_owned();
    let epoch = raw.get("agentOwnershipEpoch")?;
    let agent_ownership_epoch = if epoch.is_null() {
        None
    } else {
        Some(prompt_source(epoch)?.to_owned())
    };
    let model = raw.get("model")?;
    let model = if model.is_null() {
        None
    } else {
        Some(model.as_str()?.to_owned())
    };
    Some(ScheduledPromptExecutionSelection {
        agent_id,
        agent_ownership_epoch,
        model,
    })
}

pub fn scheduled_prompt_selection_matches(
    expected: &ScheduledPromptExecutionSelection,
    current: &ScheduledPromptExecutionSelection,
) -> bool {
    expected == current
}

fn normalize_new_chat_target(raw: &Map<String, Value>) -> Option<NewChatScheduledPromptTarget> {
    let chat_title_template = match raw.get("chatTitleTemplate") {
        Some(value) => Some(normalize_scheduled_chat_title_template(value)?),
        None => None,
    };
    let executor_id = parse_executor_id(raw.get("executorId").unwrap_or(&Value::Null))?;
    let executor_id = if executor_id != LOCAL_EXECUTOR_ID {
        OptionalNullable::some(executor_id)
    } else {
        OptionalNullable::ABSENT
    };
    let agent_id = required_string(raw.get("agentId")?)?.to_owned();
    let project_path = prompt_source(raw.get("projectPath")?)?.to_owned();
    let model = required_string(raw.get("model")?)?.to_owned();
    let api_provider_id = nullable_string(raw.get("apiProviderId")?)?;
    let model_endpoint_id = nullable_string(raw.get("modelEndpointId")?)?;
    let model_protocol = normalize_api_protocol(raw.get("modelProtocol")?)?;
    let tags = match raw.get("tags") {
        None => Vec::new(),
        Some(value) => normalize_tags(value.as_array()?),
    };
    let preamble_choice = normalize_preamble_selection_choice(raw.get("preambleChoice")?)?;
    let permission_mode = is_permission_mode(raw.get("permissionMode")?)?;
    let thinking_mode = is_thinking_mode(raw.get("thinkingMode")?)?;
    let agent_settings_by_id = raw.get("agentSettingsById")?;
    parse_agent_settings_by_id(agent_settings_by_id)?;
    Some(NewChatScheduledPromptTarget {
        chat_title_template,
        executor_id,
        agent_id,
        project_path,
        model,
        api_provider_id,
        model_endpoint_id,
        model_protocol,
        permission_mode,
        thinking_mode,
        agent_settings_by_id: Opaque::from_value(agent_settings_by_id.clone()),
        tags,
        preamble_choice,
    })
}

pub fn is_scheduled_prompt_interval_minutes(value: &Value) -> bool {
    interval_minutes(value).is_some()
}

fn interval_minutes(value: &Value) -> Option<u64> {
    let number = as_number(value)?;
    (is_safe_integer(number)
        && (SCHEDULED_PROMPT_INTERVAL_MINUTES_MIN as f64
            ..=SCHEDULED_PROMPT_INTERVAL_MINUTES_MAX as f64)
            .contains(&number))
    .then_some(number as u64)
}

pub fn normalize_scheduled_prompt_target(value: &Value) -> Option<ScheduledPromptTarget> {
    let raw = value.as_object()?;
    match raw.get("type")?.as_str()? {
        "new-chat" => Some(ScheduledPromptTarget::NewChat(Box::new(
            normalize_new_chat_target(raw)?,
        ))),
        "existing-chat" => {
            if raw.contains_key("preambleChoice") || raw.contains_key("chatTitleTemplate") {
                return None;
            }
            let chat_id = required_string(raw.get("chatId")?)?.to_owned();
            let busy_behavior = match raw.get("busyBehavior")?.as_str()? {
                "queue" => ScheduledPromptBusyBehavior::Queue,
                "skip" => ScheduledPromptBusyBehavior::Skip,
                _ => return None,
            };
            let expected_selection = match raw.get("expectedSelection") {
                None => None,
                Some(value) => Some(parse_scheduled_prompt_execution_selection(value)?),
            };
            Some(ScheduledPromptTarget::ExistingChat(
                ExistingChatScheduledPromptTarget {
                    chat_id,
                    busy_behavior,
                    expected_selection,
                },
            ))
        }
        _ => None,
    }
}

fn nullable_end(value: &Value, start: &str) -> Option<Option<String>> {
    if value.is_null() {
        return Some(None);
    }
    let end = minute_aligned_iso(value)?;
    // Canonical ISO dates are ASCII and the original compares their literal order.
    (end >= start).then(|| Some(end.to_owned()))
}

pub fn normalize_scheduled_prompt_schedule(value: &Value) -> Option<ScheduledPromptSchedule> {
    let raw = value.as_object()?;
    let next_run_at = minute_aligned_iso(raw.get("nextRunAt")?)?;
    if raw.contains_key("intervalHours") || raw.contains_key("intervalDays") {
        return None;
    }
    match raw.get("type")?.as_str()? {
        "once" => Some(ScheduledPromptSchedule::Once(
            OneOffScheduledPromptSchedule {
                next_run_at: next_run_at.to_owned(),
            },
        )),
        "recurring" => {
            let interval_minutes = interval_minutes(raw.get("intervalMinutes")?)?;
            let end_at = nullable_end(raw.get("endAt")?, next_run_at)?;
            Some(ScheduledPromptSchedule::Recurring(
                RecurringScheduledPromptSchedule {
                    interval_minutes,
                    next_run_at: next_run_at.to_owned(),
                    end_at,
                },
            ))
        }
        _ => None,
    }
}

pub fn normalize_scheduled_prompt(value: &Value) -> Option<ScheduledPrompt> {
    let raw = value.as_object()?;
    let id = required_string(raw.get("id")?)?.to_owned();
    let name = normalize_scheduled_prompt_name(raw.get("name"));
    if name.is_null() {
        return None;
    }
    let prompt = prompt_source(raw.get("prompt")?)?;
    let schedule = normalize_scheduled_prompt_schedule(raw.get("schedule")?)?;
    let target = normalize_scheduled_prompt_target(raw.get("target")?)?;
    let enabled = match raw.get("enabled") {
        None => true,
        Some(value) => value.as_bool()?,
    };
    if utf16::len(prompt) > SCHEDULED_PROMPT_MAX_LENGTH {
        return None;
    }
    let created_at = to_iso_string(date_parse(raw.get("createdAt")?.as_str()?)?).ok()?;
    let updated_at = to_iso_string(date_parse(raw.get("updatedAt")?.as_str()?)?).ok()?;
    Some(ScheduledPrompt {
        id,
        enabled,
        name: name.as_option().cloned(),
        schedule,
        target,
        prompt: prompt.to_owned(),
        created_at,
        updated_at,
    })
}

pub fn normalize_scheduled_prompt_definition_input(
    value: &Value,
) -> Option<ScheduledPromptDefinitionInput> {
    let raw = value.as_object()?;
    let name = normalize_scheduled_prompt_name(raw.get("name"));
    if name.is_null() {
        return None;
    }
    let schedule = raw.get("schedule")?.as_object()?;
    if schedule.contains_key("intervalHours") || schedule.contains_key("intervalDays") {
        return None;
    }
    let target = normalize_scheduled_prompt_target(raw.get("target")?)?;
    let prompt = prompt_source(raw.get("prompt")?)?;
    if utf16::len(prompt) > SCHEDULED_PROMPT_MAX_LENGTH {
        return None;
    }
    let schedule = match schedule.get("type")?.as_str()? {
        "once" => ScheduledPromptScheduleInput::Once(OneOffScheduleInput {
            run_at_utc: minute_aligned_iso(schedule.get("runAtUtc")?)?.to_owned(),
        }),
        "recurring" => {
            let first_run_at_utc = minute_aligned_iso(schedule.get("firstRunAtUtc")?)?;
            let interval_minutes = interval_minutes(schedule.get("intervalMinutes")?)?;
            let end_at_utc = nullable_end(schedule.get("endAtUtc")?, first_run_at_utc)?;
            ScheduledPromptScheduleInput::Recurring(RecurringScheduleInput {
                first_run_at_utc: first_run_at_utc.to_owned(),
                interval_minutes,
                end_at_utc,
            })
        }
        _ => return None,
    };
    Some(ScheduledPromptDefinitionInput {
        schedule,
        target,
        prompt: prompt.to_owned(),
        name: name.as_option().cloned(),
    })
}

pub fn normalize_scheduled_prompts_snapshot(value: &Value) -> Option<ScheduledPromptsSnapshot> {
    let raw = value.as_object()?;
    let revision = as_number(raw.get("revision")?)
        .filter(|value| is_safe_integer(*value) && *value >= 0.0)? as u64;
    let prompts = raw
        .get("prompts")?
        .as_array()?
        .iter()
        .map(normalize_scheduled_prompt)
        .collect::<Option<_>>()?;
    let mut run_log: Vec<_> = raw
        .get("runLog")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(normalize_scheduled_prompt_run_log_entry)
        .collect();
    run_log.drain(..run_log.len().saturating_sub(SCHEDULED_PROMPT_RUN_LOG_LIMIT));
    Some(ScheduledPromptsSnapshot {
        revision,
        prompts,
        run_log,
    })
}

pub fn normalize_create_scheduled_prompt_response(
    value: &Value,
) -> Option<CreateScheduledPromptResponse> {
    let raw = value.as_object()?;
    if raw.get("success")?.as_bool() != Some(true) {
        return None;
    }
    let scheduled_prompt = normalize_scheduled_prompt(raw.get("scheduledPrompt")?)?;
    let snapshot = normalize_scheduled_prompts_snapshot(raw.get("snapshot")?)?;
    let stored = snapshot
        .prompts
        .iter()
        .find(|entry| entry.id == scheduled_prompt.id)?;
    let stable_json = |value: &ScheduledPrompt| -> Option<String> {
        let text = serde_json::to_string(value).ok()?;
        let value = garcon_js::json::from_str(&text).ok()?;
        Some(stable_json_stringify(&value))
    };
    if stable_json(stored)? != stable_json(&scheduled_prompt)? {
        return None;
    }
    Some(CreateScheduledPromptResponse {
        success: true,
        scheduled_prompt,
        snapshot,
    })
}

pub fn normalize_scheduled_prompt_run_log_entry(
    value: &Value,
) -> Option<ScheduledPromptRunLogEntry> {
    let raw = value.as_object()?;
    let at = raw.get("at")?.as_str()?;
    date_parse(at)?;
    let outcome = match raw.get("outcome")?.as_str()? {
        "created-chat" => ScheduledPromptRunOutcome::CreatedChat,
        "sent" => ScheduledPromptRunOutcome::Sent,
        "queued" => ScheduledPromptRunOutcome::Queued,
        "skipped-busy" => ScheduledPromptRunOutcome::SkippedBusy,
        "missed" => ScheduledPromptRunOutcome::Missed,
        "failed" => ScheduledPromptRunOutcome::Failed,
        _ => return None,
    };
    let message = raw.get("message")?.as_str()?.to_owned();
    let scheduled_prompt_id = nullable_string(raw.get("scheduledPromptId")?)?;
    let chat_id = nullable_string(raw.get("chatId")?)?;
    let label = raw.get("promptLabel")?;
    let prompt_label = if scheduled_prompt_id.is_none() {
        if !label.is_null() {
            return None;
        }
        None
    } else {
        Some(
            label
                .as_str()
                .filter(|text| utf16::len(text) <= SCHEDULED_PROMPT_LABEL_MAX_LENGTH)?
                .to_owned(),
        )
    };
    Some(ScheduledPromptRunLogEntry {
        at: at.to_owned(),
        scheduled_prompt_id,
        prompt_label,
        outcome,
        chat_id,
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bounds_source_and_rendered_titles_in_utf8_bytes() {
        let text = "\u{1f600}".repeat(CHAT_TITLE_MAX_BYTES / 4);
        assert!(normalize_scheduled_chat_title(&json!(text)).is_some());
        let template = format!("{text}{{{{current_date}}}}");
        assert_eq!(
            render_scheduled_chat_title(&template, &TEMPLATE_VALIDATION_VALUES),
            Err(ScheduledChatTitleError::InvalidTitle)
        );
    }

    #[test]
    fn retains_the_captured_selection_through_definition_normalization() {
        let mut input = json!({"name":" ","schedule":{"type":"once","runAtUtc":"2030-01-01T09:00:00.000Z"},"target":{"type":"existing-chat","chatId":"1783725900000000","busyBehavior":"queue","expectedSelection":{"agentId":"codex","agentOwnershipEpoch":"e1","model":null}},"prompt":"  Synthetic \n"});
        let result = normalize_scheduled_prompt_definition_input(&input).unwrap();
        assert_eq!(result.prompt, "  Synthetic \n");
        assert_eq!(result.name, None);
        input["target"]["expectedSelection"]["agentOwnershipEpoch"] = json!("  ");
        assert!(normalize_scheduled_prompt_definition_input(&input).is_none());
    }

    #[test]
    fn retains_the_latest_valid_run_log_entries_without_normalizing_their_timestamps() {
        let log = (0..SCHEDULED_PROMPT_RUN_LOG_LIMIT + 1).map(|number| json!({"at":"2026-01-01T00:00:00+00:00","scheduledPromptId":" synthetic ","promptLabel":"","outcome":"queued","chatId":" ","message":number.to_string()})).chain([Value::Null]).collect::<Vec<_>>();
        let snapshot =
            normalize_scheduled_prompts_snapshot(&json!({"revision":0,"prompts":[],"runLog":log}))
                .unwrap();
        assert_eq!(snapshot.run_log.len(), SCHEDULED_PROMPT_RUN_LOG_LIMIT);
        assert_eq!(snapshot.run_log[0].message, "1");
        assert_eq!(snapshot.run_log[0].at, "2026-01-01T00:00:00+00:00");
    }
}
