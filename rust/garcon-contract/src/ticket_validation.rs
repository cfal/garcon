//! Validation shared by ticket inputs and stored snapshots.

use std::collections::HashSet;

use garcon_js::{
    date_parse::date_parse, is_safe_integer, json::as_number, number_to_string, to_iso_string,
    trim, utf16,
};
use serde_json::Value;

use crate::{
    chat_id::parse_chat_id,
    executors::is_remote_executor_id,
    json::JsonObject,
    tickets::{
        TICKET_LIMITS, TicketActor, TicketAssignee, TicketChatProvenance, TicketLinkKind,
        TicketOwner, TicketPrincipalMode, TicketPriority, TicketResolution, TicketSource,
        TicketStatus, TicketUnassigned,
    },
};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct TicketValidationError(String);

impl TicketValidationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

pub fn ticket_invalid<T>(message: impl Into<String>) -> Result<T, TicketValidationError> {
    Err(TicketValidationError::new(message))
}

pub fn ticket_bytes(value: &str) -> usize {
    value.len()
}

pub fn ticket_record<'a>(
    value: &'a Value,
    keys: &[&str],
) -> Result<&'a JsonObject, TicketValidationError> {
    let Some(record) = value.as_object() else {
        return ticket_invalid("Expected an object.");
    };
    require_keys(record, keys)?;
    Ok(record)
}

fn require_keys(record: &JsonObject, keys: &[&str]) -> Result<(), TicketValidationError> {
    if record.keys().any(|key| !keys.contains(&key.as_str())) {
        return ticket_invalid("Unexpected ticket field.");
    }
    Ok(())
}

pub fn ticket_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, TicketValidationError> {
    value.as_str().ok_or_else(|| malformed_text(field))
}

pub fn ticket_string_utf16(value: &[u16], field: &str) -> Result<String, TicketValidationError> {
    String::from_utf16(value).map_err(|_| malformed_text(field))
}

fn malformed_text(field: &str) -> TicketValidationError {
    TicketValidationError::new(format!("{field} must be well-formed Unicode text."))
}

pub fn ticket_line<'a>(
    value: &'a Value,
    field: &str,
    max_code_points: f64,
) -> Result<&'a str, TicketValidationError> {
    let raw = ticket_string(value, field)?;
    if raw
        .chars()
        .any(|c| matches!(c, '\0'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}'))
    {
        return ticket_invalid(format!("{field} must be a single line without controls."));
    }
    let text = trim(raw);
    if text.is_empty() || text.chars().count() as f64 > max_code_points {
        return ticket_invalid(format!(
            "{field} must contain 1\u{2013}{} characters.",
            number_to_string(max_code_points)
        ));
    }
    Ok(text)
}

pub fn ticket_title(value: &Value) -> Result<&str, TicketValidationError> {
    ticket_line(value, "title", TICKET_LIMITS.title_code_points as f64)
}

pub fn ticket_project(value: &Value) -> Result<&str, TicketValidationError> {
    let project = ticket_line(value, "project", TICKET_LIMITS.project_bytes as f64)?;
    if ticket_bytes(project) > TICKET_LIMITS.project_bytes {
        return ticket_invalid("project exceeds 4096 bytes.");
    }
    Ok(project)
}

pub fn ticket_ref(value: &Value) -> Result<&str, TicketValidationError> {
    let reference = ticket_line(value, "ref", TICKET_LIMITS.ref_bytes as f64)?;
    if ticket_bytes(reference) > TICKET_LIMITS.ref_bytes {
        return ticket_invalid("ref exceeds 128 bytes.");
    }
    Ok(reference)
}

pub fn ticket_body(value: &Value) -> Result<&str, TicketValidationError> {
    let body = ticket_string(value, "body")?;
    if ticket_bytes(body) > TICKET_LIMITS.body_bytes {
        return ticket_invalid("body exceeds 48 KiB.");
    }
    Ok(body)
}

pub fn ticket_comment_body(value: &Value) -> Result<&str, TicketValidationError> {
    let body = ticket_body(value)?;
    if trim(body).is_empty() {
        return ticket_invalid("Comment must not be blank.");
    }
    Ok(body)
}

pub const MAX_SAFE_TICKET_INTEGER: f64 = 9_007_199_254_740_991.0;

pub fn ticket_integer(
    value: &Value,
    field: &str,
    minimum: Option<f64>,
    maximum: Option<f64>,
) -> Result<i64, TicketValidationError> {
    validate_integer(
        as_number(value),
        field,
        minimum.unwrap_or(1.0),
        maximum.unwrap_or(MAX_SAFE_TICKET_INTEGER),
    )
}

fn validate_integer(
    value: Option<f64>,
    field: &str,
    minimum: f64,
    maximum: f64,
) -> Result<i64, TicketValidationError> {
    if let Some(value) = value
        && is_safe_integer(value)
        && !(value < minimum || value > maximum)
    {
        return Ok(value as i64);
    }
    ticket_invalid(format!(
        "{field} must be an integer from {} to {}.",
        number_to_string(minimum),
        number_to_string(maximum),
    ))
}

