use std::collections::{HashMap, HashSet};

use garcon_contract::agent_integration::parse_agent_settings_by_id;
use garcon_contract::api_providers::ApiProtocol;
use garcon_contract::chat_modes::{
    DEFAULT_PERMISSION_MODE, DEFAULT_THINKING_MODE, normalize_permission_mode,
    normalize_thinking_mode,
};
use garcon_contract::executors::{LOCAL_EXECUTOR_ID, parse_executor_id};
use garcon_contract::settings::{
    ExecutionDefaults, ExecutionDefaultsPatch, ExecutorProjectPreferences, RecentAgentSetting,
    RemoteExecutionDefaults, parse_executor_project_preferences,
};
use garcon_js::{OptionalNullable, array_index, trim};
use serde_json::{Value, json};

use super::settings_shared::{optional_string, record};

pub(super) const RECENT_PROJECT_PATHS_LIMIT: usize = 10;
const RECENT_AGENT_SETTINGS_PER_EXECUTOR_LIMIT: usize = 20;

fn optional_path(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !trim(text).is_empty())
}

fn dedupe_paths<'a>(entries: impl Iterator<Item = &'a Value>, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    entries
        .filter_map(optional_path)
        .filter(|path| seen.insert(*path))
        .take(limit)
        .map(str::to_owned)
        .collect()
}

fn values(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

pub(super) fn sorted_pinned_project_paths(value: &Value) -> Vec<String> {
    let mut paths = dedupe_paths(values(value), usize::MAX);
    paths.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    paths
}

pub(super) fn normalize_path_settings(paths: &Value) -> Result<Value, &'static str> {
    let mut result = record(paths);
    if paths["pinnedProjectPaths"].is_array() {
        result.insert(
            "pinnedProjectPaths".into(),
            json!(sorted_pinned_project_paths(&paths["pinnedProjectPaths"])),
        );
    }
    if let Some(raw) = paths.get("byExecutor") {
        let parsed = parse_executor_project_preferences(raw)
            .ok_or("Invalid executor project preferences")?;
        result.insert("byExecutor".into(), json!(parsed));
    }
    Ok(Value::Object(result))
}

pub(super) fn sanitize_path_settings(raw: &Value) -> (Value, bool) {
    let raw_paths = &raw["paths"];
    let legacy = raw.get("lastProjectPath").and_then(optional_path);
    let pinned = sorted_pinned_project_paths(&raw_paths["pinnedProjectPaths"]);
    let current = dedupe_paths(
        values(&raw_paths["recentProjectPaths"]),
        RECENT_PROJECT_PATHS_LIMIT,
    );
    let mut recent = current;
    if let Some(legacy) = legacy
        && !recent.iter().any(|path| path == legacy)
        && recent.len() < RECENT_PROJECT_PATHS_LIMIT
    {
        recent.push(legacy.into());
    }
    let pinned = json!(pinned);
    let has_pinned = raw_paths["pinnedProjectPaths"].is_array();
    let migrated = legacy.is_some()
        || (has_pinned && raw_paths["pinnedProjectPaths"] != pinned)
        || raw_paths["recentProjectPaths"]
            .as_array()
            .is_none_or(|previous| previous.len() != recent.len());
    let mut paths = record(raw_paths);
    if has_pinned {
        paths.insert("pinnedProjectPaths".into(), pinned);
    }
    paths.insert("recentProjectPaths".into(), json!(recent));
    (Value::Object(paths), migrated)
}

fn protocol(value: &Value) -> Option<ApiProtocol> {
    match value.as_str() {
        Some("openai-compatible") => Some(ApiProtocol::OpenAiCompatible),
        Some("anthropic-messages") => Some(ApiProtocol::AnthropicMessages),
        _ => None,
    }
}

