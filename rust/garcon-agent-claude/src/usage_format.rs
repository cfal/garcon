use garcon_agents_common::{
    jsonl::{JsonlLineResult, parse_first_jsonl_value},
    usage::usage_record::{
        MalformedUsage, NativeUsageTokenTotals, TranscriptUsageFormat, UsageLine, UsageRecord,
        UsageSpeed, parse_timestamp_ms, token_count,
    },
};
use garcon_interface::resources::ExecutorResult;
use garcon_js::Number;

const CLAUDE_SYNTHETIC_MODEL: &str = "<synthetic>";

pub fn parse_claude_usage_line(line: &str) -> Option<UsageLine> {
    let entry = match parse_first_jsonl_value(line) {
        JsonlLineResult::Invalid { .. } | JsonlLineResult::Incomplete => {
            return Some(UsageLine::Malformed(MalformedUsage { timestamp_ms: None }));
        }
        JsonlLineResult::Empty => return None,
        JsonlLineResult::Value { value, .. } => value,
    };
    let message = &entry["message"];
    if entry["type"] != "assistant" || !message.is_object() || entry["forkedFrom"].is_object() {
        return None;
    }
    let usage = &message["usage"];
    if !usage.is_object() {
        return None;
    }
    let timestamp_ms = parse_timestamp_ms(&entry["timestamp"])?;
    let model = message["model"]
        .as_str()
        .filter(|model| !model.is_empty() && *model != CLAUDE_SYNTHETIC_MODEL)?;
    let message_id = message["id"].as_str();
    let request_id = entry["requestId"].as_str();
    // Every content block repeats the parent request's usage, including in copied sessions.
    let dedupe_key = (message_id.is_some() || request_id.is_some()).then(|| {
        format!(
            "{}:{}",
            message_id.unwrap_or_default(),
            request_id.unwrap_or_default()
        )
    });

    Some(UsageLine::Record(UsageRecord {
        timestamp_ms,
        model: model.to_owned(),
        session_id: entry["sessionId"].as_str().unwrap_or_default().to_owned(),
        totals: NativeUsageTokenTotals {
            uncached_input_tokens: Number(token_count(&usage["input_tokens"])),
            cached_input_tokens: Number(token_count(&usage["cache_read_input_tokens"])),
            cache_write_tokens: Number(token_count(&usage["cache_creation_input_tokens"])),
            output_tokens: Number(token_count(&usage["output_tokens"])),
            reasoning_tokens: Number(0.0),
        },
        cache_write_1h_tokens: Number(token_count(
            &usage["cache_creation"]["ephemeral_1h_input_tokens"],
        )),
        speed: if usage["speed"] == "fast" {
            UsageSpeed::Fast
        } else {
            UsageSpeed::Standard
        },
        dedupe_key,
    }))
}

pub struct ClaudeUsageFormat;

impl TranscriptUsageFormat for ClaudeUsageFormat {
    type State = ();

    fn line_markers(&self) -> &[&str] {
        &["\"usage\""]
    }

    fn create_state(&self) -> Self::State {}

    fn clone_state(&self, _: &Self::State) -> Self::State {}

    fn parse_line(&self, line: &str, _: &mut Self::State) -> ExecutorResult<Option<UsageLine>> {
        Ok(parse_claude_usage_line(line))
    }
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, replay, text};
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn recorded_claude_usage_lines_match() {
        replay(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/usage-format"),
            |function, args| {
                if function != "parseClaudeUsageLine" {
                    return Err(CaseError::unhandled(function));
                }
                let line = text(function, args.first())?.expect("recorded JSONL input");
                Ok(match parse_claude_usage_line(line) {
                    Some(UsageLine::Record(record)) => {
                        garcon_js::json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap()
                    }
                    Some(UsageLine::Malformed(usage)) => {
                        json!({"malformed":true, "timestampMs":usage.timestamp_ms})
                    }
                    None => Value::Null,
                })
            },
        );
    }

    #[test]
    fn gates_lines_on_the_usage_marker_the_format_declares() {
        let format = ClaudeUsageFormat;
        let line = r#"{"type":"assistant","timestamp":"2026-10-07T00:00:00Z","message":{"model":"synthetic","usage":{}}}"#;
        assert_eq!(format.line_markers(), ["\"usage\""]);
        assert!(
            format
                .line_markers()
                .iter()
                .all(|marker| line.contains(marker))
        );
        assert!(matches!(
            format.parse_line(line, &mut ()).unwrap(),
            Some(UsageLine::Record(_))
        ));
    }
}
