//! Ports `server/runtime/terminals/terminal-manager.ts`.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::rc::Rc;
use std::time::Duration;

use garcon_base::executor_path::{to_executor_path, to_native_path};
use garcon_base::keyed_lock::KeyedLock;
use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_base::path_boundary::assert_real_within_base;
use garcon_base::user_shell::default_user_shell;
use garcon_contract::terminal::{
    TERMINAL_MAX_INPUT_BYTES, TERMINAL_SESSION_LIMIT, TerminalAttachIntent, TerminalCreateRequest,
    TerminalCreateResponse, TerminalErrorCode as Code, TerminalMetadata, TerminalOutputChunk,
    TerminalProcessStatus as Process, TerminalRenameResponse,
    TerminalServerAttachmentStatus as AttachmentStatus, TerminalStreamServerMessage,
    TerminalStreamServerPayload as Message, TerminalTerminateResponse,
};
use garcon_contract::terminal_error::TerminalError;
use garcon_contract::terminal_identity::{TerminalReference, terminal_id};
use garcon_interface::resources::ExecutorResult;
use garcon_interface::terminals::{TerminalAttachRequest, TerminalAuthority, TerminalPeer};
use garcon_js::{
    Number,
    clock::{Clock, SystemClock, to_iso_string},
};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::projects::project_directory_service::access_directory;

use super::pty::{self, PtyCommand, PtyControl, PtyEvent, SpawnedPty};
use super::terminal_replay_buffer::TerminalReplayBuffer;

const CREATE_RESULT_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_PENDING_OPERATIONS: usize = 1024;
const MAX_PENDING_BYTES: usize = 1024 * 1024;
pub const MAX_TERMINAL_REQUEST_RESULTS_PER_PRINCIPAL: usize = 256;
pub const MAX_TERMINAL_REQUEST_RESULTS: usize = 4096;

#[cfg(test)]
type Spawner =
    dyn Fn(PtyCommand) -> futures::future::LocalBoxFuture<'static, ExecutorResult<SpawnedPty>>;

#[derive(Clone)]
pub struct TerminalManagerOptions {
    pub executor_id: Option<String>,
    pub terminal_runtime_id: Option<String>,
    pub project_base_path: String,
    pub user_shell: Option<String>,
    pub clock: Rc<dyn Clock>,
    pub new_id: Rc<dyn Fn() -> Uuid>,
    pub create_result_ttl: Duration,
    pub replay_bytes: Option<f64>,
    pub request_results_per_principal: usize,
    pub request_results_total: usize,
    #[cfg(test)]
    pub(super) spawn_pty: Option<Rc<Spawner>>,
}

impl TerminalManagerOptions {
    pub fn new(project_base_path: String) -> Self {
        Self {
            executor_id: None,
            terminal_runtime_id: None,
            project_base_path,
            user_shell: None,
            clock: Rc::new(SystemClock),
            new_id: Rc::new(Uuid::new_v4),
            create_result_ttl: CREATE_RESULT_TTL,
            replay_bytes: None,
            request_results_per_principal: MAX_TERMINAL_REQUEST_RESULTS_PER_PRINCIPAL,
            request_results_total: MAX_TERMINAL_REQUEST_RESULTS,
            #[cfg(test)]
            spawn_pty: None,
        }
    }
}

type Peer = Rc<dyn TerminalPeer>;
type SessionRef = Rc<RefCell<Session>>;

#[derive(Clone)]
struct Attachment {
    client_id: String,
    peer: Peer,
}

struct Session {
    metadata: TerminalMetadata,
    pty: Option<Rc<dyn PtyControl>>,
    replay: TerminalReplayBuffer,
    attachment: Option<Attachment>,
    subscribers: Vec<Peer>,
    generation: u64,
    queue: VecDeque<QueuedOperation>,
    draining: bool,
    pending_operations: usize,
    pending_bytes: usize,
    pending_resize: Option<Rc<Resize>>,
    terminating: bool,
}

