//! GitHub CLI child process supervision.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::future::{Future, pending};
use std::io;
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::sync::LazyLock;
use std::time::Duration;

use futures::TryStreamExt;
use garcon_base::bounded_text_stream::{read_text_stream_prefix, read_text_stream_with_limit};
use garcon_base::errors::{DiagnosticError, ErrorMetadata};
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode as Code};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{json, trim};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::time::{Instant, sleep_until};
use tokio_util::io::ReaderStream;
use tokio_util::sync::CancellationToken;

use crate::cancellation::check_cancelled;
use crate::git::operation_context::{
    ScopedGitOptions, git_operation_options, mark_git_mutation_dispatched, track_git_process,
};
use crate::git::types::GitCommandOptions;

use super::gh_types::{GhCommandOptions, GhCommandResult, GhProcessError};

const GH_DEFAULT_TIMEOUT_MS: f64 = 30_000.0;
const GH_DEFAULT_MAX_STDOUT_BYTES: usize = 64 * 1024 * 1024;
const GH_DEFAULT_MAX_STDERR_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
#[error("GitHub CLI {stream} exceeded the {max_bytes} byte limit.")]
pub struct GhOutputLimitError {
    pub stream: &'static str,
    pub max_bytes: usize,
}

impl DiagnosticError for GhOutputLimitError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "GhOutputLimitError",
            code: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum OutputError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Limit(GhOutputLimitError),
}

fn environment(options: &GitCommandOptions) -> BTreeMap<OsString, OsString> {
    let mut env: BTreeMap<_, _> = options.base_environment.as_ref().map_or_else(
        || std::env::vars_os().collect(),
        |base| base.iter().cloned().collect(),
    );
    for (key, value) in options.env.iter().flatten() {
        if let Some(value) = value {
            env.insert(key.clone(), value.clone());
        } else {
            env.remove(key);
        }
    }
    env
}

fn gh_on_command_path(cwd: &str, env: &BTreeMap<OsString, OsString>) -> bool {
    let path = env
        .iter()
        .find_map(|(key, value)| {
            let name = key.as_encoded_bytes();
            let is_path = if cfg!(windows) {
                name.eq_ignore_ascii_case(b"PATH")
            } else {
                name == b"PATH"
            };
            is_path.then_some(value)
        })
        .filter(|path| !path.is_empty());
    #[cfg(unix)]
    let default = OsString::from("/usr/bin:/bin");
    #[cfg(windows)]
    let default = OsString::new();
    std::env::split_paths(path.unwrap_or(&default))
        .filter(|directory| !directory.as_os_str().is_empty())
        .any(|directory| {
            let directory = Path::new(cwd).join(directory);
            #[cfg(unix)]
            {
                let candidate = directory.join("gh");
                candidate.is_file()
                    && rustix::fs::access(candidate, rustix::fs::Access::EXEC_OK).is_ok()
            }
            #[cfg(windows)]
            {
                ["gh.exe", "gh.com", "gh.cmd", "gh.bat"]
                    .iter()
                    .any(|name| directory.join(name).is_file())
            }
        })
}

fn spawn_error(
    cwd: &str,
    env: &BTreeMap<OsString, OsString>,
    error: io::Error,
) -> Box<dyn std::error::Error> {
    if gh_on_command_path(cwd, env) {
        return error.into();
    }
    GhProcessError {
        message: "GitHub CLI (gh) is not installed or not on PATH.".into(),
        stderr: "Executable not found in $PATH: \"gh\"".into(),
        stdout: String::new(),
        code: None,
        timed_out: false,
        aborted: false,
    }
    .into()
}

fn terminate(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child
        .id()
        .and_then(|pid| rustix::process::Pid::from_raw(pid as i32))
    {
        let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
    }
    #[cfg(windows)]
    let _ = child.start_kill();
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
    status.code()
}

