//! Ports `server-agents/pi/src/agents/pi/pi-models.ts`.

use std::{
    cell::{Cell, RefCell},
    io,
    process::{ExitStatus, Stdio},
    rc::Rc,
    time::Duration,
};

use futures::{FutureExt, future::LocalBoxFuture};
use garcon_agents_common::shared::shared_probe::{
    InFlightProbes, shared_probe, wait_unless_aborted,
};
use garcon_base::errors::{
    DiagnosticError, ErrorInput, ErrorMetadata, NamedError, has_node_error_code,
};
use garcon_contract::agents::AgentModelOption;
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Clock, SystemClock, trim, trim_end, utf16};
use indexmap::IndexMap;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    time::sleep,
};
use tokio_util::sync::CancellationToken;

use crate::{config::PiConfig, pi_cli::build_pi_cli_env, pi_process_lifecycle::exit_code};

const EMPTY_BANNER: &str = "No models available. Use /login ";
const TABLE_COLUMNS: [&str; 6] = [
    "provider", "model", "context", "max-out", "thinking", "images",
];
const MODEL_CACHE_TTL_MS: i64 = 5 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS: u64 = 20_000;
const FAILURE_COOLDOWN_MS: i64 = 15_000;
const MAX_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;
const DISCOVERY: &str = "discovery";

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PiModelListingError {
    #[error("Unexpected Pi --list-models output. Check the installed Pi CLI version.")]
    Unexpected,
    #[error("Malformed row in Pi --list-models output.")]
    Malformed,
    #[error("Pi reported discovery errors. Check pi --list-models on this executor.")]
    Diagnostics,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct PiModelDiscoveryUnavailableError {
    message: String,
    pub stale_models: Vec<AgentModelOption>,
}

impl DiagnosticError for PiModelDiscoveryUnavailableError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "PiModelDiscoveryUnavailableError",
            code: Some("PI_MODEL_DISCOVERY_UNAVAILABLE"),
        }
    }
}

fn is_table_header(line: &str) -> bool {
    !line.starts_with(' ')
        && !line.ends_with(' ')
        && line
            .split(' ')
            .filter(|word| !word.is_empty())
            .eq(TABLE_COLUMNS)
}

// The metadata command works before a model is selected and reports config errors even on exit 0.
// https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/cli/list-models.ts#L29-L115
pub fn parse_pi_model_listing(
    stdout: &str,
    stderr: &str,
) -> Result<Vec<AgentModelOption>, PiModelListingError> {
    let mut lines = trim_end(stdout)
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line));
    let header = lines
        .find(|line| is_table_header(line) || line.starts_with(EMPTY_BANNER))
        .ok_or(PiModelListingError::Unexpected)?;
    let rows: Vec<_> = lines.collect();
    if header.starts_with(EMPTY_BANNER)
        && let [provider_help, model_help] = &rows[..]
        && trim_end(provider_help).ends_with("providers.md")
        && trim_end(model_help).ends_with("models.md")
    {
        // Pi can repeat the login guidance as a startup warning.
        // https://github.com/earendil-works/pi/blob/faac585884ae2c013a6b1400f3e9e77f10b34bac/packages/coding-agent/src/main.ts#L927-L973
        let diagnostics = stderr.replace("\r\n", "\n");
        let diagnostics = trim(&diagnostics);
        if !diagnostics.is_empty()
            && diagnostics != format!("Warning: {header}\n{provider_help}\n{model_help}")
        {
            return Err(PiModelListingError::Diagnostics);
        }
        return Ok(Vec::new());
    }
    if rows.is_empty() || !is_table_header(header) {
        return Err(PiModelListingError::Unexpected);
    }
    let model_start = header
        .find("model")
        .ok_or(PiModelListingError::Unexpected)? as isize;
    let context_start = header
        .find("context")
        .ok_or(PiModelListingError::Unexpected)? as isize;
    let images_start = header
        .find("images")
        .ok_or(PiModelListingError::Unexpected)? as isize;
    rows.into_iter()
        .map(|row| {
            let provider = trim(utf16::slice(row, 0, Some(model_start)));
            let id = trim(utf16::slice(row, model_start, Some(context_start)));
            let images = trim(utf16::slice(row, images_start, None));
            if provider.is_empty() || id.is_empty() || !matches!(images, "yes" | "no") {
                return Err(PiModelListingError::Malformed);
            }
            let short_id = id.rsplit('/').find(|part| !part.is_empty()).unwrap_or(id);
            Ok(AgentModelOption {
                value: format!("{provider}/{id}"),
                label: format!("{provider}: {short_id}"),
                supports_images: Some(images == "yes"),
                is_local: None,
                api_provider_id: None,
                endpoint_id: None,
                raw_model: None,
                protocol: None,
            })
        })
        .collect()
}

