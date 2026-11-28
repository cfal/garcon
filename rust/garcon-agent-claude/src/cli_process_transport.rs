use std::{
    cell::{Cell, RefCell},
    ffi::OsString,
    io,
    path::PathBuf,
    pin::Pin,
    process::Stdio,
    rc::Rc,
    time::Duration,
};

use futures::future::{FutureExt, LocalBoxFuture, Shared};
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use garcon_js::{
    json::{self, Opaque},
    trim,
};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::Command,
    sync::{mpsc, oneshot},
};

pub const MAX_STDOUT_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_STDERR_TAIL_BYTES: usize = 16 * 1024;
pub const PROCESS_EXIT_GRACE: Duration = Duration::from_secs(5);
pub const PROCESS_EXIT_TERM: Duration = Duration::from_secs(5);
pub const PROCESS_EXIT_KILL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeTransportFailureKind {
    Stdout,
    Stderr,
    Write,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClaudeTransportFailure {
    pub kind: ClaudeTransportFailureKind,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProcessExit {
    pub exit_code: i32,
    pub stderr_bytes: usize,
    pub stderr_lines: usize,
    pub stderr_retained_bytes: usize,
    pub stderr_tail_digest: Option<String>,
    pub stderr_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StderrSummary {
    pub bytes: usize,
    pub lines: usize,
    pub retained_bytes: usize,
    pub tail_digest: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum ClaudeProcessSignal {
    Term,
    Kill,
}

pub type ClaudeExitStatus = Shared<LocalBoxFuture<'static, Result<i32, String>>>;
pub type Retirement = Shared<LocalBoxFuture<'static, Result<(), String>>>;
pub type ProcessInput = Pin<Box<dyn AsyncWrite>>;
pub type ProcessOutput = Pin<Box<dyn AsyncRead>>;
pub type KillProcess = dyn Fn(ClaudeProcessSignal) -> io::Result<()>;

pub struct ClaudeSubprocess {
    pub stdin: Option<ProcessInput>,
    pub stdout: Option<ProcessOutput>,
    pub stderr: Option<ProcessOutput>,
    pub exited: LocalBoxFuture<'static, Result<i32, String>>,
    pub pid: Option<u32>,
    pub kill: Rc<KillProcess>,
}

pub struct ClaudeProcessOptions {
    pub executable: OsString,
    pub arguments: Vec<OsString>,
    pub cwd: PathBuf,
    pub environment: IndexMap<OsString, OsString>,
}

pub fn spawn_claude_subprocess(options: ClaudeProcessOptions) -> io::Result<ClaudeSubprocess> {
    spawn_claude_subprocess_with_stdin(options, Stdio::piped())
}

pub(crate) fn spawn_claude_subprocess_with_stdin(
    options: ClaudeProcessOptions,
    stdin: Stdio,
) -> io::Result<ClaudeSubprocess> {
    let mut child = Command::new(options.executable)
        .args(options.arguments)
        .current_dir(options.cwd)
        .env_clear()
        .envs(options.environment)
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .map(|input| Box::pin(input) as ProcessInput);
    let stdout = child
        .stdout
        .take()
        .map(|output| Box::pin(output) as ProcessOutput);
    let stderr = child
        .stderr
        .take()
        .map(|output| Box::pin(output) as ProcessOutput);
    #[cfg(unix)]
    let (kill, exited) = {
        use std::os::unix::process::ExitStatusExt;
        let running_pid = Rc::new(Cell::new(pid.and_then(|id| i32::try_from(id).ok())));
        let kill_pid = running_pid.clone();
        let kill: Rc<KillProcess> = Rc::new(move |signal| {
            let Some(pid) = kill_pid.get() else {
                return Ok(());
            };
            let signal = match signal {
                ClaudeProcessSignal::Term => libc::SIGTERM,
                ClaudeProcessSignal::Kill => libc::SIGKILL,
            };
            // SAFETY: Waiting on this child clears its PID before another task can signal it.
            let result = unsafe { libc::kill(pid, signal) };
            if result == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
        let exited: LocalBoxFuture<'static, _> = Box::pin(async move {
            let result = child.wait().await;
            running_pid.take();
            let status = result.map_err(|error| error.to_string())?;
            Ok(status
                .code()
                .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)))
        });
        (kill, exited)
    };
    #[cfg(windows)]
    let (kill, exited) = {
        let (send, mut receive) = mpsc::unbounded_channel();
        let kill: Rc<KillProcess> = Rc::new(move |signal| {
            let _ = send.send(signal);
            Ok(())
        });
        let exited: LocalBoxFuture<'static, _> = Box::pin(async move {
            let status = tokio::select! {
                biased;
                exit = child.wait() => exit,
                signal = receive.recv() => {
                    if signal.is_some() { child.start_kill().map_err(|error| error.to_string())?; }
                    child.wait().await
                }
            }
            .map_err(|error| error.to_string())?;
            Ok(status.code().unwrap_or(1))
        });
        (kill, exited)
    };
    Ok(ClaudeSubprocess {
        stdin,
        stdout,
        stderr,
        exited,
        pid,
        kill,
    })
}

