//! Ports `server-agents/pi/src/agents/pi/pi-rpc-client.ts`.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::rc::Rc;
use std::time::Duration;

use garcon_base::errors::{DiagnosticError, ErrorMetadata};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{
    json::{self, Opaque},
    trim,
};
use indexmap::IndexMap;
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::AbortHandle;

pub const DEFAULT_RESPONSE_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Clone, PartialEq)]
pub struct PiRpcResponse {
    pub id: String,
    pub command: String,
    pub success: bool,
    pub error: Option<String>,
    pub data: Option<Opaque>,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct PiRpcCommandError {
    pub command: String,
    message: String,
}

impl PiRpcCommandError {
    fn new(response: PiRpcResponse) -> Self {
        let command = response.command;
        let message = response
            .error
            .unwrap_or_else(|| format!("Pi rejected the {command} command"));
        Self { command, message }
    }
}

impl DiagnosticError for PiRpcCommandError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "PiRpcCommandError",
            code: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct PiRpcTransportError {
    message: String,
    pub write_attempted: bool,
}

impl PiRpcTransportError {
    pub fn new(message: impl Into<String>, write_attempted: bool) -> Self {
        Self {
            message: message.into(),
            write_attempted,
        }
    }
}

impl DiagnosticError for PiRpcTransportError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "PiRpcTransportError",
            code: None,
        }
    }
}

pub type ResponseObserver = Box<dyn FnOnce(&PiRpcResponse) -> ExecutorResult<()>>;

struct PendingRequest {
    command: String,
    observe: Option<ResponseObserver>,
    response: oneshot::Sender<ExecutorResult<PiRpcResponse>>,
    timer: Option<AbortHandle>,
    write_attempted: bool,
}

pub struct PiRpcClientOptions {
    pub on_event: Rc<dyn Fn(Opaque)>,
    pub on_malformed: Rc<dyn Fn(&str)>,
}

struct State {
    options: PiRpcClientOptions,
    pending: RefCell<IndexMap<String, PendingRequest>>,
    next_id: Cell<u64>,
    disposed: Cell<bool>,
    killed: Rc<Cell<bool>>,
}

struct WriteLine {
    id: String,
    bytes: Vec<u8>,
    timeout_ms: Option<u64>,
}

#[derive(Clone)]
pub struct PiRpcClient {
    state: Rc<State>,
    writes: mpsc::UnboundedSender<WriteLine>,
    exited: watch::Receiver<Option<i32>>,
}

impl PiRpcClient {
    pub fn new(
        stdin: Option<Box<dyn AsyncWrite + Unpin>>,
        stdout: Option<Box<dyn AsyncRead + Unpin>>,
        exited: watch::Receiver<Option<i32>>,
        killed: Rc<Cell<bool>>,
        options: PiRpcClientOptions,
    ) -> Self {
        let state = Rc::new(State {
            options,
            pending: RefCell::default(),
            next_id: Cell::new(0),
            disposed: Cell::new(false),
            killed,
        });
        let (writes, lines) = mpsc::unbounded_channel();
        {
            let state = state.clone();
            let mut exited = exited.clone();
            tokio::task::spawn_local(async move {
                let exit = exited.wait_for(|exit| exit.is_some()).await;
                if let Some(code) = exit.ok().and_then(|exit| *exit) {
                    state.dispose(&format!("Pi process exited with code {code}"));
                } else {
                    state.dispose("Pi process exit unavailable");
                }
            });
        }
        tokio::task::spawn_local(write_lines(state.clone(), stdin, lines));
        if let Some(stdout) = stdout {
            tokio::task::spawn_local(read_stdout(state.clone(), stdout));
        }
        Self {
            state,
            writes,
            exited,
        }
    }

    pub async fn exited(&self) -> Option<i32> {
        self.exited
            .clone()
            .wait_for(|exit| exit.is_some())
            .await
            .ok()
            .and_then(|exit| *exit)
    }

    pub fn send(
        &self,
        command: Map<String, Value>,
        timeout_ms: u64,
        observe: Option<ResponseObserver>,
    ) -> impl Future<Output = ExecutorResult<PiRpcResponse>> + use<> {
        self.send_inner(command, Some(timeout_ms), observe)
    }

    pub fn send_unbounded(
        &self,
        command: Map<String, Value>,
        observe: Option<ResponseObserver>,
    ) -> impl Future<Output = ExecutorResult<PiRpcResponse>> + use<> {
        self.send_inner(command, None, observe)
    }

    pub fn dispose(&self, reason: &str) {
        self.state.dispose(reason);
    }

