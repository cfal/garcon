use std::{
    cell::{Cell, RefCell},
    ffi::OsString,
    io,
    path::PathBuf,
    pin::Pin,
    rc::Rc,
    sync::LazyLock,
    time::Duration,
};

use futures::future::LocalBoxFuture;
use garcon_contract::agent_auth::{
    AgentAuthLoginCompleteResult, AgentAuthLoginLaunchResult, AgentAuthLoginStatus,
    AgentDeviceAuthInfo,
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    host::AgentLogger,
    resources::ExecutorResult,
};
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use regress::Regex;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::Command,
    sync::{Mutex, mpsc, oneshot},
    task::AbortHandle,
};

const INITIAL_RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
const SESSION_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const TERMINAL_STATUS_TTL: Duration = Duration::from_secs(15 * 60);
const SESSION_EXPIRED_ERROR: &str = "Sign-in timed out. Start a new sign-in attempt.";
const SESSION_UNAVAILABLE_ERROR: &str = "This sign-in session is no longer available.";
const SESSION_FAILED_ERROR: &str = "Sign-in failed. Start a new sign-in attempt.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliLoginMode {
    BrowserCode,
    DeviceCode,
}

pub struct CliLoginCommand {
    pub executable: OsString,
    pub args: Vec<OsString>,
}

pub struct CliLoginOutputError {
    pub retryable: bool,
    pub message: String,
}

pub struct CliLoginProcessOptions {
    pub cwd: PathBuf,
    pub env: IndexMap<OsString, OsString>,
}

pub enum CliLoginPtyEvent {
    Data(String),
    Exit {
        exit_code: i32,
        signal: Option<Opaque>,
    },
}

pub type TerminateLogin = Rc<dyn Fn() -> io::Result<()>>;
pub type LoginInput = Pin<Box<dyn AsyncWrite>>;
pub type LoginOutput = Pin<Box<dyn AsyncRead>>;

pub struct CliLoginPty {
    pub events: mpsc::UnboundedReceiver<CliLoginPtyEvent>,
    pub kill: TerminateLogin,
}

pub struct CliLoginProcess {
    pub stdin: Option<LoginInput>,
    pub stdout: Option<LoginOutput>,
    pub stderr: Option<LoginOutput>,
    pub exited: LocalBoxFuture<'static, io::Result<i32>>,
    pub kill: TerminateLogin,
}

pub type CliLoginPtySpawner = dyn Fn(
    CliLoginCommand,
    CliLoginProcessOptions,
) -> LocalBoxFuture<'static, ExecutorResult<CliLoginPty>>;
pub type CliLoginProcessSpawner =
    dyn Fn(CliLoginCommand, CliLoginProcessOptions) -> io::Result<CliLoginProcess>;
pub type CliLoginEnvironment = dyn Fn() -> IndexMap<OsString, OsString>;
pub type ValidateCode = dyn Fn(&str) -> Option<String>;
pub type ParseOutputError = dyn Fn(&str) -> Option<CliLoginOutputError>;

pub struct CliLoginControllerOptions {
    pub command: Rc<dyn Fn() -> CliLoginCommand>,
    pub mode: CliLoginMode,
    pub logger: Rc<dyn AgentLogger>,
    pub validate_code: Option<Rc<ValidateCode>>,
    pub on_succeeded: Option<Rc<dyn Fn()>>,
    pub parse_output_error: Option<Rc<ParseOutputError>>,
    pub cwd: Option<PathBuf>,
    pub environment: Option<Rc<CliLoginEnvironment>>,
    pub spawn_process: Option<Rc<CliLoginProcessSpawner>>,
    pub spawn_pty: Option<Rc<CliLoginPtySpawner>>,
    pub session_timeout: Duration,
    pub initial_response_timeout: Duration,
    pub terminal_status_ttl: Duration,
    pub new_session_id: Rc<dyn Fn() -> String>,
}

impl CliLoginControllerOptions {
    pub fn new(
        command: impl Fn() -> CliLoginCommand + 'static,
        mode: CliLoginMode,
        logger: Rc<dyn AgentLogger>,
    ) -> Self {
        Self {
            command: Rc::new(command),
            mode,
            logger,
            validate_code: None,
            on_succeeded: None,
            parse_output_error: None,
            cwd: None,
            environment: None,
            spawn_process: None,
            spawn_pty: None,
            session_timeout: SESSION_TIMEOUT,
            initial_response_timeout: INITIAL_RESPONSE_TIMEOUT,
            terminal_status_ttl: TERMINAL_STATUS_TTL,
            new_session_id: Rc::new(|| uuid::Uuid::new_v4().to_string()),
        }
    }
}

