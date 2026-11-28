use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
    sync::LazyLock,
};

use garcon_base::{
    event_loop_stalls::ActivityTracker,
    log::{Logger, ScopedLogger, create_logger},
};
use garcon_js::{Number, performance_now_ms};
use indexmap::IndexMap;
use serde::Serialize;

const SLOW_WRITE_MS: f64 = 50.0;
static LOGGER: LazyLock<ScopedLogger> = LazyLock::new(|| create_logger("ledger:write"));

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WritePhase {
    Prepare,
    Encode,
    Validate,
    Write,
    Begin,
    Statements,
    Commit,
    Rollback,
    Complete,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseTiming {
    wall_ms: Number,
    process_cpu_ms: Number,
}

impl Default for PhaseTiming {
    fn default() -> Self {
        Self {
            wall_ms: Number(0.0),
            process_cpu_ms: Number(0.0),
        }
    }
}

pub struct LedgerWriteTimings<'a> {
    operation: &'a str,
    wall_clock_ms: &'a dyn Fn() -> f64,
    cpu_clock_us: &'a dyn Fn() -> u64,
    started_at: f64,
    phase: WritePhase,
    phase_started_at: f64,
    cpu_us: u64,
    phases: IndexMap<WritePhase, PhaseTiming>,
    finish_activity: Option<Box<dyn Fn()>>,
}

impl<'a> LedgerWriteTimings<'a> {
    pub fn new(
        operation: &'a str,
        tracker: Option<&Rc<ActivityTracker>>,
        wall_clock_ms: &'a dyn Fn() -> f64,
        cpu_clock_us: &'a dyn Fn() -> u64,
    ) -> Self {
        let started_at = wall_clock_ms();
        Self {
            operation,
            wall_clock_ms,
            cpu_clock_us,
            started_at,
            phase: WritePhase::Prepare,
            phase_started_at: started_at,
            cpu_us: cpu_clock_us(),
            phases: IndexMap::new(),
            finish_activity: tracker
                .map(|tracker| Box::new(tracker.track_activity(operation)) as Box<dyn Fn()>),
        }
    }

    pub fn phase(&mut self, phase: WritePhase) {
        self.record();
        self.phase = phase;
    }

    pub fn finish(mut self, context: &impl Serialize, report: impl FnOnce(&str)) {
        self.record();
        if let Some(finish) = self.finish_activity.take() {
            finish();
        }
        let wall_ms = (self.wall_clock_ms)() - self.started_at;
        if wall_ms < SLOW_WRITE_MS {
            return;
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct SlowWrite<'a, C> {
            operation: &'a str,
            #[serde(flatten)]
            context: &'a C,
            wall_ms: Number,
            phases: &'a IndexMap<WritePhase, PhaseTiming>,
        }
        // A diagnostic failure cannot replace the storage result.
        let _ = catch_unwind(AssertUnwindSafe(|| {
            if let Ok(payload) = serde_json::to_string(&SlowWrite {
                operation: self.operation,
                context,
                wall_ms: Number(wall_ms),
                phases: &self.phases,
            }) {
                report(&payload);
            }
        }));
    }

    fn record(&mut self) {
        let now = (self.wall_clock_ms)();
        let cpu_us = (self.cpu_clock_us)();
        let phase = self.phases.entry(self.phase).or_default();
        phase.wall_ms.0 += now - self.phase_started_at;
        phase.process_cpu_ms.0 += cpu_us.saturating_sub(self.cpu_us) as f64 / 1000.0;
        self.phase_started_at = now;
        self.cpu_us = cpu_us;
    }
}

impl Drop for LedgerWriteTimings<'_> {
    fn drop(&mut self) {
        if let Some(finish) = self.finish_activity.take() {
            finish();
        }
    }
}

