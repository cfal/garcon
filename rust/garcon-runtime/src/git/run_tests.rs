use std::cell::RefCell;
use std::ffi::OsString;
use std::future::Future;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use garcon_base::errors::{DiagnosticError, ErrorInput, diagnostic_error_code};
use garcon_base::path_boundary::ProjectBoundaryError;
use garcon_cases::{CaseError, replay, text};
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode};
use garcon_interface::resources::{ExecutorCallOptions, ExecutorResult};
use serde_json::json;
use tempfile::TempDir;
use tokio::sync::oneshot;
use tokio::task::{LocalSet, spawn_blocking};
use tokio::time::{advance, pause};
use tokio_util::sync::CancellationToken;

use super::operation_context::{
    check_git_cancelled, git_mutation_dispatched, git_output_truncated, is_git_cancellation,
    with_git_operation,
};
use super::run::{
    GitOutputLimitError, assert_git_repository, git_command_env, read_git_blob_prefix,
    read_only_git_options, resolve_path_within_project, run_git, run_git_traced,
    run_git_with_stdin, strip_diff_headers,
};
use super::types::{GitCommandOptions, GitProcessError};

struct FakeGit(TempDir);

impl FakeGit {
    fn new(script: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("git");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self(dir)
    }

    fn cwd(&self) -> &str {
        self.0.path().to_str().unwrap()
    }

    fn options(&self) -> GitCommandOptions {
        let path = std::env::join_paths(std::iter::once(self.0.path().to_owned()).chain(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
        ))
        .unwrap();
        GitCommandOptions {
            timeout_ms: Some(5000.0),
            env: Some([(OsString::from("PATH"), Some(path))].into()),
            ..Default::default()
        }
    }

    async fn await_marker(&self, marker: &str) {
        let path = self.0.path().join(marker);
        spawn_blocking(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while !path.exists() {
                assert!(std::time::Instant::now() < deadline, "missing {path:?}");
                std::thread::sleep(Duration::from_millis(5));
            }
        })
        .await
        .unwrap();
    }

    fn attempts(&self) -> usize {
        std::fs::read_to_string(self.0.path().join("attempts"))
            .unwrap()
            .lines()
            .count()
    }
}

fn args(command: &str) -> Vec<String> {
    vec![command.to_owned()]
}

fn process_error<T: std::fmt::Debug>(result: ExecutorResult<T>) -> GitProcessError {
    *result.unwrap_err().downcast::<GitProcessError>().unwrap()
}

async fn locally<F: Future>(future: F) -> F::Output {
    LocalSet::new().run_until(future).await
}