async fn cancelled(signal: Option<&CancellationToken>) {
    match signal {
        Some(signal) => signal.cancelled().await,
        None => pending().await,
    }
}

async fn read_and_wait(
    mut child: Child,
    args: Vec<String>,
    scoped: ScopedGitOptions,
    stdin: Option<String>,
    deadline: Instant,
) -> ExecutorResult<GhCommandResult> {
    let ScopedGitOptions {
        options,
        context_signal,
    } = scoped;
    let timeout = sleep_until(deadline);
    let stdout = child
        .stdout
        .take()
        .map(|pipe| ReaderStream::new(pipe).map_err(OutputError::Io));
    let mut stderr = child.stderr.take().map(ReaderStream::new);
    let mut input = child.stdin.take();
    let write_input = async move {
        if let (Some(pipe), Some(input)) = (input.as_mut(), stdin) {
            let _ = pipe.write_all(input.as_bytes()).await;
        }
    };
    let stdout_limit = options
        .max_stdout_bytes
        .unwrap_or(GH_DEFAULT_MAX_STDOUT_BYTES);
    let stderr_limit = options
        .max_stderr_bytes
        .unwrap_or(GH_DEFAULT_MAX_STDERR_BYTES);
    let read_stdout = async move {
        let mut stdout = stdout;
        read_text_stream_with_limit(stdout.as_mut(), stdout_limit, || {
            OutputError::Limit(GhOutputLimitError {
                stream: "stdout",
                max_bytes: stdout_limit,
            })
        })
        .await
    };
    let read_stderr = read_text_stream_prefix(stderr.as_mut(), stderr_limit, None::<fn() -> _>);
    let caller_abort = async {
        tokio::select! {
            () = cancelled(options.signal.as_ref()) => (),
            () = cancelled(context_signal.as_ref()) => (),
        }
    };
    tokio::pin!(write_input, read_stdout, read_stderr, timeout, caller_abort);
    let (mut stdout, mut stderr, mut status, mut limit) = (None, None, None, None);
    let (mut written, mut timed_out, mut aborted) = (false, false, false);
    while stdout.is_none() || stderr.is_none() || status.is_none() {
        tokio::select! {
            biased;
            () = &mut timeout, if !timed_out => {
                timed_out = true;
                terminate(&mut child);
            }
            () = &mut caller_abort, if !aborted => {
                aborted = true;
                terminate(&mut child);
            }
            result = &mut read_stdout, if stdout.is_none() => {
                stdout = Some(match result {
                    Ok(stdout) => stdout,
                    Err(OutputError::Io(_)) => String::new(),
                    Err(OutputError::Limit(error)) => {
                        limit = Some(error);
                        terminate(&mut child);
                        String::new()
                    }
                });
            }
            result = &mut read_stderr, if stderr.is_none() => stderr = Some(result.unwrap_or_default()),
            result = child.wait(), if status.is_none() => status = Some(result?),
            () = &mut write_input, if !written => written = true,
        }
    }
    if let Some(error) = limit {
        return Err(error.into());
    }
    let stdout = stdout.unwrap_or_default();
    let stderr = stderr.unwrap_or_default();
    let code = status.and_then(exit_code);
    if code == Some(0) {
        return Ok(GhCommandResult { stdout, stderr });
    }
    let reason = if timed_out {
        "timed out".into()
    } else if aborted {
        "aborted".into()
    } else {
        code.map_or_else(|| "exit null".into(), |code| format!("exit {code}"))
    };
    let detail = [trim(&stderr), trim(&stdout)]
        .into_iter()
        .find(|text| !text.is_empty())
        .unwrap_or(&reason);
    Err(GhProcessError {
        message: format!(
            "gh {} failed ({reason}): {detail}",
            args.first().map_or("", String::as_str)
        ),
        code,
        stdout,
        stderr,
        timed_out,
        aborted,
    }
    .into())
}

