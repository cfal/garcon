use std::collections::{HashMap, HashSet};

use garcon_base::event_loop::EventLoopSteps;
use garcon_contract::usage::{
    EMPTY_USAGE_CATEGORY_COST, MAX_USAGE_MODEL_NAME_LENGTH, UsageBucket, UsageCategoryCost,
    UsageDayFormatter, UsageReadRequest, UsageTokenTotals, usage_day_formatter,
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    resources::ExecutorResult,
};
use garcon_js::{
    Number, collation::Collation, date_parse::InvalidTimeZone, is_safe_integer, math_round, utf16,
};
use indexmap::IndexMap;
use tokio_util::sync::CancellationToken;

use super::{
    transcript_usage_scanner::check_abort,
    usage_pricing::price_usage_record,
    usage_record::{NativeUsageTokenTotals, UsageRecord, merge_usage_copies},
};

const QUARTER_HOUR_MS: i64 = 15 * 60 * 1000;

struct MutableBucket {
    totals: [f64; 5],
    category_cost_usd: UsageCategoryCost,
    cost_usd: f64,
    cache_savings_usd: f64,
    records: u64,
    unpriced_records: u64,
    unpriced_tokens: f64,
    sessions: HashSet<String>,
}

impl Default for MutableBucket {
    fn default() -> Self {
        Self {
            totals: [0.0; 5],
            category_cost_usd: EMPTY_USAGE_CATEGORY_COST,
            cost_usd: 0.0,
            cache_savings_usd: 0.0,
            records: 0,
            unpriced_records: 0,
            unpriced_tokens: 0.0,
            sessions: HashSet::new(),
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAggregation {
    pub buckets: Vec<UsageBucket>,
    pub distinct_sessions: u64,
    pub malformed_records: u64,
}

struct DayFormatter {
    format: UsageDayFormatter,
    slots: HashMap<i64, Option<String>>,
}

impl DayFormatter {
    fn format(&mut self, timestamp_ms: i64) -> ExecutorResult<String> {
        let slot = timestamp_ms.div_euclid(QUARTER_HOUR_MS);
        if let Some(day) = self.slots.get(&slot) {
            return match day {
                Some(day) => Ok(day.clone()),
                None => Ok(self.format.format(timestamp_ms as f64)?),
            };
        }
        let first = self.format.format((slot * QUARTER_HOUR_MS) as f64)?;
        let last = self
            .format
            .format(((slot + 1) * QUARTER_HOUR_MS - 1) as f64)?;
        if first == last {
            self.slots.insert(slot, Some(first.clone()));
            Ok(first)
        } else {
            self.slots.insert(slot, None);
            Ok(self.format.format(timestamp_ms as f64)?)
        }
    }
}

pub struct UsageAggregator {
    window: UsageReadRequest,
    to_day: DayFormatter,
    keyed: IndexMap<String, UsageRecord>,
    unkeyed: Vec<UsageRecord>,
    malformed_records: u64,
}

impl UsageAggregator {
    pub fn new(window: UsageReadRequest) -> Result<Self, InvalidTimeZone> {
        let format = usage_day_formatter(&window.time_zone)?;
        Ok(Self {
            window,
            to_day: DayFormatter {
                format,
                slots: HashMap::new(),
            },
            keyed: IndexMap::new(),
            unkeyed: Vec::new(),
            malformed_records: 0,
        })
    }

    pub fn add(&mut self, record: &UsageRecord) {
        let Some(key) = &record.dedupe_key else {
            self.unkeyed.push(record.clone());
            return;
        };
        let merged = self.keyed.get(key).map_or_else(
            || record.clone(),
            |existing| merge_usage_copies(existing, record),
        );
        self.keyed.insert(key.clone(), merged);
    }

    pub fn add_malformed(&mut self, timestamp_ms: Option<i64>) -> ExecutorResult<()> {
        if match timestamp_ms {
            Some(timestamp) => in_window(&self.window, &self.to_day.format(timestamp)?),
            None => true,
        } {
            self.malformed_records += 1;
        }
        Ok(())
    }

    pub async fn finish(
        &mut self,
        steps: &mut EventLoopSteps,
        signal: Option<&CancellationToken>,
    ) -> ExecutorResult<UsageAggregation> {
        let mut buckets = IndexMap::<(String, String), MutableBucket>::new();
        let mut sessions = HashSet::new();
        let mut accumulate = |record: &UsageRecord| -> ExecutorResult<()> {
            check_abort(signal)?;
            let day = self.to_day.format(record.timestamp_ms)?;
            if !in_window(&self.window, &day) {
                return Ok(());
            }
            let model = truncate_model(&record.model);
            let bucket = buckets.entry((day, model)).or_default();
            let NativeUsageTokenTotals {
                uncached_input_tokens,
                cached_input_tokens,
                cache_write_tokens,
                output_tokens,
                reasoning_tokens,
            } = record.totals;
            let counts = [
                uncached_input_tokens.0,
                cached_input_tokens.0,
                cache_write_tokens.0,
                output_tokens.0,
                reasoning_tokens.0,
            ];
            for (total, count) in bucket.totals.iter_mut().zip(counts) {
                *total += count;
            }
            bucket.records += 1;
            if let Some(priced) = price_usage_record(record) {
                bucket.cost_usd += priced.cost_usd.0;
                bucket.cache_savings_usd += priced.cache_savings_usd.0;
                bucket.category_cost_usd.input.0 += priced.category_cost_usd.input.0;
                bucket.category_cost_usd.cache_read.0 += priced.category_cost_usd.cache_read.0;
                bucket.category_cost_usd.cache_write.0 += priced.category_cost_usd.cache_write.0;
                bucket.category_cost_usd.output.0 += priced.category_cost_usd.output.0;
            } else {
                bucket.unpriced_records += 1;
                bucket.unpriced_tokens += counts[0] + counts[1] + counts[2] + counts[3];
            }
            if !record.session_id.is_empty() {
                bucket.sessions.insert(record.session_id.clone());
                sessions.insert(record.session_id.clone());
            }
            Ok(())
        };
        steps.try_for_each(&self.unkeyed, &mut accumulate).await?;
        steps.try_for_each(self.keyed.values(), accumulate).await?;
        let mut buckets = buckets
            .into_iter()
            .map(|((day, model), bucket)| finish_bucket(day, model, bucket))
            .collect::<ExecutorResult<Vec<_>>>()?;
        let collation = Collation::english();
        buckets.sort_by(|left, right| {
            collation
                .compare(&left.day, &right.day)
                .then_with(|| collation.compare(&left.model, &right.model))
        });
        Ok(UsageAggregation {
            buckets,
            distinct_sessions: sessions.len() as u64,
            malformed_records: self.malformed_records,
        })
    }
}

fn in_window(window: &UsageReadRequest, day: &str) -> bool {
    day >= window.since_day.as_str() && day <= window.until_day.as_str()
}

fn truncate_model(text: &str) -> String {
    if utf16::len(text) <= MAX_USAGE_MODEL_NAME_LENGTH {
        return text.to_owned();
    }
    String::from_utf16_lossy(
        &text
            .encode_utf16()
            .take(MAX_USAGE_MODEL_NAME_LENGTH)
            .collect::<Vec<_>>(),
    )
}

fn finish_bucket(day: String, model: String, bucket: MutableBucket) -> ExecutorResult<UsageBucket> {
    let [
        uncached_input_tokens,
        cached_input_tokens,
        cache_write_tokens,
        output_tokens,
        reasoning_tokens,
    ] = bucket.totals;
    Ok(UsageBucket {
        day,
        model,
        totals: UsageTokenTotals {
            uncached_input_tokens: count(uncached_input_tokens, "totals.uncachedInputTokens")?,
            cached_input_tokens: count(cached_input_tokens, "totals.cachedInputTokens")?,
            cache_write_tokens: count(cache_write_tokens, "totals.cacheWriteTokens")?,
            output_tokens: count(output_tokens, "totals.outputTokens")?,
            reasoning_tokens: count(reasoning_tokens, "totals.reasoningTokens")?,
        },
        cost_usd: round_usd(bucket.cost_usd),
        category_cost_usd: UsageCategoryCost {
            input: round_usd(bucket.category_cost_usd.input.0),
            cache_read: round_usd(bucket.category_cost_usd.cache_read.0),
            cache_write: round_usd(bucket.category_cost_usd.cache_write.0),
            output: round_usd(bucket.category_cost_usd.output.0),
        },
        cache_savings_usd: round_usd(bucket.cache_savings_usd),
        records: bucket.records,
        unpriced_records: bucket.unpriced_records,
        unpriced_tokens: count(bucket.unpriced_tokens, "unpricedTokens")?,
        sessions: bucket.sessions.len() as u64,
    })
}

fn count(number: f64, field: &str) -> ExecutorResult<u64> {
    if is_safe_integer(number) && number >= 0.0 {
        Ok(number as u64)
    } else {
        Err(Box::new(AgentIntegrationError::new(
            AgentIntegrationErrorCode::PROVIDER_FAILURE,
            format!("Invalid usage report: {field} is not a non-negative safe integer."),
            false,
            None,
        )))
    }
}

fn round_usd(value: f64) -> Number {
    Number(math_round(value * 1e6) / 1e6)
}