async fn with_controlled_time<F: Future>(test: F) -> F::Output {
    locally(async {
        let (stop, release) = std::sync::mpsc::channel::<()>();
        let (ready, started) = oneshot::channel();
        let (expired, watchdog) = oneshot::channel();
        // An active blocking task inhibits Tokio's paused-clock auto-advance
        // while the real subprocess is scheduled and its pipes are read.
        let guard = spawn_blocking(move || {
            let _ = ready.send(());
            let _ = release.recv_timeout(Duration::from_secs(10));
            let _ = expired.send(());
        });
        started.await.unwrap();
        pause();
        let result = tokio::select! {
            result = test => result,
            _ = watchdog => panic!("Git did not settle with its simulated clock"),
        };
        drop(stop);
        guard.await.unwrap();
        result
    })
    .await
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum RunnerEvent {
    Retry,
    DeadlineDuringReap,
}

thread_local! {
    static EXPECTED_EVENT: RefCell<Option<(RunnerEvent, oneshot::Sender<()>)>> = const {
        RefCell::new(None)
    };
}

fn next_event(event: RunnerEvent) -> oneshot::Receiver<()> {
    let (sender, receiver) = oneshot::channel();
    assert!(EXPECTED_EVENT.replace(Some((event, sender))).is_none());
    receiver
}

pub(super) fn notify(event: RunnerEvent) {
    let expected = EXPECTED_EVENT.with_borrow(|next| next.as_ref().map(|(event, _)| *event));
    if expected == Some(event)
        && let Some((_, sender)) = EXPECTED_EVENT.take()
    {
        let _ = sender.send(());
    }
}

#[test]
fn recorded_pure_git_runner_operations_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/git/run"),
        |function, args| {
            let required = |argument| {
                text(function, argument)?
                    .ok_or_else(|| CaseError::undeliverable("expected a string argument"))
            };
            match function {
                "stripDiffHeaders" => Ok(json!(strip_diff_headers(required(args.first())?))),
                "readOnlyGitOptions" => {
                    let disable_optional_locks = match args {
                        [] => false,
                        [value] if value.as_object().is_some_and(|map| map.len() == 1) => value
                            .get("disableOptionalLocks")
                            .and_then(serde_json::Value::as_bool)
                            .ok_or_else(|| {
                                CaseError::undeliverable("expected boolean lock flag")
                            })?,
                        _ => return Err(CaseError::undeliverable("unexpected Git options")),
                    };
                    let options = read_only_git_options(GitCommandOptions {
                        disable_optional_locks,
                        ..Default::default()
                    });
                    Ok(json!({ "disableOptionalLocks": options.disable_optional_locks }))
                }
                "resolvePathWithinProject" => {
                    match resolve_path_within_project(
                        required(args.first())?,
                        required(args.get(1))?,
                    ) {
                        Ok(path) => Ok(json!(path)),
                        Err(error) if error.is::<ProjectBoundaryError>() => {
                            Err(CaseError::new("ProjectBoundaryError", error.to_string())
                                .with_property("errorCode", ProjectBoundaryError::ERROR_CODE)
                                .with_property("status", ProjectBoundaryError::STATUS))
                        }
                        Err(error) => Err(CaseError::undeliverable(error.to_string())),
                    }
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}

#[tokio::test]
async fn readonly_git_disables_optional_locks_without_changing_default_environment() {
    assert!(git_command_env(&GitCommandOptions::default()).is_none());
    locally(async {
        let git = FakeGit::new(r#"printf '%s' "${GIT_OPTIONAL_LOCKS-absent}""#);
        let mut options = git.options();
        options
            .env
            .as_mut()
            .unwrap()
            .insert("GIT_OPTIONAL_LOCKS".into(), Some("1".into()));
        options.disable_optional_locks = true;
        assert_eq!(
            run_git(git.cwd(), args("status"), options)
                .await
                .unwrap()
                .stdout,
            "0"
        );
    })
    .await;
}

#[tokio::test]
async fn git_spawns_with_the_explicit_worker_child_environment() {
    locally(async {
        let git = FakeGit::new(
            r#"printf '%s:%s:%s:%s' "$GARCON_CONFIG_DIR" "$GARCON_RUNTIME" "${GARCON_CONTROLLER_URL-unset}" "$GIT_OPTIONAL_LOCKS""#,
        );
        let mut options = git.options();
        options.base_environment = Some(vec![
            ("GARCON_CONFIG_DIR".into(), "/synthetic-config".into()),
            ("GARCON_RUNTIME".into(), "executor".into()),
        ].into());
        let result = run_git(git.cwd(), args("status"), read_only_git_options(options))
            .await.unwrap();
        assert_eq!(result.stdout, "/synthetic-config:executor:unset:0");
    }).await;
}

#[tokio::test]
async fn drains_real_pipes_and_never_retries_a_stdout_overflow() {
    locally(async {
        let git = FakeGit::new(
            r#"echo attempt >> attempts
case "$1" in
    stderr) head -c 4194304 /dev/zero | tr '\000' x >&2 ;;
    *) printf 'fatal: index.lock\n' >&2
       head -c 4194304 /dev/zero | tr '\000' x ;;
esac"#,
        );
        let mut options = git.options();
        options.max_stdout_bytes = Some(1024);
        options.max_stderr_bytes = Some(1024);
        let error = run_git(git.cwd(), args("stdout"), options.clone())
            .await
            .unwrap_err();
        let error = error.downcast_ref::<GitOutputLimitError>().unwrap();
        assert_eq!((error.stream, error.max_bytes), ("stdout", 1024));
        assert_eq!(error.diagnostic_metadata().name, "GitOutputLimitError");
        assert_eq!(
            diagnostic_error_code(ErrorInput::Diagnostic(error)),
            "GitOutputLimitError"
        );
        assert_eq!(git.attempts(), 1);
        let result = run_git(git.cwd(), args("stderr"), options).await.unwrap();
        assert_eq!(result.stdout, "");
        assert_eq!(result.stderr, "x".repeat(1024));
        assert_eq!(git.attempts(), 2);
    })
    .await;
}

#[tokio::test]
async fn stdin_commands_preserve_bytes_and_apply_stdout_limits() {
    locally(async {
        let git = FakeGit::new("cat");
        let output = run_git_with_stdin(git.cwd(), args("apply"), "paths\0".into(), git.options())
            .await
            .unwrap();
        assert_eq!(output.stdout, "paths\0");
        let mut options = git.options();
        options.max_stdout_bytes = Some(5);
        let error = run_git_with_stdin(git.cwd(), args("apply"), "paths\0".into(), options)
            .await
            .unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<GitOutputLimitError>()
                .unwrap()
                .max_bytes,
            5
        );
    })
    .await;
}

#[tokio::test]
async fn distinguishes_preabort_spawn_errors_and_signal_exit_codes() {
    locally(async {
        let git = FakeGit::new("echo attempt >> attempts");
        let signal = CancellationToken::new();
        signal.cancel();
        let mut options = git.options();
        options.signal = Some(signal);
        let error = process_error(run_git(git.cwd(), args("status"), options).await);
        assert_eq!(
            (error.aborted, error.timed_out, error.code),
            (Some(true), Some(false), None)
        );
        assert!(!git.0.path().join("attempts").exists());
        let missing = git.0.path().join("missing");
        let error = run_git(missing.to_str().unwrap(), args("status"), git.options())
            .await
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<io::Error>().unwrap().kind(),
            io::ErrorKind::NotFound
        );

        let git = FakeGit::new("kill -TERM $$");
        let mut trace = Vec::new();
        let error = process_error(
            run_git_traced(git.cwd(), args("status"), Some(&mut trace), git.options()).await,
        );
        assert_eq!(error.code, Some(143));
        assert_eq!(trace[0].exit_code, Some(143));
        assert_eq!((trace[0].timed_out, trace[0].aborted), (None, None));
    })
    .await;
}

