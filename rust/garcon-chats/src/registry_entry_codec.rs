//! Validates the current registry in the original's order.

use std::collections::HashSet;

use garcon_contract::{
    agent_integration::parse_agent_settings_by_id,
    api_providers::ApiProtocol,
    chat_id::{ChatId, InvalidChatIdError, parse_chat_id, parse_chat_id_input},
    chat_modes::{
        DEFAULT_PERMISSION_MODE, PermissionMode, ThinkingMode, normalize_permission_mode,
        normalize_thinking_mode,
    },
    chat_parentage::{ChatLineage, parse_chat_lineage},
    executors::is_executor_id,
    preambles::{
        ChatPreambleSelection, PendingPreambleBoundary, normalize_chat_preamble_selection,
        normalize_pending_preamble_boundary,
    },
    transcript_seed::{NativeSeedReceipt, parse_native_seed_receipt},
};
use garcon_interface::transcript::AgentNativeSessionRef;
use garcon_js::{
    OptionalNullable,
    date_parse::date_parse,
    is_safe_integer,
    json::{Opaque, as_number},
    number_to_string,
};
use serde_json::{Map, Value};

use crate::{
    carryover::segment_types::is_carry_over_segment_id,
    registry_contracts::{
        CHAT_REGISTRY_VERSION, CarryOverHandoffTarget, CarryOverMigrationQuarantine,
        CarryOverSegmentRef, ChatRegistryEntry, ChatRegistrySnapshot, StoredEntry,
    },
};

#[derive(Debug, thiserror::Error)]
pub enum RegistryCodecError {
    #[error(transparent)]
    ChatId(#[from] InvalidChatIdError),
    #[error("{0}")]
    Invalid(String),
}

fn invalid(message: impl Into<String>) -> RegistryCodecError {
    RegistryCodecError::Invalid(message.into())
}

type Record = Map<String, Value>;

fn field<'a>(object: &'a Record, key: &str) -> &'a Value {
    object.get(key).unwrap_or(&Value::Null)
}

fn version_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    version_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Number(_) => number_to_string(as_number(value).unwrap_or(0.0)),
        _ => value.to_string(),
    }
}

pub fn create_empty_registry() -> ChatRegistrySnapshot {
    ChatRegistrySnapshot::empty()
}

pub fn parse_registry(value: &Value) -> Result<ChatRegistrySnapshot, RegistryCodecError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("Invalid chats.json: registry must be an object"))?;
    let version = object.get("version");
    if version.and_then(as_number) != Some(CHAT_REGISTRY_VERSION as f64) {
        let value = version.map_or_else(|| "undefined".to_owned(), version_string);
        return Err(invalid(format!(
            "Unsupported chat registry version: {value}"
        )));
    }
    let sessions = object
        .get("sessions")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("Invalid chats.json: sessions must be an object"))?;
    let mut parsed = create_empty_registry();
    for (id, raw) in sessions {
        let id = parse_chat_id(&Value::String(id.clone()))?;
        let raw = raw
            .as_object()
            .ok_or_else(|| invalid(format!("Invalid chat registry entry for {id}")))?;
        let entry = normalize_chat_registry_entry(raw, &id)?;
        parsed.sessions.insert(id, StoredEntry::loaded(entry));
    }
    Ok(parsed)
}

pub fn normalize_registry_modes(entry: &Record) -> (PermissionMode, ThinkingMode) {
    (
        normalize_permission_mode(field(entry, "permissionMode"), DEFAULT_PERMISSION_MODE),
        normalize_thinking_mode(field(entry, "thinkingMode"), ThinkingMode::None),
    )
}

pub fn parse_pending_preamble_boundary(
    value: Option<&Value>,
) -> Result<Option<PendingPreambleBoundary>, RegistryCodecError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => normalize_pending_preamble_boundary(value)
            .map(Some)
            .ok_or_else(|| invalid("Invalid pending preamble boundary")),
    }
}

