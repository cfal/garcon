//! Ports `server-agents/opencode/src/agents/opencode/runtime-options.ts`.

use std::rc::Rc;

use futures::{FutureExt, future::LocalBoxFuture};
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use garcon_js::{Clock, SystemClock};

use super::{instance_lifecycle::OpenCodeInstance, server_instance::create_open_code_instance};
use crate::{config::OpenCodeConfig, js::AbortSignal};

// Cold platform-binary starts include transpile and plugin initialization.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/test/lib/cli-process.ts#L363
const DEFAULT_STARTUP_TIMEOUT_MS: f64 = 15_000.0;
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS: f64 = 3_000.0;
const DEFAULT_REQUEST_TIMEOUT_MS: f64 = 10_000.0;
const DEFAULT_UNAVAILABLE_RETRY_MS: f64 = 60_000.0;
const DEFAULT_SSE_RETRY_DELAY_MS: f64 = 3_000.0;
const DEFAULT_SSE_HEARTBEAT_TIMEOUT_MS: f64 = 30_000.0;
const DEFAULT_MODEL_CACHE_TTL_MS: f64 = 5.0 * 60_000.0;
const DEFAULT_SHUTDOWN_STARTUP_GRACE_MS: f64 = 100.0;
const DEFAULT_SHUTDOWN_FORK_GRACE_MS: f64 = 3_000.0;

pub type OpenCodeInstanceFactory =
    Rc<dyn Fn(AbortSignal) -> LocalBoxFuture<'static, ExecutorResult<Rc<OpenCodeInstance>>>>;

#[derive(Default)]
pub struct OpenCodeRuntimeOptions {
    pub config: Option<OpenCodeConfig>,
    pub logger: Option<Rc<dyn AgentLogger>>,
    pub startup_timeout_ms: Option<f64>,
    pub model_discovery_timeout_ms: Option<f64>,
    pub request_timeout_ms: Option<f64>,
    pub unavailable_retry_ms: Option<f64>,
    pub sse_retry_delay_ms: Option<f64>,
    pub sse_heartbeat_timeout_ms: Option<f64>,
    pub model_cache_ttl_ms: Option<f64>,
    pub shutdown_startup_grace_ms: Option<f64>,
    pub shutdown_native_fork_grace_ms: Option<f64>,
    pub idle_retirement_delay_ms: Option<f64>,
    pub idle_retirement_check_interval_ms: Option<f64>,
    pub clock: Option<Rc<dyn Clock>>,
    pub create_instance: Option<OpenCodeInstanceFactory>,
}

pub struct NormalizedOpenCodeRuntimeOptions {
    pub startup_timeout_ms: f64,
    pub model_discovery_timeout_ms: f64,
    pub request_timeout_ms: f64,
    pub unavailable_retry_ms: f64,
    pub sse_retry_delay_ms: f64,
    pub sse_heartbeat_timeout_ms: f64,
    pub model_cache_ttl_ms: f64,
    pub shutdown_startup_grace_ms: f64,
    pub shutdown_native_fork_grace_ms: f64,
    pub clock: Rc<dyn Clock>,
    pub requires_executable: bool,
    pub create_instance: OpenCodeInstanceFactory,
}

pub fn normalize_open_code_runtime_options(
    options: &OpenCodeRuntimeOptions,
) -> NormalizedOpenCodeRuntimeOptions {
    NormalizedOpenCodeRuntimeOptions {
        startup_timeout_ms: options
            .startup_timeout_ms
            .unwrap_or(DEFAULT_STARTUP_TIMEOUT_MS),
        model_discovery_timeout_ms: options
            .model_discovery_timeout_ms
            .unwrap_or(DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS),
        request_timeout_ms: options
            .request_timeout_ms
            .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS),
        unavailable_retry_ms: options
            .unavailable_retry_ms
            .unwrap_or(DEFAULT_UNAVAILABLE_RETRY_MS),
        sse_retry_delay_ms: options
            .sse_retry_delay_ms
            .unwrap_or(DEFAULT_SSE_RETRY_DELAY_MS),
        sse_heartbeat_timeout_ms: options
            .sse_heartbeat_timeout_ms
            .unwrap_or(DEFAULT_SSE_HEARTBEAT_TIMEOUT_MS),
        model_cache_ttl_ms: options
            .model_cache_ttl_ms
            .unwrap_or(DEFAULT_MODEL_CACHE_TTL_MS),
        shutdown_startup_grace_ms: options
            .shutdown_startup_grace_ms
            .unwrap_or(DEFAULT_SHUTDOWN_STARTUP_GRACE_MS),
        shutdown_native_fork_grace_ms: options
            .shutdown_native_fork_grace_ms
            .unwrap_or(DEFAULT_SHUTDOWN_FORK_GRACE_MS),
        clock: options
            .clock
            .clone()
            .unwrap_or_else(|| Rc::new(SystemClock)),
        requires_executable: options.create_instance.is_none(),
        create_instance: options
            .create_instance
            .clone()
            .unwrap_or_else(|| Rc::new(|signal| create_open_code_instance(signal).boxed_local())),
    }
}

#[cfg(test)]
mod tests {
    use garcon_js::ManualClock;

    use super::*;

    #[test]
    fn normalizes_default_timers_and_does_not_require_an_executable_for_an_injected_factory() {
        let defaults = normalize_open_code_runtime_options(&OpenCodeRuntimeOptions::default());
        assert_eq!(defaults.startup_timeout_ms, 15_000.0);
        assert_eq!(defaults.model_discovery_timeout_ms, 3_000.0);
        assert_eq!(defaults.request_timeout_ms, 10_000.0);
        assert_eq!(defaults.unavailable_retry_ms, 60_000.0);
        assert_eq!(defaults.sse_retry_delay_ms, 3_000.0);
        assert_eq!(defaults.sse_heartbeat_timeout_ms, 30_000.0);
        assert_eq!(defaults.model_cache_ttl_ms, 300_000.0);
        assert_eq!(defaults.shutdown_startup_grace_ms, 100.0);
        assert_eq!(defaults.shutdown_native_fork_grace_ms, 3_000.0);
        assert!(defaults.requires_executable);
        let overrides = normalize_open_code_runtime_options(&OpenCodeRuntimeOptions {
            clock: Some(Rc::new(ManualClock::new(32))),
            create_instance: Some(Rc::new(|_| {
                panic!("does not start an instance during normalization")
            })),
            startup_timeout_ms: Some(0.0),
            ..Default::default()
        });
        assert!(!overrides.requires_executable);
        assert_eq!(overrides.clock.now_ms(), 32);
        assert_eq!(overrides.startup_timeout_ms, 0.0);
    }
}
