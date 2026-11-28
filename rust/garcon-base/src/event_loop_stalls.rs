//! Ports `server/common/event-loop-stalls.ts`.
//!
//! Known difference: when a stall is reported with 12,400,000 bytes of JS
//! heap in use, the original reports `heapUsedMb: 12`. The Rust monitor
//! reports rounded resident process memory instead of JS heap usage.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::future::Future;
use std::rc::Rc;
use std::time::Duration;

use garcon_js::{math_round, performance_now_ms};

const SAMPLE_INTERVAL_MS: f64 = 100.0;
const REPORT_THRESHOLD_MS: f64 = 250.0;
// Finished activities kept so a stall can name work that ended while the loop was held.
const RECENT_ACTIVITY_LIMIT: usize = 64;
const REPORTED_ACTIVITY_LIMIT: usize = 8;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct EventLoopStallOptions {
    pub interval_ms: Option<f64>,
    pub threshold_ms: Option<f64>,
}

/// A stall of the event loop, which delays every socket, heartbeat, and timer
/// in the process, so peers can mistake a busy process for a dead one.
#[derive(Debug, Clone, PartialEq)]
pub struct EventLoopStall {
    /// Whole milliseconds.
    pub stall_ms: f64,
    /// Tracked work that was running while the loop was held: activities
    /// that finished during the stall, most recent first, then those still
    /// running. The stall came from one of them or from untracked work.
    pub activities: Vec<String>,
    pub heap_used_mb: u64,
}

#[derive(Debug, Clone, PartialEq)]
struct Activity {
    label: String,
    ended_at: Option<f64>,
}

#[derive(Debug, Default)]
struct Tracked {
    running: Vec<(u64, Activity)>,
    recent: VecDeque<Activity>,
    next_id: u64,
}

/// The work the process tracks, so that a stall report can name it. The
/// original keeps this state at module level; one tracker per thread holds it.
#[derive(Debug, Default)]
pub struct ActivityTracker {
    tracked: RefCell<Tracked>,
}

/// Runs a finish function when dropped, as a `finally` block does, also when
/// the work panics.
struct Finish(Option<Box<dyn Fn()>>);

impl Finish {
    fn call(&mut self) {
        if let Some(finish) = self.0.take() {
            finish();
        }
    }
}

impl Drop for Finish {
    fn drop(&mut self) {
        self.call();
    }
}

impl ActivityTracker {
    /// Records work that may hold the event loop, such as a route or a
    /// queued task. The returned function marks it finished; calling it a
    /// second time changes nothing.
    pub fn track_activity(self: &Rc<Self>, label: &str) -> impl Fn() + 'static {
        let id = self.tracked.borrow_mut().start(label);
        let tracker = Rc::clone(self);
        move || tracker.finish(id)
    }

    /// Runs `work` as a tracked activity and marks it finished when it
    /// completes or fails.
    pub async fn with_activity<T, F: Future<Output = T>>(
        self: &Rc<Self>,
        label: &str,
        work: F,
    ) -> T {
        let mut finish = Finish(Some(Box::new(self.track_activity(label))));
        let value = work.await;
        finish.call();
        value
    }

    /// Tracked work that was running from `window_start` on: activities that
    /// finished since then, most recent first, then those still running.
    pub fn activities_during(&self, window_start: f64) -> Vec<String> {
        let tracked = self.tracked.borrow();
        let mut labels: Vec<String> = Vec::new();
        for activity in tracked.recent.iter().rev() {
            // INFALLIBLE: a finished activity, which alone enters `recent`, has an end time.
            let ended_at = activity
                .ended_at
                .expect("a finished activity has an end time");
            if ended_at < window_start {
                break;
            }
            if !labels.contains(&activity.label) {
                labels.push(activity.label.clone());
            }
        }
        for (_, activity) in tracked.running.iter().rev() {
            if !labels.contains(&activity.label) {
                labels.push(activity.label.clone());
            }
        }
        labels.truncate(REPORTED_ACTIVITY_LIMIT);
        labels
    }

    fn finish(&self, id: u64) {
        let mut tracked = self.tracked.borrow_mut();
        let Some(index) = tracked
            .running
            .iter()
            .position(|(running, _)| *running == id)
        else {
            return;
        };
        let (_, mut activity) = tracked.running.remove(index);
        activity.ended_at = Some(performance_now_ms());
        tracked.recent.push_back(activity);
        if tracked.recent.len() > RECENT_ACTIVITY_LIMIT {
            tracked.recent.pop_front();
        }
    }

    /// Reports event-loop stalls through `on_stall`, sampling every
    /// `interval_ms` and reporting a delay of `threshold_ms` or more. The
    /// returned function stops the sampling.
    ///
    /// Must be called on the thread's local task queue (`LocalSet`), where the
    /// sampler runs with the tracker and the callback.
    pub fn monitor_event_loop_stalls(
        self: &Rc<Self>,
        on_stall: impl Fn(EventLoopStall) + 'static,
        options: EventLoopStallOptions,
    ) -> impl Fn() + 'static {
        let interval_ms = options.interval_ms.unwrap_or(SAMPLE_INTERVAL_MS);
        let threshold_ms = options.threshold_ms.unwrap_or(REPORT_THRESHOLD_MS);
        // A timer of a duration that is not positive never waits.
        let interval = if interval_ms.is_finite() && interval_ms > 0.0 {
            Duration::from_secs_f64(interval_ms / 1000.0)
        } else {
            Duration::ZERO
        };
        let tracker = Rc::clone(self);
        let mut expected = performance_now_ms() + interval_ms;
        let sampler = tokio::task::spawn_local(async move {
            loop {
                tokio::time::sleep(interval).await;
                let now = performance_now_ms();
                let stall_ms = now - expected;
                // The loop was held from at least the missed tick until now.
                let window_start = expected;
                expected = now + interval_ms;
                if stall_ms < threshold_ms {
                    continue;
                }
                on_stall(EventLoopStall {
                    stall_ms: math_round(stall_ms),
                    activities: tracker.activities_during(window_start),
                    heap_used_mb: heap_used_mb(),
                });
            }
        });
        move || sampler.abort()
    }
}

