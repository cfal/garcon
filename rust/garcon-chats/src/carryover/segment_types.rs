//! Ports `server/controller/chats/carryover/segment-types.ts`.

use garcon_js::{is_safe_integer, json::as_number};
use serde::Serialize;
use serde_json::Value;

pub const CARRYOVER_SEGMENT_VERSION: u8 = 1;
pub const CARRYOVER_MESSAGE_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SeedSanitationOutcome {
    NotApplicable,
    StrippedExact,
    Absent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarryOverPageDescriptor {
    pub file: String,
    pub first_sequence: u64,
    pub message_count: u64,
    pub uncompressed_bytes: u64,
    pub compressed_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarryOverSegmentIndex {
    pub version: u8,
    pub message_schema_version: u8,
    pub id: String,
    pub seed_sanitation: SeedSanitationOutcome,
    pub message_count: u64,
    pub canonical_messages_sha256: String,
    pub pages: Vec<CarryOverPageDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct CarryOverSegmentIndexError(String);

pub fn is_carry_over_segment_id(value: &Value) -> bool {
    value.as_str().is_some_and(has_segment_id)
}

pub(super) fn has_segment_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, &byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => matches!(byte, b'1'..=b'5'),
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => matches!(byte, b'0'..=b'9' | b'a'..=b'f'),
        })
}

pub fn parse_carry_over_segment_index(
    value: &Value,
    expected_id: Option<&str>,
) -> Result<CarryOverSegmentIndex, CarryOverSegmentIndexError> {
    if !value.is_object() {
        return Err(invalid("Carryover segment index must be an object"));
    }
    if as_number(&value["version"]) != Some(f64::from(CARRYOVER_SEGMENT_VERSION)) {
        return Err(invalid("Unsupported carryover segment version"));
    }
    if as_number(&value["messageSchemaVersion"])
        != Some(f64::from(CARRYOVER_MESSAGE_SCHEMA_VERSION))
    {
        return Err(invalid("Unsupported carryover message schema version"));
    }
    let id = value["id"]
        .as_str()
        .filter(|_| is_carry_over_segment_id(&value["id"]))
        .ok_or_else(|| invalid("Invalid carryover segment ID"))?;
    if expected_id.is_some_and(|expected| expected != id) {
        return Err(invalid("Carryover segment directory and index IDs differ"));
    }
    let message_count = positive_integer(&value["messageCount"], "message count")?;
    let canonical_messages_sha256 =
        checksum(&value["canonicalMessagesSha256"], "canonical digest")?;
    let pages = value["pages"]
        .as_array()
        .filter(|pages| !pages.is_empty())
        .ok_or_else(|| invalid("Carryover segment has no pages"))?;
    let pages = pages
        .iter()
        .enumerate()
        .map(|(index, page)| parse_page(page, index))
        .collect::<Result<Vec<_>, _>>()?;
    let mut expected_sequence = 0;
    for page in &pages {
        if u128::from(page.first_sequence) != expected_sequence {
            return Err(invalid("Carryover page sequences are not contiguous"));
        }
        expected_sequence += u128::from(page.message_count);
    }
    if expected_sequence != u128::from(message_count) {
        return Err(invalid("Carryover segment message count is inconsistent"));
    }
    let seed_sanitation = match value["seedSanitation"].as_str() {
        Some("not-applicable") => SeedSanitationOutcome::NotApplicable,
        Some("stripped-exact") => SeedSanitationOutcome::StrippedExact,
        Some("absent") => SeedSanitationOutcome::Absent,
        _ => return Err(invalid("Invalid carryover seed sanitation outcome")),
    };
    Ok(CarryOverSegmentIndex {
        version: CARRYOVER_SEGMENT_VERSION,
        message_schema_version: CARRYOVER_MESSAGE_SCHEMA_VERSION,
        id: id.to_owned(),
        seed_sanitation,
        message_count,
        canonical_messages_sha256,
        pages,
    })
}

pub(super) fn canonical_page_file(index: usize) -> String {
    format!("pages/{index:06}.json.br")
}

fn parse_page(
    value: &Value,
    index: usize,
) -> Result<CarryOverPageDescriptor, CarryOverSegmentIndexError> {
    if !value.is_object() {
        return Err(invalid("Invalid carryover page descriptor"));
    }
    let file = canonical_page_file(index);
    if value["file"] != file {
        return Err(invalid("Unsafe or noncanonical carryover page path"));
    }
    Ok(CarryOverPageDescriptor {
        file,
        first_sequence: nonnegative_integer(&value["firstSequence"], "page first sequence")?,
        message_count: positive_integer(&value["messageCount"], "page message count")?,
        uncompressed_bytes: positive_integer(
            &value["uncompressedBytes"],
            "page uncompressed bytes",
        )?,
        compressed_bytes: positive_integer(&value["compressedBytes"], "page compressed bytes")?,
        sha256: checksum(&value["sha256"], "page checksum")?,
    })
}

fn positive_integer(value: &Value, field: &str) -> Result<u64, CarryOverSegmentIndexError> {
    let number = nonnegative_integer(value, field)?;
    if number == 0 {
        Err(invalid_field(field))
    } else {
        Ok(number)
    }
}

fn nonnegative_integer(value: &Value, field: &str) -> Result<u64, CarryOverSegmentIndexError> {
    as_number(value)
        .filter(|number| *number >= 0.0 && is_safe_integer(*number))
        .map(|number| number as u64)
        .ok_or_else(|| invalid_field(field))
}

fn checksum(value: &Value, field: &str) -> Result<String, CarryOverSegmentIndexError> {
    value
        .as_str()
        .filter(|checksum| {
            checksum.len() == 64
                && checksum
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        })
        .map(str::to_owned)
        .ok_or_else(|| invalid_field(field))
}

fn invalid_field(field: &str) -> CarryOverSegmentIndexError {
    CarryOverSegmentIndexError(format!("Invalid carryover {field}"))
}

fn invalid(message: &str) -> CarryOverSegmentIndexError {
    CarryOverSegmentIndexError(message.to_owned())
}