impl Session {
    fn unsubscribe(&mut self, peer: &Peer) {
        self.subscribers.retain(|value| !Rc::ptr_eq(value, peer));
        if self.owns(peer) {
            self.attachment = None;
            self.generation += 1;
            self.metadata.attachment_status = AttachmentStatus::Detached;
        }
        peer.owned_terminal_ids()
            .borrow_mut()
            .shift_remove(&self.metadata.terminal_id);
    }

    fn owns(&self, peer: &Peer) -> bool {
        self.attachment
            .as_ref()
            .is_some_and(|a| Rc::ptr_eq(&a.peer, peer))
    }

    fn stop(&mut self) {
        self.terminating = true;
        if let Some(pty) = self.pty.take() {
            pty.kill();
        }
    }
}

struct Resize {
    dimensions: Cell<(u16, u16)>,
    peer: Peer,
    generation: u64,
}

enum Operation {
    Input(String),
    Resize(Rc<Resize>),
}

struct QueuedOperation {
    principal: TerminalAuthority,
    peer: Peer,
    generation: u64,
    bytes: usize,
    operation: Operation,
}

#[derive(PartialEq, Eq, Hash)]
enum RequestKey {
    Create(String),
    Terminate(String, String),
}

enum ResultValue {
    Create {
        target: Option<String>,
        result: Result<TerminalCreateResponse, TerminalError>,
    },
    Terminate(TerminalTerminateResponse),
}

struct Cached {
    expires: i64,
    value: ResultValue,
}

#[derive(Default)]
struct State {
    sessions: HashMap<String, HashMap<String, SessionRef>>,
    results: HashMap<String, HashMap<RequestKey, Cached>>,
    display_sequence: HashMap<String, u64>,
    result_count: usize,
}

impl State {
    fn prune(&mut self, now: i64, key: Option<&str>) {
        let mut expired = 0;
        self.results.retain(|principal, results| {
            if key.is_none_or(|key| key == principal) {
                let before = results.len();
                results.retain(|_, result| result.expires > now);
                expired += before - results.len();
            }
            !results.is_empty()
        });
        self.result_count -= expired;
    }

    fn cache(&mut self, principal: String, key: RequestKey, cached: Cached) {
        if self
            .results
            .entry(principal)
            .or_default()
            .insert(key, cached)
            .is_none()
        {
            self.result_count += 1;
        }
    }
}

struct Inner {
    options: TerminalManagerOptions,
    executor_id: String,
    terminal_runtime_id: String,
    user_shell: String,
    stopped: Cell<bool>,
    state: RefCell<State>,
    create_lock: KeyedLock,
    cleanup: RefCell<Option<JoinHandle<()>>>,
    logger: ScopedLogger,
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Some(cleanup) = self.cleanup.get_mut().take() {
            cleanup.abort();
        }
    }
}

#[derive(Clone)]
pub struct TerminalManager(Rc<Inner>);

impl TerminalManager {
    pub fn new(options: TerminalManagerOptions) -> Self {
        let executor_id = options
            .executor_id
            .clone()
            .unwrap_or_else(|| "local".into());
        let terminal_runtime_id = options
            .terminal_runtime_id
            .clone()
            .unwrap_or_else(|| (options.new_id)().to_string());
        let user_shell = options
            .user_shell
            .clone()
            .unwrap_or_else(default_user_shell);
        let period = options
            .create_result_ttl
            .clamp(Duration::from_secs(1), Duration::from_secs(60));
        let inner = Rc::new(Inner {
            options,
            executor_id,
            terminal_runtime_id,
            user_shell,
            stopped: Cell::new(false),
            state: RefCell::new(State::default()),
            create_lock: KeyedLock::new(),
            cleanup: RefCell::new(None),
            logger: create_logger("terminals:manager"),
        });
        let weak = Rc::downgrade(&inner);
        *inner.cleanup.borrow_mut() = Some(tokio::task::spawn_local(async move {
            loop {
                tokio::time::sleep(period).await;
                let Some(inner) = weak.upgrade() else { break };
                inner
                    .state
                    .borrow_mut()
                    .prune(inner.options.clock.now_ms(), None);
            }
        }));
        Self(inner)
    }

    pub fn executor_id(&self) -> &str {
        &self.0.executor_id
    }
    pub fn terminal_runtime_id(&self) -> &str {
        &self.0.terminal_runtime_id
    }