#[derive(Default)]
struct LoginSession {
    id: String,
    completion_pending: Cell<bool>,
    kill: RefCell<Option<TerminateLogin>>,
    stdin: RefCell<Option<Rc<Mutex<LoginInput>>>>,
    browser_process: Cell<bool>,
    device_auth: RefCell<Option<AgentDeviceAuthInfo>>,
    retryable_error: RefCell<Option<String>>,
    failure_error: RefCell<Option<String>>,
    watchdog: RefCell<Option<AbortHandle>>,
}

impl LoginSession {
    fn stop_watchdog(&self) {
        if let Some(timer) = self.watchdog.take() {
            timer.abort();
        }
    }
    fn kill(&self) -> io::Result<()> {
        let kill = self.kill.borrow().clone();
        kill.map_or(Ok(()), |kill| kill())
    }
}

struct TerminalStatus {
    status: Rc<AgentAuthLoginStatus>,
    cleanup: AbortHandle,
}

struct Inner {
    options: CliLoginControllerOptions,
    active: RefCell<Option<Rc<LoginSession>>>,
    terminal: RefCell<IndexMap<String, TerminalStatus>>,
}

#[derive(Clone)]
pub struct CliLoginController(Rc<Inner>);

impl CliLoginController {
    pub fn new(options: CliLoginControllerOptions) -> Self {
        Self(Rc::new(Inner {
            options,
            active: RefCell::default(),
            terminal: RefCell::default(),
        }))
    }

    pub async fn launch(&self) -> ExecutorResult<AgentAuthLoginLaunchResult> {
        if let Some(active) = self.0.active.borrow().as_ref() {
            return Ok(launch_result(
                active,
                false,
                active.device_auth.borrow().clone(),
            ));
        }
        let session = Rc::new(LoginSession {
            id: (self.0.options.new_session_id)(),
            ..Default::default()
        });
        self.0.active.replace(Some(session.clone()));
        self.0.start_watchdog(session.clone());
        let result = match self.0.options.mode {
            CliLoginMode::BrowserCode => self.0.launch_browser_code(session.clone()).await,
            CliLoginMode::DeviceCode => self.0.launch_device_code(session.clone()).await,
        };
        if result.is_err() {
            self.0
                .finish(&session, Err(SESSION_FAILED_ERROR.to_owned()));
        }
        result
    }

    pub fn status(&self, expected_session_id: Option<&str>) -> AgentAuthLoginStatus {
        let expected = expected_session_id.filter(|id| !id.is_empty());
        if let Some(active) = self.0.active.borrow().as_ref()
            && expected.is_none_or(|id| id == active.id)
        {
            return AgentAuthLoginStatus::Running {
                running: true,
                session_id: active.id.clone(),
                completion_pending: active.completion_pending.get(),
                retryable_error: active.retryable_error.borrow().clone(),
                device_auth: active.device_auth.borrow().clone(),
            };
        }
        match expected {
            None => AgentAuthLoginStatus::Idle { running: false },
            Some(id) => self.0.terminal.borrow().get(id).map_or_else(
                || AgentAuthLoginStatus::Failed {
                    running: false,
                    session_id: id.to_owned(),
                    error: SESSION_UNAVAILABLE_ERROR.to_owned(),
                },
                |entry| (*entry.status).clone(),
            ),
        }
    }