pub fn normalize_preamble_selection(
    value: Option<&Value>,
) -> Result<ChatPreambleSelection, RegistryCodecError> {
    match value {
        None => Ok(ChatPreambleSelection {
            revision: 0,
            ordered_preamble_ids: Vec::new(),
        }),
        Some(value) => normalize_chat_preamble_selection(value)
            .ok_or_else(|| invalid("Invalid preamble selection")),
    }
}

pub fn assert_preamble_boundary_binding(
    epoch: &str,
    boundary: Option<&PendingPreambleBoundary>,
    selection: &ChatPreambleSelection,
) -> Result<(), RegistryCodecError> {
    if let Some(boundary) = boundary {
        let bound = match boundary {
            PendingPreambleBoundary::NewChat { ownership_epoch }
            | PendingPreambleBoundary::Fork { ownership_epoch }
            | PendingPreambleBoundary::Continuation { ownership_epoch }
            | PendingPreambleBoundary::AgentSwitch { ownership_epoch }
            | PendingPreambleBoundary::SelectionChange {
                ownership_epoch, ..
            } => ownership_epoch,
        };
        if bound != epoch {
            return Err(invalid("Preamble boundary ownership epoch mismatch"));
        }
        if let PendingPreambleBoundary::SelectionChange {
            selection_revision, ..
        } = boundary
            && *selection_revision != selection.revision
        {
            return Err(invalid("Preamble boundary selection revision mismatch"));
        }
    }
    Ok(())
}

pub fn normalize_agent_id(entry: &Record) -> &str {
    field(entry, "agentId").as_str().unwrap_or_default()
}

fn nullable_string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

pub fn normalize_chat_registry_entry(
    raw: &Record,
    chat_id: &str,
) -> Result<ChatRegistryEntry, RegistryCodecError> {
    if raw.contains_key("parentChat") {
        return Err(invalid(format!(
            "Legacy parentChat in registry entry {chat_id}"
        )));
    }
    let executor_id = match raw.get("executorId") {
        None => OptionalNullable::ABSENT,
        Some(Value::Null) => OptionalNullable::NULL,
        Some(value) if is_executor_id(value) => OptionalNullable::from(nullable_string(value)),
        Some(_) => return Err(invalid("Invalid executor ID")),
    };
    let agent_id = normalize_agent_id(raw);
    let native_session = normalize_native_session(raw.get("nativeSession"), agent_id)?;
    let agent_settings_by_id = parse_agent_settings_by_id(field(raw, "agentSettingsById"))
        .ok_or_else(|| {
            let name = if agent_id.is_empty() {
                "unknown agent"
            } else {
                agent_id
            };
            invalid(format!("Invalid agentSettingsById for {name}"))
        })?;
    let agent_session_id = nullable_string(field(raw, "agentSessionId"));
    let carry_over_segments = parse_carry_over_segment_refs(field(raw, "carryOverSegments"))?;
    let native_seed_receipt = normalize_native_seed_receipt(raw.get("nativeSeedReceipt"))?;
    let agent_ownership_epoch = normalize_ownership_epoch(field(raw, "agentOwnershipEpoch"))?;
    let pending_preamble_boundary =
        parse_pending_preamble_boundary(raw.get("pendingPreambleBoundary"))?;
    let preamble_selection = normalize_preamble_selection(raw.get("preambleSelection"))?;
    assert_preamble_boundary_binding(
        agent_ownership_epoch,
        pending_preamble_boundary.as_ref(),
        &preamble_selection,
    )?;
    assert_seed_receipt_binding(agent_session_id.as_deref(), native_seed_receipt.as_ref())?;
    let (permission_mode, thinking_mode) = normalize_registry_modes(raw);
    Ok(ChatRegistryEntry {
        executor_id,
        agent_id: agent_id.to_owned(),
        agent_session_id,
        native_session,
        agent_ownership_epoch: agent_ownership_epoch.to_owned(),
        agent_settings_by_id,
        project_path: field(raw, "projectPath")
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        tags: field(raw, "tags")
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(nullable_string)
            .collect(),
        model: field(raw, "model").as_str().unwrap_or_default().to_owned(),
        api_provider_id: nullable_string(field(raw, "apiProviderId")),
        model_endpoint_id: nullable_string(field(raw, "modelEndpointId")),
        model_protocol: match field(raw, "modelProtocol").as_str() {
            Some("openai-compatible") => Some(ApiProtocol::OpenAiCompatible),
            Some("anthropic-messages") => Some(ApiProtocol::AnthropicMessages),
            _ => None,
        },
        last_read_at: OptionalNullable::from(nullable_string(field(raw, "lastReadAt"))),
        permission_mode,
        thinking_mode,
        carry_over_segments,
        native_seed_receipt,
        carry_over_migration_quarantine: normalize_migration_quarantine(
            raw.get("carryOverMigrationQuarantine"),
        )?,
        pending_preamble_boundary,
        preamble_selection,
        parent_chat_id: require_parent_chat_id(raw.get("parentChatId"), chat_id)?,
        lineage: require_chat_lineage(raw.get("lineage"), chat_id)?,
    })
}