const LOCK_FAILURE: &str =
    "echo attempt >> attempts; echo 'fatal: index.lock exists' >&2; exit 128";

#[tokio::test]
async fn budget_expiring_between_attempts_preserves_the_last_lock_failure() {
    with_controlled_time(async {
        let git = FakeGit::new(LOCK_FAILURE);
        let retry = next_event(RunnerEvent::Retry);
        let mut options = git.options();
        options.timeout_ms = Some(60.0);
        let command = run_git(git.cwd(), args("reset"), options);
        retry.await.unwrap();
        advance(Duration::from_millis(61)).await;
        let error = process_error(command.await);
        assert_eq!((error.timed_out, error.code), (Some(true), Some(128)));
        assert_eq!(error.stderr, "fatal: index.lock exists\n");
        assert_eq!(git.attempts(), 1);
    })
    .await;
}

#[tokio::test]
async fn budget_expiring_during_a_retry_reports_that_attempts_empty_stderr() {
    with_controlled_time(async {
        let git = FakeGit::new(&format!(
            r#"if [ -f attempts ]; then
    echo attempt >> attempts
    trap ': > terminated; exit 143' TERM
    : > started
    while :; do sleep 1; done 2>/dev/null
fi
{LOCK_FAILURE}"#
        ));
        let retry = next_event(RunnerEvent::Retry);
        let mut options = git.options();
        options.timeout_ms = Some(450.0);
        let command = run_git(git.cwd(), args("reset"), options);
        retry.await.unwrap();
        advance(Duration::from_millis(300)).await;
        git.await_marker("started").await;
        advance(Duration::from_millis(151)).await;
        git.await_marker("terminated").await;
        advance(Duration::from_millis(251)).await;
        let error = process_error(command.await);
        assert_eq!((error.timed_out, error.code), (Some(true), Some(143)));
        assert_eq!(error.stderr, "");
        assert_eq!(git.attempts(), 2);
    })
    .await;
}

