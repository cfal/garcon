use garcon_contract::chat_types::CompactionTrigger;
use garcon_js::{Number, json::as_number, trim};
use serde::Serialize;
use serde_json::Value;

pub const COMPACT_SUMMARY_PREAMBLE: &str =
    "This session is being continued from a previous conversation";

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionInfo {
    pub trigger: CompactionTrigger,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_tokens: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_tokens: Option<Number>,
}

pub fn parse_compact_metadata(metadata: &Value) -> CompactionInfo {
    let number = |snake, camel| {
        as_number(&metadata[snake])
            .or_else(|| as_number(&metadata[camel]))
            .map(Number)
    };
    CompactionInfo {
        trigger: if metadata["trigger"] == "auto" {
            CompactionTrigger::Auto
        } else {
            CompactionTrigger::Manual
        },
        pre_tokens: number("pre_tokens", "preTokens"),
        post_tokens: number("post_tokens", "postTokens"),
    }
}

pub fn extract_compaction_summary(text: &str) -> &str {
    trim(text.split_once("Summary:").map_or(text, |(_, body)| body))
}

pub fn is_compaction_summary_text(text: &str) -> bool {
    text.starts_with(COMPACT_SUMMARY_PREAMBLE)
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, replay, text, unknown};
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn recorded_compaction_helpers_match() {
        replay(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/compaction"),
            |function, args| match function {
                "parseCompactMetadata" => {
                    let input = unknown(function, args.first())?;
                    let result = parse_compact_metadata(&input);
                    Ok(garcon_js::json::from_slice(&serde_json::to_vec(&result).unwrap()).unwrap())
                }
                "extractCompactionSummary" => Ok(Value::String(
                    extract_compaction_summary(text(function, args.first())?.unwrap()).to_owned(),
                )),
                "isCompactionSummaryText" => Ok(json!(is_compaction_summary_text(
                    text(function, args.first())?.unwrap()
                ))),
                _ => Err(CaseError::unhandled(function)),
            },
        );
    }
}
