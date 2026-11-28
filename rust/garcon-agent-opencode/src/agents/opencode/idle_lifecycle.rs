//! Ports `server-agents/opencode/src/agents/opencode/idle-lifecycle.ts`.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use garcon_agents_common::shared::idle_session_purger::{
    DEFAULT_IDLE_SESSION_MAX_AGE_MS, DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS, IdleSessionPurger,
    purge_idle_sessions,
};
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use garcon_js::Clock;
use serde_json::json;
use tokio::{
    task::{JoinHandle, spawn_local},
    time::{Instant, MissedTickBehavior, interval_at},
};

use super::{
    endpoint_coordinator::OpenCodeEndpointCoordinator,
    turn_events::{OpenCodeSession, SessionStatus},
};
use crate::js::{log_fields, timer_delay};

const DEFAULT_RETIREMENT_DELAY_MS: f64 = 30_000.0;
const DEFAULT_RETIREMENT_CHECK_INTERVAL_MS: f64 = 5_000.0;

pub struct OpenCodeIdleLifecycleOptions {
    pub logger: Rc<dyn AgentLogger>,
    pub sessions: Rc<dyn Fn() -> Vec<(String, OpenCodeSession)>>,
    pub purge_session: Rc<dyn Fn(String)>,
    pub has_instance: Rc<dyn Fn() -> bool>,
    pub has_startup: Rc<dyn Fn() -> bool>,
    pub endpoint: Rc<OpenCodeEndpointCoordinator>,
    pub routes_idle: Rc<dyn Fn() -> bool>,
    pub decisions_idle: Rc<dyn Fn() -> bool>,
    pub has_pending_turn_waiters: Rc<dyn Fn() -> bool>,
    pub is_shutting_down: Rc<dyn Fn() -> bool>,
    pub invalidate_models: Rc<dyn Fn()>,
    pub close_instance: Rc<dyn Fn()>,
    pub clock: Rc<dyn Clock>,
    pub retirement_delay_ms: Option<f64>,
    pub retirement_check_interval_ms: Option<f64>,
}

pub struct OpenCodeIdleLifecycle {
    options: OpenCodeIdleLifecycleOptions,
    session_purger: IdleSessionPurger,
    retirement_timer: RefCell<Option<JoinHandle<()>>>,
    retirement_check: Cell<bool>,
    last_endpoint_activity_at: Cell<i64>,
}

impl OpenCodeIdleLifecycle {
    pub fn new(options: OpenCodeIdleLifecycleOptions) -> Rc<Self> {
        Rc::new(Self {
            last_endpoint_activity_at: Cell::new(options.clock.now_ms()),
            options,
            session_purger: IdleSessionPurger::default(),
            retirement_timer: RefCell::default(),
            retirement_check: Cell::new(false),
        })
    }

    pub fn record_activity(&self) {
        self.last_endpoint_activity_at
            .set(self.options.clock.now_ms());
    }

    pub fn close_instance_if_idle(&self) -> bool {
        let has_running_session = (self.options.sessions)()
            .into_iter()
            .any(|(_, session)| session.borrow().status == SessionStatus::Running);
        if has_running_session || !self.options.endpoint.idle() {
            return false;
        }
        (self.options.close_instance)();
        true
    }

    pub fn start(self: &Rc<Self>) {
        self.session_purger
            .start(DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS, {
                let weak = Rc::downgrade(self);
                move || {
                    if let Some(lifecycle) = weak.upgrade() {
                        lifecycle.purge_idle_sessions();
                    }
                }
            });
        if self.retirement_timer.borrow().is_some() {
            return;
        }
        let period = timer_delay(
            self.options
                .retirement_check_interval_ms
                .unwrap_or(DEFAULT_RETIREMENT_CHECK_INTERVAL_MS),
        );
        let mut timer = interval_at(Instant::now() + period, period);
        timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let weak = Rc::downgrade(self);
        self.retirement_timer.replace(Some(spawn_local(async move {
            loop {
                timer.tick().await;
                let Some(lifecycle) = weak.upgrade() else {
                    break;
                };
                if lifecycle.retirement_check.replace(true) {
                    continue;
                }
                spawn_local(async move {
                    if let Err(error) = lifecycle.retire_instance().await {
                        lifecycle.options.logger.error(
                            "OpenCode idle retirement check failed",
                            Some(&log_fields([("error", json!(error.to_string()))])),
                        );
                    }
                    lifecycle.retirement_check.set(false);
                });
            }
        })));
    }

    pub fn stop(&self) {
        self.session_purger.stop();
        if let Some(timer) = self.retirement_timer.take() {
            timer.abort();
        }
    }

