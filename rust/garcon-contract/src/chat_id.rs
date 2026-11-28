//! Ports `common/chat-id.ts`.

use std::fmt;
use std::ops::Deref;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use garcon_js::json::{Opaque, as_number};
use garcon_js::{is_integer, is_safe_integer, utf16};

pub const CHAT_ID_LENGTH: usize = 16;

// Without the `u` flag `\d` is ASCII-only in JavaScript, where it is Unicode
// in the `regex` crate.
static CHAT_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]{16}$").expect("CHAT_ID_PATTERN compiles"));
static LEGACY_SECONDS_CHAT_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]{10}$").expect("LEGACY_SECONDS_CHAT_ID_PATTERN compiles"));
static LEGACY_MILLISECONDS_CHAT_ID_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9]{13}$").expect("LEGACY_MILLISECONDS_CHAT_ID_PATTERN compiles")
});
const MICROSECONDS_PER_MILLISECOND: u64 = 1_000;
/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_CHAT_ID: u64 = 9_007_199_254_740_991;
/// The widest time a `Date` holds.
const MAX_DATE_MS: f64 = 8_640_000_000_000_000.0;

/// A canonical chat ID: a 16-digit Unix-microsecond timestamp.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct ChatId(String);

impl ChatId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Deref for ChatId {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for ChatId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ChatId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

// A chat ID that comes from JSON is validated as it is read, so that a
// `ChatId` is never an ID the original would reject.
impl<'de> Deserialize<'de> for ChatId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<ChatId, D::Error> {
        let text = String::deserialize(deserializer)?;
        parse_chat_id(&Value::String(text)).map_err(serde::de::Error::custom)
    }
}

/// The error `parseChatId` throws. `value` is the value that was rejected.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("Chat ID must be a valid 16-digit Unix-microsecond timestamp")]
pub struct InvalidChatIdError {
    pub value: InvalidChatIdValue,
}

#[derive(Debug, Clone, PartialEq)]
pub enum InvalidChatIdValue {
    Undefined,
    Number(f64),
    Json(Opaque),
}

impl InvalidChatIdValue {
    pub fn from_json(value: Option<&Value>) -> Self {
        match value {
            None => Self::Undefined,
            Some(value) => as_number(value).map_or_else(
                || Self::Json(Opaque::from_value(value.clone())),
                Self::Number,
            ),
        }
    }
}

impl InvalidChatIdError {
    pub fn new(value: InvalidChatIdValue) -> Self {
        Self { value }
    }

    fn from_json(value: Option<&Value>) -> Self {
        Self::new(InvalidChatIdValue::from_json(value))
    }
}

/// Reads a string that the pattern of 16 digits accepts, as microseconds.
fn microseconds_of(value: &Value) -> Result<u64, InvalidChatIdError> {
    let text = value.as_str().filter(|text| CHAT_ID_PATTERN.is_match(text));
    let Some(text) = text else {
        return Err(InvalidChatIdError::from_json(Some(value)));
    };
    // INFALLIBLE: the pattern admits 16 ASCII digits, which a `u64` holds.
    let epoch_micros = text.parse().expect("16 digits parse as u64");
    if epoch_micros > MAX_SAFE_CHAT_ID {
        return Err(InvalidChatIdError::from_json(Some(value)));
    }
    Ok(epoch_micros)
}

/// Reads a canonical chat ID.
pub fn parse_chat_id(value: &Value) -> Result<ChatId, InvalidChatIdError> {
    let epoch_micros = microseconds_of(value)?;
    let epoch_ms = (epoch_micros / MICROSECONDS_PER_MILLISECOND) as f64;
    // `Number.isFinite(new Date(epochMs).getTime())`: a Date holds ±8.64e15 ms.
    if !is_safe_integer(epoch_ms) || epoch_ms <= 0.0 || epoch_ms.abs() > MAX_DATE_MS {
        return Err(InvalidChatIdError::from_json(Some(value)));
    }
    // INFALLIBLE: the pattern accepted a string, which the checks kept.
    let text = value
        .as_str()
        .expect("a chat ID is the string that was checked");
    Ok(ChatId(text.to_owned()))
}

/// Reads a canonical chat ID from an input that may be absent.
pub fn parse_chat_id_input(value: Option<&Value>) -> Result<ChatId, InvalidChatIdError> {
    parse_chat_id(value.ok_or_else(|| InvalidChatIdError::new(InvalidChatIdValue::Undefined))?)
}