    fn send_inner(
        &self,
        mut command: Map<String, Value>,
        timeout_ms: Option<u64>,
        observe: Option<ResponseObserver>,
    ) -> impl Future<Output = ExecutorResult<PiRpcResponse>> + use<> {
        let enqueue = || -> ExecutorResult<_> {
            if self.state.disposed.get() {
                return Err(PiRpcTransportError::new("Pi RPC client is disposed", false).into());
            }
            let index = self.state.next_id.get() + 1;
            self.state.next_id.set(index);
            let id = format!("garcon-{index}");
            let kind = command
                .get("type")
                .filter(|kind| !kind.is_null())
                .map(|kind| {
                    garcon_base::errors::js_string(garcon_base::errors::ErrorInput::Json(kind))
                        .into_owned()
                })
                .unwrap_or_else(|| "unknown".to_owned());
            command.insert("id".to_owned(), Value::String(id.clone()));
            let mut bytes = json::stringify(&Value::Object(command)).into_bytes();
            bytes.push(b'\n');
            let (response, receiver) = oneshot::channel();
            self.state.pending.borrow_mut().insert(
                id.clone(),
                PendingRequest {
                    command: kind,
                    observe,
                    response,
                    timer: None,
                    write_attempted: false,
                },
            );
            if let Err(error) = self.writes.send(WriteLine {
                id,
                bytes,
                timeout_ms,
            }) {
                self.state
                    .fail(&error.0.id, "Pi process stdin is unavailable");
            }
            Ok(receiver)
        };
        let receiver = enqueue();
        async move {
            receiver?
                .await
                .map_err(|_| PiRpcTransportError::new("Pi RPC client is disposed", false))?
        }
    }
}

impl State {
    fn dispose(&self, reason: &str) {
        if self.disposed.replace(true) {
            return;
        }
        let pending = self.pending.take();
        for (_, request) in pending {
            reject(request, reason);
        }
    }

    fn fail(&self, id: &str, message: impl Into<String>) {
        if let Some(request) = self.pending.borrow_mut().shift_remove(id) {
            reject(request, message);
        }
    }

    fn handle_line(&self, line: &str) {
        if trim(line).is_empty() {
            return;
        }
        let Ok(record) = json::from_str::<Opaque>(line) else {
            (self.options.on_malformed)(line);
            return;
        };
        if !record.is_object() {
            (self.options.on_malformed)(line);
            return;
        }
        if record["type"] == "response"
            && let Some(id) = record["id"].as_str()
        {
            let request = self.pending.borrow_mut().shift_remove(id);
            let Some(request) = request else {
                return;
            };
            if let Some(timer) = request.timer {
                timer.abort();
            }
            let response = PiRpcResponse {
                id: id.to_owned(),
                command: record["command"]
                    .as_str()
                    .map_or(request.command, str::to_owned),
                success: record["success"] == true,
                error: record["error"].as_str().map(str::to_owned),
                data: record
                    .get("data")
                    .filter(|data| data.is_object())
                    .cloned()
                    .map(Opaque::from_value),
            };
            let outcome = if response.success {
                // Observes acceptance before delivering later events in the same stdout read.
                request
                    .observe
                    .map_or(Ok(()), |observe| observe(&response))
                    .map(|()| response)
            } else {
                Err(PiRpcCommandError::new(response).into())
            };
            let _ = request.response.send(outcome);
            return;
        }
        (self.options.on_event)(record);
    }
}

fn reject(pending: PendingRequest, message: impl Into<String>) {
    if let Some(timer) = pending.timer {
        timer.abort();
    }
    let _ = pending.response.send(Err(PiRpcTransportError::new(
        message,
        pending.write_attempted,
    )
    .into()));
}

async fn write_lines(
    state: Rc<State>,
    mut stdin: Option<Box<dyn AsyncWrite + Unpin>>,
    mut writes: mpsc::UnboundedReceiver<WriteLine>,
) {
    while let Some(line) = writes.recv().await {
        if !state.pending.borrow().contains_key(&line.id) {
            continue;
        }
        let Some(stdin) = &mut stdin else {
            state.fail(&line.id, "Pi process stdin is unavailable");
            continue;
        };
        if state.killed.get() || state.disposed.get() {
            state.fail(&line.id, "Pi process is not writable");
            continue;
        }
        if let Some(pending) = state.pending.borrow_mut().get_mut(&line.id) {
            pending.write_attempted = true;
        }
        let written = async {
            stdin.write_all(&line.bytes).await?;
            stdin.flush().await
        }
        .await;
        if let Err(error) = written {
            state.fail(&line.id, error.to_string());
            continue;
        }
        let Some(timeout_ms) = line.timeout_ms else {
            continue;
        };
        let mut pending = state.pending.borrow_mut();
        if let Some(request) = pending.get_mut(&line.id) {
            let id = line.id;
            let command = request.command.clone();
            let state = state.clone();
            request.timer = Some(
                tokio::task::spawn_local(async move {
                    tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                    state.fail(
                        &id,
                        format!("Pi {command} response timed out after {timeout_ms}ms"),
                    );
                })
                .abort_handle(),
            );
        }
    }
}

async fn read_stdout(state: Rc<State>, stdout: Box<dyn AsyncRead + Unpin>) {
    let mut reader = BufReader::new(stdout);
    let mut buffer = Vec::new();
    let mut first = true;
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&buffer);
        let line = if std::mem::take(&mut first) {
            line.strip_prefix('\u{feff}').unwrap_or(&line)
        } else {
            &line
        };
        let line = line.strip_suffix('\n').unwrap_or(line);
        state.handle_line(line.strip_suffix('\r').unwrap_or(line));
    }
}
