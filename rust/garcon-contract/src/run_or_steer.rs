//! Ports `common/run-or-steer.ts`.

use serde::{Deserialize, Serialize};

pub const RUN_OR_STEER_MAX_ATTEMPTS: usize = 3;
pub const RUN_OR_STEER_RETRY_DELAY_MS: u64 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunOrSteerRoute {
    Run,
    Steer,
}

pub fn next_run_or_steer_route(
    route: RunOrSteerRoute,
    status: f64,
    error_code: Option<&str>,
) -> Option<RunOrSteerRoute> {
    if status != 409.0 {
        return None;
    }
    match (route, error_code) {
        (RunOrSteerRoute::Run, Some("SESSION_BUSY")) => Some(RunOrSteerRoute::Steer),
        (RunOrSteerRoute::Steer, Some("STEER_TURN_UNAVAILABLE" | "STEER_TURN_CHANGED")) => {
            Some(RunOrSteerRoute::Run)
        }
        _ => None,
    }
}
