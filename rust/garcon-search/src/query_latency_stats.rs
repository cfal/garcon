//! Ports `server-agents/common/src/search/query-latency-stats.ts`.

use std::collections::VecDeque;

use garcon_contract::chat_search::TranscriptSearchQueryStatsV1;
use garcon_js::math_round;

const QUERY_STATS_SAMPLE_LIMIT: usize = 512;

/// Finite, nonnegative elapsed milliseconds from the monotonic clock. The
/// rounded durations and their sum fit within a JavaScript safe integer.
#[derive(Debug, Clone, Copy)]
pub struct QueryLatencySample {
    pub admission_ms: f64,
    pub execution_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Clone, Copy)]
struct RoundedSample {
    admission: u64,
    execution: u64,
    total: u64,
}

#[derive(Debug, Default)]
pub struct QueryLatencyStats {
    samples: VecDeque<RoundedSample>,
    served: u64,
    timed_out: u64,
    rejected_busy: u64,
}

impl QueryLatencyStats {
    pub fn record_served(&mut self, sample: QueryLatencySample) {
        let admission = math_round(sample.admission_ms);
        let execution = math_round(sample.execution_ms);
        let total = math_round(sample.total_ms).max(admission + execution);
        if self.samples.len() == QUERY_STATS_SAMPLE_LIMIT {
            self.samples.pop_front();
        }
        self.samples.push_back(RoundedSample {
            admission: admission as u64,
            execution: execution as u64,
            total: total as u64,
        });
        self.served += 1;
    }

    pub fn record_timed_out(&mut self) {
        self.timed_out += 1;
    }

    pub fn record_rejected_busy(&mut self) {
        self.rejected_busy += 1;
    }

    pub fn snapshot(&self) -> TranscriptSearchQueryStatsV1 {
        let [p50_ms, p95_ms, max_ms] = self.quantiles(|sample| sample.execution);
        let [admission_p50_ms, admission_p95_ms, admission_max_ms] =
            self.quantiles(|sample| sample.admission);
        let [total_p50_ms, total_p95_ms, total_max_ms] = self.quantiles(|sample| sample.total);
        TranscriptSearchQueryStatsV1 {
            served: self.served,
            timed_out: self.timed_out,
            rejected_busy: self.rejected_busy,
            p50_ms,
            p95_ms,
            max_ms,
            admission_p50_ms,
            admission_p95_ms,
            admission_max_ms,
            total_p50_ms,
            total_p95_ms,
            total_max_ms,
        }
    }

    fn quantiles(&self, field: impl Fn(&RoundedSample) -> u64) -> [u64; 3] {
        let mut sorted: Vec<_> = self.samples.iter().map(field).collect();
        sorted.sort_unstable();
        let len = sorted.len();
        if len == 0 {
            [0; 3]
        } else {
            [
                sorted[len / 2],
                sorted[(len as f64 * 0.95).floor() as usize],
                sorted[len - 1],
            ]
        }
    }
}