pub async fn get_pi_available_models(
    binary: &str,
    signal: &CancellationToken,
) -> ExecutorResult<Vec<AgentModelOption>> {
    check_abort(signal)?;
    let mut env = build_pi_cli_env(Some(&IndexMap::from_iter([(
        "NO_COLOR".to_owned(),
        "1".to_owned(),
    )])));
    env.shift_remove("FORCE_COLOR");
    let mut command = Command::new(binary);
    command
        .arg("--list-models")
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    let pid = child.id();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let stopped = Cell::new(false);
    let output_limit_reached = Cell::new(false);
    let settle = async {
        let observe = async {
            let status = child.wait().await?;
            stop_discovery_process(&mut child, pid, &stopped).await?;
            Ok::<ExitStatus, io::Error>(status)
        };
        tokio::try_join!(
            read_discovery_output(stdout.as_mut(), &output_limit_reached),
            read_discovery_output(stderr.as_mut(), &output_limit_reached),
            observe
        )
    };
    let result: ExecutorResult<(String, String, ExitStatus)> = tokio::select! {
        biased;
        _ = signal.cancelled() => Err(aborted().into()),
        settled = settle => settled.map_err(Into::into),
    };
    stop_discovery_process(&mut child, pid, &stopped).await?;
    if output_limit_reached.get() {
        // Bun's maxBuffer kills the process and reports its exit, not a pipe error.
        check_abort(signal)?;
        return Err(discovery_exit_error(exit_code(child.wait().await?)));
    }
    let (stdout, stderr, status) = result?;
    check_abort(signal)?;
    let code = exit_code(status);
    if code != 0 {
        return Err(discovery_exit_error(code));
    }
    Ok(parse_pi_model_listing(&stdout, &stderr)?)
}

fn discovery_exit_error(code: i32) -> Box<dyn std::error::Error> {
    format!("Pi model discovery failed (exit {code}). Check pi --list-models on this executor.")
        .into()
}

async fn read_discovery_output(
    pipe: Option<impl AsyncRead + Unpin>,
    output_limit_reached: &Cell<bool>,
) -> io::Result<String> {
    let Some(pipe) = pipe else {
        return Ok(String::new());
    };
    let mut bytes = Vec::new();
    pipe.take(MAX_OUTPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 > MAX_OUTPUT_BYTES {
        output_limit_reached.set(true);
        return Err(io::Error::other(
            "Pi model discovery output exceeded 4194304 bytes",
        ));
    }
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned())
}

async fn stop_discovery_process(
    child: &mut Child,
    pid: Option<u32>,
    stopped: &Cell<bool>,
) -> io::Result<()> {
    if stopped.replace(true) {
        return Ok(());
    }
    let result = stop_discovery_group(child, pid).await;
    if child.try_wait()?.is_none() {
        child.start_kill()?;
    }
    child.wait().await?;
    result
}