    pub fn list(&self, principal: &TerminalAuthority) -> Vec<TerminalMetadata> {
        let mut metadata: Vec<_> = self
            .0
            .state
            .borrow()
            .sessions
            .get(&principal.key)
            .into_iter()
            .flat_map(|sessions| sessions.values())
            .map(|session| session.borrow().metadata.clone())
            .collect();
        metadata.sort_by(|a, b| a.display_sequence.0.total_cmp(&b.display_sequence.0));
        metadata
    }

    pub fn rename(
        &self,
        principal: &TerminalAuthority,
        id: &str,
        title: Option<String>,
    ) -> Result<TerminalRenameResponse, TerminalError> {
        let session = self.require_session(principal, id)?;
        session.borrow_mut().metadata.title = title.clone();
        broadcast_status(&session);
        Ok(TerminalRenameResponse {
            success: true,
            terminal_id: id.to_owned(),
            title,
        })
    }

    pub async fn create(
        &self,
        principal: TerminalAuthority,
        request: TerminalCreateRequest,
    ) -> ExecutorResult<TerminalCreateResponse> {
        let manager = self.clone();
        // The accepted create belongs to the manager even when its reply is lost.
        tokio::task::spawn_local(async move {
            manager
                .0
                .create_lock
                .run_exclusive(
                    &principal.key,
                    || manager.create_locked(&principal, request),
                    None,
                )
                .await?
        })
        .await?
    }

    async fn create_locked(
        &self,
        principal: &TerminalAuthority,
        request: TerminalCreateRequest,
    ) -> ExecutorResult<TerminalCreateResponse> {
        self.assert_running()?;
        if request
            .expected_terminal_runtime_id
            .as_deref()
            .is_some_and(|id| id != self.terminal_runtime_id())
        {
            return Err(TerminalError::with_status(Code::TERMINAL_RUNTIME_CHANGED,
                "Terminal executor restarted. Refresh its terminal list before creating a new shell.", 409).into());
        }
        let key = RequestKey::Create(request.request_id);
        let target = request.requested_initial_working_directory;
        {
            let mut state = self.0.state.borrow_mut();
            state.prune(self.now(), Some(&principal.key));
            if let Some(Cached {
                value:
                    ResultValue::Create {
                        target: prior,
                        result,
                    },
                ..
            }) = state
                .results
                .get(&principal.key)
                .and_then(|results| results.get(&key))
            {
                if prior != &target {
                    return Err(TerminalError::with_status(
                        Code::TERMINAL_VALIDATION,
                        "A terminal request ID cannot change its directory.",
                        409,
                    )
                    .into());
                }
                return Ok(result.clone()?);
            }
            self.assert_result_capacity(&state, &principal.key)?;
            if state
                .sessions
                .get(&principal.key)
                .is_some_and(|sessions| sessions.len() >= TERMINAL_SESSION_LIMIT)
            {
                drop(state);
                return self.cache_create(
                    principal,
                    key,
                    target,
                    Err(TerminalError::with_status(
                        Code::TERMINAL_LIMIT,
                        "Close a terminal before creating another one.",
                        409,
                    )),
                );
            }
        }

        let cwd = match self.resolve_initial_directory(target.as_deref()).await {
            Ok(cwd) => cwd,
            Err(error) => {
                self.0
                    .logger
                    .warn(&format!("terminal create validation failed: {error}"));
                return self.cache_create(
                    principal,
                    key,
                    target,
                    Err(TerminalError::with_status(
                        Code::TERMINAL_VALIDATION,
                        "Initial terminal directory is unavailable.",
                        422,
                    )),
                );
            }
        };
        let display_sequence = {
            let mut state = self.0.state.borrow_mut();
            let sequence = state
                .display_sequence
                .entry(principal.key.clone())
                .or_default();
            *sequence += 1;
            *sequence
        };
        self.assert_running()?;
        let id = terminal_id(&TerminalReference {
            executor_id: self.executor_id().to_owned(),
            terminal_runtime_id: self.terminal_runtime_id().to_owned(),
            session_id: (self.0.options.new_id)().to_string(),
        });
        let started = match self
            .spawn(PtyCommand {
                file: self.0.user_shell.clone(),
                args: Vec::new(),
                cwd: cwd.clone(),
                env: pty_environment(std::env::vars_os()),
                name: "xterm-256color".into(),
                cols: 80,
                rows: 24,
            })
            .await
        {
            Ok(started) => started,
            Err(error) => {
                self.0
                    .logger
                    .error(&format!("terminal create failed: {error}"));
                return self.cache_create(
                    principal,
                    key,
                    target,
                    Err(TerminalError::with_status(
                        Code::TERMINAL_INTERNAL,
                        "Unable to start terminal.",
                        500,
                    )),
                );
            }
        };
        if self.0.stopped.get() {
            started.control.kill();
            self.assert_running()?;
        }
        let metadata = TerminalMetadata {
            terminal_id: id.clone(),
            display_sequence: Number(display_sequence as f64),
            title: None,
            initial_working_directory: to_executor_path(&cwd, None),
            process_status: Process::Running,
            attachment_status: AttachmentStatus::Detached,
            created_at: to_iso_string(self.now())?,
            exit_code: None,
            latest_output_sequence: Number(0.0),
        };
        let session = Rc::new(RefCell::new(Session {
            metadata: metadata.clone(),
            pty: Some(started.control),
            replay: TerminalReplayBuffer::new(self.0.options.replay_bytes)?,
            attachment: None,
            subscribers: Vec::new(),
            generation: 0,
            queue: VecDeque::new(),
            draining: false,
            pending_operations: 0,
            pending_bytes: 0,
            pending_resize: None,
            terminating: false,
        }));
        self.0
            .state
            .borrow_mut()
            .sessions
            .entry(principal.key.clone())
            .or_default()
            .insert(id.clone(), session.clone());
        self.wire_session(&session, principal.key.clone(), started.events);
        let result = self.cache_create(
            principal,
            key,
            target,
            Ok(TerminalCreateResponse {
                success: true,
                terminal: metadata,
            }),
        );
        self.0.logger.info(&format!(
            "terminal created id={id} principal={} sequence={display_sequence}",
            principal.key
        ));
        result
    }

