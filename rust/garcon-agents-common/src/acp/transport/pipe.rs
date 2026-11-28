//! The process `defaultSpawn` starts, with Bun's pipes.
//!
//! Bun gives the child three pipes and no process group of its own, replaces
//! its environment with the one it is given (leaving out a variable whose
//! value is `undefined`), and resolves `exited` to 128 plus the signal.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::io;
#[cfg(unix)]
use std::os::fd::AsFd;
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};
use std::rc::Rc;
use std::task::{Context, Poll, Waker};
#[cfg(unix)]
use std::{fs::File, io::Write};

use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use garcon_interface::resources::ExecutorResult;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::process::{ChildStdin, Command};

use super::{
    AcpProcess, AcpSignal, AcpSpawnSpec, AcpStdin, AcpStdinHandle, ExitedFuture, StdinReport,
};
use crate::acp::errors::boxed;

type Waited = Shared<LocalBoxFuture<'static, Result<i32, Rc<io::Error>>>>;
const BUN_STDIN_CHUNK: usize = 4096;

/// `defaultSpawn`: the command over three pipes, in its working directory
/// and environment.
pub(super) fn spawn(spec: &AcpSpawnSpec) -> ExecutorResult<Box<dyn AcpProcess>> {
    let mut command = Command::new(&spec.command);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    for (name, value) in &spec.env {
        if let Some(value) = value {
            command.env(name, value);
        }
    }
    let mut child = command.spawn()?;
    let pid = Rc::new(Cell::new(child.id()));
    let stdout = child
        .stdout
        .take()
        .map(|stdout| Box::new(stdout) as Box<dyn AsyncRead + Unpin>);
    let stderr = child
        .stderr
        .take()
        .map(|stderr| Box::new(stderr) as Box<dyn AsyncRead + Unpin>);
    let stdin = Rc::new(RefCell::new(PipeStdin {
        stdin: child.stdin.take().map(PipeWriter::new).transpose()?,
        buffer: Vec::new(),
        head: 0,
        written: 0,
        closed: false,
        waiters: Vec::new(),
        flush_error: None,
    }));
    let waited: Waited = {
        let pid = Rc::clone(&pid);
        let waited = Rc::clone(&stdin);
        let waiting: LocalBoxFuture<'static, Result<i32, Rc<io::Error>>> = Box::pin(async move {
            let status = child.wait().await;
            pid.set(None);
            waited.borrow_mut().closed = true;
            status.map(exit_code).map_err(Rc::new)
        });
        waiting.shared()
    };
    Ok(Box::new(SpawnedProcess {
        pid,
        stdin: Some(Rc::new(RefCell::new(PipeStdinHandle(stdin))) as AcpStdinHandle),
        stdout,
        stderr,
        waited,
    }))
}

struct SpawnedProcess {
    pid: Rc<Cell<Option<u32>>>,
    stdin: Option<AcpStdinHandle>,
    stdout: Option<Box<dyn AsyncRead + Unpin>>,
    stderr: Option<Box<dyn AsyncRead + Unpin>>,
    waited: Waited,
}

impl AcpProcess for SpawnedProcess {
    fn stdin(&self) -> Option<AcpStdinHandle> {
        self.stdin.clone()
    }

    fn take_stdout(&mut self) -> Option<Box<dyn AsyncRead + Unpin>> {
        self.stdout.take()
    }

    fn take_stderr(&mut self) -> Option<Box<dyn AsyncRead + Unpin>> {
        self.stderr.take()
    }

    fn exited(&self) -> ExitedFuture {
        let waited = self.waited.clone();
        Box::pin(async move {
            waited
                .await
                .map_err(|error| error as Rc<dyn std::error::Error>)
                .map_err(|error| boxed(&error))
        })
    }