pub struct ClaudeProcessTransportOptions {
    pub process: ClaudeSubprocess,
    pub logger: Rc<dyn AgentLogger>,
    pub session_id: String,
    pub on_message: Rc<dyn Fn(Opaque)>,
    pub on_failure: Rc<dyn Fn(ClaudeTransportFailure)>,
    pub on_eof: Rc<dyn Fn()>,
    pub on_exit: Rc<dyn Fn(ClaudeProcessExit)>,
    pub max_stdout_frame_bytes: Option<usize>,
}

#[derive(Default)]
pub struct ClaudeWriteLineOptions {
    pub before_write: Option<Box<dyn FnOnce() -> ExecutorResult<()>>>,
    pub attempt_timeout: Option<Duration>,
    pub kill_process_after_attempt_failure: bool,
}

enum WriteCommand {
    Write {
        frame: String,
        options: ClaudeWriteLineOptions,
        result: oneshot::Sender<ExecutorResult<()>>,
    },
    End,
}

struct Inner {
    writer: mpsc::UnboundedSender<WriteCommand>,
    exited: ClaudeExitStatus,
    kill: Rc<KillProcess>,
    pid: Option<u32>,
    killed: Cell<bool>,
    logger: Rc<dyn AgentLogger>,
    session_id: String,
    on_failure: Rc<dyn Fn(ClaudeTransportFailure)>,
    retirement: RefCell<Option<Retirement>>,
    retiring: Cell<bool>,
    failure_reported: Cell<bool>,
    stdout_noise_count: Cell<usize>,
    stderr: RefCell<StderrTail>,
}

#[derive(Clone)]
pub struct ClaudeProcessTransport(Rc<Inner>);

