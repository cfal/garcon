use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    error::Error,
    rc::Rc,
    time::Duration,
};

use async_trait::async_trait;
use futures::{
    FutureExt,
    future::{LocalBoxFuture, Shared},
};
use garcon_base::{
    errors::{ErrorMetadata, SharedDiagnosticError, error_metadata},
    keyed_lock::LockAborted,
};
use garcon_contract::agent_cli_update::{
    AGENT_CLI_UPDATE_MESSAGE_MAX_CHARS, AGENT_CLI_UPDATE_OUTPUT_MAX_CHARS,
    AgentCliInstallMethod as Method, AgentCliUpdateRun, AgentCliUpdateRunState as State,
    AgentCliUpdateStatus, AgentCliVersionAdvisory as Advisory, IDLE_AGENT_CLI_UPDATE_RUN,
};
use garcon_interface::{
    cli_updates::{AgentCliUpdateStatusRequest, AgentCliUpdates},
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    host::AgentLogger,
    resources::ExecutorResult,
};
use garcon_js::{
    clock::{Clock, SystemClock, to_iso_string},
    js::trim,
    json::Opaque,
    utf16,
};
use indexmap::IndexMap;
use tokio::sync::{Mutex, oneshot};
use tokio_util::sync::CancellationToken;

use super::{
    bounded_command::{
        BoundedCommandOptions, BoundedCommandResult, output_lines, run_bounded_command, tail_utf16,
    },
    cli_probe::probe_cli_version,
    cli_version::compare_cli_versions,
    install_resolution::{
        CliCommandPaths, CliInstallContext, CliInstallDefinition, CliInstallation, CliUpdateAction,
        LatestVersionSource, display_real_path, resolve_cli_installation,
    },
    installer_environment::Environment,
    latest_version::{
        LatestVersionCache, LatestVersionLookup, homebrew_latest_version, npm_latest_version,
    },
};

pub struct CliUpdateTarget {
    pub command: String,
    pub bundled: bool,
}

pub struct NativeReleaseSource {
    pub key: String,
    pub lookup: LatestVersionLookup,
}

pub type CliUpdateTargetResolver =
    Rc<dyn Fn() -> LocalBoxFuture<'static, ExecutorResult<CliUpdateTarget>>>;
pub type NativeReleaseResolver =
    Rc<dyn Fn() -> LocalBoxFuture<'static, ExecutorResult<NativeReleaseSource>>>;

pub struct CliUpdateServiceOptions {
    pub label: String,
    pub definition: CliInstallDefinition,
    pub target: CliUpdateTargetResolver,
    pub environment: Rc<dyn Fn() -> ExecutorResult<Environment>>,
    pub native_release: NativeReleaseResolver,
    pub on_updated: Option<Rc<dyn Fn()>>,
    pub logger: Rc<dyn AgentLogger>,
    pub clock: Option<Rc<dyn Clock>>,
}

#[derive(Clone)]
struct InstalledStatus {
    install_method: Method,
    install_path: Option<String>,
    current_version: Option<String>,
    latest_version: Option<String>,
    advisory: Advisory,
    update_command: Option<String>,
    can_update: bool,
    message: Option<String>,
    checked_at: String,
}

const UPDATE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const PROGRESS_INTERVAL_MS: i64 = 1_000;

type SharedResult<T> = Result<T, Rc<dyn Error>>;
type Pending<T> = Shared<LocalBoxFuture<'static, SharedResult<T>>>;

thread_local! {
    static INSTALLER_LOCKS: RefCell<HashMap<String, Rc<Mutex<()>>>> = RefCell::new(HashMap::new());
}

struct InstallerLock<'a> {
    key: &'a str,
    mutex: Rc<Mutex<()>>,
}

impl<'a> InstallerLock<'a> {
    fn for_key(key: &'a str) -> Self {
        let mutex =
            INSTALLER_LOCKS.with(|locks| locks.borrow_mut().entry(key.into()).or_default().clone());
        Self { key, mutex }
    }
}

impl Drop for InstallerLock<'_> {
    fn drop(&mut self) {
        if Rc::strong_count(&self.mutex) == 2 {
            INSTALLER_LOCKS.with(|locks| locks.borrow_mut().remove(self.key));
        }
    }
}

#[derive(Clone)]
pub struct CliUpdateService(Rc<Service>);

