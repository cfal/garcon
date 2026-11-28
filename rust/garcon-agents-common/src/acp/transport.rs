//! Ports `server-agents/common/src/acp/transport.ts`.
//!
//! The child process sits behind [`AcpProcess`], which reports a write to the
//! child's stdin as Bun's `FileSink` does: the bytes it took at once, or a
//! promise for the rest. The transport keeps the original's order of sends,
//! replies, output held during a confirmed send, and exit.

mod pipe;

use std::cell::{OnceCell, RefCell};
use std::collections::BTreeMap;
use std::error::Error;
use std::future::Future;
use std::io;
use std::rc::{Rc, Weak};
use std::task::Poll;

use futures::future::LocalBoxFuture;
use garcon_interface::resources::ExecutorResult;
use garcon_js::json::{Opaque, stringify};
use garcon_js::{number_to_string, trim};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{Notify, oneshot};
use tokio::task::{JoinHandle, spawn_local};
use tokio::time::sleep;

use super::errors::{AcpRpcError, boxed, plain_error, shared, shared_error};
use super::json_values::is_truthy;
use super::protocol::{AcpJsonRpcId, AcpJsonRpcMessage};
use super::timers::delay;

const DEFAULT_REQUEST_TIMEOUT_MS: f64 = 120_000.0;
const MAX_OUTPUT_DURING_SEND: usize = 4 * 1024 * 1024;
const READ_CHUNK: usize = 64 * 1024;

/// The signals `AcpProcess::kill` takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpSignal {
    Sigterm,
    Sigkill,
}

/// What the child's stdin reported for a write or a flush, as Bun's `FileSink`
/// reports it.
pub enum StdinReport {
    /// The sink took the bytes at once: their count, or nothing.
    Accepted(Option<usize>),
    /// The input closed with the process, and the sink reports success
    /// without a count.
    Closed,
    /// The sink took the bytes and reports when it wrote them.
    Pending(LocalBoxFuture<'static, io::Result<Option<usize>>>),
}

/// The stdin of an ACP process.
pub trait AcpStdin {
    /// `stdin.write(data)`.
    fn write(&mut self, data: &[u8]) -> io::Result<StdinReport>;
    /// `stdin.flush()`; a flush that throws does so here.
    fn flush(&mut self) -> io::Result<StdinReport>;
}

pub type AcpStdinHandle = Rc<RefCell<dyn AcpStdin>>;

/// `exited`: the process's exit code, 128 plus the signal for a signal exit.
pub type ExitedFuture = LocalBoxFuture<'static, ExecutorResult<i32>>;

/// A child process speaking ACP on its standard streams.
pub trait AcpProcess {
    /// The pipe to the process's stdin, for as long as it has one.
    fn stdin(&self) -> Option<AcpStdinHandle>;
    /// Takes the process's stdout, once.
    fn take_stdout(&mut self) -> Option<Box<dyn AsyncRead + Unpin>>;
    /// Takes the process's stderr, once.
    fn take_stderr(&mut self) -> Option<Box<dyn AsyncRead + Unpin>>;
    fn exited(&self) -> ExitedFuture;
    fn kill(&mut self, signal: AcpSignal);
}

/// How to start the agent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AcpSpawnSpec {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// The process's whole environment; `None` leaves a variable out.
    pub env: BTreeMap<String, Option<String>>,
}

pub type AcpSpawn = Rc<dyn Fn(&AcpSpawnSpec) -> ExecutorResult<Box<dyn AcpProcess>>>;

/// The answer to a request: its result, or the error it failed with.
#[derive(Clone, Copy)]
pub enum AcpReply<'a> {
    Result(&'a Value),
    Error(&'a (dyn Error + 'static)),
}

/// Runs once the request's frame is written.
pub type SentCallback = Rc<dyn Fn() -> ExecutorResult<()>>;

/// Runs at the wire boundary, before later frames in the same read can change
/// session state.
pub type ReplyCallback = Rc<dyn Fn(AcpReply<'_>) -> ExecutorResult<()>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpOutputDuringWrite {
    Hold,
    Stream,
}

#[derive(Default)]
pub struct AcpRequestOptions {
    pub on_sent: Option<SentCallback>,
    pub on_reply: Option<ReplyCallback>,
    pub output_during_write: Option<AcpOutputDuringWrite>,
    /// Overrides the transport default for one request; 0 disables it.
    pub timeout_ms: Option<f64>,
}

#[derive(Default)]
pub struct AcpTransportOptions {
    pub spawn: Option<AcpSpawn>,
    pub request_timeout_ms: Option<f64>,
}

