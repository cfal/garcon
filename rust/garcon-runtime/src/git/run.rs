//! Ports `server/runtime/git/run.ts`.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::future::{Future, pending};
use std::io;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use futures::TryStreamExt;
use garcon_base::bounded_text_stream::{read_text_stream_prefix, read_text_stream_with_limit};
use garcon_base::errors::{DiagnosticError, ErrorMetadata};
use garcon_base::path_boundary::ProjectBoundaryError;
use garcon_interface::resources::ExecutorResult;
use garcon_js::{math_round, path::native, trim};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::time::{Instant, sleep, sleep_until};
use tokio_util::io::ReaderStream;
use tokio_util::sync::CancellationToken;

use super::operation_context::{
    ScopedGitOptions, assert_git_working_path, git_abort_error, git_operation_options,
    is_git_cancellation, mark_git_mutation_dispatched, mark_git_output_truncated,
    track_git_process,
};
use super::types::{GitCommandOptions, GitCommandResult, GitCommandTrace, GitProcessError};

const GIT_LOCK_RETRY_DELAY: Duration = Duration::from_millis(100);
const GIT_LOCK_MAX_RETRIES: usize = 50;
const GIT_DEFAULT_TIMEOUT_MS: f64 = 30_000.0;
const GIT_DEFAULT_MAX_STDOUT_BYTES: usize = 64 * 1024 * 1024;
const GIT_DEFAULT_MAX_STDERR_BYTES: usize = 2 * 1024 * 1024;
#[cfg(unix)]
const GIT_TERMINATION_GRACE: Duration = Duration::from_millis(250);

