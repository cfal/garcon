use std::{
    cell::{Cell, RefCell},
    error::Error,
    io,
    process::{ExitStatus, Stdio},
    rc::Rc,
    time::Duration,
};

use futures::{
    FutureExt,
    future::{LocalBoxFuture, Shared},
};
use garcon_base::errors::{SharedDiagnosticError, error_metadata};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    resources::ExecutorResult,
};
use garcon_js::{
    Number,
    json::{Opaque, as_number, from_str, stringify},
    math_round, performance_now_ms, trim,
};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{mpsc, oneshot, watch},
    task::AbortHandle,
};

use super::{
    cli::{CodexCommandSource, IncompatibleCodex, ResolvedCodexCli, assert_compatible_codex},
    config_overrides::append_codex_config_args,
    protocol::{
        JsonRpcId, JsonRpcNotification, JsonRpcServerRequest, ThreadItemsListResponse,
        ThreadTurnsListResponse, parse_thread_items_list_response,
        parse_thread_turns_list_response,
    },
};

pub const CODEX_STEER_ACKNOWLEDGEMENT_TIMEOUT: Duration = Duration::from_secs(15);

pub type CodexCliResolver = Rc<
    dyn Fn(&IndexMap<String, String>) -> LocalBoxFuture<'static, ExecutorResult<ResolvedCodexCli>>,