/// A listener to the process's messages.
pub type AcpRpcListener = Rc<dyn Fn(&AcpJsonRpcMessage) -> ExecutorResult<()>>;
/// A listener to the process's stderr and to the transport's own diagnostics.
pub type AcpStderrListener = Rc<dyn Fn(&str)>;
/// A listener to the process's exit.
pub type AcpExitListener = Rc<dyn Fn(i32)>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stream {
    Stdout,
    Stderr,
}

/// A read of the process's stdout: issued, waiting for bytes, or answered and
/// not yet consumed. The exit watcher drains the answered ones, which is what
/// `Bun.peek.status` tells the original.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StdoutRead {
    Idle,
    Issued,
    Pending,
    Ready,
}

struct HeldOutput {
    stream: Stream,
    value: Option<Vec<u8>>,
}

/// The answer to a request, once it settles.
type Settled = Result<Value, Rc<dyn Error>>;

struct PendingRequest {
    on_reply: Option<ReplyCallback>,
    settle: oneshot::Sender<Settled>,
    timer: Option<JoinHandle<()>>,
}

struct TransportState {
    process: Option<Box<dyn AcpProcess>>,
    generation: u64,
    next_id: u64,
    pending: Vec<(AcpJsonRpcId, PendingRequest)>,
    send_timers: Vec<(u64, JoinHandle<()>)>,
    output_holds: usize,
    held_output: Vec<HeldOutput>,
    held_bytes: usize,
    release_exit: Option<oneshot::Sender<()>>,
    exit_code: Option<i32>,
    stdout_read: StdoutRead,
    next_timer: u64,
}

#[derive(Default)]
struct Listeners {
    next: u64,
    rpc: Vec<(u64, AcpRpcListener)>,
    stderr: Vec<(u64, AcpStderrListener)>,
    exit: Vec<(u64, AcpExitListener)>,
}

struct TransportInner {
    /// The transport's own handle, for the tasks it starts.
    me: OnceCell<Weak<TransportInner>>,
    spawn: AcpSpawn,
    request_timeout_ms: f64,
    state: RefCell<TransportState>,
    listeners: RefCell<Listeners>,
    stdout_lines: RefCell<LineBuffer>,
    stderr_lines: RefCell<LineBuffer>,
    stdout_read_changed: Notify,
}

/// A JSON-RPC connection to one agent process over its standard streams.
pub struct AcpTransport(Rc<TransportInner>);