pub fn require_chat_lineage(
    value: Option<&Value>,
    chat_id: &str,
) -> Result<Option<ChatLineage>, RegistryCodecError> {
    if value == Some(&Value::Null) {
        return Ok(None);
    }
    let lineage = value
        .and_then(parse_chat_lineage)
        .ok_or_else(|| invalid(format!("Invalid lineage for {chat_id}")))?;
    if lineage.source_chat_id.as_ref() == chat_id {
        return Err(invalid(format!(
            "Chat {chat_id} cannot be its own lineage source"
        )));
    }
    Ok(Some(lineage))
}

pub fn require_parent_chat_id(
    value: Option<&Value>,
    chat_id: &str,
) -> Result<Option<ChatId>, RegistryCodecError> {
    if value == Some(&Value::Null) {
        return Ok(None);
    }
    let parent = parse_chat_id_input(value)?;
    if parent.as_ref() == chat_id {
        return Err(invalid(format!("Chat {chat_id} cannot be its own parent")));
    }
    Ok(Some(parent))
}

pub fn parse_carry_over_segment_refs(
    value: &Value,
) -> Result<Vec<CarryOverSegmentRef>, RegistryCodecError> {
    let rows = value
        .as_array()
        .ok_or_else(|| invalid("Invalid carryover segment references"))?;
    let mut ids = HashSet::new();
    rows.iter()
        .map(|raw| {
            let raw = raw
                .as_object()
                .ok_or_else(|| invalid("Invalid carryover segment reference"))?;
            let id_value = field(raw, "id");
            let id = id_value
                .as_str()
                .filter(|_| is_carry_over_segment_id(id_value))
                .ok_or_else(|| invalid("Invalid carryover segment ID"))?;
            if !ids.insert(id) {
                return Err(invalid("Duplicate carryover segment ID"));
            }
            let agent_id = normalize_agent_name(field(raw, "agentId"), "segment agent")?;
            let model = required_string(field(raw, "model"), "segment model")?;
            let captured_at = required_timestamp(field(raw, "capturedAt"), "segment capture time")?;
            let stored_message_count = non_negative_safe_integer(
                field(raw, "storedMessageCount"),
                "stored message count",
            )?;
            let visible_message_count = non_negative_safe_integer(
                field(raw, "visibleMessageCount"),
                "visible message count",
            )?;
            if visible_message_count > stored_message_count {
                return Err(invalid("Carryover segment cutoff is outside its artifact"));
            }
            let trailing_handoff = parse_carry_over_handoff_target(raw.get("trailingHandoff"))?;
            if stored_message_count == 0 && trailing_handoff.is_none() {
                return Err(invalid(
                    "Empty carryover segment must contain one handoff boundary",
                ));
            }
            if stored_message_count > 0 && visible_message_count == 0 {
                return Err(invalid(
                    "Non-empty carryover segment must expose at least one message",
                ));
            }
            Ok(CarryOverSegmentRef {
                id: id.to_owned(),
                agent_id: agent_id.to_owned(),
                model: model.to_owned(),
                captured_at: captured_at.to_owned(),
                stored_message_count,
                visible_message_count,
                trailing_handoff,
            })
        })
        .collect()
}