    pub async fn terminate(
        &self,
        principal: TerminalAuthority,
        id: String,
        request_id: String,
    ) -> ExecutorResult<TerminalTerminateResponse> {
        let manager = self.clone();
        tokio::task::spawn_local(async move {
            manager
                .0
                .create_lock
                .run_exclusive(
                    &principal.key,
                    || async { manager.terminate_locked(&principal, id, request_id) },
                    None,
                )
                .await?
        })
        .await?
    }

    fn terminate_locked(
        &self,
        principal: &TerminalAuthority,
        id: String,
        request_id: String,
    ) -> ExecutorResult<TerminalTerminateResponse> {
        let key = RequestKey::Terminate(id.clone(), request_id);
        {
            let mut state = self.0.state.borrow_mut();
            state.prune(self.now(), Some(&principal.key));
            if let Some(Cached {
                value: ResultValue::Terminate(response),
                ..
            }) = state
                .results
                .get(&principal.key)
                .and_then(|results| results.get(&key))
            {
                return Ok(response.clone());
            }
            self.assert_result_capacity(&state, &principal.key)?;
        }
        let terminal = self.session(principal, &id).map(|session| {
            let (metadata, subscribers) = {
                let mut session = session.borrow_mut();
                session.terminating = true;
                (session.metadata.clone(), session.subscribers.clone())
            };
            for subscriber in subscribers {
                send(
                    &subscriber,
                    Message::TerminalTerminated {
                        terminal_id: id.clone(),
                    },
                );
                subscriber
                    .owned_terminal_ids()
                    .borrow_mut()
                    .shift_remove(&id);
            }
            {
                let mut session = session.borrow_mut();
                session.subscribers.clear();
                session.attachment = None;
                session.stop();
            }
            if let Some(sessions) = self.0.state.borrow_mut().sessions.get_mut(&principal.key) {
                sessions.remove(&id);
            }
            self.0.logger.info(&format!(
                "terminal terminated id={id} principal={}",
                principal.key
            ));
            metadata
        });
        let response = TerminalTerminateResponse {
            success: true,
            terminal_id: id,
            terminal,
        };
        self.0.state.borrow_mut().cache(
            principal.key.clone(),
            key,
            Cached {
                expires: self.expiry(),
                value: ResultValue::Terminate(response.clone()),
            },
        );
        Ok(response)
    }