struct Service {
    options: CliUpdateServiceOptions,
    latest_versions: LatestVersionCache,
    state: RefCell<ServiceState>,
}

struct ServiceState {
    run: AgentCliUpdateRun,
    starting: Option<Pending<()>>,
    run_snapshot: Option<InstalledStatus>,
    inspection: Option<(Rc<()>, Pending<InstalledStatus>)>,
    run_generation: u64,
}

impl CliUpdateService {
    pub fn new(options: CliUpdateServiceOptions) -> Self {
        Self(Rc::new(Service {
            options,
            latest_versions: LatestVersionCache::default(),
            state: RefCell::new(ServiceState {
                run: IDLE_AGENT_CLI_UPDATE_RUN,
                starting: None,
                run_snapshot: None,
                inspection: None,
                run_generation: 0,
            }),
        }))
    }

    fn status_with(
        &self,
        installed: InstalledStatus,
        run: AgentCliUpdateRun,
    ) -> AgentCliUpdateStatus {
        AgentCliUpdateStatus {
            cli_label: self.0.options.label.clone(),
            install_method: installed.install_method,
            install_path: installed.install_path,
            current_version: installed.current_version,
            latest_version: installed.latest_version,
            advisory: installed.advisory,
            update_command: installed.update_command,
            can_update: installed.can_update,
            message: installed.message,
            checked_at: installed.checked_at,
            run,
        }
    }

    fn shared_inspection(&self, refresh: bool) -> Pending<InstalledStatus> {
        if !refresh && let Some((_, pending)) = &self.0.state.borrow().inspection {
            return pending.clone();
        }
        let identity = Rc::new(());
        let (sender, pending) = pending_result();
        self.0.state.borrow_mut().inspection = Some((identity.clone(), pending.clone()));
        let service = self.clone();
        tokio::task::spawn_local(async move {
            let result = service.inspect(refresh).await.map_err(Rc::from);
            let mut state = service.0.state.borrow_mut();
            if state
                .inspection
                .as_ref()
                .is_some_and(|(current, _)| Rc::ptr_eq(current, &identity))
            {
                state.inspection = None;
            }
            let _ = sender.send(result);
        });
        pending
    }

    async fn begin(&self) -> ExecutorResult<()> {
        let env = (self.0.options.environment)()?;
        let (_, installation) = self.resolve(&env).await?;
        let Some(action) = installation.update.clone() else {
            return Err(Box::new(AgentIntegrationError::new(
                AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
                self.manual_message(&installation, None),
                false,
                None,
            )));
        };
        // INFALLIBLE: The resolver supplies paths for every update action.
        let paths = installation
            .paths
            .as_ref()
            .expect("update installation paths");
        let snapshot = self
            .inspect_installation(&installation, paths, &env, true)
            .await?;
        {
            let mut state = self.0.state.borrow_mut();
            state.run_snapshot = Some(snapshot.clone());
            state.inspection = None;
            state.run_generation += 1;
            state.run = AgentCliUpdateRun {
                state: State::Running,
                started_at: Some(self.timestamp()?),
                finished_at: None,
                message: Some("Checking for the latest version".into()),
                output: None,
            };
        }
        self.0.options.logger.info(
            "CLI update started.",
            Some(&fields([("command", &action.command)])),
        );
        if let (Some(before), Some(latest)) = (&snapshot.current_version, &snapshot.latest_version)
            && compare_cli_versions(before, latest).is_some_and(|order| order >= 0.0)
        {
            return self.finish(
                State::Succeeded,
                &format!(
                    "{} {before} is already the latest version.",
                    self.0.options.label
                ),
                None,
            );
        }
        let service = self.clone();
        let resolved = paths.resolved.clone();
        tokio::task::spawn_local(async move {
            if let Err(error) = service.execute(&resolved, action, env, snapshot).await {
                let _ = service.finish(State::Failed, &error.to_string(), None);
            }
        });
        Ok(())
    }