pub(super) fn sanitize_recent_agent_setting(raw: &Value) -> Option<RecentAgentSetting> {
    let executor = parse_executor_id(&raw["executorId"])?;
    Some(RecentAgentSetting {
        executor_id: if executor == LOCAL_EXECUTOR_ID {
            OptionalNullable::ABSENT
        } else {
            OptionalNullable::some(executor)
        },
        agent_id: optional_string(&raw["agentId"])?.into(),
        model: optional_string(&raw["model"])?.into(),
        api_provider_id: optional_string(&raw["apiProviderId"]).map(str::to_owned),
        model_endpoint_id: optional_string(&raw["modelEndpointId"]).map(str::to_owned),
        model_protocol: protocol(&raw["modelProtocol"]),
    })
}

pub(super) fn legacy_recent_agent_setting(raw: &Value) -> Option<RecentAgentSetting> {
    sanitize_recent_agent_setting(&json!({
        "agentId": raw["lastAgentId"],
        "model": raw["lastModel"],
        "apiProviderId": raw["lastApiProviderId"],
        "modelEndpointId": raw["lastModelEndpointId"],
        "modelProtocol": raw["lastModelProtocol"],
    }))
}

pub(super) fn dedupe_recent_agent_settings(
    entries: Vec<RecentAgentSetting>,
) -> Vec<RecentAgentSetting> {
    let mut seen = HashSet::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    entries
        .into_iter()
        .filter(|entry| {
            let executor = entry.executor_id.as_deref().unwrap_or(LOCAL_EXECUTOR_ID);
            let protocol = entry.model_protocol.map_or("", ApiProtocol::as_str);
            let key = [
                executor,
                &entry.agent_id,
                &entry.model,
                entry.api_provider_id.as_deref().unwrap_or(""),
                entry.model_endpoint_id.as_deref().unwrap_or(""),
                protocol,
            ]
            .join("\u{1f}");
            let count = counts.entry(executor.into()).or_default();
            if *count == RECENT_AGENT_SETTINGS_PER_EXECUTOR_LIMIT || !seen.insert(key) {
                return false;
            }
            *count += 1;
            true
        })
        .collect()
}

pub(super) fn sanitize_recent_agent_settings(raw: &Value) -> (Vec<RecentAgentSetting>, bool) {
    let Some(items) = raw.as_array() else {
        return (Vec::new(), true);
    };
    let entries = dedupe_recent_agent_settings(
        items
            .iter()
            .filter_map(sanitize_recent_agent_setting)
            .collect(),
    );
    let migrated = entries.len() != items.len();
    (entries, migrated)
}

pub(super) fn sanitize_execution_defaults(raw: &Value) -> ExecutionDefaults {
    ExecutionDefaults {
        permission_mode: normalize_permission_mode(&raw["permissionMode"], DEFAULT_PERMISSION_MODE),
        thinking_mode: normalize_thinking_mode(&raw["thinkingMode"], DEFAULT_THINKING_MODE),
        agent_settings_by_id: parse_agent_settings_by_id(&raw["agentSettingsById"])
            .unwrap_or_default(),
    }
}

fn sanitize_execution_defaults_patch(raw: &Value) -> ExecutionDefaultsPatch {
    ExecutionDefaultsPatch {
        permission_mode: raw
            .get("permissionMode")
            .map(|mode| normalize_permission_mode(mode, DEFAULT_PERMISSION_MODE)),
        thinking_mode: raw
            .get("thinkingMode")
            .map(|mode| normalize_thinking_mode(mode, DEFAULT_THINKING_MODE)),
        agent_settings_by_id: parse_agent_settings_by_id(&raw["agentSettingsById"]),
    }
}

pub(super) fn legacy_execution_defaults(raw: &Value) -> ExecutionDefaults {
    sanitize_execution_defaults(&json!({
        "permissionMode": raw["lastPermissionMode"],
        "thinkingMode": raw["lastThinkingMode"],
    }))
}

pub(super) fn full_execution_defaults_patch(
    defaults: &ExecutionDefaults,
) -> ExecutionDefaultsPatch {
    ExecutionDefaultsPatch {
        permission_mode: Some(defaults.permission_mode),
        thinking_mode: Some(defaults.thinking_mode),
        agent_settings_by_id: Some(defaults.agent_settings_by_id.clone()),
    }
}