/// Reads the microseconds of a canonical chat ID.
pub fn chat_id_from_epoch_microseconds(epoch_micros: u64) -> Result<ChatId, InvalidChatIdError> {
    parse_chat_id(&Value::String(epoch_micros.to_string()))
}

/// Reads the chat ID of a millisecond timestamp and the microseconds within
/// that millisecond. Both are JavaScript numbers and are checked as such.
pub fn chat_id_from_timestamp(
    epoch_ms: f64,
    micros_within_ms: f64,
) -> Result<ChatId, InvalidChatIdError> {
    if !is_safe_integer(epoch_ms) || epoch_ms <= 0.0 {
        return Err(InvalidChatIdError::new(InvalidChatIdValue::Number(
            epoch_ms,
        )));
    }
    if !is_integer(micros_within_ms) || !(0.0..=999.0).contains(&micros_within_ms) {
        return Err(InvalidChatIdError::new(InvalidChatIdValue::Number(
            micros_within_ms,
        )));
    }
    // Both are safe integers, so the sum below 2^63 is exact.
    let epoch_micros = epoch_ms as u64 * MICROSECONDS_PER_MILLISECOND + micros_within_ms as u64;
    chat_id_from_epoch_microseconds(epoch_micros)
}

/// The time of the `Date` a chat ID was created at, in milliseconds since the
/// epoch.
pub fn chat_id_created_at(chat_id: &str) -> Result<i64, InvalidChatIdError> {
    let parsed = parse_chat_id(&Value::String(chat_id.to_owned()))?;
    // INFALLIBLE: a chat ID is 16 ASCII digits no larger than 2^53.
    let epoch_micros: u64 = parsed.as_str().parse().expect("a chat ID is a number");
    Ok((epoch_micros / MICROSECONDS_PER_MILLISECOND) as i64)
}