#[cfg(unix)]
async fn stop_discovery_group(_child: &mut Child, pid: Option<u32>) -> io::Result<()> {
    use nix::{
        errno::Errno,
        sys::signal::{Signal, killpg},
        unistd::Pid,
    };
    if let Some(pid) = pid {
        match killpg(Pid::from_raw(pid as i32), Signal::SIGKILL) {
            Ok(()) | Err(Errno::ESRCH | Errno::ENOENT) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(windows)]
async fn stop_discovery_group(child: &mut Child, pid: Option<u32>) -> io::Result<()> {
    if let Some(pid) = pid
        && child.try_wait()?.is_none()
    {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned());
        let taskkill = garcon_js::path::win32::join(&[&system_root, "System32", "taskkill.exe"]);
        let mut command = Command::new(taskkill);
        command
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .env_clear()
            .env("SystemRoot", system_root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Ok(Err(error)) = tokio::time::timeout(Duration::from_secs(2), command.status()).await
            && error.kind() != io::ErrorKind::NotFound
        {
            return Err(error);
        }
    }
    Ok(())
}

type DiscoverModels =
    dyn Fn(CancellationToken) -> LocalBoxFuture<'static, ExecutorResult<Vec<AgentModelOption>>>;

#[derive(Clone)]
enum DiscoveryOutcome {
    Models(Vec<AgentModelOption>),
    Unavailable(PiModelDiscoveryUnavailableError),
    Aborted,
}

struct State {
    config: Rc<PiConfig>,
    clock: Rc<dyn Clock>,
    discover: Rc<DiscoverModels>,
    cache: RefCell<Option<(i64, Vec<AgentModelOption>)>>,
    failure: RefCell<Option<(i64, PiModelDiscoveryUnavailableError)>>,
    inflight: InFlightProbes<DiscoveryOutcome>,
    lifetime: RefCell<CancellationToken>,
}

pub struct PiModelCatalogService(Rc<State>);

impl PiModelCatalogService {
    pub fn new(config: Rc<PiConfig>) -> Self {
        Self::with_discover(
            config.clone(),
            Rc::new(SystemClock),
            Rc::new(move |signal| {
                let config = config.clone();
                async move { get_pi_available_models(&config.binary()?, &signal).await }
                    .boxed_local()
            }),
        )
    }

    pub fn with_discover(
        config: Rc<PiConfig>,
        clock: Rc<dyn Clock>,
        discover: Rc<DiscoverModels>,
    ) -> Self {
        Self(Rc::new(State {
            config,
            clock,
            discover,
            cache: RefCell::default(),
            failure: RefCell::default(),
            inflight: Rc::default(),
            lifetime: RefCell::default(),
        }))
    }

    pub async fn get_models_strict(
        &self,
        signal: Option<&CancellationToken>,
    ) -> ExecutorResult<Vec<AgentModelOption>> {
        if let Some(signal) = signal {
            check_abort(signal)?;
        }
        let lifetime = self.0.lifetime.borrow().clone();
        check_abort(&lifetime)?;
        let now = self.0.clock.now_ms();
        if let Some((until, models)) = &*self.0.cache.borrow()
            && now < *until
        {
            return Ok(models.clone());
        }
        if let Some((until, error)) = &*self.0.failure.borrow()
            && now < *until
        {
            return Err(error.clone().into());
        }
        let state = self.0.clone();
        let pending = shared_probe(&self.0.inflight, DISCOVERY, || {
            async move { Ok(state.discover_with_retry(lifetime).await) }.boxed_local()
        });
        match wait_unless_aborted(pending, signal).await? {
            DiscoveryOutcome::Models(models) => Ok(models),
            DiscoveryOutcome::Unavailable(error) => Err(error.into()),
            DiscoveryOutcome::Aborted => Err(aborted().into()),
        }
    }

    pub async fn get_models(
        &self,
        signal: Option<&CancellationToken>,
    ) -> ExecutorResult<Vec<AgentModelOption>> {
        match self.get_models_strict(signal).await {
            Ok(models) => Ok(models),
            Err(error) => {
                if let Some(signal) = signal {
                    check_abort(signal)?;
                }
                check_abort(&self.0.lifetime.borrow())?;
                Ok(error
                    .downcast_ref::<PiModelDiscoveryUnavailableError>()
                    .map_or_else(|| self.0.stale_models(), |error| error.stale_models.clone()))
            }
        }
    }

    pub fn start(&self) {
        if self.0.lifetime.borrow().is_cancelled() {
            self.0.lifetime.replace(CancellationToken::new());
        }
    }

    pub async fn stop(&self) {
        self.0.lifetime.borrow().cancel();
        let running = self.0.inflight.borrow().get(DISCOVERY).cloned();
        if let Some(running) = running {
            let _ = running.await;
        }
        self.0.cache.replace(None);
        self.0.failure.replace(None);
    }
}

impl State {
    fn stale_models(&self) -> Vec<AgentModelOption> {
        self.cache
            .borrow()
            .as_ref()
            .map_or_else(Vec::new, |(_, models)| models.clone())
    }

    async fn discover_with_retry(&self, lifetime: CancellationToken) -> DiscoveryOutcome {
        let signal = lifetime.child_token();
        let timed_out = Cell::new(false);
        let discover = self.attempt_discovery(&signal, &lifetime, &timed_out);
        tokio::pin!(discover);
        tokio::select! {
            result = &mut discover => result,
            _ = sleep(Duration::from_millis(DISCOVERY_TIMEOUT_MS)) => {
                timed_out.set(true);
                signal.cancel();
                discover.await
            }
        }
    }

    async fn attempt_discovery(
        &self,
        signal: &CancellationToken,
        lifetime: &CancellationToken,
        timed_out: &Cell<bool>,
    ) -> DiscoveryOutcome {
        let delays = match self.config.is_test_environment() {
            Ok(true) => [0, 0, 0],
            Ok(false) => [0, 75, 250],
            Err(error) => return self.unavailable(error.to_string(), true),
        };
        let mut last_error = "undefined".to_owned();
        let mut missing = false;
        for delay in delays {
            if delay > 0 {
                tokio::select! {
                    _ = signal.cancelled() => (),
                    _ = sleep(Duration::from_millis(delay)) => (),
                }
            }
            let result = match check_abort(signal) {
                Ok(()) => (self.discover)(signal.clone()).await,
                Err(error) => Err(error),
            };
            if lifetime.is_cancelled() {
                return DiscoveryOutcome::Aborted;
            }
            if timed_out.get() {
                return self.unavailable("The operation timed out.".to_owned(), true);
            }
            match result {
                Ok(models) => {
                    self.cache.replace(Some((
                        self.clock.now_ms().saturating_add(MODEL_CACHE_TTL_MS),
                        models.clone(),
                    )));
                    self.failure.replace(None);
                    return DiscoveryOutcome::Models(models);
                }
                Err(error) => {
                    missing = has_node_error_code(ErrorInput::Error(error.as_ref()), "ENOENT");
                    let invalid_listing = matches!(
                        error.downcast_ref::<PiModelListingError>(),
                        Some(PiModelListingError::Unexpected | PiModelListingError::Malformed)
                    );
                    let timeout_error = error
                        .downcast_ref::<NamedError>()
                        .is_some_and(|error| error.name == "TimeoutError");
                    last_error = error.to_string();
                    if missing || invalid_listing || timeout_error {
                        break;
                    }
                }
            }
        }
        self.unavailable(last_error, !missing)
    }

    fn unavailable(&self, message: String, cache: bool) -> DiscoveryOutcome {
        let error = PiModelDiscoveryUnavailableError {
            message,
            stale_models: self.stale_models(),
        };
        if cache {
            self.failure.replace(Some((
                self.clock.now_ms().saturating_add(FAILURE_COOLDOWN_MS),
                error.clone(),
            )));
        }
        DiscoveryOutcome::Unavailable(error)
    }
}

pub(crate) fn aborted() -> NamedError {
    NamedError {
        name: "AbortError".to_owned(),
        message: "The operation was aborted.".to_owned(),
        code: None,
    }
}

pub(crate) fn check_abort(signal: &CancellationToken) -> ExecutorResult<()> {
    if signal.is_cancelled() {
        return Err(aborted().into());
    }
    Ok(())
}
