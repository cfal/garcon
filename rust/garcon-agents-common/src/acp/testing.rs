//! An ACP process without a process, for the tests of the ACP modules: pipes
//! the test writes into, a stdin the test answers, and an exit the test
//! reports.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::io;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use garcon_js::json::stringify;
use serde_json::Value;
use tokio::io::{AsyncRead, ReadBuf};
use tokio::sync::oneshot;

use crate::acp::transport::{
    AcpProcess, AcpSignal, AcpStdin, AcpStdinHandle, ExitedFuture, StdinReport,
};

type Settled<T> = Shared<LocalBoxFuture<'static, Result<T, Rc<io::Error>>>>;

/// What a sink reports for a write the test confirms later.
pub(crate) type Report = Result<Option<usize>, Rc<io::Error>>;

/// A promise the test resolves: `Promise.withResolvers`.
pub(crate) struct Deferred<T> {
    sender: RefCell<Option<oneshot::Sender<T>>>,
    future: Settled<T>,
}

impl<T: Clone + 'static> Default for Deferred<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Clone + 'static> Deferred<T> {
    pub(crate) fn new() -> Self {
        let (sender, receiver) = oneshot::channel();
        let waiting: LocalBoxFuture<'static, Result<T, Rc<io::Error>>> = Box::pin(async move {
            receiver
                .await
                .map_err(|_| Rc::new(io::Error::other("the resolver was dropped")))
        });
        Self {
            sender: RefCell::new(Some(sender)),
            future: waiting.shared(),
        }
    }

    pub(crate) fn resolve(&self, value: T) {
        if let Some(sender) = self.sender.borrow_mut().take() {
            let _ = sender.send(value);
        }
    }

    pub(crate) fn shared(&self) -> Settled<T> {
        self.future.clone()
    }
}

impl Deferred<Report> {
    /// The pending report a sink gives for a write the test confirms later.
    pub(crate) fn report(&self) -> StdinReport {
        let report = self.future.clone();
        StdinReport::Pending(Box::pin(async move {
            report
                .await
                .and_then(|report| report)
                .map_err(|error| io::Error::other(error.to_string()))
        }))
    }
}

/// One readable pipe the test writes into.
#[derive(Default)]
struct FakePipe {
    chunks: VecDeque<Vec<u8>>,
    closed: bool,
    failure: Option<String>,
    waker: Option<Waker>,
}

impl FakePipe {
    fn wake(&mut self) {
        if let Some(waker) = self.waker.take() {
            waker.wake();
        }
    }
}

struct FakePipeReader(Rc<RefCell<FakePipe>>);

impl AsyncRead for FakePipeReader {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let mut pipe = self.0.borrow_mut();
        // A stream the test failed rejects every read; what it held is lost.
        if let Some(message) = &pipe.failure {
            return Poll::Ready(Err(io::Error::other(message.clone())));
        }
        if let Some(chunk) = pipe.chunks.pop_front() {
            let count = chunk.len().min(buffer.remaining());
            buffer.put_slice(&chunk[..count]);
            if count < chunk.len() {
                pipe.chunks.push_front(chunk[count..].to_vec());
            }
            return Poll::Ready(Ok(()));
        }
        if pipe.closed {
            return Poll::Ready(Ok(()));
        }
        pipe.waker = Some(context.waker().clone());
        Poll::Pending
    }
}

/// The process's stdin as the test shapes it.
#[derive(Default)]
struct FakeStdin {
    written: Vec<String>,
    write_handler: Option<WriteHandler>,
    next_write: Option<StdinReport>,
    flush: Option<Box<dyn FnMut() -> StdinReport>>,
}

type WriteHandler = Box<dyn FnMut(&str) -> usize>;

impl AcpStdin for FakeStdin {
    fn write(&mut self, data: &[u8]) -> io::Result<StdinReport> {
        let frame = String::from_utf8_lossy(data).into_owned();
        self.written.push(frame.clone());
        if let Some(report) = self.next_write.take() {
            return Ok(report);
        }
        Ok(match self.write_handler.as_mut() {
            // `mock(() => undefined)`: no count and no promise.
            None => StdinReport::Accepted(None),
            Some(handler) => StdinReport::Accepted(Some(handler(&frame))),
        })
    }

    fn flush(&mut self) -> io::Result<StdinReport> {
        // `stdin.flush?.()`: absent is `undefined`.
        Ok(match self.flush.as_mut() {
            None => StdinReport::Accepted(None),
            Some(flush) => flush(),
        })
    }
}

struct FakeShared {
    stdin: Rc<RefCell<FakeStdin>>,
    stdout: Rc<RefCell<FakePipe>>,
    stderr: Rc<RefCell<FakePipe>>,
    exited: Rc<Deferred<i32>>,
    exit_after_kill: RefCell<Option<Settled<()>>>,
    kills: RefCell<Vec<AcpSignal>>,
}

