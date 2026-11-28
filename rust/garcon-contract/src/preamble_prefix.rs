//! Ports `common/preamble-prefix.ts`.

use std::fmt;

use garcon_js::{is_safe_integer, json::as_number, utf16};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::preambles::PREAMBLE_COMBINED_MAX_LENGTH;

const PREAMBLE_INPUT_BOUNDARY: &str = "<!-- garcon-preamble-input --> ";
pub const PREAMBLE_OPEN_PREFIX: &str = "<garcon-preambles ";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PreamblePrefixFormat {
    #[serde(rename = "preamble-v1")]
    PreambleV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreamblePrefixReceipt {
    pub format: PreamblePrefixFormat,
    pub code_unit_length: usize,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreamblePrefixApplication {
    pub prefix: String,
    pub receipt: PreamblePrefixReceipt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreamblePrefixTooLong;

impl fmt::Display for PreamblePrefixTooLong {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Combined preamble content exceeds the maximum length")
    }
}

impl std::error::Error for PreamblePrefixTooLong {}

pub fn render_preamble_prefix(contents: &[&str]) -> String {
    if contents.is_empty() {
        return String::new();
    }
    format!(
        "<garcon-preambles version=\"1\">\n{}\n</garcon-preambles>\n\n{PREAMBLE_INPUT_BOUNDARY}",
        contents.join("\n\n"),
    )
}

pub fn create_preamble_prefix(
    contents: &[&str],
) -> Result<Option<PreamblePrefixApplication>, PreamblePrefixTooLong> {
    if contents.is_empty() {
        return Ok(None);
    }
    let prefix = render_preamble_prefix(contents);
    let code_unit_length = utf16::len(&prefix);
    if code_unit_length > PREAMBLE_COMBINED_MAX_LENGTH {
        return Err(PreamblePrefixTooLong);
    }
    let receipt = PreamblePrefixReceipt {
        format: PreamblePrefixFormat::PreambleV1,
        code_unit_length,
        sha256: preamble_prefix_sha256(prefix.encode_utf16()),
    };
    Ok(Some(PreamblePrefixApplication { prefix, receipt }))
}

pub fn preamble_prefix_sha256(prefix: impl IntoIterator<Item = u16>) -> String {
    let bytes: Vec<u8> = prefix.into_iter().flat_map(u16::to_le_bytes).collect();
    format!("{:x}", Sha256::digest(bytes))
}

pub fn parse_preamble_prefix_receipt(value: &Value) -> Option<PreamblePrefixReceipt> {
    let raw = value.as_object()?;
    if raw
        .keys()
        .any(|key| !matches!(key.as_str(), "format" | "codeUnitLength" | "sha256"))
        || raw.get("format")?.as_str()? != "preamble-v1"
    {
        return None;
    }
    let sha256 = raw.get("sha256")?.as_str()?;
    if utf16::len(sha256) != 64
        || !sha256
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'f' | b'0'..=b'9'))
    {
        return None;
    }
    let code_unit_length = as_number(raw.get("codeUnitLength")?)?;
    if !is_safe_integer(code_unit_length)
        || !(1.0..=PREAMBLE_COMBINED_MAX_LENGTH as f64).contains(&code_unit_length)
    {
        return None;
    }
    Some(PreamblePrefixReceipt {
        format: PreamblePrefixFormat::PreambleV1,
        code_unit_length: code_unit_length as usize,
        sha256: sha256.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freezes_the_exact_version_one_envelope_without_an_application_identifier() {
        assert_eq!(
            render_preamble_prefix(&["first\nbody", "second body"]),
            "<garcon-preambles version=\"1\">\nfirst\nbody\n\nsecond body\n</garcon-preambles>\n\n<!-- garcon-preamble-input --> ",
        );
    }

    #[test]
    fn hashes_exact_utf16_code_units_without_surrogate_replacement_collisions() {
        let raw = [u16::from(b'A'), 0xd800, 0xfffd];
        assert_eq!(
            preamble_prefix_sha256(raw),
            "c5c20e249fb6e2f199df43e7379e58eb6ebff17d73f21d96cf61aa2fba6afaca",
        );
        assert_ne!(
            preamble_prefix_sha256(raw),
            preamble_prefix_sha256([u16::from(b'A'), 0xfffd, 0xfffd]),
        );
    }
}