    pub fn attach(
        &self,
        principal: &TerminalAuthority,
        peer: Peer,
        request: TerminalAttachRequest,
    ) -> Result<(), TerminalError> {
        let session = self.require_session(principal, &request.terminal_id)?;
        let previous = {
            let mut state = session.borrow_mut();
            if request.after_sequence.0 > state.metadata.latest_output_sequence.0 {
                return Err(TerminalError::new(
                    Code::TERMINAL_REPLAY_SEQUENCE,
                    "Replay sequence is ahead of terminal output.",
                ));
            }
            if !state
                .subscribers
                .iter()
                .any(|other| Rc::ptr_eq(other, &peer))
            {
                state.subscribers.push(peer.clone());
            }
            state.attachment.clone()
        };
        if let Some(previous) = previous
            && (previous.client_id != request.client_id || !Rc::ptr_eq(&previous.peer, &peer))
        {
            if request.intent != TerminalAttachIntent::Takeover
                && previous.client_id != request.client_id
            {
                return Err(TerminalError::with_status(
                    Code::TERMINAL_TAKEOVER_REQUIRED,
                    "Terminal is attached in another browser tab.",
                    409,
                ));
            }
            previous
                .peer
                .owned_terminal_ids()
                .borrow_mut()
                .shift_remove(&request.terminal_id);
            if previous.client_id != request.client_id {
                send(
                    &previous.peer,
                    Message::TerminalTakenOver {
                        terminal_id: request.terminal_id.clone(),
                        replacement_client_id: request.client_id.clone(),
                    },
                );
            }
        }
        let first = {
            let mut state = session.borrow_mut();
            state.attachment = Some(Attachment {
                client_id: request.client_id,
                peer: peer.clone(),
            });
            state.generation += 1;
            peer.owned_terminal_ids()
                .borrow_mut()
                .insert(request.terminal_id.clone());
            state.metadata.attachment_status = AttachmentStatus::Attached;
            state.replay.first_retained_sequence()
        };
        if request.after_sequence.0 < first.0 - 1.0 {
            send(
                &peer,
                Message::TerminalReplayTruncated {
                    terminal_id: request.terminal_id.clone(),
                    first_sequence: first,
                },
            );
        }
        let attached = {
            let state = session.borrow();
            Message::TerminalAttached {
                terminal: state.metadata.clone(),
                replay: state.replay.after(request.after_sequence),
            }
        };
        send(&peer, attached);
        self.0.logger.info(&format!(
            "terminal attached id={} principal={}",
            request.terminal_id, principal.key
        ));
        Ok(())
    }

    pub fn input(
        &self,
        principal: TerminalAuthority,
        peer: Peer,
        id: &str,
        data: String,
    ) -> Result<(), TerminalError> {
        let bytes = data.len();
        if bytes > TERMINAL_MAX_INPUT_BYTES {
            return Err(TerminalError::new(
                Code::TERMINAL_VALIDATION,
                "Terminal input is too large.",
            ));
        }
        let session = self.require_owned(&principal, &peer, id)?;
        let generation = {
            let mut state = session.borrow_mut();
            if state.metadata.process_status != Process::Running {
                return Err(TerminalError::with_status(
                    Code::TERMINAL_PROCESS_EXITED,
                    "Terminal process has exited.",
                    409,
                ));
            }
            state.pending_resize = None;
            state.generation
        };
        self.enqueue(
            session,
            QueuedOperation {
                principal,
                peer,
                generation,
                bytes,
                operation: Operation::Input(data),
            },
        )
    }