    fn purge_idle_sessions(&self) {
        purge_idle_sessions(
            (self.options.sessions)(),
            |session| {
                let session = session.borrow();
                session.status == SessionStatus::Running
                    || session.provider_work_requires_quiescence
                    || session.pending_steering_revert_message_id.is_some()
            },
            |session| session.borrow().last_activity_at as i64,
            |id, _| (self.options.purge_session)(id),
            self.options.clock.now_ms(),
            DEFAULT_IDLE_SESSION_MAX_AGE_MS,
        );
    }

    async fn retire_instance(self: &Rc<Self>) -> ExecutorResult<bool> {
        self.options
            .endpoint
            .run_transition({
                let lifecycle = self.clone();
                move || async move {
                    let options = &lifecycle.options;
                    let since_activity = options.clock.now_ms() as f64
                        - lifecycle.last_endpoint_activity_at.get() as f64;
                    if (options.is_shutting_down)()
                        || since_activity
                            < options
                                .retirement_delay_ms
                                .unwrap_or(DEFAULT_RETIREMENT_DELAY_MS)
                        || !lifecycle.can_retire_instance()
                    {
                        return Ok(false);
                    }
                    (options.invalidate_models)();
                    options
                        .logger
                        .info("Retiring idle OpenCode server process", None);
                    (options.close_instance)();
                    Ok(true)
                }
            })
            .await
    }

    fn can_retire_instance(&self) -> bool {
        let options = &self.options;
        if !(options.has_instance)()
            || (options.has_startup)()
            || !options.endpoint.idle()
            || !(options.routes_idle)()
            || !(options.decisions_idle)()
            || (options.has_pending_turn_waiters)()
        {
            return false;
        }
        (options.sessions)().into_iter().all(|(_, session)| {
            let session = session.borrow();
            session.status != SessionStatus::Running
                && session.aborting != Some(true)
                && session.active_steering_deliveries == 0
                && session.deferred_terminal.is_none()
        })
    }
}

impl Drop for OpenCodeIdleLifecycle {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use garcon_js::{ManualClock, json::Opaque};
    use indexmap::IndexMap;
    use tokio::task::LocalSet;

    use super::*;
    use crate::{
        agents::opencode::endpoint_coordinator::OpenCodeEndpointCoordinatorOptions, js::error,
    };

    struct Logger;

    impl AgentLogger for Logger {
        fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn warn(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    }

    #[tokio::test(start_paused = true)]
    async fn retirement_waits_for_activity_and_all_owners_on_the_transition_queue() {
        LocalSet::new()
            .run_until(async {
                let logger = Rc::new(Logger);
                let endpoint =
                    OpenCodeEndpointCoordinator::new(OpenCodeEndpointCoordinatorOptions {
                        assert_available: Rc::new(|| Ok(())),
                        ensure_unlocked: Rc::new(|| {
                            Box::pin(async { Err(error("Error", "Unexpected provider startup")) })
                        }),
                        logger: logger.clone(),
                        on_activity: Rc::new(|| {}),
                    });
                let active = Rc::new(Cell::new(true));
                let clock = Rc::new(ManualClock::new(0));
                let outcomes = Rc::new(RefCell::new(Vec::new()));
                let lifecycle = OpenCodeIdleLifecycle::new(OpenCodeIdleLifecycleOptions {
                    logger,
                    sessions: Rc::new(Vec::new),
                    purge_session: Rc::new(|_| {}),
                    has_instance: Rc::new(|| true),
                    has_startup: Rc::new(|| false),
                    endpoint: endpoint.clone(),
                    routes_idle: Rc::new(|| true),
                    decisions_idle: Rc::new({
                        let active = active.clone();
                        move || !active.get()
                    }),
                    has_pending_turn_waiters: Rc::new(|| false),
                    is_shutting_down: Rc::new(|| false),
                    invalidate_models: Rc::new({
                        let outcomes = outcomes.clone();
                        move || outcomes.borrow_mut().push("invalidate")
                    }),
                    close_instance: Rc::new({
                        let outcomes = outcomes.clone();
                        move || outcomes.borrow_mut().push("close")
                    }),
                    clock: clock.clone(),
                    retirement_delay_ms: Some(30.0),
                    retirement_check_interval_ms: Some(5.0),
                });
                clock.set(30);
                assert!(
                    !lifecycle
                        .retire_instance()
                        .await
                        .expect("pending decision retains instance")
                );
                active.set(false);
                endpoint.request_started();
                assert!(
                    !lifecycle
                        .retire_instance()
                        .await
                        .expect("active lease retains instance")
                );
                endpoint.request_finished();
                lifecycle.record_activity();
                clock.set(59);
                assert!(
                    !lifecycle
                        .retire_instance()
                        .await
                        .expect("recent activity retains instance")
                );
                clock.set(60);
                assert!(
                    lifecycle
                        .retire_instance()
                        .await
                        .expect("retired idle instance")
                );
                assert_eq!(*outcomes.borrow(), ["invalidate", "close"]);
            })
            .await;
    }
}