>;
pub type CodexAppServerListener = Rc<dyn Fn(&CodexAppServerEvent) -> ExecutorResult<()>>;

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct CodexAppServerRpcError {
    pub message: String,
    pub code: Number,
    pub data: Option<Opaque>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexDeliveryOutcome {
    NotSent,
    Unknown,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{safe_message}")]
pub struct CodexAppServerDeliveryError {
    pub outcome: CodexDeliveryOutcome,
    pub safe_message: &'static str,
    #[source]
    cause: Rc<dyn Error>,
}

impl CodexAppServerDeliveryError {
    fn new(outcome: CodexDeliveryOutcome, cause: Box<dyn Error>) -> Self {
        let safe_message = match outcome {
            CodexDeliveryOutcome::NotSent => "Codex steering input was not sent",
            CodexDeliveryOutcome::Unknown => "Codex steering outcome could not be confirmed",
        };
        Self {
            outcome,
            safe_message,
            cause: Rc::from(cause),
        }
    }
}

pub struct CodexSteerRequestOptions<'a> {
    pub prepare_delivery: LocalBoxFuture<'a, ExecutorResult<()>>,
    pub acknowledgement_timeout: Option<Duration>,
}

pub struct CodexAppServerClientOptions {
    pub env: IndexMap<String, String>,
    pub config: Option<Value>,
    pub model_catalog_path: Option<String>,
    pub resolve_cli: CodexCliResolver,
    pub client_version: Rc<dyn Fn() -> String>,
    pub shutdown_grace: Duration,
    pub shutdown_terminate: Duration,
    pub shutdown_kill: Duration,
}

impl CodexAppServerClientOptions {
    pub fn new(resolve_cli: CodexCliResolver) -> Self {
        Self {
            env: IndexMap::new(),
            config: None,
            model_catalog_path: None,
            resolve_cli,
            client_version: Rc::new(|| "0.1.0".to_owned()),
            shutdown_grace: Duration::from_secs(2),
            shutdown_terminate: Duration::from_secs(5),
            shutdown_kill: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CodexAppServerMetric {
    Startup {
        duration_ms: f64,
        command_source: CodexCommandSource,
    },
    Request {
        duration_ms: f64,
        method: String,
        success: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum CodexAppServerEvent {
    Notification(JsonRpcNotification),
    ServerRequest(JsonRpcServerRequest),
    Warning(String),
    Stderr(String),
    Exit(i32),
    Metric(CodexAppServerMetric),
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
struct ClientMessage(String);

fn message(text: impl Into<String>) -> Box<dyn Error> {
    Box::new(ClientMessage(text.into()))
}

type SharedResult<T> = Result<T, Rc<dyn Error>>;
type SharedTask<T> = Shared<LocalBoxFuture<'static, SharedResult<T>>>;

struct PendingRequest {
    resolve: oneshot::Sender<ExecutorResult<Opaque>>,
    timeout: Option<AbortHandle>,
    delivery_outcome: Option<CodexDeliveryOutcome>,
}

enum WriterMessage {
    Frame {
        bytes: Vec<u8>,
        request: Option<u64>,
    },
    Close,
}

struct CodexAppServerProcess {
    #[cfg(unix)]
    pid: u32,
    stdin: mpsc::UnboundedSender<WriterMessage>,
    exited: watch::Receiver<Option<i32>>,
    #[cfg(windows)]
    signals: mpsc::UnboundedSender<ProcessSignal>,
}

#[derive(Clone, Copy)]
enum ProcessSignal {
    Terminate,
    Kill,
}

impl CodexAppServerProcess {
    fn signal(&self, signal: ProcessSignal) -> io::Result<()> {
        #[cfg(unix)]
        {
            if self.exited.borrow().is_some() {
                return Ok(());
            }
            let pid = libc::pid_t::try_from(self.pid).map_err(io::Error::other)?;
            let (pid, signal) = match signal {
                ProcessSignal::Terminate => (pid, libc::SIGTERM),
                ProcessSignal::Kill => (-pid, libc::SIGKILL),
            };
            // SAFETY: This ID belongs to the spawned child or its dedicated session.
            if unsafe { libc::kill(pid, signal) } < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error);
                }
            }
        }
        #[cfg(windows)]
        let _ = self.signals.send(signal);
        Ok(())
    }

    async fn wait_for_exit(&self, timeout: Duration) -> bool {
        let mut exited = self.exited.clone();
        tokio::time::timeout(timeout, exited.wait_for(Option::is_some))
            .await
            .is_ok()
    }
}

#[derive(Default)]
struct ClientState {
    process: Option<Rc<CodexAppServerProcess>>,
    process_generation: u64,
    pending: IndexMap<u64, PendingRequest>,
    ready: Option<SharedTask<Opaque>>,
    initialized: bool,
    shutdown: Option<SharedTask<()>>,
    shutdown_requested: bool,
}

struct Client {
    options: CodexAppServerClientOptions,
    next_id: Cell<u64>,
    next_listener: Cell<u64>,
    listeners: RefCell<IndexMap<u64, CodexAppServerListener>>,
    state: RefCell<ClientState>,
}

#[derive(Clone)]
pub struct CodexAppServerClient(Rc<Client>);

impl CodexAppServerClient {
    pub fn new(mut options: CodexAppServerClientOptions) -> Self {
        let mut env: IndexMap<_, _> = std::env::vars_os()
            .filter_map(|(key, value)| {
                Some((
                    key.into_string().ok()?,
                    value.to_string_lossy().into_owned(),
                ))
            })
            .collect();
        env.extend(options.env);
        options.env = env;
        Self(Rc::new(Client {
            options,
            next_id: Cell::new(1),
            next_listener: Cell::new(1),
            listeners: RefCell::new(IndexMap::new()),
            state: RefCell::new(ClientState::default()),
        }))
    }

    pub fn on_event(&self, listener: CodexAppServerListener) -> impl FnOnce() + use<> {
        let id = self.0.next_listener.get();
        self.0.next_listener.set(id + 1);
        self.0.listeners.borrow_mut().insert(id, listener);
        let client = Rc::downgrade(&self.0);
        move || {
            if let Some(client) = client.upgrade() {
                client.listeners.borrow_mut().shift_remove(&id);
            }
        }
    }

    pub async fn connect(&self) -> ExecutorResult<Opaque> {
        let ready = {
            let mut state = self.0.state.borrow_mut();
            if state.shutdown_requested {
                return Err(message("Codex app-server client is shut down"));
            }
            if let Some(ready) = &state.ready {
                ready.clone()
            } else {
                let client = self.clone();
                let ready = async move {
                    let result = client.start().await.map_err(Rc::from);
                    if result.is_err() {
                        client.0.state.borrow_mut().ready = None;
                    }
                    result
                }
                .boxed_local()
                .shared();
                state.ready = Some(ready.clone());
                tokio::task::spawn_local(ready.clone());
                ready
            }
        };
        ready.await.map_err(shared_error)
    }

    pub async fn request(
        &self,
        method: &str,
        params: Option<&impl Serialize>,
        timeout: Option<Duration>,
    ) -> ExecutorResult<Opaque> {
        self.connect().await?;
        let started = performance_now_ms();
        let result = self.send_request(method, params, timeout).await;
        self.emit_request_metric(method, started, result.is_ok())?;
        result
    }

    pub fn notify(&self, method: &str, params: Option<&impl Serialize>) -> ExecutorResult<()> {
        self.write_frame(&NotificationFrame { method, params }, None)
    }

    pub fn respond(&self, id: &JsonRpcId, result: &impl Serialize) -> ExecutorResult<()> {
        #[derive(Serialize)]
        struct Response<'a, T> {
            id: &'a JsonRpcId,
            result: &'a T,
        }
        self.write_frame(&Response { id, result }, None)
    }

    pub fn reject(&self, id: &JsonRpcId, code: Number, text: &str) -> ExecutorResult<()> {
        #[derive(Serialize)]
        struct Response<'a> {
            id: &'a JsonRpcId,
            error: RpcFailure<'a>,
        }
        #[derive(Serialize)]
        struct RpcFailure<'a> {
            code: Number,
            message: &'a str,
        }
        self.write_frame(
            &Response {
                id,
                error: RpcFailure {
                    code,
                    message: text,
                },
            },
            None,
        )
    }

    pub async fn list_thread_turns(
        &self,
        params: &impl Serialize,
    ) -> ExecutorResult<ThreadTurnsListResponse> {
        let response = self
            .request("thread/turns/list", Some(params), None)
            .await?;
        Ok(parse_thread_turns_list_response(&response)?)
    }

    pub async fn list_thread_items(
        &self,
        params: &impl Serialize,
    ) -> ExecutorResult<ThreadItemsListResponse> {
        let response = self
            .request("thread/items/list", Some(params), None)
            .await?;
        Ok(parse_thread_items_list_response(&response)?)
    }

    pub async fn steer_turn(
        &self,
        params: &impl Serialize,
        options: Option<CodexSteerRequestOptions<'_>>,
    ) -> ExecutorResult<Opaque> {
        let Some(options) = options else {
            return self.request("turn/steer", Some(params), None).await;
        };
        self.connect().await?;
        let started = performance_now_ms();
        let result = self
            .send_strict_request("turn/steer", params, options)
            .await;
        self.emit_request_metric("turn/steer", started, result.is_ok())?;
        result
    }

    pub async fn shutdown(&self) -> ExecutorResult<()> {
        let shutdown = {
            let mut state = self.0.state.borrow_mut();
            state.shutdown_requested = true;
            if let Some(existing) = &state.shutdown {
                existing.clone()
            } else {
                state.ready = None;
                let Some(proc) = state.process.take() else {
                    return Ok(());
                };
                let client = self.clone();
                let task = async move {
                    let result = client.shutdown_process(&proc).await.map_err(Rc::from);
                    client.0.state.borrow_mut().shutdown = None;
                    result
                }
                .boxed_local()
                .shared();
                state.shutdown = Some(task.clone());
                tokio::task::spawn_local(task.clone());
                task
            }
        };
        shutdown.await.map_err(shared_error)
    }

    async fn start(&self) -> ExecutorResult<Opaque> {
        let started = performance_now_ms();
        let options = &self.0.options;
        let resolved = (options.resolve_cli)(&options.env).await?;
        if self.0.state.borrow().shutdown_requested {
            return Err(message("Codex app-server client is shut down"));
        }
        let previous = self.0.state.borrow().process.clone();
        if let Some(previous) = previous {
            // Waits for a rejected startup peer instead of leaving its writer running as the original can.
            self.shutdown_process(&previous).await?;
            if self.0.state.borrow().shutdown_requested {
                return Err(message("Codex app-server client is shut down"));
            }
        }
        let mut args = vec!["app-server".into(), "--listen".into(), "stdio://".into()];
        append_codex_config_args(&mut args, options.config.as_ref())?;
        for flag in [
            "features.goals=false",
            "features.wake_on_agent_messages=false",
            "features.default_mode_request_user_input=true",
        ] {
            args.extend(["--config".into(), flag.into()]);
        }
        if let Some(path) = options
            .model_catalog_path
            .as_ref()
            .filter(|path| !path.is_empty())
        {
            args.extend([
                "--config".into(),
                format!("model_catalog_json={}", serde_json::to_string(path)?),
            ]);
        }
        self.spawn(&resolved.command, &args)?;
        let initialization = json!({
            "clientInfo":{"name":"garcon","title":"Garcon","version":(options.client_version)()},
            "capabilities":{"experimentalApi":true,"requestAttestation":false}
        });
        let initialized = self
            .send_request("initialize", Some(&initialization), None)
            .await?;
        if let Err(error) =
            assert_compatible_codex(initialized["userAgent"].as_str().unwrap_or_default())
        {
            self.shutdown().await?;
            return Err(Box::new(error));
        }
        self.emit(CodexAppServerEvent::Metric(CodexAppServerMetric::Startup {
            duration_ms: math_round(performance_now_ms() - started),
            command_source: resolved.source,
        }))?;
        self.notify("initialized", None::<&Value>)?;
        self.0.state.borrow_mut().initialized = true;
        Ok(initialized)
    }

    async fn send_request(
        &self,
        method: &str,
        params: Option<&impl Serialize>,
        timeout: Option<Duration>,
    ) -> ExecutorResult<Opaque> {
        let id = self.next_id();
        let respond = self.pending_request(id, method, timeout, None);
        if let Err(error) = self.write_frame(&RequestFrame { id, method, params }, Some(id)) {
            self.clear_pending(id);
            return Err(error);
        }
        respond.await?
    }

    async fn send_strict_request(
        &self,
        method: &str,
        params: &impl Serialize,
        options: CodexSteerRequestOptions<'_>,
    ) -> ExecutorResult<Opaque> {
        let id = self.next_id();
        let bytes = encode_frame(&RequestFrame {
            id,
            method,
            params: Some(params),
        })
        .map_err(|error| {
            CodexAppServerDeliveryError::new(CodexDeliveryOutcome::NotSent, error.into())
        })?;
        let stdin = self.stdin().map_err(|error| {
            CodexAppServerDeliveryError::new(CodexDeliveryOutcome::NotSent, error)
        })?;
        options.prepare_delivery.await?;
        let response = self.pending_request(
            id,
            method,
            Some(
                options
                    .acknowledgement_timeout
                    .unwrap_or(CODEX_STEER_ACKNOWLEDGEMENT_TIMEOUT),
            ),
            Some(CodexDeliveryOutcome::Unknown),
        );
        if stdin
            .send(WriterMessage::Frame {
                bytes,
                request: Some(id),
            })
            .is_err()
        {
            self.clear_pending(id);
            return Err(Box::new(CodexAppServerDeliveryError::new(
                CodexDeliveryOutcome::Unknown,
                stdin_unavailable(),
            )));
        }
        response.await?
    }

    fn pending_request(
        &self,
        id: u64,
        method: &str,
        timeout: Option<Duration>,
        delivery_outcome: Option<CodexDeliveryOutcome>,
    ) -> oneshot::Receiver<ExecutorResult<Opaque>> {
        let (resolve, respond) = oneshot::channel();
        let timeout = timeout.map(|duration| {
            let client = self.clone();
            let deadline = tokio::time::Instant::now() + duration;
            let method = method.to_owned();
            tokio::task::spawn_local(async move {
                tokio::time::sleep_until(deadline).await;
                let pending = client.0.state.borrow_mut().pending.shift_remove(&id);
                if let Some(pending) = pending {
                    let error: Box<dyn Error> = match delivery_outcome {
                        Some(outcome) => Box::new(CodexAppServerDeliveryError::new(
                            outcome,
                            message("Codex steering acknowledgement timed out"),
                        )),
                        None => Box::new(AgentIntegrationError::new(
                            AgentIntegrationErrorCode::TIMEOUT,
                            format!("Codex {method} timed out"),
                            true,
                            None,
                        )),
                    };
                    let _ = pending.resolve.send(Err(error));
                }
            })
            .abort_handle()
        });
        self.0.state.borrow_mut().pending.insert(
            id,
            PendingRequest {
                resolve,
                timeout,
                delivery_outcome,
            },
        );
        respond
    }

    fn clear_pending(&self, id: u64) -> Option<PendingRequest> {
        let pending = self.0.state.borrow_mut().pending.shift_remove(&id)?;
        if let Some(timeout) = &pending.timeout {
            timeout.abort();
        }
        Some(pending)
    }

    fn next_id(&self) -> u64 {
        let id = self.0.next_id.get();
        self.0.next_id.set(id + 1);
        id
    }

    fn emit_request_metric(&self, method: &str, started: f64, success: bool) -> ExecutorResult<()> {
        self.emit(CodexAppServerEvent::Metric(CodexAppServerMetric::Request {
            duration_ms: math_round(performance_now_ms() - started),
            method: method.to_owned(),
            success,
        }))
    }

    fn emit(&self, event: CodexAppServerEvent) -> ExecutorResult<()> {
        let listeners: Vec<_> = self.0.listeners.borrow().values().cloned().collect();
        for listener in listeners {
            listener(&event)?;
        }
        Ok(())
    }

    fn warn(&self, text: impl Into<String>) {
        let _ = self.emit(CodexAppServerEvent::Warning(text.into()));
    }

    fn stdin(&self) -> ExecutorResult<mpsc::UnboundedSender<WriterMessage>> {
        self.0
            .state
            .borrow()
            .process
            .as_ref()
            .map(|proc| proc.stdin.clone())
            .ok_or_else(stdin_unavailable)
    }

    fn write_frame(&self, payload: &impl Serialize, request: Option<u64>) -> ExecutorResult<()> {
        let stdin = self.stdin()?;
        let bytes = encode_frame(payload)?;
        stdin
            .send(WriterMessage::Frame { bytes, request })
            .map_err(|_| stdin_unavailable())
    }

    fn spawn(&self, executable: &str, args: &[String]) -> ExecutorResult<()> {
        let mut command = Command::new(executable);
        command
            .args(args)
            .env_clear()
            .envs(&self.0.options.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        // SAFETY: setsid only invokes the OS to create the child's session.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut child = command.spawn()?;
        #[cfg(unix)]
        let pid = child
            .id()
            .ok_or_else(|| message("Codex app-server has no process ID"))?;
        let stdin = child.stdin.take().ok_or_else(stdin_unavailable)?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| message("Codex app-server stdout is unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| message("Codex app-server stderr is unavailable"))?;
        let (write_frames, frames) = mpsc::unbounded_channel();
        let (exit, exited) = watch::channel(None);
        #[cfg(windows)]
        let (signals, signal_commands) = mpsc::unbounded_channel();
        let proc = Rc::new(CodexAppServerProcess {
            #[cfg(unix)]
            pid,
            stdin: write_frames,
            exited,
            #[cfg(windows)]
            signals,
        });
        let generation = {
            let mut state = self.0.state.borrow_mut();
            state.process_generation += 1;
            state.process = Some(proc);
            state.process_generation
        };
        let client = self.clone();
        tokio::task::spawn_local(async move {
            client.write_stdin(stdin, frames).await;
        });
        let client = self.clone();
        tokio::task::spawn_local(async move {
            client.read_stdout(stdout, generation).await;
        });
        let client = self.clone();
        tokio::task::spawn_local(async move {
            client.read_stderr(stderr, generation).await;
        });
        let client = self.clone();
        tokio::task::spawn_local(async move {
            #[cfg(not(windows))]
            let status = child.wait().await;
            #[cfg(windows)]
            let status = wait_child(&mut child, signal_commands).await;
            let code = status.map_or(1, exit_code);
            client.watch_exit(code);
            let _ = exit.send(Some(code));
        });
        Ok(())
    }

    async fn write_stdin(
        &self,
        mut stdin: tokio::process::ChildStdin,
        mut frames: mpsc::UnboundedReceiver<WriterMessage>,
    ) {
        while let Some(frame) = frames.recv().await {
            match frame {
                WriterMessage::Frame { bytes, request } => {
                    if let Err(error) = stdin.write_all(&bytes).await
                        && let Some(id) = request
                        && let Some(pending) = self.clear_pending(id)
                    {
                        reject_pending(pending, Box::new(error));
                    }
                }
                WriterMessage::Close => {
                    let _ = stdin.shutdown().await;
                    break;
                }
            }
        }
    }

    async fn read_stdout(&self, mut stream: impl AsyncRead + Unpin, generation: u64) {
        let mut buffer = [0; 8192];
        let mut pending = Vec::new();
        let mut first = true;
        loop {
            let read = stream.read(&mut buffer).await;
            if self.0.state.borrow().process_generation != generation {
                return;
            }
            let count = match read {
                Ok(0) => return,
                Ok(count) => count,
                Err(error) => {
                    self.warn(format!("Codex app-server stdout read failed: {error}"));
                    return;
                }
            };
            for piece in buffer[..count].split_inclusive(|byte| *byte == b'\n') {
                pending.extend_from_slice(piece);
                if !piece.ends_with(b"\n") {
                    continue;
                }
                let raw = String::from_utf8_lossy(&pending);
                let line = if first {
                    raw.strip_prefix('\u{feff}').unwrap_or(&raw)
                } else {
                    &raw
                };
                first = false;
                let line = trim(line);
                if !line.is_empty()
                    && let Err(error) = self.handle_line(line)
                {
                    self.warn(format!("Codex app-server message handler failed: {error}"));
                }
                pending.clear();
            }
        }
    }

    fn handle_line(&self, line: &str) -> ExecutorResult<()> {
        let Ok(value) = from_str::<Value>(line) else {
            self.warn("Codex app-server emitted invalid JSON.");
            return Ok(());
        };
        let Some(obj) = value.as_object() else {
            return Ok(());
        };
        let number_id = obj.get("id").and_then(as_number);
        if let Some(id) = number_id {
            if let Some(result) = obj.get("result") {
                if let Some(pending) = self.response_slot(id) {
                    let _ = pending.resolve.send(Ok(Opaque::from_value(result.clone())));
                }
                return Ok(());
            }
            if let Some(failure) = obj.get("error") {
                if let Some(pending) = self.response_slot(id) {
                    let error = CodexAppServerRpcError {
                        message: failure["message"].as_str().unwrap_or_default().to_owned(),
                        code: Number(as_number(&failure["code"]).unwrap_or(f64::NAN)),
                        data: failure.get("data").cloned().map(Opaque::from_value),
                    };
                    let _ = pending.resolve.send(Err(Box::new(error)));
                }
                return Ok(());
            }
        }
        if let Some(method) = obj.get("method").and_then(Value::as_str) {
            let id = number_id
                .map(|id| JsonRpcId::Number(Number(id)))
                .or_else(|| {
                    obj.get("id")
                        .and_then(Value::as_str)
                        .map(|id| JsonRpcId::String(id.into()))
                });
            let params = obj.get("params").cloned().map(Opaque::from_value);
            let event = if let Some(id) = id {
                CodexAppServerEvent::ServerRequest(JsonRpcServerRequest {
                    id,
                    method: method.into(),
                    params,
                })
            } else {
                CodexAppServerEvent::Notification(JsonRpcNotification {
                    method: method.into(),
                    params,
                })
            };
            self.emit(event)?;
        }
        Ok(())
    }

    fn response_slot(&self, id: f64) -> Option<PendingRequest> {
        let pending = if id >= 0.0 && id.fract() == 0.0 && id < u64::MAX as f64 {
            self.clear_pending(id as u64)
        } else {
            None
        };
        if pending.is_none() {
            self.warn(format!(
                "Ignoring late Codex app-server response: {}",
                Number(id)
            ));
        }
        pending
    }

    async fn read_stderr(&self, mut stream: impl AsyncRead + Unpin, generation: u64) {
        let mut buffer = [0; 8192];
        let mut pending = Vec::new();
        let mut first = true;
        while let Ok(count) = stream.read(&mut buffer).await {
            if count == 0 || self.0.state.borrow().process_generation != generation {
                return;
            }
            pending.extend_from_slice(&buffer[..count]);
            let complete = match std::str::from_utf8(&pending) {
                Err(error) if error.error_len().is_none() => error.valid_up_to(),
                _ => pending.len(),
            };
            let text = String::from_utf8_lossy(&pending[..complete]);
            let text = if first && !text.is_empty() {
                first = false;
                text.strip_prefix('\u{feff}').unwrap_or(&text)
            } else {
                &text
            };
            for line in text.split('\n').filter(|line| !trim(line).is_empty()) {
                if self
                    .emit(CodexAppServerEvent::Stderr(line.to_owned()))
                    .is_err()
                {
                    return;
                }
            }
            pending.drain(..complete);
        }
    }

    fn watch_exit(&self, code: i32) {
        let pending = {
            let mut state = self.0.state.borrow_mut();
            state.process = None;
            // Keeps startup single-flight until its initialize request has settled.
            if std::mem::take(&mut state.initialized) {
                state.ready = None;
            }
            std::mem::take(&mut state.pending)
        };
        for (_, request) in pending {
            reject_pending(
                request,
                message(format!("Codex app-server exited with code {code}")),
            );
        }
        let _ = self.emit(CodexAppServerEvent::Exit(code));
    }

    async fn shutdown_process(&self, process: &CodexAppServerProcess) -> ExecutorResult<()> {
        let _ = process.stdin.send(WriterMessage::Close);
        if process.wait_for_exit(self.0.options.shutdown_grace).await {
            return Ok(());
        }
        process.signal(ProcessSignal::Terminate)?;
        if process
            .wait_for_exit(self.0.options.shutdown_terminate)
            .await
        {
            return Ok(());
        }
        process.signal(ProcessSignal::Kill)?;
        if process.wait_for_exit(self.0.options.shutdown_kill).await {
            return Ok(());
        }
        Err(message("Codex app-server did not exit after SIGKILL"))
    }
}

fn reject_pending(pending: PendingRequest, error: Box<dyn Error>) {
    if let Some(timeout) = pending.timeout {
        timeout.abort();
    }
    let error = match pending.delivery_outcome {
        Some(outcome) => Box::new(CodexAppServerDeliveryError::new(outcome, error)),
        None => error,
    };
    let _ = pending.resolve.send(Err(error));
}

fn stdin_unavailable() -> Box<dyn Error> {
    message("Codex app-server stdin is unavailable")
}

#[derive(Serialize)]
struct NotificationFrame<'a, T> {
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<&'a T>,
}

#[derive(Serialize)]
struct RequestFrame<'a, T> {
    id: u64,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<&'a T>,
}

fn encode_frame(payload: &impl Serialize) -> serde_json::Result<Vec<u8>> {
    let mut bytes = stringify(&serde_json::to_value(payload)?).into_bytes();
    bytes.push(b'\n');
    Ok(bytes)
}

fn exit_code(status: ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status
            .code()
            .or_else(|| status.signal().map(|signal| 128 + signal))
            .unwrap_or(1)
    }
    #[cfg(not(unix))]
    status.code().unwrap_or(1)
}

#[cfg(windows)]
async fn wait_child(
    child: &mut tokio::process::Child,
    mut signals: mpsc::UnboundedReceiver<ProcessSignal>,
) -> io::Result<ExitStatus> {
    loop {
        tokio::select! {
            exit = child.wait() => return exit,
            signal = signals.recv() => {
                if signal.is_some() { child.start_kill()?; } else { return child.wait().await; }
            }
        }
    }
}

pub(crate) fn shared_error(error: Rc<dyn Error>) -> Box<dyn Error> {
    if let Some(error) = error.downcast_ref::<AgentIntegrationError>() {
        return Box::new(error.clone());
    }
    if let Some(error) = error.downcast_ref::<CodexAppServerRpcError>() {
        return Box::new(error.clone());
    }
    if let Some(error) = error.downcast_ref::<CodexAppServerDeliveryError>() {
        return Box::new(error.clone());
    }
    if error.is::<IncompatibleCodex>() {
        return Box::new(IncompatibleCodex);
    }
    let metadata = error_metadata(error.as_ref());
    Box::new(SharedDiagnosticError::new(error.clone(), metadata))
}