pub(super) fn sanitize_execution_defaults_settings(raw: &Value) -> (RemoteExecutionDefaults, bool) {
    let raw_global = &raw["global"];
    let global = sanitize_execution_defaults(raw_global);
    let mut defaults = RemoteExecutionDefaults {
        global,
        by_agent: Default::default(),
    };
    if !raw.is_object() {
        return (defaults, true);
    }
    let mut migrated = !raw_global.is_object()
        || execution_fields_changed(
            raw_global,
            json!(defaults.global.permission_mode),
            json!(defaults.global.thinking_mode),
        );
    if let Some(by_agent) = raw["byAgent"].as_object() {
        let mut entries: Vec<_> = by_agent.iter().collect();
        entries.sort_by_key(|(id, _)| array_index(id).unwrap_or(u64::MAX));
        for (id, candidate) in entries {
            let normalized = trim(id);
            if normalized.is_empty() || !candidate.is_object() {
                migrated = true;
                continue;
            }
            let patch = sanitize_execution_defaults_patch(candidate);
            migrated |= execution_fields_changed(
                candidate,
                json!(patch.permission_mode),
                json!(patch.thinking_mode),
            );
            // Assignment to this accessor on a plain JavaScript record doesn't create a key.
            if normalized != "__proto__" {
                defaults.by_agent.insert(normalized.into(), patch);
            }
        }
    } else {
        migrated = raw.get("byAgent").is_some();
    }
    order_execution_defaults_keys(&mut defaults);
    (defaults, migrated)
}

pub(super) fn order_execution_defaults_keys(defaults: &mut RemoteExecutionDefaults) {
    defaults.by_agent.sort_by(|left, _, right, _| {
        array_index(left)
            .unwrap_or(u64::MAX)
            .cmp(&array_index(right).unwrap_or(u64::MAX))
    });
}

fn execution_fields_changed(raw: &Value, permission_mode: Value, thinking_mode: Value) -> bool {
    raw.get("permissionMode").is_some_and(|old| old != &permission_mode)
        || raw.get("thinkingMode").is_some_and(|old| old != &thinking_mode)
        // The original compares against the newly parsed object by identity.
        || raw.get("agentSettingsById").is_some()
}

pub(super) fn record_recent_project_path(
    paths: &Value,
    project_path: &Value,
    target_executor: &Value,
) -> Result<Value, &'static str> {
    let updated = normalize_path_settings(paths)?;
    let Some(path) = optional_path(project_path) else {
        return Ok(updated);
    };
    let executor = parse_executor_id(target_executor).ok_or("Invalid executor ID")?;
    let mut updated = record(&updated);
    if executor == LOCAL_EXECUTOR_ID {
        let previous = updated.get("recentProjectPaths").unwrap_or(&Value::Null);
        let path = json!(path);
        let recent = dedupe_paths(
            std::iter::once(&path).chain(values(previous)),
            RECENT_PROJECT_PATHS_LIMIT,
        );
        updated.insert("recentProjectPaths".into(), json!(recent));
    } else {
        let mut by_executor = updated
            .get("byExecutor")
            .and_then(parse_executor_project_preferences)
            .unwrap_or_default();
        let previous = by_executor
            .entry(executor)
            .or_insert_with(|| ExecutorProjectPreferences {
                default_path: None,
                recent_paths: Vec::new(),
                pinned_paths: Vec::new(),
            });
        let candidates =
            std::iter::once(path.to_owned()).chain(std::mem::take(&mut previous.recent_paths));
        let mut seen = HashSet::new();
        previous.recent_paths = candidates
            .filter(|value| !trim(value).is_empty() && seen.insert(value.clone()))
            .take(RECENT_PROJECT_PATHS_LIMIT)
            .collect();
        updated.insert("byExecutor".into(), json!(by_executor));
    }
    Ok(Value::Object(updated))
}
