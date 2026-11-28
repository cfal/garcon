//! Ports `server/runtime/git/operation-context.ts`.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::rc::Rc;

use garcon_base::errors::NamedError;
use garcon_base::keyed_lock::LockAborted;
use garcon_base::path_boundary::resolve_real_within_base;
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode};
use garcon_contract::git_execution::GIT_OPERATION_TIMEOUT_MS;
use garcon_interface::resources::{ExecutorCallOptions, ExecutorResult};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;

use crate::ChildEnvironment;
use crate::cancellation::check_cancelled;

use super::git_domain_error::GitDomainError;
use super::types::{GitCommandOptions, GitProcessError};

struct GitOperation {
    signal: CancellationToken,
    deadline: Instant,
    root: RefCell<String>,
    child_environment: Option<ChildEnvironment>,
    pending: Cell<usize>,
    settled: Notify,
    closed: Cell<bool>,
    output_truncated: Cell<bool>,
    mutation_dispatched: Cell<bool>,
}

tokio::task_local! {
    static CURRENT: Rc<GitOperation>;
}

fn current() -> Option<Rc<GitOperation>> {
    CURRENT.try_with(Rc::clone).ok()
}

fn scoped_option(
    current: &GitOperation,
    options: &mut GitCommandOptions,
) -> Result<(), GitServiceError> {
    if current.closed.get() || current.signal.is_cancelled() {
        return Err(GitServiceError::new(
            GitServiceErrorCode::GIT_TIMEOUT,
            "Git operation expired or was cancelled",
        ));
    }
    let budget = current
        .deadline
        .saturating_duration_since(Instant::now())
        .as_secs_f64()
        * 1000.0;
    options.timeout_ms = Some(
        options
            .timeout_ms
            .unwrap_or(GIT_OPERATION_TIMEOUT_MS as f64)
            .min(budget)
            .max(1.0),
    );
    if !options.disable_optional_locks {
        options.max_stdout_bytes.get_or_insert(32_768);
    }
    options
        .truncate_stdout
        .get_or_insert(!options.disable_optional_locks);
    if options.base_environment.is_none() {
        options.base_environment = current.child_environment.clone();
    }
    let env = options.env.get_or_insert_with(Default::default);
    env.insert("GIT_TERMINAL_PROMPT".into(), Some("0".into()));
    env.insert("GCM_INTERACTIVE".into(), Some("never".into()));
    Ok(())
}

pub async fn with_git_operation<T, Fut>(
    root: &str,
    options: Option<ExecutorCallOptions>,
    mutation: bool,
    operation: impl FnOnce(CancellationToken) -> Fut,
) -> ExecutorResult<T>
where
    Fut: Future<Output = ExecutorResult<T>>,
{
    with_git_operation_with_environment(root, options, mutation, None, operation).await
}

pub async fn with_git_operation_with_environment<T, Fut>(
    root: &str,
    options: Option<ExecutorCallOptions>,
    mutation: bool,
    child_environment: Option<ChildEnvironment>,
    operation: impl FnOnce(CancellationToken) -> Fut,
) -> ExecutorResult<T>
where
    Fut: Future<Output = ExecutorResult<T>>,
{
    let options = options.unwrap_or_default();
    let timeout = options
        .timeout_ms
        .unwrap_or(GIT_OPERATION_TIMEOUT_MS as f64);
    let deadline = Instant::now() + super::run::timer_delay(timeout);
    let signal = options
        .signal
        .map_or_else(CancellationToken::new, |caller| caller.child_token());
    let timer = StopTimer(tokio::task::spawn_local({
        let signal = signal.clone();
        async move {
            sleep_until(deadline).await;
            signal.cancel();
        }
    }));
    let operation_state = Rc::new(GitOperation {
        signal: signal.clone(),
        deadline,
        root: RefCell::new(root.to_owned()),
        child_environment,
        pending: Cell::new(0),
        settled: Notify::new(),
        closed: Cell::new(false),
        output_truncated: Cell::new(false),
        mutation_dispatched: Cell::new(false),
    });
    let result = CURRENT.scope(operation_state.clone(), async {
        check_git_cancelled(&signal)?;
        let result = operation(signal.clone()).await.map_err(|error| {
            if error.downcast_ref::<GitDomainError>().is_some_and(|error| error.code == "MUTATION_OUTCOME_UNKNOWN") {
                return error;
            }
            if mutation && operation_state.mutation_dispatched.get()
                && (signal.is_cancelled() || is_git_cancellation(error.as_ref()))
            {
                return GitServiceError::new(
                    GitServiceErrorCode::GIT_MUTATION_OUTCOME_UNKNOWN,
                    "Git mutation was interrupted after dispatch. Inspect the repository before trying again.",
                ).into();
            }
            error
        });
        settle_git_processes().await;
        result
    }).await;
    drop(timer);
    if result.is_ok() && !mutation {
        check_git_cancelled(&signal)?;
    }
    result
}

struct StopTimer(JoinHandle<()>);

impl Drop for StopTimer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) fn check_git_cancelled(signal: &CancellationToken) -> Result<(), NamedError> {
    check_cancelled(Some(signal))
}