pub fn measure_ledger_write<T, C: Serialize>(
    operation: &str,
    mut context: C,
    tracker: Option<&Rc<ActivityTracker>>,
    work: impl FnOnce(&mut LedgerWriteTimings<'_>, &mut C) -> T,
) -> T {
    let mut timings =
        LedgerWriteTimings::new(operation, tracker, &performance_now_ms, &process_cpu_us);
    let result = work(&mut timings, &mut context);
    timings.finish(&context, |payload| {
        LOGGER.warn(&format!("Slow synchronous write {payload}"))
    });
    result
}

#[cfg(unix)]
fn process_cpu_us() -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: getrusage initializes the pointed-to structure on success.
    let Ok(usage) = (unsafe {
        if libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) == 0 {
            Ok(usage.assume_init())
        } else {
            Err(())
        }
    }) else {
        return 0;
    };
    let micros = |time: libc::timeval| {
        (time.tv_sec as u64)
            .saturating_mul(1_000_000)
            .saturating_add(time.tv_usec as u64)
    };
    micros(usage.ru_utime).saturating_add(micros(usage.ru_stime))
}

#[cfg(windows)]
fn process_cpu_us() -> u64 {
    use std::mem::MaybeUninit;
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };
    let mut creation = MaybeUninit::<FILETIME>::uninit();
    let mut exit = MaybeUninit::<FILETIME>::uninit();
    let mut kernel = MaybeUninit::<FILETIME>::uninit();
    let mut user = MaybeUninit::<FILETIME>::uninit();
    // SAFETY: GetCurrentProcess is a valid pseudo-handle and successful output
    // fills the supplied FILETIME structures.
    unsafe {
        if GetProcessTimes(
            GetCurrentProcess(),
            creation.as_mut_ptr(),
            exit.as_mut_ptr(),
            kernel.as_mut_ptr(),
            user.as_mut_ptr(),
        ) == 0
        {
            return 0;
        }
        let micros = |time: FILETIME| {
            ((u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)) / 10
        };
        micros(kernel.assume_init()).saturating_add(micros(user.assume_init()))
    }
}

#[cfg(not(any(unix, windows)))]
fn process_cpu_us() -> u64 {
    0
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use garcon_js::json::from_slice;
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn slow_write_reports_the_batch_and_accumulates_phase_wall_and_cpu_times() {
        let wall = Cell::new(0.0);
        let cpu = Cell::new(0);
        let wall_ms = || wall.get();
        let cpu_us = || cpu.get();
        let mut timings = LedgerWriteTimings::new("ledger staging batch", None, &wall_ms, &cpu_us);
        timings.phase(WritePhase::Encode);
        wall.set(8.0);
        cpu.set(1300);
        timings.phase(WritePhase::Validate);
        wall.set(10.0);
        cpu.set(2000);
        timings.phase(WritePhase::Commit);
        wall.set(55.0);
        cpu.set(2100);
        timings.phase(WritePhase::Rollback);
        wall.set(58.0);
        cpu.set(2500);
        timings.phase(WritePhase::Complete);
        let mut report = None;
        timings.finish(
            &json!({"chatId":"synthetic", "firstOrdinal":501, "rows":5}),
            |line| {
                report = Some(line.to_owned());
            },
        );
        let report: Value = from_slice(report.unwrap().as_bytes()).unwrap();
        assert_eq!(
            report,
            json!({
                    "operation":"ledger staging batch", "chatId":"synthetic", "firstOrdinal":501,
                    "rows":5, "wallMs":58,
                    "phases":{
                        "prepare":{"wallMs":0,"processCpuMs":0},
                        "encode":{"wallMs":8,"processCpuMs":1.3},
                        "validate":{"wallMs":2,"processCpuMs":0.7},
                        "commit":{"wallMs":45,"processCpuMs":0.1},
                        "rollback":{"wallMs":3,"processCpuMs":0.4},
                        "complete":{"wallMs":0,"processCpuMs":0},
                    },
            })
        );
    }

    #[test]
    fn writes_under_the_slow_threshold_are_not_reported() {
        let wall = Cell::new(0.0);
        let wall_ms = || wall.get();
        let timings = LedgerWriteTimings::new("ledger seed promotion", None, &wall_ms, &|| 0);
        wall.set(49.9);
        let mut reported = false;
        timings.finish(&json!({}), |_| reported = true);
        assert!(!reported);
    }
}
