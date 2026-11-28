//! Ports `server-agents/common/src/lifecycle/process-exit-fence.ts`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::rc::Rc;
use std::time::Duration;

use futures::future::LocalBoxFuture;
use garcon_interface::resources::ExecutorResult;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::execution::admission::check_signal;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminationTimings {
    pub term_ms: u64,
    pub kill_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminationSignal {
    Sigterm,
    Sigkill,
}

pub trait TerminatingProcess {
    /// Settles once the process has exited, and fails when its exit can no
    /// longer be observed.
    fn exited(&self) -> LocalBoxFuture<'static, Result<(), ()>>;
    /// Sends the signal to the process.
    fn kill(&self, signal: TerminationSignal) -> io::Result<()>;
}

#[derive(Debug, thiserror::Error)]
#[error("A previous process for this session has not exited")]
pub struct PreviousProcessNotExited;

pub const DEFAULT_TIMINGS: TerminationTimings = TerminationTimings {
    term_ms: 5_000,
    kill_ms: 5_000,
};

// One termination attempt. Its outcome is `None` until the attempt settles.
struct Attempt {
    outcome: watch::Sender<Option<bool>>,
}

type Pending = Rc<RefCell<HashMap<String, Vec<Rc<Attempt>>>>>;

/// A timed-out kill remains an admission fence until the direct child's exit
/// is observed.
pub struct ProcessExitFence {
    timings: TerminationTimings,
    pending: Pending,
}

impl Default for ProcessExitFence {
    fn default() -> Self {
        Self::new(DEFAULT_TIMINGS)
    }
}

impl ProcessExitFence {
    pub fn new(timings: TerminationTimings) -> Self {
        Self {
            timings,
            pending: Rc::default(),
        }
    }

    pub fn assert_clear(&self, key: &str) -> Result<(), PreviousProcessNotExited> {
        if self
            .pending
            .borrow()
            .get(key)
            .is_some_and(|pending| !pending.is_empty())
        {
            return Err(PreviousProcessNotExited);
        }
        Ok(())
    }

    /// Sends `SIGTERM` and resolves once the exit is observed. `SIGKILL`
    /// follows after the term grace, and the attempt resolves `false` when
    /// the kill grace passes without an exit; the fence then holds until the
    /// exit is observed anyway.
    pub fn terminate<F>(
        &self,
        key: &str,
        process: Rc<dyn TerminatingProcess>,
        on_exit: F,
    ) -> impl Future<Output = bool> + use<F>
    where
        F: FnOnce() + 'static,
    {
        let (outcome, mut settled) = watch::channel(None);
        let attempt = Rc::new(Attempt { outcome });
        self.pending
            .borrow_mut()
            .entry(key.to_owned())
            .or_default()
            .push(attempt.clone());

        // The reaction on `exited` outlives the attempt: when the exit is
        // observed, it reports the exit, clears the fence, and only then
        // settles what the attempt waits for.
        let exit = process.exited();
        let (observed, observed_by_attempt) = watch::channel(None);
        let map = Rc::clone(&self.pending);
        let key = key.to_owned();
        let finished_attempt = attempt.clone();
        tokio::task::spawn_local(async move {
            let exited = exit.await.is_ok();
            if exited {
                on_exit();
                let mut map = map.borrow_mut();
                if let Some(pending) = map.get_mut(&key) {
                    pending.retain(|other| !Rc::ptr_eq(other, &finished_attempt));
                    if pending.is_empty() {
                        map.remove(&key);
                    }
                }
            }
            observed.send_replace(Some(exited));
        });

        // Exit observation, not signal delivery, releases admission.
        let _ = process.kill(TerminationSignal::Sigterm);
        let timings = self.timings;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timings.term_ms);
        tokio::task::spawn_local(async move {
            let mut exited = exited_by(observed_by_attempt.clone(), deadline).await;
            if !exited {
                // An unconfirmed exit remains fenced.
                let _ = process.kill(TerminationSignal::Sigkill);
                let deadline = tokio::time::Instant::now() + Duration::from_millis(timings.kill_ms);
                exited = exited_by(observed_by_attempt, deadline).await;
            }
            attempt.outcome.send_replace(Some(exited));
        });

        async move {
            settled
                .wait_for(|outcome| outcome.is_some())
                .await
                .ok()
                .and_then(|outcome| *outcome)
                .unwrap_or(false)
        }
    }

    pub async fn wait(&self, key: &str, signal: Option<&CancellationToken>) -> ExecutorResult<()> {
        check_signal(signal)?;
        loop {
            let attempts: Vec<_> = {
                let pending = self.pending.borrow();
                let Some(pending) = pending.get(key) else {
                    return Ok(());
                };
                pending
                    .iter()
                    .map(|attempt| attempt.outcome.subscribe())
                    .collect()
            };
            let settled = async move {
                let mut outcomes = Vec::with_capacity(attempts.len());
                for mut attempt in attempts {
                    outcomes.push(
                        attempt
                            .wait_for(|outcome| outcome.is_some())
                            .await
                            .ok()
                            .and_then(|outcome| *outcome),
                    );
                }
                outcomes
            };
            let outcomes = match signal {
                None => settled.await,
                Some(signal) => {
                    tokio::select! {
                        biased;
                        _ = signal.cancelled() => {
                            // INFALLIBLE: the signal is cancelled here, so the check fails.
                            return Err(check_signal(Some(signal)).unwrap_err());
                        }
                        outcomes = settled => outcomes,
                    }
                }
            };
            check_signal(signal)?;
            if outcomes.into_iter().any(|outcome| outcome == Some(false)) {
                return Err(PreviousProcessNotExited.into());
            }
        }
    }
}

