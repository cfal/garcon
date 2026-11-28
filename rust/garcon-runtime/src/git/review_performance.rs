//! Ports `server/runtime/git/review-performance.ts`.

use std::cell::RefCell;
use std::future::Future;

use garcon_contract::git_diagnostics::{
    GitReviewRouteMetrics, GitReviewRoutePhase, GitReviewRoutePhaseName,
};
use garcon_js::Number;
use tokio::time::Instant;

pub async fn measure_git_review_phase<T, Fut>(
    metrics: Option<&RefCell<GitReviewRouteMetrics>>,
    name: GitReviewRoutePhaseName,
    operation: impl FnOnce() -> Fut,
) -> T
where
    Fut: Future<Output = T>,
{
    let started = Instant::now();
    let result = operation().await;
    record_git_review_phase(metrics, name, started.elapsed().as_secs_f64() * 1000.0);
    result
}

pub fn measure_git_review_phase_sync<T>(
    metrics: Option<&RefCell<GitReviewRouteMetrics>>,
    name: GitReviewRoutePhaseName,
    operation: impl FnOnce() -> T,
) -> T {
    let started = Instant::now();
    let result = operation();
    record_git_review_phase(metrics, name, started.elapsed().as_secs_f64() * 1000.0);
    result
}

fn record_git_review_phase(
    metrics: Option<&RefCell<GitReviewRouteMetrics>>,
    name: GitReviewRoutePhaseName,
    duration_ms: f64,
) {
    let Some(metrics) = metrics else {
        return;
    };
    let mut metrics = metrics.borrow_mut();
    if let Some(phase) = metrics.phases.iter_mut().find(|phase| phase.name == name) {
        phase.duration_ms.0 += duration_ms;
    } else {
        metrics.phases.push(GitReviewRoutePhase {
            name,
            duration_ms: Number(duration_ms),
        });
    }
}
