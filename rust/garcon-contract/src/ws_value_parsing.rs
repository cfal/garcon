//! Ports common/ws-value-parsing.ts.

use garcon_js::{is_safe_integer, trim};
use serde::{Serialize, Serializer};
use serde_json::Value;

use crate::chat_id::{ChatId, parse_chat_id};

pub fn str(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

pub fn required_str(value: &Value) -> Option<&str> {
    value.as_str().map(trim).filter(|value| !value.is_empty())
}

pub fn required_path(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| !trim(value).is_empty())
}

/// A non-negative safe integer that retains JavaScript's signed zero
/// in the parsed value. On the wire both zeros serialize as 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NonNegativeSafeInteger {
    value: u64,
    negative_zero: bool,
}

impl NonNegativeSafeInteger {
    pub const ZERO: Self = Self {
        value: 0,
        negative_zero: false,
    };

    pub const fn get(self) -> u64 {
        self.value
    }

    pub const fn is_negative_zero(self) -> bool {
        self.negative_zero
    }
}

impl Serialize for NonNegativeSafeInteger {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u64(self.value)
    }
}

pub fn non_negative_int(value: &Value) -> Option<NonNegativeSafeInteger> {
    let number = value.as_f64()?;
    (is_safe_integer(number) && number >= 0.0).then(|| NonNegativeSafeInteger {
        value: number as u64,
        negative_zero: number == 0.0 && number.is_sign_negative(),
    })
}

pub fn canonical_chat_id(value: &Value) -> Option<ChatId> {
    parse_chat_id(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn distinguishes_trimmed_strings_from_preserved_paths() {
        let path = json!("\u{feff}  /folder \u{a0}");
        assert_eq!(str(&path), "\u{feff}  /folder \u{a0}");
        assert_eq!(required_str(&path), Some("/folder"));
        assert_eq!(required_path(&path), Some("\u{feff}  /folder \u{a0}"));
        assert_eq!(str(&Value::Null), "");
        assert_eq!(required_str(&json!("\u{feff}")), None);
        assert_eq!(required_path(&json!("\u{feff}")), None);
    }

    #[test]
    fn accepts_safe_non_negative_integers_and_keeps_signed_zero() {
        let zero = non_negative_int(&json!(-0.0)).unwrap();
        assert_eq!(zero.get(), 0);
        assert!(zero.is_negative_zero());
        assert_eq!(serde_json::to_string(&zero).unwrap(), "0");
        assert!(!non_negative_int(&json!(0)).unwrap().is_negative_zero());
        assert_eq!(
            non_negative_int(&json!(9007199254740991_u64))
                .unwrap()
                .get(),
            9007199254740991
        );
        for rejected in [
            json!(-1),
            json!(0.5),
            json!(9007199254740992_u64),
            json!("1"),
        ] {
            assert_eq!(non_negative_int(&rejected), None);
        }
    }

    #[test]
    fn parses_canonical_chat_ids_without_leaking_parser_errors() {
        assert_eq!(
            canonical_chat_id(&json!("1783725900000123"))
                .unwrap()
                .as_str(),
            "1783725900000123"
        );
        assert_eq!(canonical_chat_id(&json!("1783725900000")), None);
        assert_eq!(canonical_chat_id(&json!(1783725900000123_u64)), None);
    }
}
