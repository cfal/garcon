//! Ports `common/chat-export-contracts.ts`.

use garcon_js::{clock::to_iso_string, date_parse::date_parse, is_safe_integer, json::as_number};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::chat_id::{ChatId, parse_chat_id};
pub use crate::transcript_entry_categories::{
    TRANSCRIPT_ENTRY_CATEGORY_ALIASES as TRANSCRIPT_EXPORT_CATEGORY_ALIASES,
    TRANSCRIPT_ENTRY_OPTIONAL_CATEGORIES as TRANSCRIPT_EXPORT_CATEGORIES,
};
use crate::transcript_entry_categories::{
    TranscriptEntryOptionalCategory, canonical_transcript_entry_optional_categories,
    is_transcript_entry_optional_category,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptExportFormat {
    Markdown,
    Xml,
}

pub const TRANSCRIPT_EXPORT_FORMATS: &[TranscriptExportFormat] = &[
    TranscriptExportFormat::Markdown,
    TranscriptExportFormat::Xml,
];
pub type TranscriptExportCategory = TranscriptEntryOptionalCategory;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TranscriptExportOmittedCount {
    pub category: TranscriptExportCategory,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptExportResponse {
    pub success: bool,
    pub chat_id: ChatId,
    pub format: TranscriptExportFormat,
    pub transcript_view_id: String,
    pub last_ordinal: u64,
    pub generated_at: String,
    pub entry_count: u64,
    pub total_entry_count: u64,
    pub exclusions: Vec<TranscriptExportCategory>,
    pub omitted: Vec<TranscriptExportOmittedCount>,
    pub document: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct TranscriptExportContractError(String);

impl TranscriptExportContractError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub const NAME: &str = "TranscriptExportContractError";
}

pub fn is_transcript_export_format(value: &Value) -> Option<TranscriptExportFormat> {
    match value.as_str()? {
        "markdown" => Some(TranscriptExportFormat::Markdown),
        "xml" => Some(TranscriptExportFormat::Xml),
        _ => None,
    }
}

pub fn is_transcript_export_category(value: &Value) -> Option<TranscriptExportCategory> {
    is_transcript_entry_optional_category(value)
}

pub fn canonical_transcript_export_categories(
    categories: impl IntoIterator<Item = TranscriptExportCategory>,
) -> Vec<TranscriptExportCategory> {
    canonical_transcript_entry_optional_categories(categories)
}

pub fn parse_transcript_export_response(
    value: &Value,
) -> Result<TranscriptExportResponse, TranscriptExportContractError> {
    use TranscriptExportContractError as Error;
    record(value, "transcript export response")?;
    if value["success"] != true {
        return Err(Error::new("success must be true"));
    }
    let chat_id = parse_chat_id(&value["chatId"]).map_err(|_| Error::new("chatId is invalid"))?;
    let format = is_transcript_export_format(&value["format"])
        .ok_or_else(|| Error::new("format is invalid"))?;
    let transcript_view_id = nonempty_string(&value["transcriptViewId"], "transcriptViewId")?;
    let last_ordinal = nonnegative_integer(&value["lastOrdinal"], "lastOrdinal")?;
    let generated_at = canonical_timestamp(&value["generatedAt"], "generatedAt")?;
    let entry_count = nonnegative_integer(&value["entryCount"], "entryCount")?;
    let total_entry_count = nonnegative_integer(&value["totalEntryCount"], "totalEntryCount")?;
    if entry_count > total_entry_count {
        return Err(Error::new("entryCount exceeds totalEntryCount"));
    }
    let exclusions = category_array(&value["exclusions"], "exclusions")?;
    let raw_omitted = array(&value["omitted"], "omitted")?;
    let mut omitted = Vec::with_capacity(raw_omitted.len());
    for (index, entry) in raw_omitted.iter().enumerate() {
        let field = format!("omitted[{index}]");
        record(entry, &field)?;
        let category = is_transcript_export_category(&entry["category"])
            .ok_or_else(|| Error::new(format!("{field}.category is invalid")))?;
        let count = nonnegative_integer(&entry["count"], &format!("{field}.count"))?;
        omitted.push(TranscriptExportOmittedCount { category, count });
    }
    if !omitted
        .iter()
        .map(|entry| entry.category)
        .eq(exclusions.iter().copied())
        || omitted.iter().map(|entry| entry.count).sum::<u64>() != total_entry_count - entry_count
    {
        return Err(Error::new(
            "omitted counts are inconsistent with exclusions and entry counts",
        ));
    }
    let document = value["document"]
        .as_str()
        .filter(|text| text.ends_with('\n'))
        .ok_or_else(|| Error::new("document must be a string ending in a newline"))?;
    Ok(TranscriptExportResponse {
        success: true,
        chat_id,
        format,
        transcript_view_id: transcript_view_id.to_owned(),
        last_ordinal,
        generated_at: generated_at.to_owned(),
        entry_count,
        total_entry_count,
        exclusions,
        omitted,
        document: document.to_owned(),
    })
}

fn category_array(
    value: &Value,
    field: &str,
) -> Result<Vec<TranscriptExportCategory>, TranscriptExportContractError> {
    let categories = array(value, field)?
        .iter()
        .map(is_transcript_export_category)
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| TranscriptExportContractError::new(format!("{field} is invalid")))?;
    if canonical_transcript_export_categories(categories.iter().copied()) != categories {
        return Err(TranscriptExportContractError::new(format!(
            "{field} must be unique and in canonical order"
        )));
    }
    Ok(categories)
}

fn nonnegative_integer(value: &Value, field: &str) -> Result<u64, TranscriptExportContractError> {
    as_number(value)
        .filter(|&number| is_safe_integer(number) && number >= 0.0)
        .map(|number| number as u64)
        .ok_or_else(|| {
            TranscriptExportContractError::new(format!("{field} must be a non-negative integer"))
        })
}

fn nonempty_string<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a str, TranscriptExportContractError> {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| TranscriptExportContractError::new(format!("{field} is invalid")))
}

fn canonical_timestamp<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a str, TranscriptExportContractError> {
    value
        .as_str()
        .filter(|s| {
            date_parse(s)
                .and_then(|epoch| to_iso_string(epoch).ok())
                .as_deref()
                == Some(*s)
        })
        .ok_or_else(|| TranscriptExportContractError::new(format!("{field} is invalid")))
}

fn array<'a>(value: &'a Value, field: &str) -> Result<&'a [Value], TranscriptExportContractError> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| TranscriptExportContractError::new(format!("{field} must be an array")))
}

fn record<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a Map<String, Value>, TranscriptExportContractError> {
    value
        .as_object()
        .ok_or_else(|| TranscriptExportContractError::new(format!("{field} must be an object")))
}