    async fn execute(
        &self,
        resolved: &str,
        action: CliUpdateAction,
        env: Environment,
        snapshot: InstalledStatus,
    ) -> ExecutorResult<()> {
        let result = {
            let lock = InstallerLock::for_key(&action.lock_key);
            let _guard = match lock.mutex.try_lock() {
                Ok(guard) => guard,
                Err(_) => {
                    self.progress("Waiting for another update to finish");
                    lock.mutex.lock().await
                }
            };
            self.progress(&format!("Running {}", action.command));
            let installer_env = env
                .iter()
                .chain(&action.env)
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            let last_published = Cell::new(0);
            let publish = |line: &str| {
                let now = self.clock().now_ms();
                if now - last_published.get() >= PROGRESS_INTERVAL_MS {
                    last_published.set(now);
                    self.progress(line);
                }
            };
            run_bounded_command(
                &action.executable,
                &action.args,
                BoundedCommandOptions {
                    env: &installer_env,
                    timeout: UPDATE_TIMEOUT,
                    max_output_bytes: AGENT_CLI_UPDATE_OUTPUT_MAX_CHARS,
                    on_line: Some(&publish),
                },
            )
            .await?
        };
        self.0.latest_versions.clear();
        if let Some(on_updated) = &self.0.options.on_updated {
            on_updated();
        }
        let output = combined_output(&result);
        if result.timed_out {
            return self.finish(
                State::Failed,
                "The update timed out after 30 minutes.",
                output,
            );
        }
        if result.exit_code != Some(0) {
            let code = result
                .exit_code
                .map_or_else(|| "null".into(), |code| code.to_string());
            return self.finish(
                State::Failed,
                &format!(
                    "The update command exited with code {code}: {}",
                    failure_reason(&result)
                ),
                output,
            );
        }
        self.progress("Verifying the installed version");
        let label = &self.0.options.label;
        let (state, message) = match probe_cli_version(resolved, &env, VERSION_PROBE_TIMEOUT).await
        {
            None => (
                State::Unchanged,
                format!("The update command finished, but {label} did not report its version."),
            ),
            Some(after)
                if match &snapshot.latest_version {
                    Some(latest) => compare_cli_versions(&after, latest).unwrap_or(-1.0) < 0.0,
                    None => snapshot.current_version.as_deref() == Some(&after),
                } =>
            {
                (
                    State::Unchanged,
                    format!("The update command finished, but {label} still reports {after}."),
                )
            }
            Some(after) => (
                State::Succeeded,
                format!(
                    "Updated {label} to {after}. Running chats keep the previous version; new sessions use the update."
                ),
            ),
        };
        self.finish(state, &message, output)
    }

    async fn inspect(&self, refresh: bool) -> ExecutorResult<InstalledStatus> {
        let env = (self.0.options.environment)()?;
        let (target, installation) = self.resolve(&env).await?;
        let Some(paths) = &installation.paths else {
            return Ok(InstalledStatus {
                install_method: Method::Missing,
                install_path: None,
                current_version: None,
                latest_version: None,
                advisory: Advisory::Unknown,
                update_command: None,
                can_update: false,
                message: Some(format!(
                    "{} ({}) was not found on PATH.",
                    self.0.options.label, target.command
                )),
                checked_at: self.timestamp()?,
            });
        };
        self.inspect_installation(&installation, paths, &env, refresh)
            .await
    }

    async fn inspect_installation(
        &self,
        installation: &CliInstallation,
        paths: &CliCommandPaths,
        env: &Environment,
        refresh: bool,
    ) -> ExecutorResult<InstalledStatus> {
        let (current_version, latest) = tokio::join!(
            probe_cli_version(&paths.resolved, env, VERSION_PROBE_TIMEOUT),
            self.latest_version(installation, env, refresh),
        );
        let latest = latest?;
        let latest_version = current_version.as_ref().and(latest);
        let advisory = match current_version
            .as_deref()
            .zip(latest_version.as_deref())
            .and_then(|(current, latest)| compare_cli_versions(current, latest))
        {
            None => Advisory::Unknown,
            Some(order) if order < 0.0 => Advisory::BehindLatest,
            Some(_) => Advisory::Current,
        };
        let message = if installation.method == Method::Bundled {
            Some(self.manual_message(installation, None))
        } else if current_version.is_none() {
            Some(format!(
                "{} at {} did not report its version.",
                self.0.options.label, paths.real
            ))
        } else if advisory == Advisory::BehindLatest && installation.update.is_none() {
            Some(self.manual_message(installation, latest_version.as_deref()))
        } else {
            None
        };
        Ok(InstalledStatus {
            install_method: installation.method,
            install_path: Some(paths.real.clone()),
            current_version,
            latest_version,
            advisory,
            update_command: installation
                .update
                .as_ref()
                .map(|action| action.command.clone())
                .or_else(|| installation.manual_command.clone()),
            can_update: installation.update.is_some(),
            message,
            checked_at: self.timestamp()?,
        })
    }