impl AcpTransport {
    pub fn new(options: AcpTransportOptions) -> Self {
        let inner = Rc::new(TransportInner {
            me: OnceCell::new(),
            spawn: options.spawn.unwrap_or_else(|| Rc::new(pipe::spawn)),
            request_timeout_ms: options
                .request_timeout_ms
                .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS),
            state: RefCell::new(TransportState {
                process: None,
                generation: 0,
                next_id: 1,
                pending: Vec::new(),
                send_timers: Vec::new(),
                output_holds: 0,
                held_output: Vec::new(),
                held_bytes: 0,
                release_exit: None,
                exit_code: None,
                stdout_read: StdoutRead::Idle,
                next_timer: 0,
            }),
            listeners: RefCell::default(),
            stdout_lines: RefCell::new(LineBuffer::new()),
            stderr_lines: RefCell::new(LineBuffer::new()),
            stdout_read_changed: Notify::new(),
        });
        // INFALLIBLE: the handle is set once, before anyone else holds the transport.
        assert!(inner.me.set(Rc::downgrade(&inner)).is_ok());
        Self(inner)
    }

    pub fn is_connected(&self) -> bool {
        self.0.state.borrow().process.is_some()
    }

    /// Starts the process and its readers; a connected transport ignores a
    /// second call.
    pub fn connect(&self, spec: &AcpSpawnSpec) -> ExecutorResult<()> {
        if self.0.state.borrow().process.is_some() {
            return Ok(());
        }
        self.0.state.borrow_mut().exit_code = None;
        let mut process = (self.0.spawn)(spec)?;
        self.0.stdout_lines.replace(LineBuffer::new());
        self.0.stderr_lines.replace(LineBuffer::new());
        let stdout = process.take_stdout();
        let stderr = process.take_stderr();
        let exited = process.exited();
        let generation = {
            let mut state = self.0.state.borrow_mut();
            state.generation += 1;
            state.process = Some(process);
            state.generation
        };
        if let Some(reader) = stdout {
            self.0.spawn_read_lines(Stream::Stdout, reader, generation);
        }
        if let Some(reader) = stderr {
            self.0.spawn_read_lines(Stream::Stderr, reader, generation);
        }
        self.0.spawn_watch_exit(exited, generation);
        Ok(())
    }

    /// Sends a request and returns the answer of its reply. The frame is
    /// written when this is called; `timeoutMs` overrides the transport default
    /// for one request, and 0 disables it.
    pub fn request(
        &self,
        method: &str,
        params: Option<Value>,
        options: AcpRequestOptions,
    ) -> impl Future<Output = ExecutorResult<Value>> + use<> {
        let id = {
            let mut state = self.0.state.borrow_mut();
            let id = AcpJsonRpcId::Number(state.next_id as f64);
            state.next_id += 1;
            id
        };
        let timeout_ms = options.timeout_ms.unwrap_or(self.0.request_timeout_ms);
        let (settle, settled) = oneshot::channel();
        let timer = (timeout_ms > 0.0).then(|| {
            let id = id.clone();
            let transport = Rc::downgrade(&self.0);
            let error = shared_error(format!(
                "ACP request timed out after {timeout}ms: {method}",
                timeout = number_to_string(timeout_ms)
            ));
            spawn_local(async move {
                sleep(delay(timeout_ms)).await;
                if let Some(transport) = transport.upgrade() {
                    transport.settle_pending(&id, Err(error));
                }
            })
        });
        let sent = options.on_sent.map(|on_sent| -> SentCallback {
            let id = id.clone();
            let transport = Rc::downgrade(&self.0);
            Rc::new(move || {
                let Some(transport) = transport.upgrade() else {
                    return Ok(());
                };
                // A request that timed out before its flush is no longer sent.
                if transport.has_pending(&id) {
                    on_sent()?;
                }
                Ok(())
            })
        });
        self.0.state.borrow_mut().pending.push((
            id.clone(),
            PendingRequest {
                on_reply: options.on_reply,
                settle,
                timer,
            },
        ));
        let mut message = vec![
            ("jsonrpc", Value::String("2.0".to_owned())),
            ("id", id_value(&id)),
            ("method", Value::String(method.to_owned())),
        ];
        if let Some(params) = params {
            message.push(("params", params));
        }
        let written = self.0.write(
            frame(message),
            sent,
            options
                .output_during_write
                .unwrap_or(AcpOutputDuringWrite::Hold),
        );
        if let Err(error) = written {
            self.0.settle_pending(&id, Err(Rc::from(error)));
        }
        async move {
            match settled.await {
                Ok(Ok(result)) => Ok(result),
                Ok(Err(error)) => Err(boxed(&error)),
                // The transport is gone with the request unanswered.
                Err(_) => Err(plain_error("ACP transport closed")),
            }
        }
    }

    pub fn notify(&self, method: &str, params: Option<Value>) -> ExecutorResult<()> {
        let mut message = vec![
            ("jsonrpc", Value::String("2.0".to_owned())),
            ("method", Value::String(method.to_owned())),
        ];
        if let Some(params) = params {
            message.push(("params", params));
        }
        self.0
            .write(frame(message), None, AcpOutputDuringWrite::Hold)
    }

    pub fn respond(&self, id: AcpJsonRpcId, result: Value) -> ExecutorResult<()> {
        self.0.write(
            frame(vec![
                ("jsonrpc", Value::String("2.0".to_owned())),
                ("id", id_value(&id)),
                ("result", result),
            ]),
            None,
            AcpOutputDuringWrite::Hold,
        )
    }

    pub fn respond_error(
        &self,
        id: AcpJsonRpcId,
        code: f64,
        message: &str,
        data: Option<Value>,
    ) -> ExecutorResult<()> {
        let mut error = vec![
            ("code", Value::from(code)),
            ("message", Value::String(message.to_owned())),
        ];
        if let Some(data) = data {
            error.push(("data", data));
        }
        self.0.write(
            frame(vec![
                ("jsonrpc", Value::String("2.0".to_owned())),
                ("id", id_value(&id)),
                ("error", object(error)),
            ]),
            None,
            AcpOutputDuringWrite::Hold,
        )
    }

    /// Closes the transport with `ACP transport closed` and terminates the
    /// process.
    pub fn close(&self) {
        self.0
            .close_with_error(shared_error("ACP transport closed"), AcpSignal::Sigterm);
    }

    pub fn on_rpc_message(
        &self,
        callback: impl Fn(&AcpJsonRpcMessage) -> ExecutorResult<()> + 'static,
    ) -> Box<dyn Fn()> {
        let callback: AcpRpcListener = Rc::new(callback);
        self.add_listener(|listeners| &mut listeners.rpc, callback)
    }

    pub fn on_stderr(&self, callback: impl Fn(&str) + 'static) -> Box<dyn Fn()> {
        let callback: AcpStderrListener = Rc::new(callback);
        self.add_listener(|listeners| &mut listeners.stderr, callback)
    }

    /// A listener attached after the process exited still hears of it, so a
    /// watcher added after the last awaited reply cannot miss a death.
    pub fn on_exit(&self, callback: impl Fn(i32) + 'static) -> Box<dyn Fn()> {
        let exit_code = self.0.state.borrow().exit_code;
        if let Some(exit_code) = exit_code {
            let detached = Rc::new(RefCell::new(false));
            let flag = Rc::clone(&detached);
            spawn_local(async move {
                tokio::task::yield_now().await;
                if !*flag.borrow() {
                    callback(exit_code);
                }
            });
            return Box::new(move || *detached.borrow_mut() = true);
        }
        let callback: AcpExitListener = Rc::new(callback);
        self.add_listener(|listeners| &mut listeners.exit, callback)
    }

    fn add_listener<T: 'static>(
        &self,
        list: fn(&mut Listeners) -> &mut Vec<(u64, T)>,
        callback: T,
    ) -> Box<dyn Fn()> {
        let id = {
            let mut listeners = self.0.listeners.borrow_mut();
            listeners.next += 1;
            let id = listeners.next;
            list(&mut listeners).push((id, callback));
            id
        };
        let transport = Rc::downgrade(&self.0);
        Box::new(move || {
            if let Some(transport) = transport.upgrade() {
                list(&mut transport.listeners.borrow_mut()).retain(|(other, _)| *other != id);
            }
        })
    }
}