pub fn parse_carry_over_handoff_target(
    value: Option<&Value>,
) -> Result<Option<CarryOverHandoffTarget>, RegistryCodecError> {
    if value == Some(&Value::Null) {
        return Ok(None);
    }
    let raw = value
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("Invalid carryover handoff target"))?;
    Ok(Some(CarryOverHandoffTarget {
        agent_id: normalize_agent_name(field(raw, "agentId"), "handoff target agent")?.to_owned(),
        model: required_string(field(raw, "model"), "handoff target model")?.to_owned(),
    }))
}

pub fn normalize_native_seed_receipt(
    value: Option<&Value>,
) -> Result<Option<NativeSeedReceipt>, RegistryCodecError> {
    if value == Some(&Value::Null) {
        return Ok(None);
    }
    value
        .and_then(parse_native_seed_receipt)
        .map(Some)
        .ok_or_else(|| invalid("Invalid native seed receipt"))
}

pub fn normalize_migration_quarantine(
    value: Option<&Value>,
) -> Result<Option<CarryOverMigrationQuarantine>, RegistryCodecError> {
    if value == Some(&Value::Null) {
        return Ok(None);
    }
    let error = || invalid("Invalid carryover migration quarantine");
    let raw = value.and_then(Value::as_object).ok_or_else(error)?;
    let artifact_id = field(raw, "artifactId")
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(error)?;
    let error_code = field(raw, "errorCode")
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(error)?;
    Ok(Some(CarryOverMigrationQuarantine {
        artifact_id: artifact_id.to_owned(),
        error_code: error_code.to_owned(),
    }))
}

pub fn assert_seed_receipt_binding(
    session: Option<&str>,
    receipt: Option<&NativeSeedReceipt>,
) -> Result<(), RegistryCodecError> {
    if receipt.is_some_and(|receipt| Some(receipt.agent_session_id.as_str()) != session) {
        return Err(invalid("Native seed receipt session mismatch"));
    }
    Ok(())
}

pub fn normalize_agent_name<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a str, RegistryCodecError> {
    required_string(value, field).and_then(|text| {
        if text.is_empty() {
            Err(invalid(format!("Invalid carryover {field}")))
        } else {
            Ok(text)
        }
    })
}

pub fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, RegistryCodecError> {
    value
        .as_str()
        .ok_or_else(|| invalid(format!("Invalid carryover {field}")))
}

pub fn required_timestamp<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a str, RegistryCodecError> {
    value
        .as_str()
        .filter(|text| !text.is_empty() && date_parse(text).is_some())
        .ok_or_else(|| invalid(format!("Invalid carryover {field}")))
}

fn safe_unsigned(value: &Value) -> Option<u64> {
    as_number(value)
        .filter(|&number| number >= 0.0 && is_safe_integer(number))
        .map(|number| number as u64)
}

pub fn non_negative_safe_integer(value: &Value, field: &str) -> Result<u64, RegistryCodecError> {
    safe_unsigned(value).ok_or_else(|| invalid(format!("Invalid carryover {field}")))
}

pub fn normalize_ownership_epoch(value: &Value) -> Result<&str, RegistryCodecError> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid("Chat is missing agentOwnershipEpoch"))
}

pub fn normalize_native_session(
    value: Option<&Value>,
    agent_id: &str,
) -> Result<Option<AgentNativeSessionRef>, RegistryCodecError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let raw = value
        .as_object()
        .ok_or_else(|| invalid(format!("Invalid native session for {agent_id}")))?;
    if field(raw, "ownerId").as_str() != Some(agent_id) {
        return Err(invalid(format!(
            "Native session owner mismatch for {agent_id}"
        )));
    }
    let schema_version = safe_unsigned(field(raw, "schemaVersion"))
        .filter(|&version| version >= 1)
        .ok_or_else(|| {
            invalid(format!(
                "Invalid native session schema version for {agent_id}"
            ))
        })?;
    let value = field(raw, "value");
    if !value.is_object() {
        return Err(invalid(format!(
            "Invalid native session value for {agent_id}"
        )));
    }
    Ok(Some(AgentNativeSessionRef {
        owner_id: agent_id.to_owned(),
        schema_version,
        value: Opaque::from_value(value.clone()),
    }))
}