/// The process, for the transport.
pub(crate) struct FakeAcpProcess(Rc<FakeShared>);

/// The same process, for the test.
#[derive(Clone)]
pub(crate) struct FakeAcpControl(Rc<FakeShared>);

impl FakeAcpProcess {
    pub(crate) fn create() -> (Box<dyn AcpProcess>, FakeAcpControl) {
        let shared = Rc::new(FakeShared {
            stdin: Rc::new(RefCell::new(FakeStdin::default())),
            stdout: Rc::new(RefCell::new(FakePipe::default())),
            stderr: Rc::new(RefCell::new(FakePipe::default())),
            exited: Rc::new(Deferred::new()),
            exit_after_kill: RefCell::new(None),
            kills: RefCell::new(Vec::new()),
        });
        (Box::new(Self(Rc::clone(&shared))), FakeAcpControl(shared))
    }
}

impl AcpProcess for FakeAcpProcess {
    fn stdin(&self) -> Option<AcpStdinHandle> {
        Some(Rc::clone(&self.0.stdin) as AcpStdinHandle)
    }

    fn take_stdout(&mut self) -> Option<Box<dyn AsyncRead + Unpin>> {
        Some(Box::new(FakePipeReader(Rc::clone(&self.0.stdout))))
    }

    fn take_stderr(&mut self) -> Option<Box<dyn AsyncRead + Unpin>> {
        Some(Box::new(FakePipeReader(Rc::clone(&self.0.stderr))))
    }

    fn exited(&self) -> ExitedFuture {
        let exited = self.0.exited.shared();
        Box::pin(async move {
            exited
                .await
                .map_err(|error| io::Error::other(error.to_string()).into())
        })
    }

    fn kill(&mut self, signal: AcpSignal) {
        self.0.kills.borrow_mut().push(signal);
        // A killed process ends by the signal, at once or after its gate.
        let after = self.0.exit_after_kill.borrow().clone();
        match after {
            None => self.0.exited.resolve(143),
            Some(after) => {
                let exited = Rc::clone(&self.0.exited);
                tokio::task::spawn_local(async move {
                    let _ = after.await;
                    exited.resolve(143);
                });
            }
        }
    }
}

impl FakeAcpControl {
    /// Answers each frame's text as the transport writes it; the handler
    /// returns the bytes it reports taking.
    pub(crate) fn on_write(&self, handler: impl FnMut(&str) -> usize + 'static) {
        self.0.stdin.borrow_mut().write_handler = Some(Box::new(handler));
    }

    /// Makes the next write report this instead: `mockReturnValueOnce`.
    pub(crate) fn report_next_write(&self, report: StdinReport) {
        self.0.stdin.borrow_mut().next_write = Some(report);
    }

    /// `stdin.flush`: absent, it reports nothing.
    pub(crate) fn on_flush(&self, flush: impl FnMut() -> StdinReport + 'static) {
        self.0.stdin.borrow_mut().flush = Some(Box::new(flush));
    }

    /// Every frame the transport wrote to the process's stdin, in order.
    pub(crate) fn written(&self) -> Vec<String> {
        self.0.stdin.borrow().written.clone()
    }

    /// `JSON.stringify(message)` and a newline, as the tests feed a stream.
    pub(crate) fn write_stdout_line(&self, message: &Value) {
        let mut line = stringify(message).into_bytes();
        line.push(b'\n');
        self.write_stdout(&line);
    }

    pub(crate) fn write_stdout(&self, bytes: &[u8]) {
        let mut pipe = self.0.stdout.borrow_mut();
        pipe.chunks.push_back(bytes.to_vec());
        pipe.wake();
    }

    pub(crate) fn write_stderr_line(&self, line: &str) {
        self.write_stderr(format!("{line}\n").as_bytes());
    }

    pub(crate) fn write_stderr(&self, bytes: &[u8]) {
        let mut pipe = self.0.stderr.borrow_mut();
        pipe.chunks.push_back(bytes.to_vec());
        pipe.wake();
    }

    pub(crate) fn close_stdout(&self) {
        let mut pipe = self.0.stdout.borrow_mut();
        pipe.closed = true;
        pipe.wake();
    }

    pub(crate) fn fail_stdout(&self, message: &str) {
        let mut pipe = self.0.stdout.borrow_mut();
        pipe.failure = Some(message.to_owned());
        pipe.wake();
    }

    /// Ends the newest process as a crash would.
    pub(crate) fn exit(&self, code: i32) {
        self.0.exited.resolve(code);
    }

    /// After a kill, the process exits once `gate` settles.
    pub(crate) fn exit_after_kill(&self, gate: &Deferred<()>) {
        *self.0.exit_after_kill.borrow_mut() = Some(gate.shared());
    }

    pub(crate) fn kills(&self) -> Vec<AcpSignal> {
        self.0.kills.borrow().clone()
    }
}