#[cfg(unix)]
async fn terminate_git_process(pid: u32) -> io::Result<()> {
    use rustix::io::Errno;
    use rustix::process::{Pid, Signal, kill_process_group};
    let pid =
        Pid::from_raw(pid as i32).ok_or_else(|| io::Error::other("invalid Git process group"))?;
    match kill_process_group(pid, Signal::TERM) {
        Ok(()) => {}
        Err(Errno::SRCH) => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    sleep(GIT_TERMINATION_GRACE).await;
    match kill_process_group(pid, Signal::KILL) {
        Ok(()) | Err(Errno::SRCH) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(windows)]
async fn terminate_git_process(pid: u32) -> io::Result<()> {
    Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await?;
    Ok(())
}

pub fn git_command_env(options: &GitCommandOptions) -> Option<BTreeMap<OsString, OsString>> {
    if !options.disable_optional_locks && options.env.is_none() {
        return None;
    }
    let mut env: BTreeMap<_, _> = std::env::vars_os().collect();
    for (name, value) in options.env.iter().flatten() {
        if let Some(value) = value {
            env.insert(name.clone(), value.clone());
        } else {
            env.remove(name);
        }
    }
    if options.disable_optional_locks {
        env.insert("GIT_OPTIONAL_LOCKS".into(), "0".into());
    }
    Some(env)
}

pub fn read_only_git_options(mut options: GitCommandOptions) -> GitCommandOptions {
    options.disable_optional_locks = true;
    options
}

fn apply_environment(command: &mut Command, options: &GitCommandOptions) {
    if let Some(env) = git_command_env(options) {
        command.env_clear().envs(env);
    }
}

fn is_lock_error(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("index.lock") || lower.contains("unable to create") && lower.contains(".lock")
}

pub(super) fn timer_delay(milliseconds: f64) -> Duration {
    if !(1.0..=i32::MAX as f64).contains(&milliseconds) {
        Duration::from_millis(1)
    } else {
        Duration::from_millis(milliseconds as u64)
    }
}

fn budget_duration(milliseconds: f64) -> Duration {
    if milliseconds.is_nan() {
        return Duration::from_millis(1);
    }
    Duration::from_secs_f64((milliseconds / 1000.0).clamp(0.0, 1e9))
}

#[derive(Debug, thiserror::Error)]
#[error("Git {stream} exceeded the {max_bytes} byte limit.")]
pub struct GitOutputLimitError {
    pub stream: &'static str,
    pub max_bytes: usize,
}

impl DiagnosticError for GitOutputLimitError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "GitOutputLimitError",
            code: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum OutputError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Limit(#[from] GitOutputLimitError),
}

#[derive(Default)]
struct Attempt {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn make_git_process_error(
    args: &[String],
    result: Attempt,
    timed_out: Option<bool>,
    aborted: Option<bool>,
) -> GitProcessError {
    let reason = if timed_out == Some(true) {
        "timed out".to_owned()
    } else if aborted == Some(true) {
        "aborted".to_owned()
    } else {
        format!(
            "exit {}",
            result
                .exit_code
                .map_or_else(|| "null".to_owned(), |code| code.to_string())
        )
    };
    let message = [trim(&result.stderr), trim(&result.stdout), &reason]
        .into_iter()
        .find(|message| !message.is_empty())
        .unwrap_or(&reason);
    let verb = args.first().map_or("undefined", String::as_str);
    GitProcessError {
        message: format!("git {verb} failed ({reason}): {message}"),
        code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        timed_out,
        aborted,
    }
}

fn signals_aborted(options: &ScopedGitOptions) -> bool {
    options
        .options
        .signal
        .as_ref()
        .is_some_and(CancellationToken::is_cancelled)
        || options
            .context_signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
}

async fn wait_for_abort(options: &ScopedGitOptions) {
    async fn cancelled(signal: Option<&CancellationToken>) {
        match signal {
            Some(signal) => signal.cancelled().await,
            None => pending().await,
        }
    }
    tokio::select! {
        () = cancelled(options.options.signal.as_ref()) => {}
        () = cancelled(options.context_signal.as_ref()) => {}
    }
}

fn exit_code(status: ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status
            .code()
            .or_else(|| status.signal().map(|signal| 128 + signal))
    }
    #[cfg(windows)]
    {
        status.code()
    }
}

async fn output_attempt(
    child: &mut Child,
    input: Option<&str>,
    options: &ScopedGitOptions,
    deadline: Instant,
) -> ExecutorResult<(Attempt, bool)> {
    let pid = child.id();
    let diagnostic = options.options.truncate_stdout == Some(true);
    let stdout_limit = options.options.max_stdout_bytes.unwrap_or(if diagnostic {
        32768
    } else {
        GIT_DEFAULT_MAX_STDOUT_BYTES
    });
    let stderr_limit = options
        .options
        .max_stderr_bytes
        .unwrap_or(GIT_DEFAULT_MAX_STDERR_BYTES);
    let mut stdout = child
        .stdout
        .take()
        .map(|pipe| ReaderStream::new(pipe).map_err(OutputError::Io));
    let mut stderr = child.stderr.take().map(ReaderStream::new);
    let mut stdin = child.stdin.take();
    let limit_reached = CancellationToken::new();
    let output_limit = RefCell::new(None);
    let capture = async {
        let read_stdout = async {
            let result = if diagnostic {
                read_text_stream_prefix(
                    stdout.as_mut(),
                    stdout_limit,
                    Some(|| {
                        mark_git_output_truncated();
                        Ok(())
                    }),
                )
                .await
            } else {
                read_text_stream_with_limit(stdout.as_mut(), stdout_limit, || {
                    GitOutputLimitError {
                        stream: "stdout",
                        max_bytes: stdout_limit,
                    }
                    .into()
                })
                .await
            };
            match result {
                Ok(text) => text,
                Err(OutputError::Limit(error)) => {
                    *output_limit.borrow_mut() = Some(error);
                    limit_reached.cancel();
                    String::new()
                }
                Err(OutputError::Io(_)) => String::new(),
            }
        };
        let read_stderr = async {
            read_text_stream_prefix(
                stderr.as_mut(),
                stderr_limit,
                None::<fn() -> io::Result<()>>,
            )
            .await
            .unwrap_or_default()
        };
        let write_stdin = async {
            if let (Some(mut stdin), Some(input)) = (stdin.take(), input) {
                let _ = stdin.write_all(input.as_bytes()).await;
                let _ = stdin.shutdown().await;
            }
        };
        let (stdout, stderr, status, ()) =
            tokio::join!(read_stdout, read_stderr, child.wait(), write_stdin);
        Ok::<_, io::Error>(Attempt {
            stdout,
            stderr,
            exit_code: exit_code(status?),
        })
    };
    tokio::pin!(capture);
    let (result, mut timed_out) = tokio::select! {
        biased;
        () = limit_reached.cancelled() => (None, false),
        () = wait_for_abort(options) => (None, false),
        () = sleep_until(deadline) => (None, true),
        result = &mut capture => (Some(result), false),
    };
    let result = match result {
        Some(result) => {
            let exceeded_limit = output_limit.borrow().is_some();
            if exceeded_limit && let Some(pid) = pid {
                terminate_git_process(pid).await?;
            }
            result?
        }
        None => {
            let terminate = async {
                if let Some(pid) = pid {
                    terminate_git_process(pid).await?;
                }
                Ok::<_, io::Error>(())
            };
            // The deadline remains live while a cancelled process is still exiting.
            let settled = async {
                tokio::select! {
                    result = &mut capture => result,
                    () = sleep_until(deadline), if !timed_out => {
                        timed_out = true;
                        capture.await
                    }
                }
            };
            let (result, termination) = tokio::join!(settled, terminate);
            termination?;
            result?
        }
    };
    if let Some(error) = output_limit.borrow_mut().take() {
        return Err(error.into());
    }
    Ok((result, timed_out))
}

struct RunningAttempt {
    child: Child,
    deadline: Instant,
}

fn start_git_attempt(
    cwd: &str,
    args: &[String],
    options: &ScopedGitOptions,
    deadline: Instant,
    piped_stdin: bool,
) -> ExecutorResult<Option<RunningAttempt>> {
    let now = Instant::now();
    let remaining = deadline.saturating_duration_since(now);
    if remaining.is_zero() {
        return Ok(None);
    }
    let aborted = || make_git_process_error(args, Attempt::default(), Some(false), Some(true));
    if signals_aborted(options) {
        return Err(aborted().into());
    }
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .args(args)
        .stdin(if piped_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    apply_environment(&mut command, &options.options);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(_) if signals_aborted(options) => return Err(aborted().into()),
        Err(error) => return Err(error.into()),
    };
    if !options.options.disable_optional_locks {
        mark_git_mutation_dispatched();
    }
    Ok(Some(RunningAttempt {
        child,
        deadline: now + timer_delay(remaining.as_secs_f64() * 1000.0),
    }))
}

fn run_git_process(
    cwd: String,
    args: Vec<String>,
    options: ScopedGitOptions,
    input: Option<String>,
) -> impl Future<Output = ExecutorResult<GitCommandResult>> {
    let deadline = Instant::now()
        + budget_duration(options.options.timeout_ms.unwrap_or(GIT_DEFAULT_TIMEOUT_MS));
    // Bun dispatches the first subprocess before yielding. In particular, a
    // caller abandoning its reply in the same turn must still see the dispatch.
    let first = start_git_attempt(&cwd, &args, &options, deadline, input.is_some());
    async move {
        let mut next = first;
        let mut last_failure = None;
        for attempt in 0.. {
            let Some(mut active) = next? else {
                return Err(make_git_process_error(
                    &args,
                    last_failure.unwrap_or_default(),
                    Some(true),
                    None,
                )
                .into());
            };
            let (result, timed_out) = output_attempt(
                &mut active.child,
                input.as_deref(),
                &options,
                active.deadline,
            )
            .await?;
            let aborted = timed_out || signals_aborted(&options);
            if result.exit_code == Some(0) && !aborted {
                return Ok(GitCommandResult {
                    stdout: result.stdout,
                    stderr: result.stderr,
                });
            }
            if args.first().is_none_or(|arg| arg != "push")
                && is_lock_error(&result.stderr)
                && attempt < GIT_LOCK_MAX_RETRIES
            {
                sleep(GIT_LOCK_RETRY_DELAY.min(deadline.saturating_duration_since(Instant::now())))
                    .await;
                let aborted = timed_out || signals_aborted(&options);
                if aborted {
                    return Err(make_git_process_error(
                        &args,
                        result,
                        Some(timed_out),
                        Some(aborted),
                    )
                    .into());
                }
                last_failure = Some(result);
                next = start_git_attempt(&cwd, &args, &options, deadline, input.is_some());
                continue;
            }
            return Err(
                make_git_process_error(&args, result, Some(timed_out), Some(aborted)).into(),
            );
        }
        // INFALLIBLE: every iteration returns or advances until the finite retry bound.
        unreachable!()
    }
}

pub fn run_git(
    cwd: &str,
    args: Vec<String>,
    options: GitCommandOptions,
) -> impl Future<Output = ExecutorResult<GitCommandResult>> + use<> {
    run_git_with_input(cwd, args, None, options)
}

pub fn run_git_with_stdin(
    cwd: &str,
    args: Vec<String>,
    input: String,
    options: GitCommandOptions,
) -> impl Future<Output = ExecutorResult<GitCommandResult>> + use<> {
    run_git_with_input(cwd, args, Some(input), options)
}

fn run_git_with_input(
    cwd: &str,
    args: Vec<String>,
    input: Option<String>,
    options: GitCommandOptions,
) -> impl Future<Output = ExecutorResult<GitCommandResult>> + use<> {
    let cwd = cwd.to_owned();
    let command =
        git_operation_options(options).map(|options| run_git_process(cwd, args, options, input));
    track_git_process(async move { command?.await })
}

pub async fn run_git_traced(
    cwd: &str,
    args: Vec<String>,
    trace: Option<&mut Vec<GitCommandTrace>>,
    options: GitCommandOptions,
) -> ExecutorResult<GitCommandResult> {
    let started = Instant::now();
    let result = run_git(cwd, args.clone(), options).await;
    if let Some(trace) = trace {
        let failure = result
            .as_ref()
            .err()
            .and_then(|error| error.downcast_ref::<GitProcessError>());
        let (stdout, stderr) = match &result {
            Ok(result) => (&result.stdout[..], &result.stderr[..]),
            Err(_) => failure.map_or(("", ""), |error| (&error.stdout, &error.stderr)),
        };
        trace.push(GitCommandTrace {
            args,
            duration_ms: math_round(started.elapsed().as_secs_f64() * 1000.0) as u64,
            stdout_bytes: stdout.len(),
            stderr_bytes: stderr.len(),
            failed: result.is_err().then_some(true),
            exit_code: failure.and_then(|error| error.code),
            timed_out: failure.and_then(|error| error.timed_out.filter(|value| *value)),
            aborted: failure.and_then(|error| error.aborted.filter(|value| *value)),
        });
    }
    result
}

pub fn read_git_blob_prefix(
    cwd: &str,
    object: &str,
    signal: Option<CancellationToken>,
) -> impl Future<Output = ExecutorResult<Vec<u8>>> + use<> {
    let cwd = cwd.to_owned();
    let object = object.to_owned();
    let options = git_operation_options(read_only_git_options(GitCommandOptions {
        signal,
        ..Default::default()
    }));
    track_git_process(async move {
        let options = options?;
        if signals_aborted(&options) {
            return Err(git_abort_error("The operation was aborted").into());
        }
        let mut command = Command::new("git");
        command
            .current_dir(cwd)
            .args(["show", &object])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        apply_environment(&mut command, &options.options);
        let mut child = command.spawn()?;
        let mut prefix = Vec::new();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Git pipe was not opened"))?;
        let result = {
            let mut stdout = stdout.take(8192);
            let read = stdout.read_to_end(&mut prefix);
            tokio::pin!(read);
            let result = tokio::select! {
                result = &mut read => Some(result),
                () = wait_for_abort(&options) => None,
                () = sleep(timer_delay(options.options.timeout_ms.unwrap_or(GIT_DEFAULT_TIMEOUT_MS))) => None,
            };
            signal_blob(&mut child)?;
            // Bun's spawn signal stops the process, but its stdout still returns any prefix.
            match result {
                Some(result) => result,
                None => read.await,
            }
        };
        child.wait().await?;
        result?;
        Ok(prefix)
    })
}

#[cfg(unix)]
fn signal_blob(child: &mut Child) -> io::Result<()> {
    use rustix::io::Errno;
    use rustix::process::{Pid, Signal, kill_process};

    if let Some(pid) = child.id().and_then(|pid| Pid::from_raw(pid as i32)) {
        match kill_process(pid, Signal::TERM) {
            Ok(()) | Err(Errno::SRCH) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn signal_blob(child: &mut Child) -> io::Result<()> {
    child.start_kill()
}

pub async fn is_binary_file(file_path: &str) -> bool {
    let result: ExecutorResult<_> = async {
        assert_git_working_path(file_path).await?;
        let mut handle = tokio::fs::File::open(file_path).await?;
        let mut prefix = Vec::new();
        (&mut handle).take(8192).read_to_end(&mut prefix).await?;
        Ok(prefix.contains(&0))
    }
    .await;
    result.unwrap_or(false)
}

pub fn strip_diff_headers(diff: &str) -> &str {
    if diff.starts_with("@@") {
        return diff;
    }
    let Some(position) = garcon_js::utf16::index_of(diff, "\n@@") else {
        return diff;
    };
    garcon_js::utf16::slice(diff, position as isize + 1, None)
}

pub async fn assert_git_repository(
    project_path: &str,
    signal: Option<CancellationToken>,
) -> ExecutorResult<()> {
    if !directory_accessible(project_path).await {
        return Err(format!("Unable to access project directory: {project_path}").into());
    }
    let result = run_git(
        project_path,
        vec!["rev-parse".into(), "--is-inside-work-tree".into()],
        read_only_git_options(GitCommandOptions {
            signal: signal.clone(),
            ..Default::default()
        }),
    )
    .await;
    let result = match result {
        Ok(result) => result,
        Err(error) if signal.as_ref().is_some_and(CancellationToken::is_cancelled)
            || is_git_cancellation(error.as_ref()) => return Err(error),
        Err(_) => return Err("Git is not initialized in this directory. Initialize a repository with \"git init\" before using source control actions.".into()),
    };
    if trim(&result.stdout) != "true" {
        return Err("The target path exists but is not inside a Git working tree.".into());
    }
    Ok(())
}

async fn directory_accessible(path: &str) -> bool {
    #[cfg(unix)]
    {
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || rustix::fs::access(path, rustix::fs::Access::EXISTS))
            .await
            .is_ok_and(|result| result.is_ok())
    }
    #[cfg(windows)]
    {
        tokio::fs::metadata(path).await.is_ok()
    }
}

pub fn resolve_path_within_project(project_path: &str, file: &str) -> ExecutorResult<String> {
    let cwd = if cfg!(unix) && native::is_absolute(project_path) {
        native::SEP.to_owned()
    } else {
        std::env::current_dir()?.to_string_lossy().into_owned()
    };
    let root = native::resolve(&cwd, &[project_path]);
    let resolved = native::resolve(&root, &[file]);
    if resolved != root
        && !resolved
            .strip_prefix(&root)
            .is_some_and(|tail| tail.starts_with(native::SEP))
    {
        return Err(ProjectBoundaryError {
            message: "The requested file path resolves outside the project root.".to_owned(),
        }
        .into());
    }
    Ok(resolved)
}