/// `JSON.stringify(payload)` followed by the frame's newline.
fn frame(message: Vec<(&str, Value)>) -> Vec<u8> {
    let payload = object(message);
    let mut frame = stringify(&payload).into_bytes();
    frame.push(b'\n');
    frame
}

fn object(entries: Vec<(&str, Value)>) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

fn id_value(id: &AcpJsonRpcId) -> Value {
    match id {
        AcpJsonRpcId::Number(number) => Value::from(*number),
        AcpJsonRpcId::String(text) => Value::String(text.clone()),
    }
}

impl TransportInner {
    /// The transport's own weak handle, for a task that outlives a call.
    fn weak(&self) -> Weak<Self> {
        match self.me.get() {
            Some(me) => Weak::clone(me),
            // INFALLIBLE: the constructor sets the handle before any task can start.
            None => unreachable!("the transport's own handle is set at construction"),
        }
    }

    fn generation(&self) -> u64 {
        self.state.borrow().generation
    }

    /// Whether `generation` names the process the transport is connected to.
    fn is_process(&self, generation: u64) -> bool {
        let state = self.state.borrow();
        state.generation == generation && state.process.is_some()
    }

    fn has_pending(&self, id: &AcpJsonRpcId) -> bool {
        self.state
            .borrow()
            .pending
            .iter()
            .any(|(pending, _)| pending == id)
    }

    fn settle_pending(&self, id: &AcpJsonRpcId, reply: Settled) {
        let entry = {
            let mut state = self.state.borrow_mut();
            let index = state.pending.iter().position(|(pending, _)| pending == id);
            index.map(|index| state.pending.remove(index))
        };
        let Some((_, pending)) = entry else {
            return;
        };
        let PendingRequest {
            on_reply,
            settle,
            timer,
        } = pending;
        if let Some(timer) = timer {
            timer.abort();
        }
        let reply = match on_reply {
            None => reply,
            Some(on_reply) => {
                // A reply callback that throws settles the request with its error.
                let delivered: ExecutorResult<()> = match &reply {
                    Ok(result) => on_reply(AcpReply::Result(result)),
                    Err(error) => on_reply(AcpReply::Error(error.as_ref())),
                };
                delivered.map_or_else(|error| -> Settled { Err(Rc::from(error)) }, |()| reply)
            }
        };
        let _ = settle.send(reply);
    }