pub fn ticket_uuid<'a>(value: &'a Value, field: &str) -> Result<&'a str, TicketValidationError> {
    let canonical = |value: &&str| {
        value.len() == 36
            && value.bytes().enumerate().all(|(index, byte)| match index {
                8 | 13 | 18 | 23 => byte == b'-',
                14 => byte == b'4',
                19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
                _ => matches!(byte, b'0'..=b'9' | b'a'..=b'f'),
            })
    };
    value
        .as_str()
        .filter(canonical)
        .ok_or_else(|| TicketValidationError::new(format!("{field} must be a canonical UUIDv4.")))
}

pub const TICKET_ID_PREFIX: &str = "G-";

pub fn format_ticket_id(number: f64) -> Result<String, TicketValidationError> {
    let number = validate_integer(Some(number), "ticket number", 1.0, MAX_SAFE_TICKET_INTEGER)?;
    Ok(format!("{TICKET_ID_PREFIX}{number}"))
}

fn parse_ticket_id(value: &str) -> Result<u64, TicketValidationError> {
    let Some(digits) = value.strip_prefix(TICKET_ID_PREFIX) else {
        return ticket_invalid("ticketId must have the form G-42.");
    };
    if !matches!(digits.as_bytes().first(), Some(b'1'..=b'9'))
        || !digits.bytes().all(|b| b.is_ascii_digit())
    {
        return ticket_invalid("ticketId must have the form G-42.");
    }
    Ok(validate_integer(
        digits.parse().ok(),
        "ticket number",
        1.0,
        MAX_SAFE_TICKET_INTEGER,
    )? as u64)
}

pub fn ticket_id(value: &Value) -> Result<&str, TicketValidationError> {
    let Some(id) = value.as_str() else {
        return ticket_invalid("ticketId must have the form G-42.");
    };
    parse_ticket_id(id)?;
    Ok(id)
}

pub fn ticket_number(value: &str) -> Result<u64, TicketValidationError> {
    parse_ticket_id(value)
}

pub fn stored_ticket_id(value: &Value) -> Result<String, TicketValidationError> {
    if let Some(legacy) = value.as_str().and_then(|value| value.strip_prefix("ISS-")) {
        let migrated = format!("{TICKET_ID_PREFIX}{legacy}");
        parse_ticket_id(&migrated)?;
        return Ok(migrated);
    }
    ticket_id(value).map(str::to_owned)
}

pub fn ticket_chat_id(value: &Value) -> Result<String, TicketValidationError> {
    parse_chat_id(value)
        .map(|id| id.as_str().to_owned())
        .map_err(|_| TicketValidationError::new("chatId must be a valid 16-digit chat ID."))
}

pub fn ticket_status(value: &Value) -> Result<TicketStatus, TicketValidationError> {
    match value.as_str() {
        Some("open") => Ok(TicketStatus::Open),
        Some("in-progress") => Ok(TicketStatus::InProgress),
        Some("in-review") => Ok(TicketStatus::InReview),
        Some("closed") => Ok(TicketStatus::Closed),
        _ => ticket_invalid("Invalid ticket status."),
    }
}

pub fn ticket_resolution(value: &Value) -> Result<TicketResolution, TicketValidationError> {
    match value.as_str() {
        Some("done") => Ok(TicketResolution::Done),
        Some("canceled") => Ok(TicketResolution::Canceled),
        _ => ticket_invalid("Invalid ticket resolution."),
    }
}

pub fn ticket_priority(value: &Value) -> Result<TicketPriority, TicketValidationError> {
    let priority = ticket_integer(value, "priority", Some(0.0), Some(3.0))?;
    // INFALLIBLE: ticket_integer validated the full repr range above.
    Ok(TicketPriority::try_from(priority as u8).expect("validated ticket priority"))
}

pub fn ticket_labels(value: &Value) -> Result<Vec<String>, TicketValidationError> {
    let Some(labels) = value
        .as_array()
        .filter(|labels| labels.len() <= TICKET_LIMITS.labels)
    else {
        return ticket_invalid("At most 20 labels are allowed.");
    };
    let mut labels = labels
        .iter()
        .map(|label| ticket_line(label, "label", TICKET_LIMITS.label_code_points as f64))
        .collect::<Result<Vec<_>, _>>()?;
    if labels.iter().collect::<HashSet<_>>().len() != labels.len() {
        return ticket_invalid("Labels must be distinct.");
    }
    labels.sort_by(|a, b| utf16::cmp(a, b));
    Ok(labels.into_iter().map(str::to_owned).collect())
}

fn ticket_executor_id(value: &Value) -> Result<String, TicketValidationError> {
    if !is_remote_executor_id(value) {
        return ticket_invalid("Invalid executor identity.");
    }
    // INFALLIBLE: the executor ID predicate requires a string.
    Ok(value
        .as_str()
        .expect("validated remote executor ID")
        .to_owned())
}

