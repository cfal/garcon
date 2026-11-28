//! Ports `common/preambles.ts`.

use std::{collections::HashSet, fmt, sync::LazyLock};

use garcon_js::{
    OptionalNullable, clock::to_iso_string, date_parse::date_parse, is_safe_integer,
    json::as_number, trim, utf16,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    agents::{AgentId, is_agent_id},
    executors::{ExecutorId, LOCAL_EXECUTOR_ID, parse_executor_id},
    snippets::is_snippet_short_name,
    tags::normalize_tag_slug,
    template_tokens::{
        CHAT_ID_TEMPLATE_TOKEN, RUNTIME_TEMPLATE_VARIABLES, RuntimeTemplateValues,
        TemplateExpansionError, expand_template,
    },
};

pub const PREAMBLE_MAX_COUNT: usize = 100;
pub const PREAMBLE_TITLE_MAX_CODE_POINTS: usize = 120;
pub const PREAMBLE_CONTENT_MAX_LENGTH: usize = 32_000;
pub const PREAMBLE_COMBINED_MAX_LENGTH: usize = 64_000;
pub const PREAMBLE_PATH_RULE_MAX_COUNT: usize = 32;
pub const PREAMBLE_AGENT_FILTER_MAX_COUNT: usize = 32;
pub const PREAMBLE_TAG_FILTER_MAX_COUNT: usize = 32;
pub const PREAMBLE_TAG_MAX_CODE_POINTS: usize = 64;
pub const PREAMBLE_FILE_CONTEXT_SEPARATOR: &str =
    "\n\nReferenced file contents from @file mentions:\n\n";
pub const PREAMBLE_CHAT_ID_TOKEN: &str = CHAT_ID_TEMPLATE_TOKEN;
pub const PREAMBLE_ID_LIFETIME_MAX_COUNT: usize = 100_000;
pub const PREAMBLES_FILE_MAX_BYTES: usize = 64 * 1024 * 1024;

pub const PREAMBLE_BOUNDARY_KINDS: &[&str] = &[
    "new-chat",
    "fork",
    "continuation",
    "agent-switch",
    "selection-change",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreambleBoundaryKind {
    NewChat,
    Fork,
    Continuation,
    AgentSwitch,
    SelectionChange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum PendingPreambleBoundary {
    NewChat {
        ownership_epoch: String,
    },
    Fork {
        ownership_epoch: String,
    },
    Continuation {
        ownership_epoch: String,
    },
    AgentSwitch {
        ownership_epoch: String,
    },
    SelectionChange {
        ownership_epoch: String,
        selection_revision: u64,
    },
}

pub fn same_preamble_boundary(
    left: &PendingPreambleBoundary,
    right: &PendingPreambleBoundary,
) -> bool {
    left == right
}

pub type PreambleId = String;

static PREAMBLE_ID_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the UUID pattern is a valid regular expression.
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        .expect("preamble ID pattern")
});

pub fn is_preamble_id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|id| PREAMBLE_ID_PATTERN.is_match(id))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum PreambleSelectionChoice {
    Defaults,
    Explicit {
        ordered_preamble_ids: Vec<PreambleId>,
    },
}

pub fn normalize_ordered_preamble_ids(value: &Value) -> Option<Vec<PreambleId>> {
    let values = value.as_array()?;
    if values.len() > PREAMBLE_MAX_COUNT {
        return None;
    }
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|value| {
            if !is_preamble_id(value) {
                return None;
            }
            let id = value.as_str()?;
            seen.insert(id).then(|| id.to_owned())
        })
        .collect()
}