impl ClaudeProcessTransport {
    pub fn new(options: ClaudeProcessTransportOptions) -> Self {
        let ClaudeSubprocess {
            stdin,
            stdout,
            stderr,
            exited,
            pid,
            kill,
        } = options.process;
        let (writer, writes) = mpsc::unbounded_channel();
        let exit = exited.shared();
        let inner = Rc::new(Inner {
            writer,
            exited: exit.clone(),
            kill,
            pid,
            killed: Cell::default(),
            logger: options.logger,
            session_id: options.session_id,
            on_failure: options.on_failure,
            retirement: RefCell::default(),
            retiring: Cell::default(),
            failure_reported: Cell::default(),
            stdout_noise_count: Cell::default(),
            stderr: RefCell::default(),
        });
        tokio::task::spawn_local(run_writer(Rc::downgrade(&inner), stdin, writes));
        if let Some(stdout) = stdout {
            let inner = inner.clone();
            let max_bytes = options
                .max_stdout_frame_bytes
                .unwrap_or(MAX_STDOUT_FRAME_BYTES);
            tokio::task::spawn_local(async move {
                let result = read_bounded_stdout(
                    stdout,
                    options.on_message.as_ref(),
                    || inner.record_stdout_noise(),
                    max_bytes,
                )
                .await;
                match result {
                    Ok(())
                        if !inner.retiring.get()
                            && !wait_for_exit(inner.exited.clone(), Duration::ZERO).await =>
                    {
                        (options.on_eof)()
                    }
                    Err(error) if !inner.retiring.get() => {
                        inner.report_failure(ClaudeTransportFailureKind::Stdout, error.to_string())
                    }
                    _ => {}
                }
            });
        }
        let stderr_reader = stderr.map(|stderr| {
            let inner = inner.clone();
            tokio::task::spawn_local(async move {
                if let Err(error) =
                    drain_stderr(stderr, |text| inner.stderr.borrow_mut().record(text)).await
                    && !inner.retiring.get()
                {
                    inner.report_failure(ClaudeTransportFailureKind::Stderr, error.to_string());
                }
            })
        });
        let process = inner.clone();
        tokio::task::spawn_local(async move {
            match exit.await {
                Ok(exit_code) => {
                    if let Some(reader) = stderr_reader {
                        let _ = reader.await;
                    }
                    let summary = process.stderr.borrow().summary();
                    (options.on_exit)(ClaudeProcessExit {
                        exit_code,
                        stderr_bytes: summary.bytes,
                        stderr_lines: summary.lines,
                        stderr_retained_bytes: summary.retained_bytes,
                        stderr_tail_digest: summary.tail_digest,
                        stderr_truncated: summary.truncated,
                    });
                }
                Err(error) => process.report_failure(
                    ClaudeTransportFailureKind::Stdout,
                    format!("Claude CLI exit status failed: {error}"),
                ),
            }
        });
        Self(inner)
    }

    pub fn pid(&self) -> Option<u32> {
        self.0.pid
    }
    pub fn exited(&self) -> ClaudeExitStatus {
        self.0.exited.clone()
    }
    pub fn killed(&self) -> bool {
        self.0.killed.get()
    }
    pub fn kill(&self, signal: ClaudeProcessSignal) -> io::Result<()> {
        self.0.kill(signal)
    }
    pub fn stderr_summary(&self) -> StderrSummary {
        self.0.stderr.borrow().summary()
    }

    pub fn write_line(
        &self,
        jsonl: String,
        options: ClaudeWriteLineOptions,
    ) -> LocalBoxFuture<'static, ExecutorResult<()>> {
        let (result, completed) = oneshot::channel();
        if self
            .0
            .writer
            .send(WriteCommand::Write {
                frame: jsonl,
                options,
                result,
            })
            .is_err()
        {
            let error = "Claude CLI process is not writable";
            self.0
                .report_failure(ClaudeTransportFailureKind::Write, error.to_owned());
            return Box::pin(async move { Err(error.into()) });
        }
        Box::pin(async move { completed.await? })
    }

    pub fn retire(&self) -> Retirement {
        if let Some(retirement) = self.0.retirement.borrow().as_ref() {
            return retirement.clone();
        }
        self.0.retiring.set(true);
        let _ = self.0.writer.send(WriteCommand::End);
        let process = self.0.clone();
        let retirement = async move { process.retire().await }.boxed_local().shared();
        self.0.retirement.replace(Some(retirement.clone()));
        let retirement_task = retirement.clone();
        tokio::task::spawn_local(async move {
            let _ = retirement_task.await;
        });
        retirement
    }
}

impl Inner {
    fn kill(&self, signal: ClaudeProcessSignal) -> io::Result<()> {
        (self.kill)(signal)?;
        self.killed.set(true);
        Ok(())
    }

    fn report_failure(&self, kind: ClaudeTransportFailureKind, message: String) {
        if !self.failure_reported.replace(true) {
            (self.on_failure)(ClaudeTransportFailure { kind, message });
        }
    }