    async fn resolve(
        &self,
        env: &Environment,
    ) -> ExecutorResult<(CliUpdateTarget, CliInstallation)> {
        let target = (self.0.options.target)().await?;
        let installation = if target.bundled {
            let real = tokio::fs::canonicalize(&target.command)
                .await
                .map_or_else(|_| target.command.clone(), |path| display_real_path(&path));
            CliInstallation {
                method: Method::Bundled,
                paths: Some(CliCommandPaths {
                    resolved: target.command.clone(),
                    real,
                }),
                update: None,
                manual_command: None,
                latest_version: LatestVersionSource::None,
            }
        } else {
            let platform = if cfg!(windows) {
                "win32"
            } else {
                std::env::consts::OS
            };
            resolve_cli_installation(
                &self.0.options.definition,
                CliInstallContext {
                    command: &target.command,
                    env,
                    platform,
                },
            )
            .await
        };
        Ok((target, installation))
    }

    async fn latest_version(
        &self,
        installation: &CliInstallation,
        env: &Environment,
        fresh: bool,
    ) -> ExecutorResult<Option<String>> {
        let (key, lookup) = match &installation.latest_version {
            LatestVersionSource::None => return Ok(None),
            LatestVersionSource::Native => {
                let release = (self.0.options.native_release)().await?;
                (release.key, release.lookup)
            }
            LatestVersionSource::Homebrew { brew, name, cask } => (
                format!("homebrew:{}:{name}", if *cask { "cask" } else { "formula" }),
                homebrew_latest_version(brew.clone(), name.clone(), *cask, env.clone()),
            ),
            LatestVersionSource::Npm => {
                let package = &self.0.options.definition.package_name;
                (
                    format!("npm:{package}"),
                    npm_latest_version(package.clone(), env.clone()),
                )
            }
        };
        Ok(self.0.latest_versions.get(key, lookup, fresh).await)
    }

    fn manual_message(&self, installation: &CliInstallation, latest: Option<&str>) -> String {
        if installation.method == Method::Bundled {
            return format!(
                "Garcon runs its bundled {}, which updates with Garcon.",
                self.0.options.label
            );
        }
        let subject =
            latest.map_or_else(String::new, |latest| format!("Version {latest} is out. "));
        let location = installation.paths.as_ref().map_or_else(
            || "Update".into(),
            |paths| format!("Garcon runs {}; update", paths.real),
        );
        let command = installation.manual_command.as_ref().map_or_else(
            || " with the tool that installed it.".into(),
            |command| format!(" with: {command}"),
        );
        format!("{subject}{location} it{command}")
    }

    fn progress(&self, message: &str) {
        let mut state = self.0.state.borrow_mut();
        if state.run.state == State::Running {
            state.run.message = Some(truncate(message));
        }
    }

    fn finish(&self, status: State, message: &str, output: Option<String>) -> ExecutorResult<()> {
        let message = truncate(message);
        let finished_at = self.timestamp()?;
        {
            let mut state = self.0.state.borrow_mut();
            state.run = AgentCliUpdateRun {
                state: status,
                started_at: state.run.started_at.clone(),
                finished_at: Some(finished_at),
                message: Some(message.clone()),
                output: output.map(|output| tail_utf16(&output, AGENT_CLI_UPDATE_OUTPUT_MAX_CHARS)),
            };
            state.run_snapshot = None;
            state.inspection = None;
            state.run_generation += 1;
        }
        let status_label = match status {
            State::Succeeded => "succeeded",
            State::Failed => "failed",
            State::Unchanged => "unchanged",
            State::Idle => "idle",
            State::Running => "running",
        };
        let fields = fields([("state", status_label), ("message", &message)]);
        if status == State::Failed {
            self.0
                .options
                .logger
                .warn("CLI update finished.", Some(&fields));
        } else {
            self.0
                .options
                .logger
                .info("CLI update finished.", Some(&fields));
        }
        Ok(())
    }

    fn clock(&self) -> &dyn Clock {
        self.0.options.clock.as_deref().unwrap_or(&SystemClock)
    }

    fn timestamp(&self) -> ExecutorResult<String> {
        Ok(to_iso_string(self.clock().now_ms())?)
    }
}