    fn reject_all_pending(&self, error: &Rc<dyn Error>) {
        let ids: Vec<_> = self
            .state
            .borrow()
            .pending
            .iter()
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.settle_pending(&id, Err(Rc::clone(error)));
        }
    }

    fn take_held_output(&self) -> Vec<HeldOutput> {
        let mut state = self.state.borrow_mut();
        let output = std::mem::take(&mut state.held_output);
        state.held_bytes = 0;
        if let Some(release) = state.release_exit.take() {
            let _ = release.send(());
        }
        output
    }

    fn disconnect(&self, error: Rc<dyn Error>) {
        {
            let mut state = self.state.borrow_mut();
            for (_, timer) in state.send_timers.drain(..) {
                timer.abort();
            }
            state.output_holds = 0;
        }
        drop(self.take_held_output());
        self.reject_all_pending(&error);
        {
            let mut state = self.state.borrow_mut();
            state.process = None;
            state.stdout_read = StdoutRead::Idle;
        }
        self.stdout_read_changed.notify_one();
    }

    fn close_with_error(&self, error: Rc<dyn Error>, signal: AcpSignal) {
        let process = self.state.borrow_mut().process.take();
        self.disconnect(error);
        if let Some(mut process) = process {
            process.kill(signal);
        }
    }

    /// `onFailure`: ends the process `generation` names, unless the transport
    /// moved on from it.
    fn fail(&self, generation: u64, error: Rc<dyn Error>) {
        if self.is_process(generation) {
            self.close_with_error(error, AcpSignal::Sigkill);
        }
    }

    fn send_timer_finished(&self, id: u64) {
        let mut state = self.state.borrow_mut();
        if let Some(index) = state.send_timers.iter().position(|(timer, _)| *timer == id) {
            let (_, timer) = state.send_timers.remove(index);
            timer.abort();
        }
    }

    fn set_stdout_read(&self, read: StdoutRead) {
        self.state.borrow_mut().stdout_read = read;
        self.stdout_read_changed.notify_one();
    }

    /// `#write`: writes one frame, and confirms a send only once the pipe
    /// took it. A confirmed send holds what the process writes until then.
    fn write(
        &self,
        frame: Vec<u8>,
        on_sent: Option<SentCallback>,
        output_during_write: AcpOutputDuringWrite,
    ) -> ExecutorResult<()> {
        let (stdin, generation) = {
            let state = self.state.borrow();
            let generation = state.generation;
            let stdin = state.process.as_ref().and_then(|process| process.stdin());
            (stdin, generation)
        };
        let Some(stdin) = stdin else {
            return Err(plain_error(STDIN_UNAVAILABLE));
        };
        let flushed = match write_frame(&stdin, &frame, on_sent.is_some()) {
            Ok(flushed) => flushed,
            Err(error) => {
                self.fail(generation, Rc::clone(&error));
                return Err(boxed(&error));
            }
        };
        match flushed {
            FrameFlush::Settled => {
                if let Some(on_sent) = on_sent {
                    on_sent()?;
                }
                Ok(())
            }
            FrameFlush::Pending(flushed) => {
                let Some(on_sent) = on_sent else {
                    let transport = self.weak();
                    spawn_local(async move {
                        if let Err(error) = flushed.await
                            && let Some(inner) = transport.upgrade()
                        {
                            inner.fail(generation, error);
                        }
                    });
                    return Ok(());
                };
                let hold = output_during_write == AcpOutputDuringWrite::Hold;
                let timeout_ms = self.request_timeout_ms;
                let timeout_ms = if timeout_ms == 0.0 || timeout_ms.is_nan() {
                    DEFAULT_REQUEST_TIMEOUT_MS
                } else {
                    timeout_ms
                };
                let timer = spawn_local({
                    let transport = self.weak();
                    let error = shared_error("ACP frame write timed out");
                    async move {
                        sleep(delay(timeout_ms)).await;
                        if let Some(inner) = transport.upgrade() {
                            inner.fail(generation, error);
                        }
                    }
                });
                let timer_id = {
                    let mut state = self.state.borrow_mut();
                    state.next_timer += 1;
                    let timer_id = state.next_timer;
                    state.send_timers.push((timer_id, timer));
                    if hold {
                        state.output_holds += 1;
                    }
                    timer_id
                };
                let transport = self.weak();
                spawn_local(async move {
                    let flushed = flushed.await;
                    let Some(inner) = transport.upgrade() else {
                        return;
                    };
                    if !inner.is_process(generation) {
                        return;
                    }
                    let delivered: Result<(), Rc<dyn Error>> = match flushed {
                        Err(error) => Err(error),
                        Ok(()) => (|| -> ExecutorResult<()> {
                            inner.send_timer_finished(timer_id);
                            if hold {
                                inner.state.borrow_mut().output_holds -= 1;
                            }
                            on_sent()?;
                            if inner.state.borrow().output_holds > 0 {
                                return Ok(());
                            }
                            for held in inner.take_held_output() {
                                if !inner.is_process(generation) {
                                    break;
                                }
                                inner.consume(held.stream, held.value.as_deref(), generation)?;
                            }
                            Ok(())
                        })()
                        .map_err(Rc::<dyn Error>::from),
                    };
                    if let Err(error) = delivered {
                        inner.fail(generation, error);
                    }
                });
                Ok(())
            }
        }
    }
}