    pub async fn complete(
        &self,
        session_id: &str,
        code: &str,
    ) -> ExecutorResult<AgentAuthLoginCompleteResult> {
        let session = self
            .0
            .active
            .borrow()
            .clone()
            .filter(|session| session.id == session_id && session.browser_process.get())
            .ok_or_else(|| {
                CliLoginSessionError::new("No matching pending auth login").into_integration()
            })?;
        let trimmed = garcon_js::trim(code);
        if trimmed.is_empty() {
            return Err("code is required".into());
        }
        let stdin = session
            .stdin
            .borrow()
            .clone()
            .ok_or("Pending auth login cannot accept a code")?;
        if session.completion_pending.get() {
            return Err(
                CliLoginSessionError::new("Auth login completion is already pending")
                    .into_integration()
                    .into(),
            );
        }
        if let Some(message) = self
            .0
            .options
            .validate_code
            .as_ref()
            .and_then(|validate| validate(trimmed))
            .filter(|message| !message.is_empty())
        {
            session.retryable_error.replace(Some(message.clone()));
            return Err(AgentIntegrationError::new(
                AgentIntegrationErrorCode::AUTH_LOGIN_CODE_INVALID,
                message,
                true,
                None,
            )
            .into());
        }
        session.completion_pending.set(true);
        session.retryable_error.take();
        let written: io::Result<()> = async {
            let mut stdin = stdin.lock().await;
            stdin.write_all(format!("{trimmed}\n").as_bytes()).await?;
            stdin.flush().await
        }
        .await;
        if written.is_err() {
            // A partial write cannot safely be retried against the same process.
            self.0
                .finish(&session, Err(SESSION_FAILED_ERROR.to_owned()));
            let _ = session.kill();
            return Err(SESSION_FAILED_ERROR.into());
        }
        Ok(AgentAuthLoginCompleteResult {
            submitted: true,
            session_id: session_id.to_owned(),
        })
    }

    pub fn stop(&self) {
        if let Some(active) = self.0.active.take() {
            active.stop_watchdog();
            if active.kill().is_err() {
                self.0
                    .options
                    .logger
                    .debug("Auth login termination failed", None);
            }
        }
        for (_, entry) in self.0.terminal.take() {
            entry.cleanup.abort();
        }
    }
}

fn launch_result(
    session: &LoginSession,
    launched: bool,
    device_auth: Option<AgentDeviceAuthInfo>,
) -> AgentAuthLoginLaunchResult {
    AgentAuthLoginLaunchResult {
        launched,
        already_running: !launched,
        session_id: session.id.clone(),
        device_auth,
    }
}

impl Inner {
    fn process_options(&self) -> CliLoginProcessOptions {
        CliLoginProcessOptions {
            cwd: self
                .options
                .cwd
                .clone()
                .or_else(std::env::home_dir)
                .unwrap_or_default(),
            env: self
                .options
                .environment
                .as_ref()
                .map_or_else(default_login_environment, |get| get()),
        }
    }

    fn is_current(&self, session: &Rc<LoginSession>) -> bool {
        self.active
            .borrow()
            .as_ref()
            .is_some_and(|active| Rc::ptr_eq(active, session))
    }

    fn start_watchdog(self: &Rc<Self>, session: Rc<LoginSession>) {
        let weak = Rc::downgrade(self);
        let timeout = tokio::time::sleep(self.options.session_timeout);
        let timer_session = session.clone();
        let task = tokio::task::spawn_local(async move {
            timeout.await;
            if let Some(inner) = weak.upgrade()
                && inner.is_current(&timer_session)
            {
                timer_session.watchdog.take();
                inner.finish(&timer_session, Err(SESSION_EXPIRED_ERROR.to_owned()));
                if timer_session.kill().is_err() {
                    inner
                        .options
                        .logger
                        .debug("Expired auth login termination failed", None);
                }
            }
        });
        session.watchdog.replace(Some(task.abort_handle()));
    }

    fn finish_from_exit(self: &Rc<Self>, session: &Rc<LoginSession>, exit_code: i32) {
        let outcome = if exit_code == 0 {
            Ok(())
        } else {
            Err(session
                .failure_error
                .borrow()
                .clone()
                .unwrap_or_else(|| SESSION_FAILED_ERROR.to_owned()))
        };
        self.finish(session, outcome);
    }

