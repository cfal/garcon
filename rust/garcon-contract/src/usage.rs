//! Ports `common/usage.ts`.

use std::sync::LazyLock;

use garcon_js::{
    Number,
    clock::{InvalidTimeValue, to_iso_string},
    date_parse::{IntlTimeZone, InvalidCalendarInstant, InvalidTimeZone, date_parse},
    is_safe_integer,
    json::as_number,
    math_round, utf16,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const USAGE_WINDOW_DAYS: &[u64] = &[7, 30, 90];
pub type UsageWindowDays = u64;
pub const MAX_USAGE_WINDOW_DAYS: u64 = 90;
pub const USAGE_RETENTION_DAYS: u64 = 92;
pub const MAX_USAGE_BUCKETS: usize = 10_000;
pub const MAX_USAGE_MODEL_NAME_LENGTH: usize = 200;
pub const USAGE_READ_TIMEOUT_MS: u64 = 110_000;
const DAY_MS: i64 = 86_400_000;

static USAGE_DAY_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the ISO calendar day shape is a valid regular expression.
    Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$").expect("usage day pattern")
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokenTotals {
    pub uncached_input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCategoryCost {
    pub input: Number,
    pub cache_read: Number,
    pub cache_write: Number,
    pub output: Number,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub day: String,
    pub model: String,
    pub totals: UsageTokenTotals,
    pub cost_usd: Number,
    pub category_cost_usd: UsageCategoryCost,
    pub cache_savings_usd: Number,
    pub records: u64,
    pub unpriced_records: u64,
    pub unpriced_tokens: u64,
    pub sessions: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageSourceStatus {
    Ok,
    Missing,
    Partial,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentUsageReportStatus {
    Ok,
    Missing,
    Partial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReadRequest {
    pub since_day: String,
    pub until_day: String,
    pub time_zone: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSourceCounts {
    pub scanned_files: u64,
    pub unreadable_files: u64,
    pub malformed_records: u64,
    pub distinct_sessions: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageReport {
    pub status: AgentUsageReportStatus,
    pub buckets: Vec<UsageBucket>,
    #[serde(flatten)]
    pub counts: UsageSourceCounts,
    pub pricing_as_of: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAgentSummary {
    pub agent_id: String,
    pub status: UsageSourceStatus,
    pub message: Option<String>,
    pub buckets: Vec<UsageBucket>,
    #[serde(flatten)]
    pub counts: UsageSourceCounts,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    #[serde(flatten)]
    pub request: UsageReadRequest,
    pub executor_id: String,
    pub read_at: String,
    pub pricing_as_of: Option<String>,
    pub agents: Vec<UsageAgentSummary>,
}

pub const EMPTY_USAGE_TOTALS: UsageTokenTotals = UsageTokenTotals {
    uncached_input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
};

pub const EMPTY_USAGE_CATEGORY_COST: UsageCategoryCost = UsageCategoryCost {
    input: Number(0.0),
    cache_read: Number(0.0),
    cache_write: Number(0.0),
    output: Number(0.0),
};

pub fn usage_total_tokens(totals: &UsageTokenTotals) -> f64 {
    totals.uncached_input_tokens as f64
        + totals.cached_input_tokens as f64
        + totals.cache_write_tokens as f64
        + totals.output_tokens as f64
}

pub fn is_usage_window_days(value: &Value) -> bool {
    as_number(value).is_some_and(|value| USAGE_WINDOW_DAYS.iter().any(|&days| days as f64 == value))
}

fn day_start(value: &str) -> Option<i64> {
    date_parse(&format!("{value}T00:00:00Z"))
}

fn utc_day(epoch_ms: i64) -> Result<String, InvalidTimeValue> {
    let iso = to_iso_string(epoch_ms)?;
    Ok(utf16::slice(&iso, 0, Some(10)).to_owned())
}

fn usage_day_text(value: &Value) -> Option<&str> {
    let text = value.as_str()?;
    if !USAGE_DAY_PATTERN.is_match(text) {
        return None;
    }
    (utc_day(day_start(text)?).ok()?.as_str() == text).then_some(text)
}

pub fn is_usage_day(value: &Value) -> bool {
    usage_day_text(value).is_some()
}

fn usage_time_zone_text(value: &Value) -> Option<&str> {
    let zone = value.as_str()?;
    if zone.is_empty() || utf16::len(zone) > 64 {
        return None;
    }
    IntlTimeZone::parse(zone).ok()?;
    Some(zone)
}

pub fn is_usage_time_zone(value: &Value) -> bool {
    usage_time_zone_text(value).is_some()
}

#[derive(Debug, Clone, Copy)]
pub struct UsageDayFormatter(IntlTimeZone);

impl UsageDayFormatter {
    pub fn format(&self, epoch_ms: f64) -> Result<String, InvalidCalendarInstant> {
        if !epoch_ms.is_finite() {
            return Err(InvalidCalendarInstant);
        }
        self.0
            .calendar_day(epoch_ms as i64)
            .map(|day| day.to_string())
    }
}

pub fn usage_day_formatter(time_zone: &str) -> Result<UsageDayFormatter, InvalidTimeZone> {
    IntlTimeZone::parse(time_zone).map(UsageDayFormatter)
}

pub fn is_usage_window_in_range(
    request: &UsageReadRequest,
    now_ms: f64,
) -> Result<bool, InvalidTimeValue> {
    if !now_ms.is_finite() {
        return Err(InvalidTimeValue);
    }
    let oldest = utc_day((now_ms - (USAGE_RETENTION_DAYS - 2) as f64 * DAY_MS as f64) as i64)?;
    let latest = utc_day((now_ms + DAY_MS as f64) as i64)?;
    Ok(utf16::cmp(&request.since_day, &oldest).is_ge()
        && utf16::cmp(&request.until_day, &latest).is_le())
}

pub fn usage_window_length(since_day: &str, until_day: &str) -> f64 {
    let day = |text| day_start(text).map_or(f64::NAN, |time| time as f64);
    math_round((day(until_day) - day(since_day)) / DAY_MS as f64) + 1.0
}

pub fn enumerate_usage_days(
    since_day: &str,
    until_day: &str,
) -> Result<Vec<String>, InvalidTimeValue> {
    let mut days = Vec::new();
    let (Some(mut cursor), Some(end)) = (day_start(since_day), day_start(until_day)) else {
        return Ok(days);
    };
    while cursor <= end {
        days.push(utc_day(cursor)?);
        cursor += DAY_MS;
    }
    Ok(days)
}

pub fn parse_usage_read_request(value: &Value) -> Option<UsageReadRequest> {
    let raw = value.as_object()?;
    let since_day = usage_day_text(raw.get("sinceDay")?)?;
    let until_day = usage_day_text(raw.get("untilDay")?)?;
    let time_zone = usage_time_zone_text(raw.get("timeZone")?)?;
    let length = usage_window_length(since_day, until_day);
    if !(1.0..=MAX_USAGE_WINDOW_DAYS as f64).contains(&length) {
        return None;
    }
    Some(UsageReadRequest {
        since_day: since_day.to_owned(),
        until_day: until_day.to_owned(),
        time_zone: time_zone.to_owned(),
    })
}

fn count(value: &Value) -> Option<u64> {
    let number = as_number(value)?;
    (is_safe_integer(number) && number >= 0.0).then_some(number as u64)
}

fn amount(value: &Value) -> Option<Number> {
    let number = as_number(value)?;
    (number.is_finite() && number >= 0.0).then_some(Number(number))
}

pub fn parse_usage_token_totals(value: &Value) -> Option<UsageTokenTotals> {
    let raw = value.as_object()?;
    Some(UsageTokenTotals {
        uncached_input_tokens: count(raw.get("uncachedInputTokens")?)?,
        cached_input_tokens: count(raw.get("cachedInputTokens")?)?,
        cache_write_tokens: count(raw.get("cacheWriteTokens")?)?,
        output_tokens: count(raw.get("outputTokens")?)?,
        reasoning_tokens: count(raw.get("reasoningTokens")?)?,
    })
}

fn parse_category_cost(value: &Value) -> Option<UsageCategoryCost> {
    let raw = value.as_object()?;
    Some(UsageCategoryCost {
        input: amount(raw.get("input")?)?,
        cache_read: amount(raw.get("cacheRead")?)?,
        cache_write: amount(raw.get("cacheWrite")?)?,
        output: amount(raw.get("output")?)?,
    })
}

fn parse_bucket(value: &Value) -> Option<UsageBucket> {
    let raw = value.as_object()?;
    let day = usage_day_text(raw.get("day")?)?;
    let model = raw.get("model")?.as_str()?;
    if model.is_empty() || utf16::len(model) > MAX_USAGE_MODEL_NAME_LENGTH {
        return None;
    }
    let totals = parse_usage_token_totals(raw.get("totals")?)?;
    let category_cost_usd = parse_category_cost(raw.get("categoryCostUsd")?)?;
    let cost_usd = amount(raw.get("costUsd")?)?;
    let cache_savings_usd = amount(raw.get("cacheSavingsUsd")?)?;
    let records = count(raw.get("records")?)?;
    let unpriced_records = count(raw.get("unpricedRecords")?)?;
    let unpriced_tokens = count(raw.get("unpricedTokens")?)?;
    let sessions = count(raw.get("sessions")?)?;
    if unpriced_records > records {
        return None;
    }
    Some(UsageBucket {
        day: day.to_owned(),
        model: model.to_owned(),
        totals,
        cost_usd,
        category_cost_usd,
        cache_savings_usd,
        records,
        unpriced_records,
        unpriced_tokens,
        sessions,
    })
}

fn parse_buckets(value: &Value) -> Option<Vec<UsageBucket>> {
    let values = value.as_array()?;
    if values.len() > MAX_USAGE_BUCKETS {
        return None;
    }
    values.iter().map(parse_bucket).collect()
}

fn parse_source_counts(raw: &Map<String, Value>) -> Option<UsageSourceCounts> {
    Some(UsageSourceCounts {
        scanned_files: count(raw.get("scannedFiles")?)?,
        unreadable_files: count(raw.get("unreadableFiles")?)?,
        malformed_records: count(raw.get("malformedRecords")?)?,
        distinct_sessions: count(raw.get("distinctSessions")?)?,
    })
}

pub fn parse_agent_usage_report(value: &Value) -> Option<AgentUsageReport> {
    let raw = value.as_object()?;
    let status = match raw.get("status")?.as_str()? {
        "ok" => AgentUsageReportStatus::Ok,
        "missing" => AgentUsageReportStatus::Missing,
        "partial" => AgentUsageReportStatus::Partial,
        _ => return None,
    };
    let pricing_as_of = usage_day_text(raw.get("pricingAsOf")?)?.to_owned();
    let buckets = parse_buckets(raw.get("buckets")?)?;
    let counts = parse_source_counts(raw)?;
    Some(AgentUsageReport {
        status,
        buckets,
        counts,
        pricing_as_of,
    })
}

fn parse_agent_summary(value: &Value) -> Option<UsageAgentSummary> {
    let raw = value.as_object()?;
    let agent_id = raw.get("agentId")?.as_str()?;
    if agent_id.is_empty() || utf16::len(agent_id) > 64 {
        return None;
    }
    let status = match raw.get("status")?.as_str()? {
        "ok" => UsageSourceStatus::Ok,
        "missing" => UsageSourceStatus::Missing,
        "partial" => UsageSourceStatus::Partial,
        "failed" => UsageSourceStatus::Failed,
        _ => return None,
    };
    let message = raw.get("message")?;
    let message = if message.is_null() {
        None
    } else {
        Some(
            message
                .as_str()
                .filter(|text| utf16::len(text) <= 2000)?
                .to_owned(),
        )
    };
    let buckets = parse_buckets(raw.get("buckets")?)?;
    let counts = parse_source_counts(raw)?;
    Some(UsageAgentSummary {
        agent_id: agent_id.to_owned(),
        status,
        message,
        buckets,
        counts,
    })
}

pub fn parse_usage_summary(value: &Value) -> Option<UsageSummary> {
    let raw = value.as_object()?;
    let request = parse_usage_read_request(value)?;
    let executor_id = raw.get("executorId")?.as_str()?.to_owned();
    let read_at = raw.get("readAt")?.as_str()?.to_owned();
    date_parse(&read_at)?;
    let pricing_as_of = raw.get("pricingAsOf")?;
    let pricing_as_of = if pricing_as_of.is_null() {
        None
    } else {
        Some(usage_day_text(pricing_as_of)?.to_owned())
    };
    let agents = raw.get("agents")?.as_array()?;
    if agents.len() > 64 {
        return None;
    }
    let agents = agents
        .iter()
        .map(parse_agent_summary)
        .collect::<Option<_>>()?;
    Some(UsageSummary {
        request,
        executor_id,
        read_at,
        pricing_as_of,
        agents,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn validates_only_calendar_days_and_counts_inclusive_windows() {
        assert!(!is_usage_day(&json!("2026-02-29")));
        assert!(is_usage_day(&json!("2024-02-29")));
        assert_eq!(usage_window_length("2024-02-28", "2024-03-01"), 3.0);
        assert_eq!(
            enumerate_usage_days("2024-02-28", "2024-03-01").unwrap(),
            ["2024-02-28", "2024-02-29", "2024-03-01"],
        );
        assert!(
            enumerate_usage_days("2024-03-01", "2024-02-28")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn reasoning_is_already_included_in_output_tokens() {
        let totals = UsageTokenTotals {
            uncached_input_tokens: 1,
            cached_input_tokens: 2,
            cache_write_tokens: 3,
            output_tokens: 4,
            reasoning_tokens: 2,
        };
        assert_eq!(usage_total_tokens(&totals), 10.0);
    }

    #[test]
    fn parses_only_inclusive_windows_that_fit_the_cap() {
        let mut raw = json!({"sinceDay":"2026-07-30", "untilDay":"2026-10-27", "timeZone":"Pacific/Kiritimati"});
        assert!(parse_usage_read_request(&raw).is_some());
        raw["sinceDay"] = json!("2026-07-29");
        assert!(parse_usage_read_request(&raw).is_none());
        raw["sinceDay"] = json!("2026-10-27");
        raw["timeZone"] = json!("UTC ");
        assert!(parse_usage_read_request(&raw).is_none());
    }
}
