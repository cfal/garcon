//! Ports `server-agents/common/src/direct/single-query-options.ts`.

use std::time::Duration;

use garcon_contract::chat_modes::ThinkingMode;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_DIRECT_SINGLE_QUERY_TIMEOUT_MS: u64 = 30_000;
pub const MAX_DIRECT_SINGLE_QUERY_TIMEOUT_MS: u64 = 15 * 60_000;

pub struct DirectSingleQueryOptions {
    pub model: String,
    pub thinking_mode: ThinkingMode,
    pub timeout_ms: Option<f64>,
    pub signal: CancellationToken,
}

pub fn direct_single_query_timeout_ms(value: Option<f64>) -> u64 {
    let Some(value) = value.filter(|value| value.is_finite()) else {
        return DEFAULT_DIRECT_SINGLE_QUERY_TIMEOUT_MS;
    };
    value
        .round()
        .clamp(1_000.0, MAX_DIRECT_SINGLE_QUERY_TIMEOUT_MS as f64) as u64
}

pub fn direct_single_query_timeout(value: Option<f64>) -> Duration {
    Duration::from_millis(direct_single_query_timeout_ms(value))
}