    fn record_stdout_noise(&self) {
        let occurrence = self.stdout_noise_count.get() + 1;
        self.stdout_noise_count.set(occurrence);
        if occurrence > 3 {
            return;
        }
        let session_id =
            String::from_utf16_lossy(&self.session_id.encode_utf16().take(8).collect::<Vec<_>>());
        let fields = IndexMap::from([
            (
                "sessionId".to_owned(),
                Opaque::from_value(json!(session_id)),
            ),
            ("processId".to_owned(), Opaque::from_value(json!(self.pid))),
            (
                "occurrence".to_owned(),
                Opaque::from_value(json!(occurrence)),
            ),
        ]);
        self.logger
            .warn("Claude CLI emitted non-JSON stdout", Some(&fields));
    }

    async fn retire(&self) -> Result<(), String> {
        if wait_for_exit(self.exited.clone(), PROCESS_EXIT_GRACE).await {
            return Ok(());
        }
        if !self.killed.get() {
            self.kill(ClaudeProcessSignal::Term)
                .map_err(|error| error.to_string())?;
        }
        if wait_for_exit(self.exited.clone(), PROCESS_EXIT_TERM).await {
            return Ok(());
        }
        self.kill(ClaudeProcessSignal::Kill)
            .map_err(|error| error.to_string())?;
        if wait_for_exit(self.exited.clone(), PROCESS_EXIT_KILL).await {
            return Ok(());
        }
        Err("Claude process did not exit after SIGKILL".to_owned())
    }
}

pub(crate) async fn wait_for_exit(exited: ClaudeExitStatus, duration: Duration) -> bool {
    tokio::select! {
        biased;
        _ = exited => true,
        () = tokio::time::sleep(duration) => false,
    }
}

async fn run_writer(
    inner: std::rc::Weak<Inner>,
    mut stdin: Option<ProcessInput>,
    mut writes: mpsc::UnboundedReceiver<WriteCommand>,
) {
    while let Some(write) = writes.recv().await {
        let Some(process) = inner.upgrade() else {
            return;
        };
        match write {
            WriteCommand::End => {
                if let Some(mut input) = stdin.take() {
                    let _ = input.shutdown().await;
                }
            }
            WriteCommand::Write {
                frame,
                options,
                result,
            } => {
                let mut attempt_began = false;
                let kill_after_failure = options.kill_process_after_attempt_failure;
                let written: ExecutorResult<()> = async {
                    if process.retiring.get() || process.killed.get() {
                        return Err("Claude CLI process is not writable".into());
                    }
                    let input = stdin
                        .as_mut()
                        .ok_or("Claude CLI process has no writable stdin")?;
                    if let Some(before_write) = options.before_write {
                        before_write()?;
                    }
                    attempt_began = true;
                    let write = async {
                        input.write_all(format!("{frame}\n").as_bytes()).await?;
                        input.flush().await
                    };
                    if let Some(timeout) = options.attempt_timeout {
                        tokio::time::timeout(timeout, write)
                            .await
                            .map_err(|_| "Claude CLI stdin write timed out")??;
                    } else {
                        write.await?;
                    }
                    Ok(())
                }
                .await;
                if let Err(error) = &written {
                    if kill_after_failure
                        && attempt_began
                        && !process.killed.get()
                        && let Err(error) = process.kill(ClaudeProcessSignal::Term)
                    {
                        let _ = result.send(Err(error.into()));
                        continue;
                    }
                    process.report_failure(ClaudeTransportFailureKind::Write, error.to_string());
                }
                let _ = result.send(written);
            }
        }
    }
}

async fn read_bounded_stdout(
    mut stream: ProcessOutput,
    on_message: &dyn Fn(Opaque),
    on_noise: impl Fn(),
    max_frame_bytes: usize,
) -> ExecutorResult<()> {
    let mut decoder = TextDecoder::default();
    let mut bytes = [0; 8192];
    let mut line = String::new();
    loop {
        let read = stream.read(&mut bytes).await?;
        let text = decoder.decode(&bytes[..read], read == 0);
        for chunk in text.split_inclusive('\n') {
            if let Some(chunk) = chunk.strip_suffix('\n') {
                line.push_str(chunk);
                handle_stdout_line(&line, on_message, &on_noise, max_frame_bytes)?;
                line.clear();
            } else {
                line.push_str(chunk);
            }
        }
        if read == 0 {
            if !trim(&line).is_empty() {
                handle_stdout_line(&line, on_message, &on_noise, max_frame_bytes)?;
            }
            return Ok(());
        }
        if line.len() > max_frame_bytes {
            return Err("Claude CLI emitted an oversized JSON frame".into());
        }
    }
}

