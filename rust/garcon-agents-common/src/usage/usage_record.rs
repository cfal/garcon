use garcon_interface::resources::ExecutorResult;
use garcon_js::{Number, date_parse::date_parse, json::as_number};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageSpeed {
    Standard,
    Fast,
    Ultrafast,
    Flex,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUsageTokenTotals {
    pub uncached_input_tokens: Number,
    pub cached_input_tokens: Number,
    pub cache_write_tokens: Number,
    pub output_tokens: Number,
    pub reasoning_tokens: Number,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub timestamp_ms: i64,
    pub model: String,
    pub session_id: String,
    pub totals: NativeUsageTokenTotals,
    #[serde(rename = "cacheWrite1hTokens")]
    pub cache_write_1h_tokens: Number,
    pub speed: UsageSpeed,
    pub dedupe_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MalformedUsage {
    pub timestamp_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum UsageLine {
    Record(UsageRecord),
    Malformed(MalformedUsage),
}

pub trait TranscriptUsageFormat {
    type State;

    fn line_markers(&self) -> &[&str];
    fn create_state(&self) -> Self::State;
    fn clone_state(&self, state: &Self::State) -> Self::State;
    fn parse_line(&self, line: &str, state: &mut Self::State) -> ExecutorResult<Option<UsageLine>>;
}

pub fn token_count(value: &Value) -> f64 {
    as_number(value)
        .filter(|value| value.is_finite() && *value > 0.0)
        .map_or(0.0, f64::trunc)
}

pub fn parse_timestamp_ms(value: &Value) -> Option<i64> {
    date_parse(value.as_str()?)
}

pub fn merge_usage_copies(left: &UsageRecord, right: &UsageRecord) -> UsageRecord {
    let earliest = if right.timestamp_ms < left.timestamp_ms {
        right
    } else {
        left
    };
    let max = |left: Number, right: Number| Number(left.0.max(right.0));
    UsageRecord {
        totals: NativeUsageTokenTotals {
            uncached_input_tokens: max(
                left.totals.uncached_input_tokens,
                right.totals.uncached_input_tokens,
            ),
            cached_input_tokens: max(
                left.totals.cached_input_tokens,
                right.totals.cached_input_tokens,
            ),
            cache_write_tokens: max(
                left.totals.cache_write_tokens,
                right.totals.cache_write_tokens,
            ),
            output_tokens: max(left.totals.output_tokens, right.totals.output_tokens),
            reasoning_tokens: max(left.totals.reasoning_tokens, right.totals.reasoning_tokens),
        },
        cache_write_1h_tokens: max(left.cache_write_1h_tokens, right.cache_write_1h_tokens),
        ..earliest.clone()
    }
}