    fn finish(self: &Rc<Self>, session: &Rc<LoginSession>, outcome: Result<(), String>) {
        if !self.is_current(session) {
            return;
        }
        self.active.take();
        session.stop_watchdog();
        let succeeded = outcome.is_ok();
        let status = Rc::new(match outcome {
            Ok(()) => AgentAuthLoginStatus::Succeeded {
                running: false,
                session_id: session.id.clone(),
            },
            Err(error) => AgentAuthLoginStatus::Failed {
                running: false,
                session_id: session.id.clone(),
                error,
            },
        });
        let expected = Rc::downgrade(&status);
        let weak = Rc::downgrade(self);
        let id = session.id.clone();
        let timeout = tokio::time::sleep(self.options.terminal_status_ttl);
        let cleanup = tokio::task::spawn_local(async move {
            timeout.await;
            if let (Some(inner), Some(expected)) = (weak.upgrade(), expected.upgrade()) {
                let mut terminal = inner.terminal.borrow_mut();
                if terminal
                    .get(&id)
                    .is_some_and(|entry| Rc::ptr_eq(&entry.status, &expected))
                {
                    terminal.shift_remove(&id);
                }
            }
        })
        .abort_handle();
        self.terminal
            .borrow_mut()
            .insert(session.id.clone(), TerminalStatus { status, cleanup });
        if succeeded && let Some(callback) = &self.options.on_succeeded {
            callback();
        }
    }

    async fn launch_browser_code(
        self: &Rc<Self>,
        session: Rc<LoginSession>,
    ) -> ExecutorResult<AgentAuthLoginLaunchResult> {
        let command = (self.options.command)();
        let options = self.process_options();
        let process = match &self.options.spawn_process {
            Some(spawn) => spawn(command, options)?,
            None => spawn_login_process(command, options)?,
        };
        let CliLoginProcess {
            stdin,
            stdout,
            stderr,
            exited,
            kill,
        } = process;
        session.browser_process.set(true);
        session
            .stdin
            .replace(stdin.map(|input| Rc::new(Mutex::new(input))));
        session.kill.replace(Some(kill));

        let (url, initial) = oneshot::channel();
        let (initial_finished, initial_processed) = oneshot::channel::<()>();
        let url = RefCell::new(Some(url));
        let weak = Rc::downgrade(self);
        let listener_session = session.clone();
        let logger = self.options.logger.clone();
        let drained = tokio::task::spawn_local(async move {
            let on_line = |line: &str| {
                let line = strip_ansi(line);
                let pending = url.borrow().is_some();
                if pending
                    && let Some(auth) = browser_auth_from_stripped(&line)
                    && let Some(sender) = url.take()
                {
                    let _ = sender.send(auth);
                }
                if let Some(inner) = weak.upgrade()
                    && inner.is_current(&listener_session)
                    && let Some(error) = inner
                        .options
                        .parse_output_error
                        .as_ref()
                        .and_then(|parse| parse(&line))
                {
                    if error.retryable {
                        if listener_session.completion_pending.replace(false) {
                            listener_session
                                .retryable_error
                                .replace(Some(error.message));
                        }
                    } else {
                        listener_session.failure_error.replace(Some(error.message));
                    }
                }
            };
            tokio::join!(
                drain_login_output(stdout, &on_line, logger.as_ref()),
                drain_login_output(stderr, &on_line, logger.as_ref())
            );
        });
        let weak = Rc::downgrade(self);
        let exit_session = session.clone();
        tokio::task::spawn_local(async move {
            match exited.await {
                Ok(exit_code) => {
                    let _ = drained.await;
                    // Initial URL delivery and pipe end precede the exit callback.
                    let _ = initial_processed.await;
                    if let Some(inner) = weak.upgrade() {
                        inner.finish_from_exit(&exit_session, exit_code);
                    }
                }
                Err(_) => {
                    if let Some(inner) = weak.upgrade() {
                        inner.options.logger.warn("Auth login process failed", None);
                        inner.finish(&exit_session, Err(SESSION_FAILED_ERROR.to_owned()));
                    }
                }
            }
        });
        let auth = tokio::time::timeout(self.options.initial_response_timeout, initial)
            .await
            .ok()
            .and_then(Result::ok);
        let _ = initial_finished.send(());
        if !self.is_current(&session) {
            return Err(SESSION_UNAVAILABLE_ERROR.into());
        }
        let Some(auth) = auth else {
            session.kill()?;
            return Err("Auth login did not print a sign-in URL".into());
        };
        session.device_auth.replace(Some(auth.clone()));
        Ok(launch_result(&session, true, Some(auth)))
    }