    pub fn resize(
        &self,
        principal: TerminalAuthority,
        peer: Peer,
        id: &str,
        cols: Number,
        rows: Number,
    ) -> Result<(), TerminalError> {
        let valid = |n: f64| (1.0..=4096.0).contains(&n) && n.fract() == 0.0;
        if !valid(cols.0) || !valid(rows.0) {
            return Err(TerminalError::new(
                Code::TERMINAL_VALIDATION,
                "Invalid terminal dimensions.",
            ));
        }
        let session = self.require_owned(&principal, &peer, id)?;
        let dimensions = (cols.0 as u16, rows.0 as u16);
        let (resize, generation) = {
            let mut state = session.borrow_mut();
            if state.metadata.process_status != Process::Running {
                return Ok(());
            }
            if let Some(pending) = &state.pending_resize
                && pending.generation == state.generation
                && Rc::ptr_eq(&pending.peer, &peer)
            {
                pending.dimensions.set(dimensions);
                return Ok(());
            }
            let resize = Rc::new(Resize {
                dimensions: Cell::new(dimensions),
                peer: peer.clone(),
                generation: state.generation,
            });
            state.pending_resize = Some(resize.clone());
            (resize, state.generation)
        };
        let outcome = self.enqueue(
            session.clone(),
            QueuedOperation {
                principal,
                peer,
                generation,
                bytes: 0,
                operation: Operation::Resize(resize),
            },
        );
        if outcome.is_err() {
            session.borrow_mut().pending_resize = None;
        }
        outcome
    }

    pub fn detach_peer(&self, principal: &TerminalAuthority, peer: &Peer) {
        if let Some(sessions) = self.0.state.borrow().sessions.get(&principal.key) {
            for session in sessions.values() {
                session.borrow_mut().unsubscribe(peer);
            }
        }
        peer.owned_terminal_ids().borrow_mut().clear();
    }

    pub fn detach_terminal(&self, principal: &TerminalAuthority, peer: &Peer, id: &str) {
        if let Some(session) = self.session(principal, id) {
            session.borrow_mut().unsubscribe(peer);
        }
    }

    pub fn shutdown(&self) {
        self.0.stopped.set(true);
        if let Some(cleanup) = self.0.cleanup.borrow_mut().take() {
            cleanup.abort();
        }
        let mut state = self.0.state.borrow_mut();
        for session in state
            .sessions
            .values()
            .flat_map(|sessions| sessions.values())
        {
            session.borrow_mut().stop();
        }
        state.sessions.clear();
        state.results.clear();
        state.result_count = 0;
    }

    fn enqueue(
        &self,
        session: SessionRef,
        operation: QueuedOperation,
    ) -> Result<(), TerminalError> {
        let start = {
            let mut state = session.borrow_mut();
            if state.pending_operations >= MAX_PENDING_OPERATIONS
                || state.pending_bytes + operation.bytes > MAX_PENDING_BYTES
            {
                return Err(TerminalError::with_status(
                    Code::TERMINAL_BACKPRESSURE,
                    "Terminal input queue is full.",
                    429,
                ));
            }
            state.pending_bytes += operation.bytes;
            state.pending_operations += 1;
            state.queue.push_back(operation);
            !std::mem::replace(&mut state.draining, true)
        };
        if start {
            let manager = self.clone();
            tokio::task::spawn_local(async move {
                loop {
                    let operation = {
                        let mut state = session.borrow_mut();
                        match state.queue.pop_front() {
                            Some(operation) => operation,
                            None => {
                                state.draining = false;
                                break;
                            }
                        }
                    };
                    manager.run_operation(&session, operation).await;
                    tokio::task::yield_now().await;
                }
            });
        }
        Ok(())
    }

