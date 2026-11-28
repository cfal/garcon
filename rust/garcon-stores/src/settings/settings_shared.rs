use garcon_contract::hidden_bash_command_patterns::parse_hidden_bash_command_patterns;
use garcon_contract::settings::{
    APP_TITLE_MAX_LENGTH, normalize_agent_switch_compaction_ui_settings,
    normalize_chat_title_ui_settings, normalize_commit_message_ui_settings,
    normalize_prompt_refinement_ui_settings, normalize_ticket_chat_ui_settings,
};
use garcon_js::{is_safe_integer, json::as_number, trim, utf16};
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::types::{FolderFilter, FolderFilterStatus};

pub(super) fn record(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

pub(super) fn optional_string(value: &Value) -> Option<&str> {
    value.as_str().map(trim).filter(|text| !text.is_empty())
}

pub(super) fn normalize_ui_settings(ui: &Value) -> Value {
    let mut normalized = record(ui);
    let identity = optional_string(&ui["appIdentity"]["title"])
        .filter(|title| utf16::len(title) <= APP_TITLE_MAX_LENGTH)
        .map(|title| json!({ "title": title }));
    replace(&mut normalized, "appIdentity", identity);
    if normalized.contains_key("pinnedInsertPosition") {
        normalized.insert(
            "pinnedInsertPosition".into(),
            json!(if ui["pinnedInsertPosition"].as_str() == Some("bottom") {
                "bottom"
            } else {
                "top"
            }),
        );
    }
    replace(
        &mut normalized,
        "hiddenBashCommandPatterns",
        parse_hidden_bash_command_patterns(&ui["hiddenBashCommandPatterns"]),
    );
    replace(
        &mut normalized,
        "chatTitle",
        normalize_chat_title_ui_settings(&ui["chatTitle"]),
    );
    replace(
        &mut normalized,
        "agentSwitchCompaction",
        normalize_agent_switch_compaction_ui_settings(&ui["agentSwitchCompaction"]),
    );
    replace(
        &mut normalized,
        "commitMessage",
        normalize_commit_message_ui_settings(&ui["commitMessage"]),
    );
    replace(
        &mut normalized,
        "promptRefinement",
        normalize_prompt_refinement_ui_settings(&ui["promptRefinement"]),
    );
    replace(
        &mut normalized,
        "ticketChat",
        normalize_ticket_chat_ui_settings(&ui["ticketChat"]),
    );
    Value::Object(normalized)
}

fn replace<T: Serialize>(ui: &mut Map<String, Value>, key: &str, value: Option<T>) {
    if let Some(value) = value {
        ui.insert(key.into(), json!(value));
    } else {
        ui.shift_remove(key);
    }
}

pub(super) fn sanitize_string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(optional_string)
        .map(str::to_owned)
        .collect()
}

pub(super) fn sanitize_folder_filter(raw: &Value) -> FolderFilter {
    FolderFilter {
        text_tokens: sanitize_string_array(&raw["textTokens"]),
        tags: sanitize_string_array(&raw["tags"]),
        agents: sanitize_string_array(&raw["agents"]),
        models: sanitize_string_array(&raw["models"]),
        status: match optional_string(&raw["status"]) {
            Some("active") => Some(FolderFilterStatus::Active),
            Some("unread") => Some(FolderFilterStatus::Unread),
            _ => None,
        },
    }
}

pub(super) fn normalize_remote_settings_version(value: &Value) -> u64 {
    as_number(value)
        .filter(|number| is_safe_integer(*number) && *number >= 0.0)
        .map_or(0, |number| number as u64)
}