pub fn ticket_owner(value: &Value) -> Result<TicketOwner, TicketValidationError> {
    let raw = ticket_record(value, &["kind", "chatId", "ownerKey", "executorId"])?;
    match value["kind"].as_str() {
        Some("executor") => {
            require_keys(raw, &["kind", "executorId"])?;
            Ok(TicketOwner::Executor {
                executor_id: ticket_executor_id(&value["executorId"])?,
            })
        }
        Some("chat") => {
            require_keys(raw, &["kind", "chatId"])?;
            Ok(TicketOwner::Chat {
                chat_id: ticket_chat_id(&value["chatId"])?,
            })
        }
        Some("user") => {
            require_keys(raw, &["kind", "ownerKey"])?;
            let owner_key = ticket_string(&value["ownerKey"], "ownerKey")?;
            if owner_key.is_empty() || owner_key.chars().count() > 256 {
                return ticket_invalid("Invalid owner key.");
            }
            Ok(TicketOwner::User {
                owner_key: owner_key.to_owned(),
            })
        }
        _ => ticket_invalid("Invalid ticket owner."),
    }
}

pub fn parse_ticket_assignee_query(value: &str) -> Result<TicketAssignee, TicketValidationError> {
    if value == "unassigned" {
        return Ok(TicketAssignee::Unassigned(TicketUnassigned::Unassigned));
    }
    let Some((kind, value)) = value.split_once(':') else {
        return ticket_invalid("Invalid assignee filter.");
    };
    let field = match kind {
        "chat" => "chatId",
        "user" => "ownerKey",
        "executor" => "executorId",
        _ => return ticket_invalid("Invalid assignee filter."),
    };
    let raw = serde_json::json!({ "kind": kind, (field): value });
    ticket_owner(&raw).map(TicketAssignee::Owner)
}

pub fn ticket_actor(value: &Value) -> Result<TicketActor, TicketValidationError> {
    let raw = ticket_record(
        value,
        &[
            "kind",
            "chatId",
            "provenance",
            "username",
            "principalMode",
            "declaredChatId",
            "executorId",
        ],
    )?;
    let declared_chat_id = || match raw.get("declaredChatId") {
        Some(Value::Null) => Ok(None),
        _ => ticket_chat_id(&value["declaredChatId"]).map(Some),
    };
    match value["kind"].as_str() {
        Some("executor") => {
            require_keys(raw, &["kind", "executorId", "declaredChatId"])?;
            Ok(TicketActor::Executor {
                executor_id: ticket_executor_id(&value["executorId"])?,
                declared_chat_id: declared_chat_id()?,
            })
        }
        Some("chat") => {
            require_keys(raw, &["kind", "chatId", "provenance"])?;
            if value["provenance"] != "observed" {
                return ticket_invalid("Invalid chat provenance.");
            }
            Ok(TicketActor::Chat {
                chat_id: ticket_chat_id(&value["chatId"])?,
                provenance: TicketChatProvenance::Observed,
            })
        }
        kind => {
            require_keys(
                raw,
                &["kind", "username", "principalMode", "declaredChatId"],
            )?;
            let principal_mode = match (kind, value["principalMode"].as_str()) {
                (Some("user"), Some("local")) => TicketPrincipalMode::Local,
                (Some("user"), Some("authenticated")) => TicketPrincipalMode::Authenticated,
                _ => return ticket_invalid("Invalid principal attribution."),
            };
            let username = ticket_line(&value["username"], "username", 256.0)?;
            if principal_mode == TicketPrincipalMode::Local && username != "local" {
                return ticket_invalid("Invalid local principal.");
            }
            Ok(TicketActor::User {
                username: username.to_owned(),
                principal_mode,
                declared_chat_id: declared_chat_id()?,
            })
        }
    }
}

pub fn ticket_source(value: &Value) -> Result<TicketSource, TicketValidationError> {
    ticket_record(value, &["chatId", "transcriptViewId", "ordinal"])?;
    Ok(TicketSource {
        chat_id: ticket_chat_id(&value["chatId"])?,
        transcript_view_id: ticket_uuid(&value["transcriptViewId"], "transcriptViewId")?.to_owned(),
        ordinal: ticket_integer(&value["ordinal"], "ordinal", None, None)? as u64,
    })
}

pub fn ticket_timestamp(value: &Value) -> Result<&str, TicketValidationError> {
    if let Some(value) = value.as_str()
        && date_parse(value)
            .and_then(|instant| to_iso_string(instant).ok())
            .as_deref()
            == Some(value)
    {
        return Ok(value);
    }
    ticket_invalid("Invalid ticket timestamp.")
}

pub fn ticket_boolean(value: &Value) -> Result<bool, TicketValidationError> {
    value
        .as_bool()
        .ok_or_else(|| TicketValidationError::new("Expected a boolean."))
}

pub fn ticket_link_kind(value: &Value) -> Result<TicketLinkKind, TicketValidationError> {
    match value.as_str() {
        Some("blocks") => Ok(TicketLinkKind::Blocks),
        Some("related") => Ok(TicketLinkKind::Related),
        _ => ticket_invalid("Invalid link kind."),
    }
}
