//! Ports `common/chat-handoff-artifact-contracts.ts`.

use garcon_js::{
    clock::to_iso_string, date_parse::date_parse, is_safe_integer, json::as_number, utf16,
};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::chat_export_contracts::{TRANSCRIPT_EXPORT_CATEGORIES, is_transcript_export_category};
use crate::chat_id::{ChatId, parse_chat_id};
use crate::handoff_sizing::{
    AgentSwitchContextWindowTokens, is_handoff_context_window_tokens, usable_handoff_token_budget,
};
use crate::transcript_entry_categories::TranscriptEntryCategory;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHandoffArtifactRequest {
    pub chat_id: ChatId,
    pub context_window_tokens: AgentSwitchContextWindowTokens,
}

pub const CHAT_HANDOFF_ARTIFACT_FOLD: &str = "handoff-v1";
pub const CHAT_HANDOFF_ARTIFACT_GAP_UNIT: &str = "eligible-entry";

pub type ChatHandoffArtifactExclusionCategory = TranscriptEntryCategory;
pub const CHAT_HANDOFF_ARTIFACT_EXCLUSION_CATEGORIES: [ChatHandoffArtifactExclusionCategory;
    TRANSCRIPT_EXPORT_CATEGORIES.len() + 1] = {
    let mut categories =
        [TranscriptEntryCategory::Conversation; TRANSCRIPT_EXPORT_CATEGORIES.len() + 1];
    let mut index = 0;
    while index < TRANSCRIPT_EXPORT_CATEGORIES.len() {
        categories[index + 1] =
            TranscriptEntryCategory::Optional(TRANSCRIPT_EXPORT_CATEGORIES[index]);
        index += 1;
    }
    categories
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatHandoffArtifactExcludedEntryCount {
    pub category: ChatHandoffArtifactExclusionCategory,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHandoffArtifactResponse {
    pub success: bool,
    pub chat_id: ChatId,
    pub transcript_view_id: String,
    pub last_ordinal: u64,
    pub generated_at: String,
    pub context_window_tokens: AgentSwitchContextWindowTokens,
    pub usable_token_budget: u64,
    pub estimated_tokens: u64,
    pub fold: &'static str,
    pub gap_unit: &'static str,
    pub source_entry_count: u64,
    pub eligible_entry_count: u64,
    pub excluded_entry_counts: Vec<ChatHandoffArtifactExcludedEntryCount>,
    pub included_entry_count: u64,
    pub budget_omitted_entry_count: u64,
    pub abridged_entry_count: u64,
    pub gap_count: u64,
    pub projection_truncated: bool,
    pub document_code_units: u64,
    pub document: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ChatHandoffArtifactContractError(String);

impl ChatHandoffArtifactContractError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub const NAME: &str = "ChatHandoffArtifactContractError";
}

use ChatHandoffArtifactContractError as Error;

pub fn parse_chat_handoff_artifact_response(
    value: &Value,
) -> Result<ChatHandoffArtifactResponse, Error> {
    record(value, "handoff artifact response")?;
    if value["success"] != true {
        return Err(Error::new("success must be true"));
    }
    let chat_id = parse_chat_id(&value["chatId"]).map_err(|_| Error::new("chatId is invalid"))?;
    let transcript_view_id = nonempty_string(&value["transcriptViewId"], "transcriptViewId")?;
    let last_ordinal = nonnegative_integer(&value["lastOrdinal"], "lastOrdinal")?;
    let generated_at = canonical_timestamp(&value["generatedAt"], "generatedAt")?;
    let context_window_tokens = as_number(&value["contextWindowTokens"])
        .filter(|_| is_handoff_context_window_tokens(&value["contextWindowTokens"]))
        .ok_or_else(|| Error::new("contextWindowTokens is invalid"))?;
    let usable_token_budget =
        nonnegative_integer(&value["usableTokenBudget"], "usableTokenBudget")?;
    if usable_token_budget as f64 != usable_handoff_token_budget(context_window_tokens) {
        return Err(Error::new(
            "usableTokenBudget is inconsistent with contextWindowTokens",
        ));
    }
    let estimated_tokens = nonnegative_integer(&value["estimatedTokens"], "estimatedTokens")?;
    if estimated_tokens > usable_token_budget {
        return Err(Error::new("estimatedTokens exceeds usableTokenBudget"));
    }
    if value["fold"] != CHAT_HANDOFF_ARTIFACT_FOLD {
        return Err(Error::new("fold is invalid"));
    }
    if value["gapUnit"] != CHAT_HANDOFF_ARTIFACT_GAP_UNIT {
        return Err(Error::new("gapUnit is invalid"));
    }
    let source_entry_count = nonnegative_integer(&value["sourceEntryCount"], "sourceEntryCount")?;
    let eligible_entry_count =
        nonnegative_integer(&value["eligibleEntryCount"], "eligibleEntryCount")?;
    let excluded_entry_counts = parse_excluded_entry_counts(&value["excludedEntryCounts"])?;
    if eligible_entry_count
        + excluded_entry_counts
            .iter()
            .map(|entry| entry.count)
            .sum::<u64>()
        != source_entry_count
    {
        return Err(Error::new(
            "source, eligible, and excluded entry counts are inconsistent",
        ));
    }
    let included_entry_count =
        nonnegative_integer(&value["includedEntryCount"], "includedEntryCount")?;
    let budget_omitted_entry_count =
        nonnegative_integer(&value["budgetOmittedEntryCount"], "budgetOmittedEntryCount")?;
    if included_entry_count + budget_omitted_entry_count != eligible_entry_count {
        return Err(Error::new(
            "eligible, included, and budget-omitted entry counts are inconsistent",
        ));
    }
    let abridged_entry_count =
        nonnegative_integer(&value["abridgedEntryCount"], "abridgedEntryCount")?;
    if abridged_entry_count > included_entry_count {
        return Err(Error::new("abridgedEntryCount exceeds includedEntryCount"));
    }
    let gap_count = nonnegative_integer(&value["gapCount"], "gapCount")?;
    if gap_count > budget_omitted_entry_count {
        return Err(Error::new(
            "gapCount is inconsistent with budgetOmittedEntryCount",
        ));
    }
    let raw_projection_truncated = value["projectionTruncated"]
        .as_bool()
        .ok_or_else(|| Error::new("projectionTruncated must be a boolean"))?;
    let projection_truncated = budget_omitted_entry_count > 0 || abridged_entry_count > 0;
    if raw_projection_truncated != projection_truncated {
        return Err(Error::new(
            "projectionTruncated is inconsistent with entry counts",
        ));
    }
    let document_code_units =
        nonnegative_integer(&value["documentCodeUnits"], "documentCodeUnits")?;
    let document = value["document"]
        .as_str()
        .filter(|s| s.ends_with('\n'))
        .ok_or_else(|| Error::new("document must be a string ending in a newline"))?;
    if utf16::len(document) as u64 != document_code_units {
        return Err(Error::new(
            "documentCodeUnits is inconsistent with document",
        ));
    }
    Ok(ChatHandoffArtifactResponse {
        success: true,
        chat_id,
        transcript_view_id: transcript_view_id.to_owned(),
        last_ordinal,
        generated_at: generated_at.to_owned(),
        context_window_tokens: context_window_tokens as AgentSwitchContextWindowTokens,
        usable_token_budget,
        estimated_tokens,
        fold: CHAT_HANDOFF_ARTIFACT_FOLD,
        gap_unit: CHAT_HANDOFF_ARTIFACT_GAP_UNIT,
        source_entry_count,
        eligible_entry_count,
        excluded_entry_counts,
        included_entry_count,
        budget_omitted_entry_count,
        abridged_entry_count,
        gap_count,
        projection_truncated,
        document_code_units,
        document: document.to_owned(),
    })
}

fn parse_excluded_entry_counts(
    value: &Value,
) -> Result<Vec<ChatHandoffArtifactExcludedEntryCount>, Error> {
    let values = value
        .as_array()
        .ok_or_else(|| Error::new("excludedEntryCounts must be an array"))?;
    let mut counts = Vec::with_capacity(values.len());
    for (index, item) in values.iter().enumerate() {
        let field = format!("excludedEntryCounts[{index}]");
        record(item, &field)?;
        let raw_category = &item["category"];
        let category = if raw_category == "conversation" {
            TranscriptEntryCategory::Conversation
        } else {
            TranscriptEntryCategory::Optional(
                is_transcript_export_category(raw_category)
                    .ok_or_else(|| Error::new(format!("{field}.category is invalid")))?,
            )
        };
        let count = nonnegative_integer(&item["count"], &format!("{field}.count"))?;
        if count == 0 {
            return Err(Error::new(format!("{field}.count must be positive")));
        }
        counts.push(ChatHandoffArtifactExcludedEntryCount { category, count });
    }
    let canonical = CHAT_HANDOFF_ARTIFACT_EXCLUSION_CATEGORIES
        .into_iter()
        .filter(|category| counts.iter().any(|entry| entry.category == *category));
    if !counts.iter().map(|entry| entry.category).eq(canonical) {
        return Err(Error::new(
            "excludedEntryCounts must be unique and in canonical order",
        ));
    }
    Ok(counts)
}

fn nonnegative_integer(value: &Value, field: &str) -> Result<u64, Error> {
    as_number(value)
        .filter(|&number| is_safe_integer(number) && number >= 0.0)
        .map(|number| number as u64)
        .ok_or_else(|| Error::new(format!("{field} must be a non-negative integer")))
}

fn nonempty_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, Error> {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::new(format!("{field} is invalid")))
}

fn canonical_timestamp<'a>(value: &'a Value, field: &str) -> Result<&'a str, Error> {
    value
        .as_str()
        .filter(|s| {
            date_parse(s)
                .and_then(|epoch| to_iso_string(epoch).ok())
                .as_deref()
                == Some(*s)
        })
        .ok_or_else(|| Error::new(format!("{field} is invalid")))
}

fn record<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>, Error> {
    value
        .as_object()
        .ok_or_else(|| Error::new(format!("{field} must be an object")))
}