pub fn normalize_preamble_selection_choice(value: &Value) -> Option<PreambleSelectionChoice> {
    let raw = value.as_object()?;
    match raw.get("mode")?.as_str()? {
        "defaults" if has_only_keys(raw, &["mode"]) => Some(PreambleSelectionChoice::Defaults),
        "explicit" if has_only_keys(raw, &["mode", "orderedPreambleIds"]) => {
            Some(PreambleSelectionChoice::Explicit {
                ordered_preamble_ids: normalize_ordered_preamble_ids(
                    raw.get("orderedPreambleIds")?,
                )?,
            })
        }
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPreambleSelection {
    pub revision: u64,
    pub ordered_preamble_ids: Vec<PreambleId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreambleSelectionUnavailableReason {
    Missing,
    OutOfScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreambleSelectionReference {
    pub id: PreambleId,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnavailablePreambleSelectionReference {
    pub id: PreambleId,
    pub reason: PreambleSelectionUnavailableReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreambleSelectionProjection {
    pub catalog_revision: u64,
    pub eligible_preambles: Vec<PreambleSelectionReference>,
    pub unavailable: Vec<UnavailablePreambleSelectionReference>,
}

pub const PREAMBLE_SELECTION_UNAVAILABLE_REASONS: &[&str] = &["missing", "out-of-scope"];

pub fn is_preamble_selection_unavailable_reason(
    value: &Value,
) -> Option<PreambleSelectionUnavailableReason> {
    Some(match value.as_str()? {
        "missing" => PreambleSelectionUnavailableReason::Missing,
        "out-of-scope" => PreambleSelectionUnavailableReason::OutOfScope,
        _ => return None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreambleProjectPathRule {
    pub project_path: String,
    pub include_nested: bool,
    #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
    pub executor_id: OptionalNullable<ExecutorId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PreambleScope {
    Global,
    ProjectPaths { rules: Vec<PreambleProjectPathRule> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreambleTagMatchMode {
    Any,
    All,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreambleTagFilter {
    pub mode: PreambleTagMatchMode,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreambleDefinition {
    pub enabled: bool,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet_short_name: Option<String>,
    pub content: String,
    pub scope: PreambleScope,
    pub agent_ids: Vec<AgentId>,
    pub tag_filter: PreambleTagFilter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preamble {
    pub id: PreambleId,
    #[serde(flatten)]
    pub definition: PreambleDefinition,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreambleDefinitionInput {
    pub enabled: bool,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet_short_name: Option<String>,
    pub content: String,
    pub scope: PreambleScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_ids: Option<Vec<AgentId>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_filter: Option<PreambleTagFilter>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreamblesSnapshot {
    pub revision: u64,
    pub preambles: Vec<Preamble>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePreambleRequest {
    pub expected_revision: u64,
    pub preamble: PreambleDefinitionInput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdatePreambleRequest {
    #[serde(flatten)]
    pub request: CreatePreambleRequest,
    pub id: PreambleId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovePreambleRequest {
    pub expected_revision: u64,
    pub id: PreambleId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderPreamblesRequest {
    pub expected_revision: u64,
    pub ordered_preamble_ids: Vec<PreambleId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreamblesMutationResponse {
    pub success: bool,
    pub snapshot: PreamblesSnapshot,
}

pub fn normalize_preambles_mutation_response(value: &Value) -> Option<PreamblesMutationResponse> {
    let raw = value.as_object()?;
    if !has_only_keys(raw, &["success", "snapshot"]) || raw.get("success")?.as_bool() != Some(true)
    {
        return None;
    }
    let snapshot = normalize_preambles_snapshot(raw.get("snapshot")?)?;
    Some(PreamblesMutationResponse {
        success: true,
        snapshot,
    })
}

pub const PREAMBLES_INVALIDATION_REASONS: &[&str] = &["created", "updated", "removed", "reordered"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreamblesInvalidationReason {
    Created,
    Updated,
    Removed,
    Reordered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct PreambleErrorCode(&'static str);

impl PreambleErrorCode {
    pub const VALIDATION_FAILED: Self = Self("PREAMBLE_VALIDATION_FAILED");
    pub const NOT_FOUND: Self = Self("PREAMBLE_NOT_FOUND");
    pub const REVISION_CONFLICT: Self = Self("PREAMBLE_REVISION_CONFLICT");
    pub const REVISION_EXHAUSTED: Self = Self("PREAMBLE_REVISION_EXHAUSTED");
    pub const LIMIT_REACHED: Self = Self("PREAMBLE_LIMIT_REACHED");
    pub const COMBINED_LIMIT_EXCEEDED: Self = Self("PREAMBLE_COMBINED_LIMIT_EXCEEDED");
    pub const PROJECT_PATH_OUTSIDE_BASE: Self = Self("PREAMBLE_PROJECT_PATH_OUTSIDE_BASE");
    pub const PROJECT_PATH_NOT_FOUND: Self = Self("PREAMBLE_PROJECT_PATH_NOT_FOUND");
    pub const PROJECT_PATH_INACCESSIBLE: Self = Self("PREAMBLE_PROJECT_PATH_INACCESSIBLE");
    pub const PROJECT_PATH_NOT_DIRECTORY: Self = Self("PREAMBLE_PROJECT_PATH_NOT_DIRECTORY");
    pub const ENVELOPE_MISMATCH: Self = Self("PREAMBLE_ENVELOPE_MISMATCH");
    pub const SLASH_COMMAND_BLOCKED: Self = Self("PREAMBLE_SLASH_COMMAND_BLOCKED");
    pub const ID_COLLISION: Self = Self("PREAMBLE_ID_COLLISION");
    pub const ID_LIFETIME_LIMIT_REACHED: Self = Self("PREAMBLE_ID_LIFETIME_LIMIT_REACHED");
    pub const CATALOG_SAVE_UNKNOWN: Self = Self("PREAMBLE_CATALOG_SAVE_UNKNOWN");
    pub const SELECTION_REVISION_CONFLICT: Self = Self("PREAMBLE_SELECTION_REVISION_CONFLICT");
    pub const SELECTION_COMPOSITION_INVALID: Self = Self("PREAMBLE_SELECTION_COMPOSITION_INVALID");
    pub const SELECTION_NOTICE_FAILED: Self = Self("PREAMBLE_SELECTION_NOTICE_FAILED");
    pub const SELECTION_SAVE_UNKNOWN: Self = Self("PREAMBLE_SELECTION_SAVE_UNKNOWN");
    pub const SNIPPET_NAME_CONFLICT: Self = Self("PREAMBLE_SNIPPET_NAME_CONFLICT");

    pub fn as_str(self) -> &'static str {
        self.0
    }
}

impl fmt::Display for PreambleErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

pub fn render_preamble_content<S: AsRef<str>>(
    content: &str,
    values: &RuntimeTemplateValues<S>,
) -> Result<String, TemplateExpansionError> {
    expand_template(
        content,
        RUNTIME_TEMPLATE_VARIABLES,
        |variable| values.get(variable),
        PREAMBLE_COMBINED_MAX_LENGTH as f64,
    )
}

fn has_only_keys(value: &Map<String, Value>, keys: &[&str]) -> bool {
    value.keys().all(|key| keys.contains(&key.as_str()))
}

fn non_empty_string(value: &Value) -> Option<&str> {
    let content = trim(value.as_str()?);
    (!content.is_empty()).then_some(content)
}

fn timestamp(value: &Value) -> Option<String> {
    to_iso_string(date_parse(value.as_str()?)?).ok()
}

fn non_negative_safe_integer(value: &Value) -> Option<u64> {
    let number = as_number(value)?;
    (is_safe_integer(number) && number >= 0.0).then_some(number as u64)
}

pub fn is_preamble_boundary_kind(value: &Value) -> Option<PreambleBoundaryKind> {
    Some(match value.as_str()? {
        "new-chat" => PreambleBoundaryKind::NewChat,
        "fork" => PreambleBoundaryKind::Fork,
        "continuation" => PreambleBoundaryKind::Continuation,
        "agent-switch" => PreambleBoundaryKind::AgentSwitch,
        "selection-change" => PreambleBoundaryKind::SelectionChange,
        _ => return None,
    })
}

pub fn normalize_pending_preamble_boundary(value: &Value) -> Option<PendingPreambleBoundary> {
    let raw = value.as_object()?;
    let kind = is_preamble_boundary_kind(raw.get("kind")?)?;
    let ownership_epoch = non_empty_string(raw.get("ownershipEpoch")?)?.to_owned();
    if kind == PreambleBoundaryKind::SelectionChange {
        if !has_only_keys(raw, &["kind", "ownershipEpoch", "selectionRevision"]) {
            return None;
        }
        let selection_revision = non_negative_safe_integer(raw.get("selectionRevision")?)?;
        return Some(PendingPreambleBoundary::SelectionChange {
            ownership_epoch,
            selection_revision,
        });
    }
    if !has_only_keys(raw, &["kind", "ownershipEpoch"]) {
        return None;
    }
    Some(match kind {
        PreambleBoundaryKind::NewChat => PendingPreambleBoundary::NewChat { ownership_epoch },
        PreambleBoundaryKind::Fork => PendingPreambleBoundary::Fork { ownership_epoch },
        PreambleBoundaryKind::Continuation => {
            PendingPreambleBoundary::Continuation { ownership_epoch }
        }
        PreambleBoundaryKind::AgentSwitch => {
            PendingPreambleBoundary::AgentSwitch { ownership_epoch }
        }
        PreambleBoundaryKind::SelectionChange => return None,
    })
}

pub fn normalize_chat_preamble_selection(value: &Value) -> Option<ChatPreambleSelection> {
    let raw = value.as_object()?;
    if !has_only_keys(raw, &["revision", "orderedPreambleIds"]) {
        return None;
    }
    let revision = non_negative_safe_integer(raw.get("revision")?)?;
    let ordered_preamble_ids = normalize_ordered_preamble_ids(raw.get("orderedPreambleIds")?)?;
    Some(ChatPreambleSelection {
        revision,
        ordered_preamble_ids,
    })
}

pub fn normalize_preamble_selection_reference(value: &Value) -> Option<PreambleSelectionReference> {
    let raw = value.as_object()?;
    if !has_only_keys(raw, &["id", "title"]) {
        return None;
    }
    let id = raw
        .get("id")
        .filter(|value| is_preamble_id(value))?
        .as_str()?
        .to_owned();
    let title = normalize_preamble_title(raw.get("title")?)?;
    Some(PreambleSelectionReference { id, title })
}

pub fn normalize_unavailable_preamble_selection_reference(
    value: &Value,
) -> Option<UnavailablePreambleSelectionReference> {
    let raw = value.as_object()?;
    if !has_only_keys(raw, &["id", "reason"]) {
        return None;
    }
    let id = raw
        .get("id")
        .filter(|value| is_preamble_id(value))?
        .as_str()?
        .to_owned();
    let reason = is_preamble_selection_unavailable_reason(raw.get("reason")?)?;
    Some(UnavailablePreambleSelectionReference { id, reason })
}

pub fn normalize_preamble_selection_projection(
    value: &Value,
) -> Option<PreambleSelectionProjection> {
    let raw = value.as_object()?;
    if !has_only_keys(
        raw,
        &["catalogRevision", "eligiblePreambles", "unavailable"],
    ) {
        return None;
    }
    let catalog_revision = non_negative_safe_integer(raw.get("catalogRevision")?)?;
    let eligible = raw.get("eligiblePreambles")?.as_array()?;
    let missing = raw.get("unavailable")?.as_array()?;
    if eligible.len() > PREAMBLE_MAX_COUNT || missing.len() > PREAMBLE_MAX_COUNT {
        return None;
    }
    let mut eligible_preambles = Vec::with_capacity(eligible.len());
    let mut unavailable = Vec::with_capacity(missing.len());
    let mut ids = HashSet::new();
    for item in eligible {
        let reference = normalize_preamble_selection_reference(item)?;
        if !ids.insert(reference.id.clone()) {
            return None;
        }
        eligible_preambles.push(reference);
    }
    for item in missing {
        let reference = normalize_unavailable_preamble_selection_reference(item)?;
        if !ids.insert(reference.id.clone()) {
            return None;
        }
        unavailable.push(reference);
    }
    Some(PreambleSelectionProjection {
        catalog_revision,
        eligible_preambles,
        unavailable,
    })
}

pub fn is_preambles_invalidation_reason(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|reason| PREAMBLES_INVALIDATION_REASONS.contains(&reason))
}

pub fn normalize_preamble_title(value: &Value) -> Option<String> {
    let title = non_empty_string(value)?;
    if title.contains(['\r', '\n']) || title.chars().count() > PREAMBLE_TITLE_MAX_CODE_POINTS {
        return None;
    }
    Some(title.to_owned())
}

pub fn normalize_preamble_scope(value: &Value) -> Option<PreambleScope> {
    let raw = value.as_object()?;
    match raw.get("type")?.as_str()? {
        "global" if has_only_keys(raw, &["type"]) => Some(PreambleScope::Global),
        "project-paths" if has_only_keys(raw, &["type", "rules"]) => {
            let rules = raw.get("rules")?.as_array()?;
            if rules.is_empty() || rules.len() > PREAMBLE_PATH_RULE_MAX_COUNT {
                return None;
            }
            let mut parsed = Vec::with_capacity(rules.len());
            let mut paths = HashSet::new();
            for rule in rules {
                let rule = rule.as_object()?;
                if !has_only_keys(rule, &["executorId", "projectPath", "includeNested"]) {
                    return None;
                }
                let executor_id =
                    parse_executor_id(rule.get("executorId").unwrap_or(&Value::Null))?;
                let project_path = rule.get("projectPath")?.as_str()?.to_owned();
                if trim(&project_path).is_empty() {
                    return None;
                }
                let include_nested = rule.get("includeNested")?.as_bool()?;
                if !paths.insert((executor_id.clone(), project_path.clone())) {
                    return None;
                }
                let executor_id = if executor_id == LOCAL_EXECUTOR_ID {
                    OptionalNullable::ABSENT
                } else {
                    OptionalNullable::some(executor_id)
                };
                parsed.push(PreambleProjectPathRule {
                    project_path,
                    include_nested,
                    executor_id,
                });
            }
            Some(PreambleScope::ProjectPaths { rules: parsed })
        }
        _ => None,
    }
}

fn normalize_preamble_agent_ids(value: Option<&Value>) -> Option<Vec<AgentId>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let values = value.as_array()?;
    if values.len() > PREAMBLE_AGENT_FILTER_MAX_COUNT {
        return None;
    }
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|value| {
            if !is_agent_id(value) {
                return None;
            }
            let id = value.as_str()?;
            seen.insert(id).then(|| id.to_owned())
        })
        .collect()
}

fn normalize_preamble_tag_filter(value: Option<&Value>) -> Option<PreambleTagFilter> {
    let Some(value) = value else {
        return Some(PreambleTagFilter {
            mode: PreambleTagMatchMode::Any,
            tags: Vec::new(),
        });
    };
    let raw = value.as_object()?;
    if !has_only_keys(raw, &["mode", "tags"]) {
        return None;
    }
    let mode = match raw.get("mode")?.as_str()? {
        "any" => PreambleTagMatchMode::Any,
        "all" => PreambleTagMatchMode::All,
        _ => return None,
    };
    let values = raw.get("tags")?.as_array()?;
    if values.len() > PREAMBLE_TAG_FILTER_MAX_COUNT {
        return None;
    }
    let mut seen = HashSet::new();
    let mut tags = Vec::with_capacity(values.len());
    for value in values {
        let text = value.as_str()?;
        let tag = normalize_tag_slug(text);
        if tag.is_empty()
            || tag != text
            || tag.chars().count() > PREAMBLE_TAG_MAX_CODE_POINTS
            || !seen.insert(text)
        {
            return None;
        }
        tags.push(tag);
    }
    Some(PreambleTagFilter { mode, tags })
}

const PREAMBLE_DEFINITION_KEYS: &[&str] = &[
    "enabled",
    "title",
    "snippetShortName",
    "content",
    "scope",
    "agentIds",
    "tagFilter",
];

pub fn normalize_preamble_definition_input(value: &Value) -> Option<PreambleDefinition> {
    let raw = value.as_object()?;
    if !has_only_keys(raw, PREAMBLE_DEFINITION_KEYS) {
        return None;
    }
    normalize_preamble_definition(raw)
}

fn normalize_preamble_definition(raw: &Map<String, Value>) -> Option<PreambleDefinition> {
    let title = normalize_preamble_title(raw.get("title")?)?;
    let snippet_short_name = match raw.get("snippetShortName") {
        None => None,
        Some(value) if is_snippet_short_name(value) => Some(value.as_str()?.to_owned()),
        Some(_) => return None,
    };
    let scope = normalize_preamble_scope(raw.get("scope")?)?;
    let agent_ids = normalize_preamble_agent_ids(raw.get("agentIds"))?;
    let tag_filter = normalize_preamble_tag_filter(raw.get("tagFilter"))?;
    let enabled = raw.get("enabled")?.as_bool()?;
    let content = raw.get("content")?.as_str()?;
    if trim(content).is_empty()
        || utf16::len(content) > PREAMBLE_CONTENT_MAX_LENGTH
        || content.contains(PREAMBLE_FILE_CONTEXT_SEPARATOR)
    {
        return None;
    }
    Some(PreambleDefinition {
        enabled,
        title,
        snippet_short_name,
        content: content.to_owned(),
        scope,
        agent_ids,
        tag_filter,
    })
}

pub fn normalize_preamble(value: &Value) -> Option<Preamble> {
    let raw = value.as_object()?;
    if raw.keys().any(|key| {
        !(matches!(key.as_str(), "id" | "createdAt" | "updatedAt")
            || PREAMBLE_DEFINITION_KEYS.contains(&key.as_str()))
    }) {
        return None;
    }
    let id = raw
        .get("id")
        .filter(|value| is_preamble_id(value))?
        .as_str()?
        .to_owned();
    let definition = normalize_preamble_definition(raw)?;
    let created_at = timestamp(raw.get("createdAt")?)?;
    let updated_at = timestamp(raw.get("updatedAt")?)?;
    Some(Preamble {
        id,
        definition,
        created_at,
        updated_at,
    })
}

pub fn normalize_preambles_snapshot(value: &Value) -> Option<PreamblesSnapshot> {
    let raw = value.as_object()?;
    if !has_only_keys(raw, &["revision", "preambles"]) {
        return None;
    }
    let revision = non_negative_safe_integer(raw.get("revision")?)?;
    let items = raw.get("preambles")?.as_array()?;
    if items.len() > PREAMBLE_MAX_COUNT {
        return None;
    }
    let mut preambles = Vec::with_capacity(items.len());
    let mut ids = HashSet::new();
    let mut snippet_names = HashSet::new();
    for item in items {
        let preamble = normalize_preamble(item)?;
        if !ids.insert(preamble.id.clone())
            || preamble
                .definition
                .snippet_short_name
                .as_ref()
                .is_some_and(|name| !snippet_names.insert(name.clone()))
        {
            return None;
        }
        preambles.push(preamble);
    }
    Some(PreamblesSnapshot {
        revision,
        preambles,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_omitted_and_explicit_automatic_filters_without_broadening_malformed_values() {
        let mut definition = json!({"enabled":true,"title":"  Synthetic  ","content":"Keep  spaces","scope":{"type":"global"}});
        let result = normalize_preamble_definition_input(&definition).unwrap();
        assert_eq!(result.title, "Synthetic");
        assert_eq!(result.content, "Keep  spaces");
        assert!(result.agent_ids.is_empty());
        assert!(result.tag_filter.tags.is_empty());
        definition["agentIds"] = Value::Null;
        assert!(normalize_preamble_definition_input(&definition).is_none());
        definition["agentIds"] = json!(["codex"]);
        definition["tagFilter"] = json!({"mode":"all","tags":["Backend"]});
        assert!(normalize_preamble_definition_input(&definition).is_none());
    }

    #[test]
    fn applies_title_limits_in_code_points_and_body_limits_in_utf16() {
        let emoji = "\u{1f600}";
        assert!(
            normalize_preamble_title(&json!(emoji.repeat(PREAMBLE_TITLE_MAX_CODE_POINTS)))
                .is_some()
        );
        assert!(
            normalize_preamble_title(&json!(emoji.repeat(PREAMBLE_TITLE_MAX_CODE_POINTS + 1)))
                .is_none()
        );
        let mut definition = json!({"enabled":true,"title":"Synthetic","content":emoji.repeat(PREAMBLE_CONTENT_MAX_LENGTH / 2),"scope":{"type":"global"}});
        assert!(normalize_preamble_definition_input(&definition).is_some());
        definition["content"] = json!(emoji.repeat(PREAMBLE_CONTENT_MAX_LENGTH / 2 + 1));
        assert!(normalize_preamble_definition_input(&definition).is_none());
    }
}