async fn exited_by(
    mut observed: watch::Receiver<Option<bool>>,
    deadline: tokio::time::Instant,
) -> bool {
    match tokio::time::timeout_at(deadline, observed.wait_for(|observed| observed.is_some())).await
    {
        Ok(Ok(observed)) => *observed == Some(true),
        _ => false,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::cell::Cell;
    use std::process::Stdio;
    use std::rc::Rc;

    use garcon_base::errors::NamedError;
    use tokio::io::AsyncReadExt;
    use tokio::process::{Child, Command};
    use tokio::task::LocalSet;

    use super::*;

    /// Whether `error` is the reason a signal aborted with when nothing gave it one.
    fn aborted(error: &(dyn std::error::Error + 'static)) -> bool {
        error
            .downcast_ref::<NamedError>()
            .is_some_and(|error| error.name == "AbortError")
    }

    /// A real child process, with one task observing its exit as the transports do.
    struct Shell {
        pid: u32,
        exit: watch::Receiver<Option<Result<(), ()>>>,
    }

    impl Shell {
        async fn spawn(script: &str) -> Rc<Self> {
            let mut child: Child = Command::new("sh")
                .args(["-c", script])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let mut stdout = child.stdout.take().unwrap();
            let ready = tokio::time::timeout(Duration::from_secs(5), stdout.read_u8())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(ready, b'!');
            let pid = child.id().unwrap();
            let (exit, observed) = watch::channel(None);
            tokio::task::spawn_local(async move {
                let status = child.wait().await;
                exit.send_replace(Some(status.map(|_| ()).map_err(|_| ())));
            });
            Rc::new(Self {
                pid,
                exit: observed,
            })
        }
    }

    impl TerminatingProcess for Shell {
        fn exited(&self) -> LocalBoxFuture<'static, Result<(), ()>> {
            let mut exit = self.exit.clone();
            Box::pin(async move {
                exit.wait_for(|exit| exit.is_some())
                    .await
                    .ok()
                    .and_then(|exit| *exit)
                    .unwrap_or(Err(()))
            })
        }

        fn kill(&self, signal: TerminationSignal) -> io::Result<()> {
            let signal = match signal {
                TerminationSignal::Sigterm => libc::SIGTERM,
                TerminationSignal::Sigkill => libc::SIGKILL,
            };
            // SAFETY: `kill` reads only the process id and the signal number.
            if unsafe { libc::kill(self.pid as libc::pid_t, signal) } == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }
    }

    /// A process whose exit and signals a test controls.
    struct Scripted {
        exit: watch::Sender<Option<Result<(), ()>>>,
        signals: RefCell<Vec<TerminationSignal>>,
    }

    impl Scripted {
        fn new() -> Rc<Self> {
            let (exit, _) = watch::channel(None);
            Rc::new(Self {
                exit,
                signals: RefCell::default(),
            })
        }
    }

    impl TerminatingProcess for Scripted {
        fn exited(&self) -> LocalBoxFuture<'static, Result<(), ()>> {
            let mut exit = self.exit.subscribe();
            Box::pin(async move {
                exit.wait_for(|exit| exit.is_some())
                    .await
                    .ok()
                    .and_then(|exit| *exit)
                    .unwrap_or(Err(()))
            })
        }

        fn kill(&self, signal: TerminationSignal) -> io::Result<()> {
            self.signals.borrow_mut().push(signal);
            Ok(())
        }
    }

    const PATIENT: TerminationTimings = TerminationTimings {
        term_ms: 5_000,
        kill_ms: 5_000,
    };

    #[tokio::test]
    async fn a_process_that_exits_on_sigterm_is_reported_and_clears_the_fence() {
        const SCRIPT: &str = "printf '!'; exec sleep 30";
        LocalSet::new()
            .run_until(async {
                let fence = ProcessExitFence::new(PATIENT);
                let exits = Rc::new(Cell::new(0));
                let observed = Rc::clone(&exits);
                let shell = Shell::spawn(SCRIPT).await;
                let attempt =
                    fence.terminate("session", shell, move || observed.set(observed.get() + 1));
                assert!(matches!(
                    fence.assert_clear("session"),
                    Err(PreviousProcessNotExited)
                ));

                let exited = tokio::time::timeout(Duration::from_secs(10), attempt)
                    .await
                    .unwrap();

                assert!(exited);
                assert_eq!(exits.get(), 1);
                fence.assert_clear("session").unwrap();
                fence.wait("session", None).await.unwrap();

                let output = Command::new("bun")
                    .arg(concat!(
                        env!("CARGO_MANIFEST_DIR"),
                        "/tests/oracles/process-exit-fence.ts"
                    ))
                    .arg(SCRIPT)
                    .output()
                    .await
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let outcome = serde_json::json!({ "exited": exited, "exitCallbacks": exits.get() });
                assert_eq!(serde_json::to_vec(&outcome).unwrap(), output.stdout);
            })
            .await;
    }

    #[tokio::test]
    async fn a_process_that_ignores_sigterm_is_killed() {
        LocalSet::new()
            .run_until(async {
                let timings = TerminationTimings {
                    term_ms: 50,
                    kill_ms: 5_000,
                };
                let fence = ProcessExitFence::new(timings);
                let exits = Rc::new(Cell::new(0));
                let observed = Rc::clone(&exits);
                let shell = Shell::spawn("trap '' TERM; printf '!'; exec sleep 30").await;

                let exited = tokio::time::timeout(
                    Duration::from_secs(10),
                    fence.terminate("session", shell, move || observed.set(observed.get() + 1)),
                )
                .await
                .unwrap();

                assert!(exited);
                assert_eq!(exits.get(), 1);
                fence.assert_clear("session").unwrap();
            })
            .await;
    }

    #[tokio::test]
    async fn an_unconfirmed_exit_keeps_the_fence_until_it_is_observed() {
        LocalSet::new()
            .run_until(async {
                let timings = TerminationTimings {
                    term_ms: 10,
                    kill_ms: 10,
                };
                let fence = ProcessExitFence::new(timings);
                let process = Scripted::new();
                let attempt = fence.terminate("session", process.clone(), || {});

                assert!(!attempt.await);
                assert_eq!(
                    *process.signals.borrow(),
                    [TerminationSignal::Sigterm, TerminationSignal::Sigkill]
                );
                assert!(matches!(
                    fence.assert_clear("session"),
                    Err(PreviousProcessNotExited)
                ));
                let error = fence.wait("session", None).await.unwrap_err();
                assert!(error.is::<PreviousProcessNotExited>());

                // The exit observed later clears the fence without another wait.
                process.exit.send_replace(Some(Ok(())));
                tokio::task::yield_now().await;
                fence.assert_clear("session").unwrap();
                fence.wait("session", None).await.unwrap();
            })
            .await;
    }

    #[tokio::test]
    async fn a_lost_exit_observation_never_clears_the_fence() {
        LocalSet::new()
            .run_until(async {
                let fence = ProcessExitFence::new(PATIENT);
                let process = Scripted::new();
                let attempt = fence.terminate("session", process.clone(), || {});
                process.exit.send_replace(Some(Err(())));

                assert!(!attempt.await);
                assert_eq!(
                    *process.signals.borrow(),
                    [TerminationSignal::Sigterm, TerminationSignal::Sigkill]
                );
                assert!(matches!(
                    fence.wait("session", None).await,
                    Err(error) if error.is::<PreviousProcessNotExited>()
                ));
            })
            .await;
    }

    #[tokio::test]
    async fn wait_returns_once_every_pending_exit_is_observed() {
        LocalSet::new()
            .run_until(async {
                let fence = ProcessExitFence::new(PATIENT);
                let first = Scripted::new();
                let second = Scripted::new();
                let _first_attempt = fence.terminate("session", first.clone(), || {});
                let _second_attempt = fence.terminate("session", second.clone(), || {});
                let waiting = fence.wait("session", None);
                tokio::pin!(waiting);
                assert!(futures::poll!(waiting.as_mut()).is_pending());

                first.exit.send_replace(Some(Ok(())));
                assert!(futures::poll!(waiting.as_mut()).is_pending());
                second.exit.send_replace(Some(Ok(())));

                waiting.await.unwrap();
                fence.assert_clear("session").unwrap();
            })
            .await;
    }

    #[tokio::test]
    async fn wait_stops_when_the_caller_aborts() {
        LocalSet::new()
            .run_until(async {
                let fence = ProcessExitFence::new(PATIENT);
                let process = Scripted::new();
                let _attempt = fence.terminate("session", process, || {});
                let signal = CancellationToken::new();
                let waiting = fence.wait("session", Some(&signal));
                tokio::pin!(waiting);
                assert!(futures::poll!(waiting.as_mut()).is_pending());

                signal.cancel();

                assert!(aborted(waiting.await.unwrap_err().as_ref()));
                assert!(matches!(
                    fence.assert_clear("session"),
                    Err(PreviousProcessNotExited)
                ));

                let aborted_signal = CancellationToken::new();
                aborted_signal.cancel();
                let error = fence
                    .wait("session", Some(&aborted_signal))
                    .await
                    .unwrap_err();
                assert!(aborted(error.as_ref()));
            })
            .await;
    }

    #[test]
    fn a_session_without_a_pending_exit_is_clear() {
        let fence = ProcessExitFence::default();
        fence.assert_clear("session").unwrap();
        assert_eq!(fence.timings, DEFAULT_TIMINGS);
    }
}