#[tokio::test]
async fn push_is_never_retried_after_a_lock_failure() {
    locally(async {
        let git = FakeGit::new(LOCK_FAILURE);
        let error = process_error(run_git(git.cwd(), args("push"), git.options()).await);
        assert_eq!(error.code, Some(128));
        assert_eq!(error.stderr, "fatal: index.lock exists\n");
        assert_eq!(git.attempts(), 1);
    })
    .await;
}

#[tokio::test]
async fn caller_abort_during_retry_keeps_the_failure_without_spawning_again() {
    with_controlled_time(async {
        let git = FakeGit::new(LOCK_FAILURE);
        let retry = next_event(RunnerEvent::Retry);
        let signal = CancellationToken::new();
        let mut options = git.options();
        options.signal = Some(signal.clone());
        let command = run_git(git.cwd(), args("reset"), options);
        retry.await.unwrap();
        signal.cancel();
        advance(Duration::from_millis(101)).await;
        let failure = process_error(command.await);
        assert_eq!((failure.aborted, failure.code), (Some(true), Some(128)));
        assert_eq!(failure.stderr, "fatal: index.lock exists\n");
        assert_eq!(git.attempts(), 1);
    })
    .await;
}

#[tokio::test]
async fn deadline_keeps_running_while_an_aborted_process_waits_to_be_reaped() {
    with_controlled_time(async {
        let git = FakeGit::new(
            r#"trap ': > terminated' TERM
: > started
while :; do sleep 1; done 2>/dev/null"#,
        );
        let signal = CancellationToken::new();
        let mut options = git.options();
        options.signal = Some(signal.clone());
        options.timeout_ms = Some(180.0);
        let command = run_git(git.cwd(), args("reset"), options);
        git.await_marker("started").await;
        signal.cancel();
        git.await_marker("terminated").await;
        let deadline = next_event(RunnerEvent::DeadlineDuringReap);
        advance(Duration::from_millis(181)).await;
        deadline.await.unwrap();
        advance(Duration::from_millis(70)).await;
        let error = process_error(command.await);
        assert_eq!(
            (error.timed_out, error.aborted, error.code),
            (Some(true), Some(true), Some(137))
        );
    })
    .await;
}