    async fn run_operation(&self, session: &SessionRef, queued: QueuedOperation) {
        let pty = if expired(&queued.principal, self.now()) {
            None
        } else {
            let mut state = session.borrow_mut();
            if let Operation::Resize(resize) = &queued.operation
                && state
                    .pending_resize
                    .as_ref()
                    .is_some_and(|pending| Rc::ptr_eq(pending, resize))
            {
                state.pending_resize = None;
            }
            if !self.0.stopped.get()
                && !state.terminating
                && state.generation == queued.generation
                && state.owns(&queued.peer)
                && queued
                    .peer
                    .owned_terminal_ids()
                    .borrow()
                    .contains(&state.metadata.terminal_id)
            {
                state.pty.clone()
            } else {
                None
            }
        };
        if let Some(pty) = pty {
            let result = match queued.operation {
                Operation::Input(data) => pty.write(data).await,
                Operation::Resize(resize) => {
                    let (cols, rows) = resize.dimensions.get();
                    pty.resize(cols, rows).await
                }
            };
            if let Err(error) = result {
                let id = session.borrow().metadata.terminal_id.clone();
                self.0
                    .logger
                    .warn(&format!("terminal operation failed id={id}: {error}"));
                send(
                    &queued.peer,
                    Message::TerminalError {
                        terminal_id: Some(id),
                        code: Code::TERMINAL_INTERNAL,
                        message: "Terminal operation failed.".into(),
                    },
                );
            }
        }
        let mut state = session.borrow_mut();
        state.pending_bytes -= queued.bytes;
        state.pending_operations -= 1;
    }

    fn wire_session(
        &self,
        session: &SessionRef,
        principal: String,
        mut events: tokio::sync::mpsc::Receiver<PtyEvent>,
    ) {
        let session = Rc::downgrade(session);
        let logger = self.0.logger.clone();
        tokio::task::spawn_local(async move {
            while let Some(event) = events.recv().await {
                let Some(session) = session.upgrade() else {
                    break;
                };
                if session.borrow().terminating {
                    break;
                }
                match event {
                    PtyEvent::Output(data) => {
                        let (peer, terminal_id, sequence) = {
                            let mut state = session.borrow_mut();
                            let sequence = Number(state.metadata.latest_output_sequence.0 + 1.0);
                            state.metadata.latest_output_sequence = sequence;
                            state.replay.append(TerminalOutputChunk {
                                sequence,
                                data: data.clone(),
                            });
                            (
                                state.attachment.as_ref().map(|a| a.peer.clone()),
                                state.metadata.terminal_id.clone(),
                                sequence,
                            )
                        };
                        if let Some(peer) = peer {
                            send(
                                &peer,
                                Message::TerminalOutput {
                                    terminal_id,
                                    sequence,
                                    data,
                                },
                            );
                        }
                    }
                    PtyEvent::Exited(code) => {
                        let id = {
                            let mut state = session.borrow_mut();
                            state.metadata.process_status = Process::Exited;
                            state.metadata.exit_code = Some(Number(f64::from(code)));
                            state.pty = None;
                            state.metadata.terminal_id.clone()
                        };
                        broadcast_status(&session);
                        logger.info(&format!(
                            "terminal exited id={id} principal={principal} code={code}"
                        ));
                        break;
                    }
                }
            }
        });
    }

    async fn spawn(&self, command: PtyCommand) -> ExecutorResult<SpawnedPty> {
        #[cfg(test)]
        if let Some(spawn) = &self.0.options.spawn_pty {
            return spawn(command).await;
        }
        pty::spawn(command).await
    }

    async fn resolve_initial_directory(&self, requested: Option<&str>) -> ExecutorResult<String> {
        let base = to_native_path(&self.0.options.project_base_path, None);
        let target = requested.map_or_else(|| base.clone(), |path| to_native_path(path, None));
        let directory = assert_real_within_base(&base, &target).await?;
        if !tokio::fs::metadata(&directory).await?.is_dir() {
            return Err("Terminal path is not a directory".into());
        }
        access_directory(&directory).await?;
        Ok(directory)
    }

    fn assert_running(&self) -> Result<(), TerminalError> {
        if self.0.stopped.get() {
            Err(stopping())
        } else {
            Ok(())
        }
    }

    fn assert_result_capacity(&self, state: &State, principal: &str) -> Result<(), TerminalError> {
        if state.result_count >= self.0.options.request_results_total
            || state.results.get(principal).map_or(0, HashMap::len)
                >= self.0.options.request_results_per_principal
        {
            Err(TerminalError::with_status(
                Code::TERMINAL_BACKPRESSURE,
                "Too many terminal requests are awaiting idempotency expiry.",
                429,
            ))
        } else {
            Ok(())
        }
    }