    fn kill(&mut self, signal: AcpSignal) {
        let Some(pid) = self.pid.get() else {
            return;
        };
        #[cfg(unix)]
        {
            // SAFETY: `kill` has no memory-safety preconditions, and the pid
            // belongs to a child this process started.
            unsafe {
                libc::kill(
                    pid as libc::pid_t,
                    match signal {
                        AcpSignal::Sigterm => libc::SIGTERM,
                        AcpSignal::Sigkill => libc::SIGKILL,
                    },
                );
            }
        }
        #[cfg(windows)]
        {
            let _ = signal;
            // TerminateProcess is what both signals mean on Windows.
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
    }
}

/// Bun's exit status: the code, or 128 plus the signal.
fn exit_code(status: ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        // INFALLIBLE: a reaped child exited by a code or by a signal.
        status
            .code()
            .or_else(|| status.signal().map(|signal| 128 + signal))
            .expect("an exit status")
    }
    #[cfg(windows)]
    {
        // INFALLIBLE: a reaped child on Windows always exited by a code.
        status.code().expect("an exit status")
    }
}

#[cfg(unix)]
struct PipeWriter {
    immediate: File,
    pending: ChildStdin,
}

#[cfg(unix)]
impl PipeWriter {
    fn new(stdin: ChildStdin) -> io::Result<Self> {
        // Duplicating the descriptor keeps the original pipe's nonblocking
        // mode, which `into_owned_fd` would reset.
        let immediate = File::from(stdin.as_fd().try_clone_to_owned()?);
        #[cfg(test)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: F_GETFL reads flags from the live descriptor owned by the File.
            let flags = unsafe { libc::fcntl(immediate.as_raw_fd(), libc::F_GETFL) };
            assert!(
                flags >= 0 && flags & libc::O_NONBLOCK != 0,
                "ACP stdin must not block"
            );
        }
        Ok(Self {
            immediate,
            pending: stdin,
        })
    }

    fn write(
        &mut self,
        bytes: &[u8],
        context: Option<&mut Context<'_>>,
    ) -> Poll<io::Result<usize>> {
        let Some(context) = context else {
            // Tokio may not have polled the reactor for the pipe's initial
            // writable event yet. The nonblocking write can still succeed.
            return match self.immediate.write(bytes) {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => Poll::Pending,
                result => Poll::Ready(result),
            };
        };
        Pin::new(&mut self.pending).poll_write(context, bytes)
    }
}

#[cfg(windows)]
struct PipeWriter(ChildStdin);

#[cfg(windows)]
impl PipeWriter {
    fn new(stdin: ChildStdin) -> io::Result<Self> {
        Ok(Self(stdin))
    }

    fn write(
        &mut self,
        bytes: &[u8],
        context: Option<&mut Context<'_>>,
    ) -> Poll<io::Result<usize>> {
        let Some(context) = context else {
            return Poll::Pending;
        };
        Pin::new(&mut self.0).poll_write(context, bytes)
    }
}

/// The write end of the child's stdin, buffered as `FileSink` is.
struct PipeStdin {
    stdin: Option<PipeWriter>,
    buffer: Vec<u8>,
    head: usize,
    written: u64,
    /// The child exited, after which Bun's sink reports `true` for a write.
    closed: bool,
    waiters: Vec<Waker>,
    flush_error: Option<io::Error>,
}

impl PipeStdin {
    /// Hands the buffered bytes to the child until it would block.
    fn push(&mut self, mut context: Option<&mut Context<'_>>) -> io::Result<()> {
        let previous = self.written;
        let result = self.push_bytes(&mut context);
        if self.written != previous || result.is_err() {
            for waiter in self.waiters.drain(..) {
                waiter.wake();
            }
        }
        result
    }