const STDIN_UNAVAILABLE: &str = "ACP transport stdin is unavailable";

impl TransportInner {
    /// `consume`: decodes what a read returned, delivers the lines it
    /// completes, and ends the transport when stdout ends.
    fn consume(&self, stream: Stream, value: Option<&[u8]>, generation: u64) -> ExecutorResult<()> {
        let lines = match stream {
            Stream::Stdout => &self.stdout_lines,
            Stream::Stderr => &self.stderr_lines,
        };
        let received = lines.borrow_mut().receive(value);
        for line in &received {
            match stream {
                Stream::Stdout => self.handle_stdout_line(line)?,
                Stream::Stderr => self.emit_stderr(line),
            }
        }
        if value.is_none() && stream == Stream::Stdout && self.is_process(generation) {
            self.close_with_error(
                shared_error("ACP transport stdout closed"),
                AcpSignal::Sigkill,
            );
        }
        Ok(())
    }

    fn handle_stdout_line(&self, line: &str) -> ExecutorResult<()> {
        // The suffix is this port's parse error text; the original prints
        // JavaScriptCore's.
        let message = match Opaque::parse(line) {
            Ok(json) => AcpJsonRpcMessage::new(json),
            Err(error) => {
                self.emit_stderr(&format!("ACP transport received invalid JSON: {error}"));
                return Ok(());
            }
        };
        if let Some(id) = message.read_id()? {
            let error = message.get("error");
            if message.has("error") && error.is_some_and(is_truthy) {
                let rpc = AcpRpcError::new(
                    error.and_then(|error| error.get("message")),
                    error.and_then(|error| error.get("code")).cloned(),
                    error.and_then(|error| error.get("data")).cloned(),
                );
                self.settle_pending(&id, Err(shared(rpc)));
                return Ok(());
            }
            if message.has("result") {
                self.settle_pending(&id, Ok(message["result"].clone()));
                return Ok(());
            }
        }
        self.emit_rpc_message(&message)
    }

    fn emit_rpc_message(&self, message: &AcpJsonRpcMessage) -> ExecutorResult<()> {
        let listeners: Vec<_> = self
            .listeners
            .borrow()
            .rpc
            .iter()
            .map(|(_, listener)| Rc::clone(listener))
            .collect();
        for listener in listeners {
            listener(message)?;
        }
        Ok(())
    }

    fn emit_stderr(&self, line: &str) {
        let listeners: Vec<_> = self
            .listeners
            .borrow()
            .stderr
            .iter()
            .map(|(_, listener)| Rc::clone(listener))
            .collect();
        for listener in listeners {
            listener(line);
        }
    }

    fn emit_exit(&self, exit_code: i32) {
        let listeners: Vec<_> = self
            .listeners
            .borrow()
            .exit
            .iter()
            .map(|(_, listener)| Rc::clone(listener))
            .collect();
        for listener in listeners {
            listener(exit_code);
        }
    }

    fn spawn_read_lines(
        &self,
        stream: Stream,
        mut reader: Box<dyn AsyncRead + Unpin>,
        generation: u64,
    ) {
        let transport = self.weak();
        spawn_local(async move {
            let read = read_lines(&transport, stream, reader.as_mut(), generation).await;
            if let Err(error) = read
                && let Some(inner) = transport.upgrade()
                && inner.is_process(generation)
            {
                inner.close_with_error(Rc::<dyn Error>::from(error), AcpSignal::Sigkill);
            }
            if stream == Stream::Stdout
                && let Some(inner) = transport.upgrade()
                && inner.is_process(generation)
            {
                inner.set_stdout_read(StdoutRead::Idle);
            }
        });
    }

    /// `#watchExit`: after the process exits, drains the protocol bytes that
    /// are already readable, waits for a bounded send to publish or discard
    /// what it holds, and only then disconnects.
    fn spawn_watch_exit(&self, exited: ExitedFuture, generation: u64) {
        let transport = self.weak();
        spawn_local(async move {
            let exit_code = match exited.await {
                Ok(exit_code) => exit_code,
                Err(error) => {
                    // The original's `exited` never rejects; a wait that
                    // fails ends the pipe here.
                    if let Some(inner) = transport.upgrade()
                        && inner.is_process(generation)
                    {
                        inner.close_with_error(Rc::<dyn Error>::from(error), AcpSignal::Sigkill);
                    }
                    return;
                }
            };
            loop {
                let Some(inner) = transport.upgrade() else {
                    return;
                };
                let readable = {
                    let state = inner.state.borrow();
                    state.generation == generation
                        && matches!(state.stdout_read, StdoutRead::Issued | StdoutRead::Ready)
                };
                if !readable {
                    break;
                }
                inner.stdout_read_changed.notified().await;
            }
            let Some(inner) = transport.upgrade() else {
                return;
            };
            if inner.generation() != generation {
                return;
            }
            if !inner.state.borrow().held_output.is_empty() {
                let released = {
                    let mut state = inner.state.borrow_mut();
                    let (release, released) = oneshot::channel();
                    state.release_exit = Some(release);
                    released
                };
                let _ = released.await;
                let Some(inner) = transport.upgrade() else {
                    return;
                };
                if inner.generation() != generation {
                    return;
                }
            }
            inner.state.borrow_mut().exit_code = Some(exit_code);
            inner.disconnect(shared_error(format!(
                "ACP transport process exited with code {exit_code}"
            )));
            inner.emit_exit(exit_code);
        });
    }
}