#[tokio::test]
async fn cancellation_does_not_release_the_operation_before_its_process_group_settles() {
    locally(async {
        use rustix::io::Errno;
        use rustix::process::{Pid, test_kill_process};

        // The TERM trap cannot complete before the runner escalates to KILL.
        let git = FakeGit::new(
            r#"trap 'while [ ! -f trap-release ]; do sleep 1; done; echo settled > finished; exit 143' TERM
printf '%s\n' "$$" > started.tmp
mv started.tmp started
while :; do sleep 1; done"#,
        );
        let caller = CancellationToken::new();
        let opts = ExecutorCallOptions {
            signal: Some(caller.clone()),
            ..Default::default()
        };
        let git = &git;
        let result = with_git_operation(git.cwd(), Some(opts), true, |signal| async move {
            // The operation abandons the command's reply, not its ownership of the process.
            drop(run_git(git.cwd(), args("add"), git.options()));
            git.await_marker("started").await;
            caller.cancel();
            signal.cancelled().await;
            check_git_cancelled(&signal)?;
            Ok(())
        })
        .await;
        let error = result.unwrap_err();
        assert_eq!(
            error.downcast_ref::<GitServiceError>().unwrap().code,
            GitServiceErrorCode::GIT_MUTATION_OUTCOME_UNKNOWN
        );
        let pid = tokio::fs::read_to_string(git.0.path().join("started"))
            .await
            .unwrap();
        let pid = Pid::from_raw(pid.trim().parse().unwrap()).unwrap();
        assert_eq!(test_kill_process(pid), Err(Errno::SRCH));
        assert!(!git.0.path().join("finished").exists());
    })
    .await;
}

#[tokio::test]
async fn cancellation_in_the_dispatch_turn_reports_an_unknown_mutation_outcome() {
    locally(async {
        let git = FakeGit::new("exit 0");
        let caller = CancellationToken::new();
        let opts = ExecutorCallOptions {
            signal: Some(caller.clone()),
            ..Default::default()
        };
        let git = &git;
        let result = with_git_operation(git.cwd(), Some(opts), true, |signal| async move {
            drop(run_git(git.cwd(), args("add"), git.options()));
            assert!(git_mutation_dispatched());
            caller.cancel();
            check_git_cancelled(&signal)?;
            Ok(())
        })
        .await;
        let error = result.unwrap_err();
        assert_eq!(
            error.downcast_ref::<GitServiceError>().unwrap().code,
            GitServiceErrorCode::GIT_MUTATION_OUTCOME_UNKNOWN
        );
    })
    .await;
}

#[tokio::test]
async fn scoped_diagnostics_truncate_but_drain_and_preserve_prompt_fences() {
    locally(async {
        let git = FakeGit::new(r#"printf '%s %s' "$GIT_TERMINAL_PROMPT" "$GCM_INTERACTIVE""#);
        with_git_operation(git.cwd(), None, true, |_| async {
            let mut options = git.options();
            options.max_stdout_bytes = Some(4);
            let result = run_git(git.cwd(), args("add"), options).await?;
            assert_eq!(result.stdout, "0 ne");
            assert!(git_output_truncated());
            Ok(())
        })
        .await
        .unwrap();
    })
    .await;
}

#[tokio::test]
async fn repository_probe_keeps_abort_metadata_and_blob_reads_its_bounded_binary_prefix() {
    locally(async {
        let repo = tempfile::tempdir().unwrap();
        let path = repo.path().to_str().unwrap();
        let init = vec!["init".into(), "--quiet".into(), "--template=".into()];
        run_git(path, init, GitCommandOptions::default())
            .await
            .unwrap();
        assert_git_repository(path, None).await.unwrap();
        let signal = CancellationToken::new();
        signal.cancel();
        let cancelled = process_error(assert_git_repository(path, Some(signal.clone())).await);
        assert_eq!(
            (cancelled.aborted, cancelled.timed_out),
            (Some(true), Some(false))
        );
        let cancelled = read_git_blob_prefix(path, "unused", Some(signal))
            .await
            .unwrap_err();
        assert!(is_git_cancellation(cancelled.as_ref()));
        assert_eq!(cancelled.to_string(), "The operation was aborted");
        let content = format!("prefix\0{}", "x".repeat(16384));
        let result = run_git_with_stdin(
            path,
            vec!["hash-object".into(), "-w".into(), "--stdin".into()],
            content.clone(),
            GitCommandOptions::default(),
        )
        .await
        .unwrap();
        let prefix = read_git_blob_prefix(path, result.stdout.trim(), None)
            .await
            .unwrap();
        assert_eq!(prefix, content.as_bytes()[..8192]);
    })
    .await;
}