fn start_gh(
    cwd: &str,
    args: Vec<String>,
    options: GhCommandOptions,
    dispatched: fn(),
) -> ExecutorResult<impl Future<Output = ExecutorResult<GhCommandResult>> + use<>> {
    let scoped = git_operation_options(GitCommandOptions {
        timeout_ms: options.timeout_ms,
        signal: options.signal,
        max_stdout_bytes: options.max_stdout_bytes,
        max_stderr_bytes: options.max_stderr_bytes,
        disable_optional_locks: true,
        base_environment: options.base_environment,
        env: options.env,
        ..Default::default()
    })?;
    check_cancelled(scoped.options.signal.as_ref())?;
    check_cancelled(scoped.context_signal.as_ref())?;
    let timeout = scoped.options.timeout_ms.unwrap_or(GH_DEFAULT_TIMEOUT_MS);
    let deadline = Instant::now() + Duration::from_millis(timeout as u64);
    let environment = environment(&scoped.options);
    // Bun spawns before yielding and signals only the direct child.
    let child = Command::new("gh")
        .args(&args)
        .current_dir(cwd)
        .env_clear()
        .envs(&environment)
        .stdin(if options.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| spawn_error(cwd, &environment, error))?;
    dispatched();
    Ok(read_and_wait(child, args, scoped, options.stdin, deadline))
}

pub fn run_gh(
    cwd: &str,
    args: Vec<String>,
    options: GhCommandOptions,
) -> impl Future<Output = ExecutorResult<GhCommandResult>> + use<> {
    let command = start_gh(cwd, args, options, || {});
    track_git_process(async move { command?.await })
}

static HTTP_REJECTION: LazyLock<regress::Regex> = LazyLock::new(|| {
    // INFALLIBLE: this is the original's fixed stderr line pattern.
    regress::Regex::with_flags(r"^gh: [^\r\n]*\(HTTP (4\d{2})\)\s*$", "m")
        .expect("valid HTTP rejection pattern")
});

fn is_definite_http_rejection(error: &(dyn std::error::Error + 'static)) -> bool {
    error.downcast_ref::<GhProcessError>().is_some_and(|error| {
        !error.timed_out
            && !error.aborted
            && HTTP_REJECTION
                .find(&error.stderr)
                .and_then(|matched| matched.group(1))
                .is_some_and(|range| &error.stderr[range] != "408")
    })
}

pub fn run_gh_mutation(
    cwd: &str,
    args: Vec<String>,
    options: GhCommandOptions,
) -> impl Future<Output = ExecutorResult<GhCommandResult>> + use<> {
    let command = start_gh(cwd, args, options, mark_git_mutation_dispatched);
    track_git_process(async move {
        let command = command
            .map_err(|error| GitServiceError::new(Code::GH_MUTATION_REJECTED, error.to_string()))?;
        command.await.map_err(|error| {
            if is_definite_http_rejection(error.as_ref()) {
                GitServiceError::new(Code::GH_MUTATION_REJECTED, error.to_string()).into()
            } else {
                GitServiceError::new(Code::GIT_MUTATION_OUTCOME_UNKNOWN,
                    "GitHub did not confirm the mutation after dispatch. Check its outcome before trying again.",
                ).into()
            }
        })
    })
}

pub fn parse_gh_json(stdout: &str, command: &str) -> ExecutorResult<Value> {
    json::from_str(stdout)
        .map_err(|_| format!("gh {command} returned malformed JSON output.").into())
}

pub async fn run_gh_json(
    cwd: &str,
    args: Vec<String>,
    options: GhCommandOptions,
) -> ExecutorResult<Value> {
    let command = args.first().cloned().unwrap_or_default();
    let result = run_gh(cwd, args, options).await?;
    parse_gh_json(&result.stdout, &command)
}

pub async fn assert_accessible_directory(project: &str) -> ExecutorResult<()> {
    tokio::fs::metadata(project)
        .await
        .map_err(|_| format!("Unable to access project directory: {project}"))?;
    Ok(())
}
