//! Ports `server-agents/common/src/shared/event-loop.ts`.

use std::{
    cell::RefCell,
    convert::Infallible,
    future::Future,
    pin::Pin,
    rc::Rc,
    task::{Context, Waker},
    time::Duration,
};

use garcon_js::performance_now_ms;
use tokio::time::{Sleep, sleep};

const STEP_BUDGET_MS: f64 = 10.0;
const SLOW_STEP_MS: f64 = 50.0;
const TIMER_TURN: Duration = Duration::from_millis(1);

pub type SlowStepReporter = dyn Fn(&str, f64);

thread_local! {
    static SLOW_STEP_REPORTER: RefCell<Option<Rc<SlowStepReporter>>> = const { RefCell::new(None) };
}

/// Gives the current-thread runtime's timer and I/O driver a turn.
pub async fn yield_to_event_loop() {
    // Tokio 1.54 wakes deferred tasks after polling the driver. A separate task
    // cannot be repolled early by unrelated wakes of the caller or its LocalSet.
    let _ = tokio::spawn(tokio::task::yield_now()).await;
}

pub fn report_slow_steps(reporter: Rc<SlowStepReporter>) -> impl Fn() {
    SLOW_STEP_REPORTER.with(|current| *current.borrow_mut() = Some(reporter.clone()));
    move || {
        SLOW_STEP_REPORTER.with(|current| {
            let mut current = current.borrow_mut();
            if current
                .as_ref()
                .is_some_and(|value| Rc::ptr_eq(value, &reporter))
            {
                *current = None;
            }
        });
    }
}

/// Bounds consecutive passes of one named operation with a shared time budget.
pub struct EventLoopSteps {
    operation: String,
    now_ms: Box<dyn Fn() -> f64>,
    step_start: f64,
    step_end: f64,
    holding: Pin<Box<Sleep>>,
}

impl EventLoopSteps {
    /// Creates steps on a Tokio runtime with timers enabled.
    pub fn new(operation: impl Into<String>) -> Self {
        Self::with_clock(operation, performance_now_ms)
    }

    pub fn with_clock(operation: impl Into<String>, now_ms: impl Fn() -> f64 + 'static) -> Self {
        let step_start = now_ms();
        Self {
            operation: operation.into(),
            now_ms: Box::new(now_ms),
            step_start,
            step_end: step_start + STEP_BUDGET_MS,
            holding: holding_probe(),
        }
    }

    pub fn due(&self) -> bool {
        (self.now_ms)() >= self.step_end
    }

    pub async fn next(&mut self) {
        if !self.due() {
            return;
        }
        let step_ms = (self.now_ms)() - self.step_start;
        if step_ms >= SLOW_STEP_MS && !self.holding.is_elapsed() {
            let reporter = SLOW_STEP_REPORTER.with(|current| current.borrow().clone());
            if let Some(reporter) = reporter {
                reporter(&self.operation, step_ms);
            }
        }
        yield_to_event_loop().await;
        self.step_start = (self.now_ms)();
        self.step_end = self.step_start + STEP_BUDGET_MS;
        self.holding = holding_probe();
    }

    pub async fn for_each<T>(
        &mut self,
        items: impl IntoIterator<Item = T>,
        mut visit: impl FnMut(T),
    ) {
        let result = self
            .try_for_each(items, |item| {
                visit(item);
                Ok::<_, Infallible>(())
            })
            .await;
        match result {
            Ok(()) => {}
            Err(impossible) => match impossible {},
        }
    }

    pub async fn try_for_each<T, E>(
        &mut self,
        items: impl IntoIterator<Item = T>,
        mut visit: impl FnMut(T) -> Result<(), E>,
    ) -> Result<(), E> {
        for item in items {
            visit(item)?;
            if self.due() {
                self.next().await;
            }
        }
        Ok(())
    }
}

pub async fn for_each_in_steps<T>(
    operation: impl Into<String>,
    items: impl IntoIterator<Item = T>,
    visit: impl FnMut(T),
) {
    EventLoopSteps::new(operation).for_each(items, visit).await;
}