fn handle_stdout_line(
    line: &str,
    on_message: &dyn Fn(Opaque),
    on_noise: &dyn Fn(),
    max_frame_bytes: usize,
) -> ExecutorResult<()> {
    if line.len() > max_frame_bytes {
        return Err("Claude CLI emitted an oversized JSON frame".into());
    }
    let line = trim(line);
    if line.is_empty() {
        return Ok(());
    }
    match json::from_str::<Value>(line) {
        Ok(value) if truthy(&value) => on_message(value.into()),
        Err(_) if line.starts_with(['{', '[']) => {
            return Err("Claude CLI emitted malformed JSON".into());
        }
        _ => on_noise(),
    }
    Ok(())
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(text) => !text.is_empty(),
        Value::Number(_) => json::as_number(value).is_some_and(|value| value != 0.0),
        Value::Array(_) | Value::Object(_) => true,
    }
}

async fn drain_stderr(mut stream: ProcessOutput, on_chunk: impl Fn(&str)) -> io::Result<()> {
    let mut decoder = TextDecoder::default();
    let mut bytes = [0; 8192];
    loop {
        let read = stream.read(&mut bytes).await?;
        on_chunk(&decoder.decode(&bytes[..read], read == 0));
        if read == 0 {
            return Ok(());
        }
    }
}

#[derive(Default)]
struct StderrTail {
    tail: String,
    bytes: usize,
    lines: usize,
}

impl StderrTail {
    fn record(&mut self, chunk: &str) {
        self.bytes += chunk.len();
        self.lines += chunk
            .as_bytes()
            .iter()
            .filter(|&&byte| byte == b'\n')
            .count();
        self.tail.push_str(chunk);
        if self.tail.len() > MAX_STDERR_TAIL_BYTES {
            self.tail = String::from_utf8_lossy(
                &self.tail.as_bytes()[self.tail.len() - MAX_STDERR_TAIL_BYTES..],
            )
            .into_owned();
        }
    }

    fn summary(&self) -> StderrSummary {
        let retained_bytes = self.tail.len();
        let tail_digest = (retained_bytes > 0).then(|| {
            let digest = Sha256::digest(self.tail.as_bytes());
            digest[..8]
                .iter()
                .fold(String::with_capacity(16), |mut hex, byte| {
                    use std::fmt::Write;
                    let _ = write!(hex, "{byte:02x}");
                    hex
                })
        });
        StderrSummary {
            bytes: self.bytes,
            lines: self.lines,
            retained_bytes,
            tail_digest,
            truncated: self.bytes > retained_bytes,
        }
    }
}

#[derive(Default)]
struct TextDecoder {
    pending: Vec<u8>,
    started: bool,
}

impl TextDecoder {
    fn decode(&mut self, chunk: &[u8], eof: bool) -> String {
        self.pending.extend_from_slice(chunk);
        let count = if eof {
            self.pending.len()
        } else {
            complete_utf8_prefix(&self.pending)
        };
        let mut text = String::from_utf8_lossy(&self.pending[..count]);
        if !self.started && !text.is_empty() {
            self.started = true;
            if let Some(other) = text.strip_prefix('\u{feff}') {
                text = std::borrow::Cow::Owned(other.to_owned());
            }
        }
        let result = text.into_owned();
        self.pending.drain(..count);
        result
    }
}

fn complete_utf8_prefix(bytes: &[u8]) -> usize {
    let mut cursor = 0;
    while let Err(error) = std::str::from_utf8(&bytes[cursor..]) {
        cursor += error.valid_up_to();
        match error.error_len() {
            Some(length) => cursor += length,
            None => return cursor,
        }
    }
    bytes.len()
}

#[cfg(test)]
mod tests;
