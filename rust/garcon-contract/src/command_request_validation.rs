//! Ports `common/command-request-validation.ts`.

use garcon_js::{OptionalNullable, trim};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::chat_id::{ChatId, parse_chat_id};

pub const COMMAND_CORRELATION_ID_MAX_BYTES: usize = 256;
pub const QUEUE_ENTRY_ID_MAX_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct CommandRequestValidationError {
    pub message: String,
}

impl CommandRequestValidationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub fn is_command_correlation_id_within_limit(value: &str) -> bool {
    value.len() <= COMMAND_CORRELATION_ID_MAX_BYTES
}

pub fn is_queue_entry_id_within_limit(value: &str) -> bool {
    value.len() <= QUEUE_ENTRY_ID_MAX_BYTES
}

pub fn request_record(value: &Value) -> Result<&Map<String, Value>, CommandRequestValidationError> {
    value
        .as_object()
        .ok_or_else(|| CommandRequestValidationError::new("request body must be an object"))
}

pub fn required_string<'a>(
    body: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, CommandRequestValidationError> {
    required_content(body, field).map(trim)
}

pub fn required_command_correlation_id<'a>(
    body: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, CommandRequestValidationError> {
    let value = required_string(body, field)?;
    if !is_command_correlation_id_within_limit(value) {
        return Err(CommandRequestValidationError::new(format!(
            "{field} must be at most {COMMAND_CORRELATION_ID_MAX_BYTES} bytes"
        )));
    }
    Ok(value)
}

pub fn required_queue_entry_id<'a>(
    body: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, CommandRequestValidationError> {
    let value = required_string(body, field)?;
    if !is_queue_entry_id_within_limit(value) {
        return Err(CommandRequestValidationError::new(format!(
            "{field} must be at most {QUEUE_ENTRY_ID_MAX_BYTES} bytes"
        )));
    }
    Ok(value)
}

pub fn required_chat_id(
    body: &Map<String, Value>,
    field: &str,
) -> Result<ChatId, CommandRequestValidationError> {
    let value = required_string(body, field)?;
    parse_chat_id(&Value::String(value.to_owned())).map_err(|_| {
        CommandRequestValidationError::new(format!(
            "{field} must be a valid 16-digit Unix-microsecond timestamp"
        ))
    })
}

pub fn optional_chat_id(
    body: &Map<String, Value>,
    field: &str,
) -> Result<Option<ChatId>, CommandRequestValidationError> {
    match body.get(field) {
        None | Some(Value::Null) => Ok(None),
        _ => required_chat_id(body, field).map(Some),
    }
}

pub fn required_content<'a>(
    body: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, CommandRequestValidationError> {
    body.get(field)
        .and_then(Value::as_str)
        .filter(|value| !trim(value).is_empty())
        .ok_or_else(|| CommandRequestValidationError::new(format!("{field} is required")))
}

pub fn required_string_content<'a>(
    body: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, CommandRequestValidationError> {
    body.get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| CommandRequestValidationError::new(format!("{field} must be a string")))
}

pub fn optional_string<'a>(
    body: &'a Map<String, Value>,
    field: &str,
    trim_whitespace: bool,
) -> Result<Option<&'a str>, CommandRequestValidationError> {
    match body.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(if trim_whitespace { trim(value) } else { value })),
        _ => Err(CommandRequestValidationError::new(format!(
            "{field} must be a string"
        ))),
    }
}

pub fn optional_non_empty_string<'a>(
    body: &'a Map<String, Value>,
    field: &str,
) -> Result<Option<&'a str>, CommandRequestValidationError> {
    let value = optional_string(body, field, true)?;
    if value == Some("") {
        return Err(CommandRequestValidationError::new(format!(
            "{field} must not be empty"
        )));
    }
    Ok(value)
}

pub fn optional_nullable_string<'a>(
    body: &'a Map<String, Value>,
    field: &str,
) -> Result<OptionalNullable<&'a str>, CommandRequestValidationError> {
    match body.get(field) {
        None => Ok(OptionalNullable::ABSENT),
        Some(Value::Null) => Ok(OptionalNullable::NULL),
        Some(Value::String(value)) => Ok(OptionalNullable::some(trim(value))),
        _ => Err(CommandRequestValidationError::new(format!(
            "{field} must be a string or null"
        ))),
    }
}

pub fn optional_record<'a>(
    value: &'a Value,
    field: &str,
) -> Result<Option<&'a Map<String, Value>>, CommandRequestValidationError> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_object()
        .map(Some)
        .ok_or_else(|| CommandRequestValidationError::new(format!("{field} must be an object")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn applies_distinct_trim_and_empty_content_rules() {
        let value = json!({"body":" \u{feff}line\n ","blank":"  ","null":null});
        let record = request_record(&value).unwrap();
        assert_eq!(
            required_content(record, "body").unwrap(),
            " \u{feff}line\n "
        );
        assert_eq!(required_string(record, "body").unwrap(), "line");
        assert!(required_content(record, "blank").is_err());
        assert_eq!(required_string_content(record, "blank").unwrap(), "  ");
        assert_eq!(optional_string(record, "blank", true).unwrap(), Some(""));
        assert!(optional_non_empty_string(record, "blank").is_err());
        assert_eq!(
            optional_nullable_string(record, "missing").unwrap(),
            OptionalNullable::ABSENT
        );
        assert_eq!(
            optional_nullable_string(record, "null").unwrap(),
            OptionalNullable::NULL
        );
    }

    #[test]
    fn bounds_ids_by_utf8_bytes_after_trimming() {
        let bytes_256 = "\u{1f600}".repeat(64);
        assert!(is_command_correlation_id_within_limit(&bytes_256));
        assert!(!is_queue_entry_id_within_limit(&bytes_256));
        let value = json!({"requestId": format!("  {bytes_256}  "), "chatId": "bad"});
        let record = request_record(&value).unwrap();
        assert_eq!(
            required_command_correlation_id(record, "requestId").unwrap(),
            bytes_256
        );
        assert_eq!(
            required_queue_entry_id(record, "requestId")
                .unwrap_err()
                .message,
            "requestId must be at most 128 bytes"
        );
        assert_eq!(
            required_chat_id(record, "chatId").unwrap_err().message,
            "chatId must be a valid 16-digit Unix-microsecond timestamp"
        );
        assert!(optional_chat_id(record, "missing").unwrap().is_none());
    }
}