pub fn is_git_cancellation(error: &(dyn std::error::Error + 'static)) -> bool {
    error
        .downcast_ref::<NamedError>()
        .is_some_and(|error| matches!(error.name.as_str(), "AbortError" | "TimeoutError"))
        || error.is::<LockAborted>()
        || error
            .downcast_ref::<GitProcessError>()
            .is_some_and(|error| error.aborted == Some(true) || error.timed_out == Some(true))
        || error
            .downcast_ref::<GitServiceError>()
            .is_some_and(|error| error.code == GitServiceErrorCode::GIT_TIMEOUT)
}

pub fn git_operation_signal() -> Option<CancellationToken> {
    current().map(|context| context.signal.clone())
}

pub(super) fn mark_git_mutation_dispatched() {
    if let Some(current) = current() {
        current.mutation_dispatched.set(true);
    }
}

pub fn git_mutation_dispatched() -> bool {
    current().is_some_and(|context| context.mutation_dispatched.get())
}

pub async fn settle_git_processes() {
    if let Some(current) = current() {
        current.closed.set(true);
        while current.pending.get() != 0 {
            current.settled.notified().await;
        }
    }
}

struct PendingProcess(Rc<GitOperation>);

impl Drop for PendingProcess {
    fn drop(&mut self) {
        let operation = &self.0;
        operation.pending.set(operation.pending.get() - 1);
        operation.settled.notify_one();
    }
}

pub(super) fn track_git_process<T: 'static>(
    future: impl Future<Output = ExecutorResult<T>> + 'static,
) -> impl Future<Output = ExecutorResult<T>> {
    let task = if let Some(current) = current() {
        current.pending.set(current.pending.get() + 1);
        let pending = PendingProcess(current.clone());
        tokio::task::spawn_local(CURRENT.scope(current, async move {
            let _pending = pending;
            future.await
        }))
    } else {
        tokio::task::spawn_local(future)
    };
    async move { task.await? }
}

pub(super) struct ScopedGitOptions {
    pub options: GitCommandOptions,
    pub context_signal: Option<CancellationToken>,
}

pub(super) fn git_operation_options(
    mut options: GitCommandOptions,
) -> Result<ScopedGitOptions, GitServiceError> {
    let context_signal = if let Some(current) = current() {
        scoped_option(&current, &mut options)?;
        Some(current.signal.clone())
    } else {
        None
    };
    Ok(ScopedGitOptions {
        options,
        context_signal,
    })
}

pub async fn assert_git_working_path(file_path: &str) -> ExecutorResult<()> {
    if let Some(current) = current() {
        check_git_cancelled(&current.signal)?;
        let root = current.root.borrow().clone();
        resolve_real_within_base(&root, file_path).await?;
    }
    Ok(())
}

pub fn restrict_git_working_root(root: String) {
    if let Some(current) = current() {
        *current.root.borrow_mut() = root;
    }
}

pub(super) fn mark_git_output_truncated() {
    if let Some(current) = current() {
        current.output_truncated.set(true);
    }
}

pub fn git_output_truncated() -> bool {
    current().is_some_and(|context| context.output_truncated.get())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use garcon_base::errors::{ErrorInput, diagnostic_error_code};
    use garcon_base::keyed_lock::KeyedLock;
    use tokio::sync::oneshot;
    use tokio::task::LocalSet;
    use tokio::time::timeout;

    use super::*;

    #[tokio::test]
    async fn preaborted_git_scope_preserves_abort_metadata() {
        let signal = CancellationToken::new();
        signal.cancel();
        let options = ExecutorCallOptions {
            signal: Some(signal),
            ..Default::default()
        };
        let result = LocalSet::new()
            .run_until(with_git_operation::<(), _>(
                "/",
                Some(options),
                false,
                |_| async {
                    panic!("preaborted operation must not run");
                },
            ))
            .await;
        let error = result.unwrap_err();
        assert_eq!(
            diagnostic_error_code(ErrorInput::Error(error.as_ref())),
            "AbortError"
        );
        assert!(is_git_cancellation(error.as_ref()));
        assert_eq!(error.to_string(), "The operation was aborted.");
    }

    #[tokio::test]
    async fn cancelled_repository_lock_waiter_is_git_cancellation() {
        let lock = KeyedLock::new();
        let signal = CancellationToken::new();
        let (entered, entered_rx) = oneshot::channel();
        let (release, release_rx) = oneshot::channel();
        let owner = lock.run_exclusive(
            "repo",
            || async {
                entered.send(()).unwrap();
                release_rx.await.unwrap();
            },
            None,
        );
        let waiter = async {
            entered_rx.await.unwrap();
            let work = lock.run_exclusive(
                "repo",
                || async {
                    panic!("cancelled waiter must not acquire the lock");
                },
                Some(&signal),
            );
            tokio::pin!(work);
            assert!(futures::poll!(&mut work).is_pending());
            signal.cancel();
            let result: ExecutorResult<()> = work.await.map_err(Into::into);
            release.send(()).unwrap();
            result
        };
        let (owner, result) = timeout(Duration::from_secs(1), async {
            tokio::join!(owner, waiter)
        })
        .await
        .unwrap();
        owner.unwrap();
        let error = result.unwrap_err();
        assert_eq!(
            diagnostic_error_code(ErrorInput::Error(error.as_ref())),
            "AbortError"
        );
        assert!(is_git_cancellation(error.as_ref()));
        assert_eq!(error.to_string(), "The operation was aborted.");
    }
}