    fn cache_create(
        &self,
        principal: &TerminalAuthority,
        key: RequestKey,
        target: Option<String>,
        result: Result<TerminalCreateResponse, TerminalError>,
    ) -> ExecutorResult<TerminalCreateResponse> {
        self.0.state.borrow_mut().cache(
            principal.key.clone(),
            key,
            Cached {
                expires: self.expiry(),
                value: ResultValue::Create {
                    target,
                    result: result.clone(),
                },
            },
        );
        Ok(result?)
    }

    fn now(&self) -> i64 {
        self.0.options.clock.now_ms()
    }
    fn expiry(&self) -> i64 {
        self.now().saturating_add(
            i64::try_from(self.0.options.create_result_ttl.as_millis()).unwrap_or(i64::MAX),
        )
    }

    fn session(&self, principal: &TerminalAuthority, id: &str) -> Option<SessionRef> {
        self.0
            .state
            .borrow()
            .sessions
            .get(&principal.key)?
            .get(id)
            .cloned()
    }

    fn require_session(
        &self,
        principal: &TerminalAuthority,
        id: &str,
    ) -> Result<SessionRef, TerminalError> {
        self.session(principal, id).ok_or_else(|| {
            TerminalError::with_status(Code::TERMINAL_NOT_FOUND, "Terminal not found.", 404)
        })
    }

    fn require_owned(
        &self,
        principal: &TerminalAuthority,
        peer: &Peer,
        id: &str,
    ) -> Result<SessionRef, TerminalError> {
        let session = self.require_session(principal, id)?;
        if !session.borrow().owns(peer) {
            return Err(TerminalError::with_status(
                Code::TERMINAL_NOT_ATTACHED,
                "Terminal is not attached to this connection.",
                409,
            ));
        }
        Ok(session)
    }
}

fn pty_environment(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    // CommandBuilder replaces environment keys case-insensitively on Windows.
    let overrides = [
        ("GARCON_CONTROLLER_URL", ""),
        ("TERM", "xterm-256color"),
        ("COLORTERM", "truecolor"),
        ("FORCE_COLOR", "3"),
    ];
    inherited
        .into_iter()
        .chain(overrides.map(|(key, value)| (key.into(), value.into())))
        .collect()
}

fn send(peer: &Peer, payload: Message) {
    peer.send_terminal_message(TerminalStreamServerMessage {
        payload,
        attachment_id: None,
    });
}

fn broadcast_status(session: &SessionRef) {
    let subscribers = session.borrow().subscribers.clone();
    for peer in subscribers {
        let terminal = session.borrow().metadata.clone();
        send(&peer, Message::TerminalStatus { terminal });
    }
}

pub(super) fn expired(principal: &TerminalAuthority, now: i64) -> bool {
    principal
        .expires_at_ms
        .is_some_and(|expiry| i128::from(expiry) <= i128::from(now))
}

pub(super) fn stopping() -> TerminalError {
    TerminalError::with_status(
        Code::TERMINAL_UNAVAILABLE,
        "Terminal executor is stopping.",
        503,
    )
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::pty_environment;

    #[test]
    fn pty_overrides_win_with_mixed_case_inherited_names() {
        let inherited = [
            ("Garcon_Controller_Url", "synthetic-credential"),
            ("term", "dumb"),
            ("colorterm", "none"),
            ("force_color", "0"),
        ]
        .map(|(key, value)| (key.into(), value.into()));
        let env = pty_environment(inherited);
        for (key, expected) in [
            ("GARCON_CONTROLLER_URL", ""),
            ("TERM", "xterm-256color"),
            ("COLORTERM", "truecolor"),
            ("FORCE_COLOR", "3"),
        ] {
            let (actual_key, actual_value) = env
                .iter()
                .rev()
                .find(|(name, _)| name.eq_ignore_ascii_case(OsStr::new(key)))
                .unwrap();
            assert_eq!(
                (actual_key.as_os_str(), actual_value.as_os_str()),
                (OsStr::new(key), OsStr::new(expected))
            );
        }
    }
}
