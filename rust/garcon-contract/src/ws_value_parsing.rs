//! Ports common/ws-value-parsing.ts.

use garcon_js::{is_safe_integer, trim};
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

pub fn non_negative_int(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (is_safe_integer(number) && number >= 0.0).then_some(number as u64)
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
    fn accepts_safe_non_negative_integers_and_normalizes_signed_zero() {
        assert_eq!(non_negative_int(&json!(-0.0)), Some(0));
        assert_eq!(non_negative_int(&json!(0)), Some(0));
        assert_eq!(
            non_negative_int(&json!(9007199254740991_u64)),
            Some(9007199254740991)
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