// An elapsed deadline does not fire until the timer driver has run.
fn holding_probe() -> Pin<Box<Sleep>> {
    let mut timer = Box::pin(sleep(TIMER_TURN));
    let mut register = tokio::task::unconstrained(timer.as_mut());
    let _ = Pin::new(&mut register).poll(&mut Context::from_waker(Waker::noop()));
    timer
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use tokio::task::LocalSet;

    #[tokio::test(start_paused = true)]
    async fn yielding_does_not_wait_for_a_timer_deadline() {
        let before = tokio::time::Instant::now();
        LocalSet::new().run_until(yield_to_event_loop()).await;
        assert_eq!(tokio::time::Instant::now(), before);
    }

    #[tokio::test]
    async fn yielding_polls_the_driver_for_a_pending_timer() {
        LocalSet::new()
            .run_until(async {
                tokio::task::spawn_local(async {
                    let timer = holding_probe();
                    std::thread::sleep(Duration::from_millis(10));
                    assert!(!timer.is_elapsed(), "the driver has not run");
                    yield_to_event_loop().await;
                    assert!(timer.is_elapsed(), "the driver polled the due timer");
                })
                .await
                .unwrap();
            })
            .await;
    }

    fn steps(operation: &str, now: &Rc<Cell<f64>>) -> EventLoopSteps {
        let clock = now.clone();
        EventLoopSteps::with_clock(operation, move || clock.get())
    }

    #[tokio::test(start_paused = true)]
    async fn visits_every_item_in_order_while_bounding_each_step_by_elapsed_time() {
        LocalSet::new()
            .run_until(async {
                let now = Rc::new(Cell::new(0.0));
                let counts = Rc::new(RefCell::new(Vec::new()));
                let ticks = counts.clone();
                let probe_time = now.clone();
                let probe = tokio::task::spawn_local(async move {
                    for _ in 0..60 {
                        tokio::task::yield_now().await;
                        ticks.borrow_mut().push(probe_time.get());
                    }
                });
                let mut visited = Vec::new();
                steps("synthetic-pass", &now)
                    .for_each(0..60, |item| {
                        visited.push(item);
                        now.set(now.get() + 2.0);
                    })
                    .await;
                yield_to_event_loop().await;
                probe.abort();
                assert_eq!(visited, (0..60).collect::<Vec<_>>());
                let ticks = counts.borrow();
                assert!(ticks.len() > 2, "bulk work must let other local tasks run");
                assert!(ticks.windows(2).all(|tick| tick[1] - tick[0] <= 20.0));
                assert!(ticks.last().is_some_and(|tick| now.get() - tick <= 20.0));
            })
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn finishes_cheap_work_without_yielding() {
        LocalSet::new()
            .run_until(async {
                let ran = Rc::new(Cell::new(false));
                let flag = ran.clone();
                let probe = tokio::task::spawn_local(async move { flag.set(true) });
                let now = Rc::new(Cell::new(0.0));
                steps("synthetic-pass", &now)
                    .for_each([1, 2, 3], |_| {})
                    .await;
                assert!(!ran.get());
                probe.abort();
            })
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn consecutive_passes_share_one_step_budget() {
        LocalSet::new()
            .run_until(async {
                let ran = Rc::new(Cell::new(false));
                let flag = ran.clone();
                let probe = tokio::task::spawn_local(async move { flag.set(true) });
                let now = Rc::new(Cell::new(0.0));
                let mut steps = steps("synthetic-passes", &now);
                steps.for_each([1, 2], |_| now.set(now.get() + 4.0)).await;
                assert!(!ran.get());
                steps.for_each([3], |_| now.set(now.get() + 4.0)).await;
                assert!(ran.get());
                assert!(!steps.due());
                probe.await.unwrap();
            })
            .await;
    }

    type StepHistory = Rc<RefCell<Vec<(String, f64)>>>;

    fn record_steps() -> (StepHistory, Rc<SlowStepReporter>) {
        let history = Rc::new(RefCell::new(Vec::new()));
        let writes = history.clone();
        (
            history,
            Rc::new(move |operation, ms| writes.borrow_mut().push((operation.into(), ms))),
        )
    }

    #[tokio::test(start_paused = true)]
    async fn reports_a_held_step_past_the_slow_limit_with_its_operation() {
        let (history, reporter) = record_steps();
        let stop = report_slow_steps(reporter);
        let now = Rc::new(Cell::new(0.0));
        let mut steps = steps("synthetic-slow-pass", &now);
        now.set(50.0);
        steps.next().await;
        assert_eq!(*history.borrow(), [("synthetic-slow-pass".into(), 50.0)]);
        stop();
    }

    #[tokio::test(start_paused = true)]
    async fn does_not_report_a_long_step_that_let_the_loop_run_while_it_waited() {
        let (history, reporter) = record_steps();
        let stop = report_slow_steps(reporter);
        let now = Rc::new(Cell::new(0.0));
        let mut steps = steps("synthetic-waiting-pass", &now);
        sleep(Duration::from_millis(60)).await;
        now.set(60.0);
        steps.next().await;
        assert!(history.borrow().is_empty());
        stop();
    }

    #[tokio::test(start_paused = true)]
    async fn stopping_an_old_reporter_does_not_disable_its_replacement() {
        let (first, reporter) = record_steps();
        let stop_first = report_slow_steps(reporter);
        let (second, reporter) = record_steps();
        let stop_second = report_slow_steps(reporter);
        stop_first();
        let now = Rc::new(Cell::new(0.0));
        let mut steps = steps("synthetic-pass", &now);
        now.set(50.0);
        steps.next().await;
        stop_second();
        now.set(100.0);
        steps.next().await;
        assert!(first.borrow().is_empty());
        assert_eq!(*second.borrow(), [("synthetic-pass".into(), 50.0)]);
    }

    #[tokio::test(start_paused = true)]
    async fn visit_failure_stops_before_the_next_item() {
        let now = Rc::new(Cell::new(0.0));
        let mut visited = Vec::new();
        let failure = steps("synthetic-pass", &now)
            .try_for_each(0..3, |item| {
                visited.push(item);
                if item == 1 { Err("synthetic") } else { Ok(()) }
            })
            .await;
        assert_eq!(failure, Err("synthetic"));
        assert_eq!(visited, [0, 1]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_due_step_lets_a_ready_socket_progress() {
        LocalSet::new()
            .run_until(async {
                let listener = tokio::net::TcpListener::bind(("0.0.0.0", 0)).await.unwrap();
                let port = listener.local_addr().unwrap().port();
                let _peer = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
                let (accepted, mut done) = tokio::sync::oneshot::channel();
                let accept = tokio::task::spawn_local(async move {
                    let _socket = listener.accept().await.unwrap();
                    accepted.send(()).unwrap();
                });
                let now = Rc::new(Cell::new(0.0));
                let mut steps = steps("synthetic-socket-readiness", &now);
                now.set(10.0);
                steps.next().await;
                done.try_recv()
                    .expect("socket progresses during a due step");
                accept.await.unwrap();
            })
            .await;
    }
}