    async fn launch_device_code(
        self: &Rc<Self>,
        session: Rc<LoginSession>,
    ) -> ExecutorResult<AgentAuthLoginLaunchResult> {
        let spawn = self
            .options
            .spawn_pty
            .as_ref()
            .ok_or("Device-code login requires a PTY spawner")?;
        let CliLoginPty { mut events, kill } =
            spawn((self.options.command)(), self.process_options()).await?;
        if !self.is_current(&session) {
            kill()?;
            return Err(SESSION_EXPIRED_ERROR.into());
        }
        session.kill.replace(Some(kill));
        let (sender, initial) = oneshot::channel();
        let weak = Rc::downgrade(self);
        let event_session = session.clone();
        tokio::task::spawn_local(async move {
            let mut sender = Some(sender);
            let mut output = String::new();
            while let Some(event) = events.recv().await {
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                match event {
                    CliLoginPtyEvent::Data(chunk) if sender.is_some() => {
                        output.push_str(&chunk);
                        if let Some(auth) = parse_device_auth(&output)
                            && let Some(sender) = sender.take()
                        {
                            if inner.is_current(&event_session) {
                                event_session.device_auth.replace(Some(auth.clone()));
                            }
                            let _ = sender.send(auth);
                            output.clear();
                        }
                    }
                    CliLoginPtyEvent::Data(_) => {}
                    CliLoginPtyEvent::Exit { exit_code, signal } => {
                        inner.finish_from_exit(&event_session, exit_code);
                        if exit_code != 0 {
                            let mut fields = IndexMap::from([(
                                "exitCode".to_owned(),
                                Opaque::from_value(serde_json::json!(exit_code)),
                            )]);
                            if let Some(signal) = signal {
                                fields.insert("signal".to_owned(), signal);
                            }
                            inner
                                .options
                                .logger
                                .warn("Auth login exited unsuccessfully", Some(&fields));
                        }
                    }
                }
            }
        });
        let deadline = tokio::time::sleep(self.options.initial_response_timeout);
        tokio::pin!(deadline);
        let auth = tokio::select! {
            biased;
            auth = initial => match auth { Ok(auth) => Some(auth), Err(_) => { deadline.await; None } },
            _ = &mut deadline => None,
        };
        Ok(launch_result(&session, true, auth))
    }
}

#[derive(Debug, thiserror::Error)]
#[error(transparent)]
pub struct CliLoginSessionError(AgentIntegrationError);

impl CliLoginSessionError {
    pub fn new(message: &str) -> Self {
        Self(AgentIntegrationError::new(
            AgentIntegrationErrorCode::AUTH_LOGIN_SESSION_MISMATCH,
            message,
            false,
            None,
        ))
    }

    fn into_integration(self) -> AgentIntegrationError {
        self.0
    }
}

impl garcon_base::errors::DiagnosticError for CliLoginSessionError {
    fn diagnostic_metadata(&self) -> garcon_base::errors::ErrorMetadata<'_> {
        garcon_base::errors::ErrorMetadata {
            code: Some(self.0.code.as_str()),
            name: "CliLoginSessionError",
        }
    }
}

static ANSI: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: The static expression is valid ECMAScript syntax.
    Regex::new(r"\x1b\[[0-9;]*[A-Za-z]").expect("ANSI sequence")
});
static LOGIN_URL: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: The static expression is valid ECMAScript syntax.
    Regex::new(r"https://\S+").expect("HTTPS address")
});
static DEVICE_CODE: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: The static expression is valid ECMAScript syntax.
    Regex::with_flags(r"^\s+([A-Z0-9]+-[A-Z0-9]+)\s*$", "m").expect("device authorization code")
});

fn strip_ansi(raw: &str) -> String {
    let mut output = String::new();
    let mut start = 0;
    for found in ANSI.find_iter(raw) {
        let range = found.range();
        output.push_str(&raw[start..range.start]);
        start = range.end;
    }
    output.push_str(&raw[start..]);
    output
}

pub fn parse_device_auth(raw: &str) -> Option<AgentDeviceAuthInfo> {
    let output = strip_ansi(raw);
    let url = LOGIN_URL.find(&output)?.range();
    let code = DEVICE_CODE.find(&output)?.group(1)?;
    Some(AgentDeviceAuthInfo {
        url: output[url].to_owned(),
        code: Some(output[code].to_owned()),
        needs_code: None,
    })
}

fn browser_auth_from_stripped(output: &str) -> Option<AgentDeviceAuthInfo> {
    let url = LOGIN_URL.find(output)?.range();
    Some(AgentDeviceAuthInfo {
        url: output[url].to_owned(),
        code: None,
        needs_code: Some(true),
    })
}