/// Reads a chat ID of the legacy ten-digit second or thirteen-digit
/// millisecond form as the canonical ID, or `None` for any other value. The
/// padded ID is read like any other chat ID and not caught, so a legacy ID of
/// all zeros, whose padded timestamp is zero, is rejected with
/// `InvalidChatIdError` for the padded ID.
pub fn legacy_chat_id_to_canonical(value: &Value) -> Result<Option<ChatId>, InvalidChatIdError> {
    let Some(text) = value.as_str() else {
        return Ok(None);
    };
    if !LEGACY_SECONDS_CHAT_ID_PATTERN.is_match(text)
        && !LEGACY_MILLISECONDS_CHAT_ID_PATTERN.is_match(text)
    {
        return Ok(None);
    }
    let padded = utf16::pad_end(text, CHAT_ID_LENGTH, "0");
    parse_chat_id(&Value::String(padded.into_owned())).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_js::to_iso_string;
    use serde_json::json;

    #[test]
    fn parses_the_canonical_safe_microsecond_format() {
        let chat_id = "1783725900000123";
        assert_eq!(parse_chat_id(&json!(chat_id)).unwrap().as_str(), chat_id);
        assert!(is_safe_integer(chat_id.parse::<f64>().unwrap()));
        let created = chat_id_created_at(chat_id).unwrap();
        assert_eq!(
            to_iso_string(created).unwrap(),
            to_iso_string(1_783_725_900_000).unwrap()
        );
    }

    #[test]
    fn formats_timestamps_and_microsecond_suffixes() {
        assert_eq!(
            chat_id_from_timestamp(1_783_725_900_000.0, 7.0)
                .unwrap()
                .as_str(),
            "1783725900000007"
        );
        assert_eq!(
            chat_id_from_epoch_microseconds(1_783_725_900_000_999)
                .unwrap()
                .as_str(),
            "1783725900000999"
        );
    }

    #[test]
    fn rejects_invalid_id() {
        for chat_id in [
            "1783725900000",
            "178372590000007",
            "17837259000000123",
            "178372590000007231252",
            " 1783725900000123",
            "1783725900000123 ",
            "+178372590000123",
            "178372590000.123",
            "1783725900000e3",
            "abcdefghij123456",
            "9999999999999999",
        ] {
            let error = parse_chat_id(&json!(chat_id)).unwrap_err();
            assert_eq!(
                error.to_string(),
                "Chat ID must be a valid 16-digit Unix-microsecond timestamp",
                "{chat_id}"
            );
            assert_eq!(
                error.value,
                InvalidChatIdValue::from_json(Some(&json!(chat_id)))
            );
        }
        for value in [
            Value::Null,
            json!(1783725900000123_u64),
            json!([]),
            json!({}),
        ] {
            assert!(parse_chat_id(&value).is_err());
        }
        // Arabic-Indic digits are not `[0-9]`.
        assert!(parse_chat_id(&json!("١٧٨٣٧٢٥٩٠٠٠٠٠١٢٣")).is_err());
    }

    #[test]
    fn rejects_invalid_timestamp_components() {
        assert!(chat_id_from_timestamp(0.0, 0.0).is_err());
        assert!(chat_id_from_timestamp(1_783_725_900_000.0, -1.0).is_err());
        assert!(chat_id_from_timestamp(1_783_725_900_000.0, 1_000.0).is_err());
        assert!(chat_id_from_timestamp(f64::NAN, 0.0).is_err());
        assert!(chat_id_from_timestamp(1_783_725_900_000.5, 0.0).is_err());
        assert!(chat_id_from_timestamp(1_783_725_900_000.0, 0.5).is_err());
        // `value` is the component that was rejected.
        assert_eq!(
            chat_id_from_timestamp(0.0, 7.0).unwrap_err().value,
            InvalidChatIdValue::Number(0.0)
        );
        assert_eq!(
            chat_id_from_timestamp(1_783_725_900_000.0, -1.0)
                .unwrap_err()
                .value,
            InvalidChatIdValue::Number(-1.0)
        );
    }

    #[test]
    fn rejected_timestamp_keeps_the_original_double() {
        for rejected in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.0] {
            let error = chat_id_from_timestamp(rejected, 0.0).unwrap_err();
            let InvalidChatIdValue::Number(number) = error.value else {
                panic!("rejected value was not a number");
            };
            assert_eq!(number.to_bits(), rejected.to_bits());
        }
    }

    #[test]
    fn distinguishes_absent_null_and_opaque_rejected_values() {
        assert_eq!(
            parse_chat_id_input(None).unwrap_err().value,
            InvalidChatIdValue::Undefined,
        );
        for value in [Value::Null, json!({"value": ["synthetic", 1.0]})] {
            assert_eq!(
                parse_chat_id(&value).unwrap_err().value,
                InvalidChatIdValue::Json(Opaque::from_value(value)),
            );
        }
    }

    #[test]
    fn migrates_only_common_seconds_and_milliseconds_lengths() {
        let canonical = |value: &str| {
            legacy_chat_id_to_canonical(&json!(value))
                .map(|chat_id| chat_id.map(|chat_id| chat_id.to_string()))
        };
        assert_eq!(
            canonical("1772710502"),
            Ok(Some("1772710502000000".to_owned()))
        );
        assert_eq!(
            canonical("1774634779935"),
            Ok(Some("1774634779935000".to_owned()))
        );
        assert_eq!(canonical("177463477993"), Ok(None));
        assert_eq!(canonical("17746347799350"), Ok(None));
        assert_eq!(canonical("not-numeric"), Ok(None));
        assert_eq!(legacy_chat_id_to_canonical(&Value::Null), Ok(None));
        assert_eq!(
            legacy_chat_id_to_canonical(&json!(1772710502_u64)),
            Ok(None)
        );
    }

    #[test]
    fn rejects_a_legacy_id_whose_padded_timestamp_is_zero() {
        // The padded ID is read like any other and its rejection is not caught.
        for legacy in ["0000000000", "0000000000000"] {
            let error = legacy_chat_id_to_canonical(&json!(legacy)).unwrap_err();
            assert_eq!(
                error.value,
                InvalidChatIdValue::from_json(Some(&json!("0000000000000000")))
            );
        }
        // One microsecond past the epoch is a valid ID.
        assert_eq!(
            legacy_chat_id_to_canonical(&json!("0000000000001")),
            Ok(Some(ChatId("0000000000001000".to_owned())))
        );
    }

    #[test]
    fn a_chat_id_round_trips_through_json_only_when_canonical() {
        let id: ChatId = garcon_js::json::from_str("\"1783725900000123\"").unwrap();
        assert_eq!(id.as_str(), "1783725900000123");
        assert_eq!(serde_json::to_string(&id).unwrap(), "\"1783725900000123\"");
        assert!(garcon_js::json::from_str::<ChatId>("\"1783725900000\"").is_err());
    }
}