/// Reads a pipe to its end, one chunk at a time, and hands each chunk to
/// `consume`; output that arrives during a confirmed send is held for the
/// send to publish in order.
async fn read_lines(
    transport: &Weak<TransportInner>,
    stream: Stream,
    reader: &mut (dyn AsyncRead + Unpin),
    generation: u64,
) -> ExecutorResult<()> {
    let mut chunk = vec![0u8; READ_CHUNK];
    loop {
        {
            let Some(inner) = transport.upgrade() else {
                return Ok(());
            };
            if !inner.is_process(generation) {
                return Ok(());
            }
            if stream == Stream::Stdout {
                inner.set_stdout_read(StdoutRead::Issued);
            }
        }
        let read = std::future::poll_fn(|cx| {
            let mut read = std::pin::pin!(reader.read(&mut chunk));
            match read.as_mut().poll(cx) {
                Poll::Ready(result) => Poll::Ready(result),
                Poll::Pending => {
                    if stream == Stream::Stdout
                        && let Some(inner) = transport.upgrade()
                        && inner.is_process(generation)
                    {
                        inner.set_stdout_read(StdoutRead::Pending);
                    }
                    Poll::Pending
                }
            }
        })
        .await;
        let Some(inner) = transport.upgrade() else {
            return Ok(());
        };
        let count = match read {
            Ok(count) => count,
            Err(error) => return Err(Box::new(error)),
        };
        if !inner.is_process(generation) {
            return Ok(());
        }
        if stream == Stream::Stdout {
            inner.set_stdout_read(StdoutRead::Ready);
        }
        let value = (count > 0).then(|| &chunk[..count]);
        let held = inner.state.borrow().output_holds > 0;
        if held {
            let mut state = inner.state.borrow_mut();
            state.held_bytes += value.map_or(0, <[u8]>::len).max(64);
            if state.held_bytes > MAX_OUTPUT_DURING_SEND {
                return Err(plain_error("ACP output exceeded the pending send buffer"));
            }
            state.held_output.push(HeldOutput {
                stream,
                value: value.map(<[u8]>::to_vec),
            });
        } else {
            inner.consume(stream, value, generation)?;
        }
        if value.is_none() {
            return Ok(());
        }
    }
}