    fn push_bytes(&mut self, context: &mut Option<&mut Context<'_>>) -> io::Result<()> {
        let Some(stdin) = self.stdin.as_mut() else {
            return Ok(());
        };
        while self.head < self.buffer.len() {
            match stdin.write(&self.buffer[self.head..], context.as_deref_mut()) {
                Poll::Ready(Ok(0)) => {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "failed to write whole buffer",
                    ));
                }
                Poll::Ready(Ok(count)) => {
                    self.head += count;
                    self.written += count as u64;
                }
                Poll::Ready(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {}
                Poll::Ready(Err(error)) => return Err(error),
                Poll::Pending => return Ok(()),
            }
        }
        self.buffer.clear();
        self.head = 0;
        Ok(())
    }

    /// The count of bytes written once everything buffered is handed over.
    fn target(&self) -> u64 {
        self.written + (self.buffer.len() - self.head) as u64
    }
}

/// A write to the pipe, once it was accepted: its byte count, or the flush.
struct PipeWrite {
    stdin: Rc<RefCell<PipeStdin>>,
    target: u64,
    reported: Option<usize>,
}

impl Future for PipeWrite {
    type Output = io::Result<Option<usize>>;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let mut stdin = self.stdin.borrow_mut();
        if stdin.written >= self.target {
            return Poll::Ready(Ok(self.reported));
        }
        let pushed = stdin.push(Some(context));
        if stdin.written >= self.target {
            return Poll::Ready(Ok(self.reported));
        }
        pushed?;
        if !stdin
            .waiters
            .iter()
            .any(|waiter| waiter.will_wake(context.waker()))
        {
            stdin.waiters.push(context.waker().clone());
        }
        Poll::Pending
    }
}

/// `process.stdin` as the transport sees it.
struct PipeStdinHandle(Rc<RefCell<PipeStdin>>);

impl AcpStdin for PipeStdinHandle {
    fn write(&mut self, data: &[u8]) -> io::Result<StdinReport> {
        let (target, taken) = {
            let mut stdin = self.0.borrow_mut();
            if stdin.closed {
                return Ok(StdinReport::Closed);
            }
            let previous = stdin.buffer.len();
            stdin.buffer.extend_from_slice(data);
            let target = stdin.target();
            if let Err(error) = stdin.push(None) {
                let kept = previous.max(stdin.head);
                stdin.buffer.truncate(kept);
                // FileSink leaves small writes for the caller to flush.
                if data.len() < BUN_STDIN_CHUNK {
                    stdin.flush_error = Some(error);
                    return Ok(StdinReport::Accepted(Some(data.len())));
                }
                return Ok(StdinReport::Pending(Box::pin(async { Err(error) })));
            }
            (target, stdin.written >= target)
        };
        self.report(target, taken, Some(data.len()))
    }

    fn flush(&mut self) -> io::Result<StdinReport> {
        let (target, taken) = {
            let mut stdin = self.0.borrow_mut();
            if stdin.closed {
                return Ok(StdinReport::Accepted(None));
            }
            if let Some(error) = stdin.flush_error.take() {
                return Err(error);
            }
            let target = stdin.target();
            stdin.push(None)?;
            (target, stdin.written >= target)
        };
        self.report(target, taken, Some(0))
    }
}

impl PipeStdinHandle {
    /// The sink's answer once it tried to hand over the bytes up to
    /// `target`: the count `accepted`, or a future for the rest.
    fn report(&self, target: u64, taken: bool, accepted: Option<usize>) -> io::Result<StdinReport> {
        Ok(if taken {
            StdinReport::Accepted(accepted)
        } else {
            StdinReport::Pending(Box::pin(PipeWrite {
                stdin: Rc::clone(&self.0),
                target,
                reported: accepted,
            }))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sink_whose_process_exited_reports_a_closed_write() {
        let mut handle = PipeStdinHandle(Rc::new(RefCell::new(PipeStdin {
            stdin: None,
            buffer: Vec::new(),
            head: 0,
            written: 0,
            closed: true,
            waiters: Vec::new(),
            flush_error: None,
        })));
        assert!(matches!(
            AcpStdin::write(&mut handle, b"frame\n"),
            Ok(StdinReport::Closed)
        ));
        assert!(matches!(
            AcpStdin::flush(&mut handle),
            Ok(StdinReport::Accepted(None))
        ));
    }
}