impl Tracked {
    fn start(&mut self, label: &str) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.running.push((
            id,
            Activity {
                label: label.to_owned(),
                ended_at: None,
            },
        ));
        id
    }
}

/// The memory the process uses, in whole megabytes. The original reads the
/// JavaScript heap; the port has no heap of its own and reports the resident
/// set size, which is zero where it cannot be read.
fn heap_used_mb() -> u64 {
    let bytes = resident_bytes().unwrap_or(0);
    math_round(bytes as f64 / 1e6) as u64
}

#[cfg(target_os = "linux")]
fn resident_bytes() -> Option<u64> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    // The second count is the resident pages.
    let resident_pages: u64 = statm.split(' ').nth(1)?.parse().ok()?;
    resident_pages.checked_mul(page_size())
}

#[cfg(not(target_os = "linux"))]
fn resident_bytes() -> Option<u64> {
    None
}

#[cfg(target_os = "linux")]
fn page_size() -> u64 {
    // SAFETY: `sysconf` reads a constant of the system and has no state.
    u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::time::{Duration, Instant};

    use super::*;

    /// Holds the event loop, as the original's `block` does.
    fn block(duration: Duration) {
        let until = Instant::now() + duration;
        while Instant::now() < until {
            std::hint::spin_loop();
        }
    }

    fn recording_stalls() -> (
        Rc<RefCell<Vec<EventLoopStall>>>,
        impl Fn(EventLoopStall) + 'static,
    ) {
        let stalls = Rc::new(RefCell::new(Vec::new()));
        let recorded = Rc::clone(&stalls);
        let on_stall = move |stall| recorded.borrow_mut().push(stall);
        (stalls, on_stall)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reports_a_stall_longer_than_the_threshold_once_and_stays_quiet_otherwise() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (stalls, on_stall) = recording_stalls();
                let tracker = Rc::new(ActivityTracker::default());
                let stop = tracker.monitor_event_loop_stalls(
                    on_stall,
                    EventLoopStallOptions {
                        interval_ms: Some(20.0),
                        threshold_ms: Some(150.0),
                    },
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
                assert!(stalls.borrow().is_empty());

                block(Duration::from_millis(300));
                tokio::time::sleep(Duration::from_millis(60)).await;

                assert_eq!(stalls.borrow().len(), 1, "{:?}", stalls.borrow());
                let stall = stalls.borrow()[0].clone();
                assert!(stall.stall_ms >= 150.0, "{stall:?}");
                assert!(stall.heap_used_mb > 0, "{stall:?}");
                stop();
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stops_sampling_once_stopped() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (stalls, on_stall) = recording_stalls();
                let tracker = Rc::new(ActivityTracker::default());
                let stop = tracker.monitor_event_loop_stalls(
                    on_stall,
                    EventLoopStallOptions {
                        interval_ms: Some(20.0),
                        threshold_ms: Some(50.0),
                    },
                );
                stop();
                block(Duration::from_millis(120));
                tokio::time::sleep(Duration::from_millis(60)).await;
                assert!(stalls.borrow().is_empty(), "{:?}", stalls.borrow());
                // Stopping again is harmless.
                stop();
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn names_the_activity_that_held_the_loop_and_still_running_work() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (stalls, on_stall) = recording_stalls();
                let tracker = Rc::new(ActivityTracker::default());
                let finish_earlier = tracker.track_activity("synthetic earlier work");
                finish_earlier();
                let finish_running = tracker.track_activity("synthetic running work");
                let stop = tracker.monitor_event_loop_stalls(
                    on_stall,
                    EventLoopStallOptions {
                        interval_ms: Some(20.0),
                        threshold_ms: Some(150.0),
                    },
                );
                tokio::time::sleep(Duration::from_millis(60)).await;
                tracker
                    .with_activity("synthetic blocking work", async {
                        block(Duration::from_millis(300))
                    })
                    .await;
                tokio::time::sleep(Duration::from_millis(60)).await;

                assert_eq!(stalls.borrow().len(), 1, "{:?}", stalls.borrow());
                assert_eq!(
                    stalls.borrow()[0].activities,
                    ["synthetic blocking work", "synthetic running work"]
                );
                finish_running();
                stop();
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn finished_activities_are_named_most_recent_first_and_capped() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let tracker = Rc::new(ActivityTracker::default());
                let keep_running = tracker.track_activity("still running");
                for index in 0..12 {
                    let finish = tracker.track_activity(&format!("work {index}"));
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    finish();
                    // Finishing again changes nothing.
                    finish();
                }
                let names = tracker.activities_during(0.0);
                assert_eq!(names.len(), REPORTED_ACTIVITY_LIMIT);
                assert_eq!(names[0], "work 11");
                assert_eq!(names[REPORTED_ACTIVITY_LIMIT - 1], "work 4");

                // Work that ended before the window is not named; work still
                // running is named after what finished in the window.
                tokio::time::sleep(Duration::from_millis(10)).await;
                let window_start = performance_now_ms();
                assert_eq!(tracker.activities_during(window_start), ["still running"]);
                // Work that finishes inside the window is named most recent first.
                keep_running();
                assert_eq!(tracker.activities_during(window_start), ["still running"]);
                // A window that starts after everything finished names nothing.
                tokio::time::sleep(Duration::from_millis(1)).await;
                assert!(tracker.activities_during(performance_now_ms()).is_empty());
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn only_the_most_recent_finished_activities_are_kept() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let tracker = Rc::new(ActivityTracker::default());
                for index in 0..=RECENT_ACTIVITY_LIMIT {
                    tracker.track_activity(&format!("work {index}"))();
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                let names = tracker.activities_during(0.0);
                assert_eq!(names[0], format!("work {RECENT_ACTIVITY_LIMIT}"));
                assert!(!names.contains(&"work 0".to_owned()));
                assert_eq!(
                    tracker.activities_during(0.0).len(),
                    REPORTED_ACTIVITY_LIMIT
                );
            })
            .await;
    }

    #[test]
    fn an_activity_is_also_finished_when_the_work_panics() {
        let tracker = Rc::new(ActivityTracker::default());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut completed = Finish(Some(Box::new(tracker.track_activity("completed work"))));
            completed.call();
            let _panicking = Finish(Some(Box::new(tracker.track_activity("panicking work"))));
            panic!("synthetic failure");
        }));
        assert!(result.is_err());
        let names = tracker.activities_during(0.0);
        assert_eq!(names, ["panicking work", "completed work"]);
    }

    #[test]
    fn heap_used_is_a_whole_number_of_megabytes() {
        let used = heap_used_mb();
        #[cfg(target_os = "linux")]
        assert!(used > 0);
        let _ = used;
    }
}