pub fn parse_browser_auth(raw: &str) -> Option<AgentDeviceAuthInfo> {
    browser_auth_from_stripped(&strip_ansi(raw))
}

fn default_login_environment() -> IndexMap<OsString, OsString> {
    let mut env: IndexMap<_, _> = std::env::vars_os().collect();
    for (key, value) in [
        ("TERM", "xterm-256color"),
        ("COLORTERM", "truecolor"),
        ("FORCE_COLOR", "3"),
    ] {
        env.insert(key.into(), value.into());
    }
    env
}

fn spawn_login_process(
    command: CliLoginCommand,
    options: CliLoginProcessOptions,
) -> io::Result<CliLoginProcess> {
    use std::process::Stdio;
    let mut process = Command::new(command.executable)
        .args(command.args)
        .current_dir(options.cwd)
        .env_clear()
        .envs(options.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdin = process
        .stdin
        .take()
        .map(|input| Box::pin(input) as LoginInput);
    let stdout = process
        .stdout
        .take()
        .map(|output| Box::pin(output) as LoginOutput);
    let stderr = process
        .stderr
        .take()
        .map(|output| Box::pin(output) as LoginOutput);
    #[cfg(unix)]
    let (kill, exited) = {
        use std::os::unix::process::ExitStatusExt;
        let pid = Rc::new(Cell::new(
            process.id().and_then(|pid| i32::try_from(pid).ok()),
        ));
        let kill_pid = pid.clone();
        let kill: TerminateLogin = Rc::new(move || {
            let Some(pid) = kill_pid.get() else {
                return Ok(());
            };
            // SAFETY: The unreaped child owns this positive PID; wait clears it before yielding.
            let result = unsafe { libc::kill(pid, libc::SIGTERM) };
            if result == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
        let exited: LocalBoxFuture<'static, _> = Box::pin(async move {
            let result = process.wait().await;
            pid.take();
            let status = result?;
            Ok(status
                .code()
                .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)))
        });
        (kill, exited)
    };
    #[cfg(windows)]
    let (kill, exited) = {
        let cancelled = tokio_util::sync::CancellationToken::new();
        let terminate = cancelled.clone();
        let kill: TerminateLogin = Rc::new(move || {
            terminate.cancel();
            Ok(())
        });
        let exited: LocalBoxFuture<'static, _> = Box::pin(async move {
            let status = tokio::select! {
                biased;
                exit = process.wait() => exit?,
                _ = cancelled.cancelled() => { process.start_kill()?; process.wait().await? }
            };
            Ok(status.code().unwrap_or(1))
        });
        (kill, exited)
    };
    Ok(CliLoginProcess {
        stdin,
        stdout,
        stderr,
        exited,
        kill,
    })
}

const MAX_LINE_LENGTH: usize = 16_384;

async fn drain_login_output(
    stream: Option<LoginOutput>,
    on_line: &dyn Fn(&str),
    logger: &dyn AgentLogger,
) {
    let Some(mut stream) = stream else {
        return;
    };
    let mut buffer = [0; 4096];
    let mut pending = Vec::new();
    let mut line = Vec::new();
    let mut first = true;
    loop {
        let read = match stream.read(&mut buffer).await {
            Ok(read) => read,
            Err(_) => {
                logger.debug("Auth login output read failed", None);
                return;
            }
        };
        pending.extend_from_slice(&buffer[..read]);
        let valid_end = if read == 0 {
            pending.len()
        } else {
            complete_utf8_prefix(&pending)
        };
        let text = String::from_utf8_lossy(&pending[..valid_end]);
        let mut text = text.as_ref();
        if first && !text.is_empty() {
            first = false;
            text = text.strip_prefix('\u{feff}').unwrap_or(text);
        }
        for piece in text.split_inclusive('\n') {
            let terminated = piece.ends_with('\n');
            line.extend(piece.strip_suffix('\n').unwrap_or(piece).encode_utf16());
            let excess = line.len().saturating_sub(MAX_LINE_LENGTH);
            if excess != 0 {
                line.drain(..excess);
            }
            if terminated {
                on_line(&String::from_utf16_lossy(&line));
                line.clear();
            }
        }
        pending.drain(..valid_end);
        if read == 0 {
            if !line.is_empty() {
                on_line(&String::from_utf16_lossy(&line));
            }
            return;
        }
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