/// What `writeFrame` returned: a sink that needs no confirming, or the flush
/// that confirms the send.
enum FrameFlush {
    Settled,
    Pending(LocalBoxFuture<'static, Result<(), Rc<dyn Error>>>),
}

const INCOMPLETE_FRAME_WRITE: &str = "Incomplete ACP frame write";

fn io_shared<T>(result: io::Result<T>) -> Result<T, Rc<dyn Error>> {
    result.map_err(|error| {
        if error.kind() == io::ErrorKind::BrokenPipe {
            return shared(garcon_base::errors::NamedError {
                name: "Error".to_owned(),
                message: "EPIPE: broken pipe, write".to_owned(),
                code: Some("EPIPE".to_owned()),
            });
        }
        Rc::new(error) as Rc<dyn Error>
    })
}

/// `writeFrame`: writes one frame and, when the send is confirmed, flushes
/// it. A write that took fewer bytes than the frame, or that found the input
/// closed, is incomplete.
fn write_frame(
    stdin: &AcpStdinHandle,
    frame: &[u8],
    confirm: bool,
) -> Result<FrameFlush, Rc<dyn Error>> {
    let written = io_shared(stdin.borrow_mut().write(frame))?;
    if !confirm {
        return Ok(match written {
            StdinReport::Accepted(_) | StdinReport::Closed => FrameFlush::Settled,
            StdinReport::Pending(written) => {
                FrameFlush::Pending(Box::pin(
                    async move { io_shared(written.await).map(|_| ()) },
                ))
            }
        });
    }
    match written {
        StdinReport::Accepted(bytes) => flush(stdin, bytes, false, frame.len()),
        // The sink's `true` is neither the count nor `undefined`.
        StdinReport::Closed => flush(stdin, None, true, frame.len()),
        StdinReport::Pending(written) => {
            let stdin = Rc::clone(stdin);
            let length = frame.len();
            Ok(FrameFlush::Pending(Box::pin(async move {
                let bytes = io_shared(written.await)?;
                match flush(&stdin, bytes, false, length)? {
                    FrameFlush::Settled => Ok(()),
                    FrameFlush::Pending(flushed) => flushed.await,
                }
            })))
        }
    }
}

fn flush(
    stdin: &AcpStdinHandle,
    bytes: Option<usize>,
    incomplete: bool,
    length: usize,
) -> Result<FrameFlush, Rc<dyn Error>> {
    if incomplete || bytes.is_some_and(|bytes| bytes != length) {
        return Err(shared_error(INCOMPLETE_FRAME_WRITE));
    }
    Ok(match io_shared(stdin.borrow_mut().flush())? {
        StdinReport::Accepted(_) | StdinReport::Closed => FrameFlush::Settled,
        StdinReport::Pending(flushed) => {
            FrameFlush::Pending(Box::pin(
                async move { io_shared(flushed.await).map(|_| ()) },
            ))
        }
    })
}

/// The decoded text of one pipe, split into lines as it arrives.
struct LineBuffer {
    text: String,
    pending: Vec<u8>,
    at_start: bool,
}

impl LineBuffer {
    fn new() -> Self {
        Self {
            text: String::new(),
            pending: Vec::new(),
            at_start: true,
        }
    }

    /// Appends what a read returned and returns the lines it completes;
    /// `None` ends the stream, which completes an unterminated last line.
    fn receive(&mut self, value: Option<&[u8]>) -> Vec<String> {
        let last = value.is_none();
        let decoded = self.decode(value.unwrap_or(&[]), last);
        self.text.push_str(&decoded);
        let mut lines: Vec<String> = std::mem::take(&mut self.text)
            .split('\n')
            .map(str::to_owned)
            .collect();
        if !last {
            self.text = lines.pop().unwrap_or_default();
        }
        lines
            .iter()
            .filter_map(|line| {
                let trimmed = trim(line);
                (!trimmed.is_empty()).then(|| trimmed.to_owned())
            })
            .collect()
    }

    /// `TextDecoder` over a byte stream: an incomplete sequence waits for
    /// more bytes, a malformed one reads as U+FFFD, and a byte order mark at
    /// the start is dropped.
    fn decode(&mut self, bytes: &[u8], last: bool) -> String {
        let mut input = std::mem::take(&mut self.pending);
        input.extend_from_slice(bytes);
        let split = if last {
            input.len()
        } else {
            incomplete_tail(&input)
        };
        self.pending.extend_from_slice(&input[split..]);
        let mut text = String::from_utf8_lossy(&input[..split]).into_owned();
        if self.at_start && split > 0 {
            self.at_start = false;
            if let Some(rest) = text.strip_prefix('\u{feff}') {
                text = rest.to_owned();
            }
        }
        text
    }
}

/// The start of the longest suffix of `input` that begins a UTF-8 sequence
/// the next read may complete.
fn incomplete_tail(input: &[u8]) -> usize {
    (1..=3.min(input.len()))
        .map(|length| input.len() - length)
        .find(|&start| starts_sequence(&input[start..]))
        .unwrap_or(input.len())
}

/// Whether `bytes` is the beginning of a UTF-8 sequence that needs more
/// bytes to be complete or malformed.
fn starts_sequence(bytes: &[u8]) -> bool {
    let Some((&lead, rest)) = bytes.split_first() else {
        return false;
    };
    let (expected, lowest, highest) = match lead {
        0xC2..=0xDF => (2, 0x80, 0xBF),
        0xE0 => (3, 0xA0, 0xBF),
        0xE1..=0xEC | 0xEE..=0xEF => (3, 0x80, 0xBF),
        0xED => (3, 0x80, 0x9F),
        0xF0 => (4, 0x90, 0xBF),
        0xF1..=0xF3 => (4, 0x80, 0xBF),
        0xF4 => (4, 0x80, 0x8F),
        _ => return false,
    };
    if bytes.len() >= expected {
        return false;
    }
    match rest.split_first() {
        None => true,
        Some((&second, _)) if !(lowest..=highest).contains(&second) => false,
        Some(_) => rest.iter().all(|&byte| (0x80..=0xBF).contains(&byte)),
    }
}

#[cfg(test)]
mod tests;