#[async_trait(?Send)]
impl AgentCliUpdates for CliUpdateService {
    async fn status(
        &self,
        request: AgentCliUpdateStatusRequest,
    ) -> ExecutorResult<AgentCliUpdateStatus> {
        let mut generation = {
            let state = self.0.state.borrow();
            if let Some(snapshot) = &state.run_snapshot {
                return Ok(self.status_with(snapshot.clone(), state.run.clone()));
            }
            state.run_generation
        };
        let mut inspection = self
            .shared_inspection(request.refresh)
            .await
            .map_err(box_shared_error)?;
        loop {
            check_abort(request.signal.as_ref())?;
            {
                let state = self.0.state.borrow();
                if generation == state.run_generation || state.run_snapshot.is_some() {
                    return Ok(self.status_with(
                        state.run_snapshot.clone().unwrap_or(inspection),
                        state.run.clone(),
                    ));
                }
                generation = state.run_generation;
            }
            inspection = self
                .shared_inspection(false)
                .await
                .map_err(box_shared_error)?;
        }
    }

    async fn start_update(&self) -> ExecutorResult<AgentCliUpdateStatus> {
        let existing = {
            let state = self.0.state.borrow();
            (state.run.state == State::Running, state.starting.clone())
        };
        if !existing.0 {
            let pending = existing.1.unwrap_or_else(|| {
                let (sender, pending) = pending_result();
                self.0.state.borrow_mut().starting = Some(pending.clone());
                let service = self.clone();
                tokio::task::spawn_local(async move {
                    let result = service.begin().await.map_err(Rc::from);
                    service.0.state.borrow_mut().starting = None;
                    let _ = sender.send(result);
                });
                pending
            });
            pending.await.map_err(box_shared_error)?;
        }
        self.status(AgentCliUpdateStatusRequest {
            refresh: false,
            signal: None,
        })
        .await
    }
}

fn pending_result<T: Clone + 'static>() -> (oneshot::Sender<SharedResult<T>>, Pending<T>) {
    let (sender, receiver) = oneshot::channel();
    let pending = async move {
        match receiver.await {
            Ok(value) => value,
            Err(error) => Err(Rc::from(Box::new(error) as Box<dyn Error>)),
        }
    }
    .boxed_local()
    .shared();
    (sender, pending)
}

fn box_shared_error(error: Rc<dyn Error>) -> Box<dyn Error> {
    if let Some(error) = error.downcast_ref::<AgentIntegrationError>() {
        return Box::new(error.clone());
    }
    let ErrorMetadata { name, code } = error_metadata(error.as_ref());
    Box::new(SharedDiagnosticError::new(
        error.clone(),
        ErrorMetadata { name, code },
    ))
}

fn check_abort(signal: Option<&CancellationToken>) -> ExecutorResult<()> {
    if signal.is_some_and(CancellationToken::is_cancelled) {
        return Err(Box::new(LockAborted));
    }
    Ok(())
}

fn fields<const N: usize>(fields: [(&str, &str); N]) -> IndexMap<String, Opaque> {
    fields
        .into_iter()
        .map(|(key, value)| (key.into(), Opaque::from_value(value.into())))
        .collect()
}

fn truncate(message: &str) -> String {
    if utf16::len(message) <= AGENT_CLI_UPDATE_MESSAGE_MAX_CHARS {
        return message.to_owned();
    }
    let units: Vec<_> = message
        .encode_utf16()
        .take(AGENT_CLI_UPDATE_MESSAGE_MAX_CHARS - 1)
        .collect();
    format!("{}\u{2026}", String::from_utf16_lossy(&units))
}

fn combined_output(result: &BoundedCommandResult) -> Option<String> {
    let output = [trim(&result.stdout), trim(&result.stderr)]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    (!output.is_empty()).then_some(output)
}

fn failure_reason(result: &BoundedCommandResult) -> String {
    let stderr = output_lines(&result.stderr);
    let stdout = output_lines(&result.stdout);
    let failure = stderr.iter().rev().chain(stdout.iter().rev()).find(|line| {
        let line = line.to_ascii_lowercase();
        line.contains("error") || line.contains("fail")
    });
    truncate(
        failure
            .or_else(|| stderr.last())
            .or_else(|| stdout.last())
            .map_or("no output", String::as_str),
    )
}
