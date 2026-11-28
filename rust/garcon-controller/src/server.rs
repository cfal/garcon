mod catalog_configuration;
mod runtime_environment;
mod unavailable_local_executor;

use std::cell::Cell;
use std::error::Error;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::rc::Rc;

use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_base::server_runtime::{
    ServerListener, ServerRuntimeState, advertised_server_url, create_server_runtime_state,
    log_server_ready, publish_server_runtime, remove_server_runtime,
};
use garcon_contract::cli_runtime_paths::{RuntimeKind, cli_runtime_file};
use garcon_contract::ws_revision_invalidations::TicketsInvalidatedMessage;
use garcon_http::app_title::resolve_public_app_title;
use garcon_http::compose_routes::compose_routes;
use garcon_http::http_request::HttpAuthentication;
use garcon_http::http_route::{HttpRouteOptions, HttpRouter};
use garcon_http::listener::Listener;
use garcon_http::routes::{
    auth::AuthRoutes, create_edge_routes, executors::create_executor_connection_routes,
    r#static::StaticRoutes, tickets::create_ticket_routes,
};
use garcon_http::ws::{BrowserSocketLimits, BrowserSocketOptions, BrowserSockets};
use garcon_interface::execution_runtime::ExecutionRuntimeApi;
use garcon_interface::host::AgentApiProviderReader;
use garcon_interface::resources::ExecutorResult;
use garcon_js::SystemClock;
use garcon_stores::auth::passwords::BunPasswords;
use garcon_stores::auth::service::AuthService;
use garcon_stores::auth::store::AuthAccountStore;
use garcon_stores::auth::token::AuthTokens;
use garcon_stores::executors::config_store::ExecutorConfigStore;
use garcon_stores::settings::SettingsStore;
use garcon_stores::telegram_settings_store::TelegramSettingsStore;
use garcon_stores::tickets::{
    service::TicketServiceOptions,
    setup::{TicketRuntime, initialize_tickets},
};
use tokio::fs;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::config::{HELP_TEXT, ServerConfig, initialize_server_config, is_help_requested};
use super::provider_configuration::{ProviderConfiguration, ProviderProfiles};
use super::workspace_lease::{ControllerLease, acquire_controller_lease};
use super::workspace_version::open_workspace;

pub use unavailable_local_executor::UnavailableLocalExecutor;

pub struct LocalExecutorContext<'a> {
    pub config: &'a ServerConfig,
    pub workspace_dir: &'a Path,
    pub credentials: Rc<dyn AgentApiProviderReader>,
}

type StartLocal<'a> =
    Box<dyn FnOnce(LocalExecutorContext<'_>) -> ExecutorResult<Rc<dyn ExecutionRuntimeApi>> + 'a>;

pub struct Controller {
    pub address: SocketAddr,
    pub runtime_file: String,
    pub instance_id: String,
    local: Rc<dyn ExecutionRuntimeApi>,
    lease: ControllerLease,
    listener: JoinHandle<()>,
    auth_routes: Rc<AuthRoutes>,
    browser_sockets: Rc<BrowserSockets>,
    executors: Rc<ExecutorConfigStore>,
    tickets: Rc<TicketRuntime>,
    listener_shutdown: CancellationToken,
    lease_lost: CancellationToken,
    shutting_down: Rc<Cell<bool>>,
    logger: ScopedLogger,
}

/// Runs the native controller in the calling process.
///
/// # Safety
/// Call before starting other threads; startup changes the process environment.
pub unsafe fn run_native(args: &[String], local: Rc<dyn ExecutionRuntimeApi>) -> ExitCode {
    // SAFETY: the caller guarantees the startup environment can be changed.
    unsafe { run_native_with_local(args, |_| Ok(local)) }
}

/// Builds Local on the controller's LocalSet after the workspace and provider
/// policy are open and before the listener is bound.
/// # Safety
/// Call before starting other threads; startup changes the process environment.
pub unsafe fn run_native_with_local(
    args: &[String],
    start_local: impl FnOnce(LocalExecutorContext<'_>) -> ExecutorResult<Rc<dyn ExecutionRuntimeApi>>,
) -> ExitCode {
    if is_help_requested(args) {
        print!("{HELP_TEXT}");
        return ExitCode::SUCCESS;
    }
    // SAFETY: callers guarantee the startup environment can be changed.
    match unsafe { run_process(args, Box::new(start_local)) } {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            create_logger("server").error(&format!("Failed to start or stop server: {error}"));
            ExitCode::FAILURE
        }
    }
}

unsafe fn run_process(args: &[String], start_local: StartLocal<'_>) -> Result<(), Box<dyn Error>> {
    if args.first().is_some_and(|argument| argument == "executor") {
        return Err("The native controller does not run the executor subcommand".into());
    }
    let server_root = install_root()?;
    let config = initialize_server_config(args, &server_root.to_string_lossy())?;
    // SAFETY: the native entry point is single threaded and has not built the runtime yet.
    unsafe { runtime_environment::install(&config.config_dir) };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    tokio::task::LocalSet::new().block_on(&runtime, run_until_shutdown(config, start_local))
}

fn install_root() -> std::io::Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let cwd = std::env::current_dir()?;
    let installed = executable
        .ancestors()
        .skip(1)
        .find(|root| root.join("web/build").is_dir());
    if let Some(installed) = installed {
        Ok(installed.to_path_buf())
    } else if cwd.join("web/build").is_dir() {
        Ok(cwd)
    } else {
        Ok(executable.parent().map_or(cwd, Path::to_path_buf))
    }
}

async fn run_until_shutdown(
    config: ServerConfig,
    start_local: StartLocal<'_>,
) -> Result<(), Box<dyn Error>> {
    #[cfg(unix)]
    let shutdown_signal = {
        use tokio::signal::unix::{SignalKind, signal};

        let mut terminate = signal(SignalKind::terminate())?;
        let mut interrupt = signal(SignalKind::interrupt())?;
        async move {
            tokio::select! {
                _ = terminate.recv() => {}
                _ = interrupt.recv() => {}
            }
        }
    };
    #[cfg(windows)]
    let shutdown_signal = {
        let mut interrupt = tokio::signal::windows::ctrl_c()?;
        async move {
            interrupt.recv().await;
        }
    };
    let controller = Controller::start_with_local(config, start_local).await?;
    tokio::select! {
        () = shutdown_signal => {}
        _ = controller.lease_lost() => {}
    }
    controller.shutdown().await
}

impl Controller {
    /// Starts the controller on the caller's LocalSet.
    pub async fn start(
        config: ServerConfig,
        local: Rc<dyn ExecutionRuntimeApi>,
    ) -> Result<Self, Box<dyn Error>> {
        Self::start_with_local(config, |_| Ok(local)).await
    }

    pub async fn start_with_local(
        config: ServerConfig,
        start_local: impl FnOnce(
            LocalExecutorContext<'_>,
        ) -> ExecutorResult<Rc<dyn ExecutionRuntimeApi>>,
    ) -> Result<Self, Box<dyn Error>> {
        if std::env::var_os("GARCON_AGENT_EXECUTOR_CONFIG").is_some_and(|value| !value.is_empty()) {
            return Err("GARCON_AGENT_EXECUTOR_CONFIG is no longer supported. Add executors in the app and use a fresh workspace for experimental remote-only chats.".into());
        }
        if config.rollback_carry_over_migration {
            return Err("--rollback-carryover-migration is not supported by the Rust controller; use Garcon 0.4.2".into());
        }
        let logger = create_logger("server");
        let lease_lost = CancellationToken::new();
        let lost = lease_lost.clone();
        let lease_logger = create_logger("server");
        let lease = acquire_controller_lease(
            Path::new(&config.config_dir),
            Path::new(&config.workspace_dir),
            Rc::new(move |error| {
                lease_logger.error(&format!("Workspace lease was compromised: {error}"));
                lost.cancel();
            }),
        )
        .await?;
        let shutting_down = Rc::new(Cell::new(false));
        let result = bind_controller(
            &config,
            &lease,
            Rc::clone(&shutting_down),
            &logger,
            start_local,
        )
        .await;
        let BoundController {
            local,
            listener,
            router,
            address,
            runtime_file,
            instance_id,
            auth_routes,
            browser_sockets,
            executors,
            tickets,
        } = match result {
            Ok(values) => values,
            Err(error) => {
                if let Err(release) = lease.release().await {
                    logger.warn(&format!("Failed to release workspace lease: {release}"));
                }
                return Err(error);
            }
        };
        let listener_shutdown = CancellationToken::new();
        let router = Rc::new(router);
        let listener = tokio::task::spawn_local(listener.serve(
            move |request, peer| {
                let router = Rc::clone(&router);
                async move { router.handle(request, peer).await }
            },
            listener_shutdown.clone(),
        ));
        log_server_ready(
            &logger,
            ServerListener {
                bind_address: &config.bind_address,
                port: f64::from(address.port()),
                auth_disabled: config.auth_disabled,
                base_path: Some(&config.base_path),
            },
        );
        Ok(Self {
            address,
            runtime_file,
            instance_id,
            local,
            lease,
            listener,
            auth_routes,
            browser_sockets,
            executors,
            tickets,
            listener_shutdown,
            lease_lost,
            shutting_down,
            logger,
        })
    }

    pub fn local(&self) -> Rc<dyn ExecutionRuntimeApi> {
        self.local.clone()
    }

    pub async fn lease_lost(&self) {
        self.lease_lost.cancelled().await;
    }

    pub async fn shutdown(self) -> Result<(), Box<dyn Error>> {
        self.shutting_down.set(true);
        self.logger.info("server: shutting down...");
        self.listener_shutdown.cancel();
        self.browser_sockets.shutdown().await;
        let listener = self.listener.await;
        self.auth_routes.drain().await;
        self.executors.drain().await;
        let local = self.local.dispose().await;
        self.tickets.close();
        let runtime = remove_server_runtime(self.runtime_file, &self.instance_id).await;
        let lease = self.lease.release().await;
        listener?;
        local?;
        runtime?;
        lease?;
        Ok(())
    }
}

struct BoundController {
    local: Rc<dyn ExecutionRuntimeApi>,
    listener: Listener,
    router: HttpRouter,
    address: SocketAddr,
    runtime_file: String,
    instance_id: String,
    auth_routes: Rc<AuthRoutes>,
    browser_sockets: Rc<BrowserSockets>,
    executors: Rc<ExecutorConfigStore>,
    tickets: Rc<TicketRuntime>,
}

async fn bind_controller(
    config: &ServerConfig,
    lease: &ControllerLease,
    shutting_down: Rc<Cell<bool>>,
    logger: &ScopedLogger,
    start_local: impl FnOnce(LocalExecutorContext<'_>) -> ExecutorResult<Rc<dyn ExecutionRuntimeApi>>,
) -> Result<BoundController, Box<dyn Error>> {
    let path = cli_runtime_file(&config.config_dir, RuntimeKind::Controller);
    match fs::remove_file(path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let runtime = Rc::new(create_server_runtime_state(
        lease.workspace_dir().to_string_lossy(),
        &SystemClock,
    )?);
    open_workspace(lease.workspace_dir()).await?;
    let clock: Rc<dyn garcon_js::Clock> = Rc::new(SystemClock);
    let store = AuthAccountStore::open(&config.config_dir, clock.clone()).await?;
    let auth = Rc::new(AuthService::new(
        store,
        AuthTokens::new(config.jwt_token_expiry.clone(), clock.clone()),
        Rc::new(BunPasswords),
        clock.clone(),
    ));
    let auth_routes = AuthRoutes::new(
        auth.clone(),
        config.auth_disabled,
        config.trust_proxy_enabled,
    )?;
    let profiles = ProviderProfiles::open(&config.config_dir, clock.clone()).await?;
    let executors = ExecutorConfigStore::open(&lease.workspace_dir().to_string_lossy()).await?;
    let providers =
        ProviderConfiguration::open(profiles, lease.workspace_dir(), &executors).await?;
    let credentials = providers.local_credentials();
    let settings = SettingsStore::open(
        &lease.workspace_dir().to_string_lossy(),
        providers.settings_options(),
    )
    .await?;
    TelegramSettingsStore::open(&config.config_dir, clock.clone()).await?;
    let catalog_routes = catalog_configuration::initialize_catalog_routes(
        &lease.workspace_dir().to_string_lossy(),
        clock.as_ref(),
    )
    .await?;
    let title_settings = settings.clone();
    let edge_routes = create_edge_routes(
        Rc::clone(&runtime),
        config.workspace_name.clone(),
        StaticRoutes {
            web_build_dir: PathBuf::from(&config.web_build_dir),
            base_path: config.base_path.clone(),
            app_title: Rc::new(move || {
                let current = title_settings.snapshot();
                resolve_public_app_title(&current.ui, current.remote_settings_version)
            }),
        },
        &auth_routes,
    )?;
    let unported_log = std::env::var_os("GARCON_RS_UNPORTED_LOG")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if !garcon_js::is_integer(config.max_ws_clients.0) || config.max_ws_clients.0 < 1.0 {
        return Err("WebSocket maximum must be a positive integer".into());
    }
    if config.http_idle_timeout_seconds.0 > f64::from(u8::MAX) {
        return Err("Bun.serve expects idleTimeout to be 255 or less".into());
    }
    let browser_sockets = BrowserSockets::new(
        BrowserSocketOptions {
            max_clients: config.max_ws_clients.0 as usize,
            limits: BrowserSocketLimits::from_config(
                config.ws_max_payload_length,
                config.ws_idle_timeout_seconds,
                config.ws_backpressure_limit,
            )?,
            auth_disabled: config.auth_disabled,
            shutting_down: Rc::clone(&shutting_down),
        },
        auth.clone(),
        runtime.identity.instance_id.clone(),
        clock.clone(),
        unported_log.clone(),
    )?;
    let ticket_sockets = browser_sockets.clone();
    let tickets = Rc::new(initialize_tickets(
        lease.workspace_dir(),
        TicketServiceOptions {
            chat_exists: None,
            commands_enabled: Rc::new(move || {
                let commands = settings.feature_settings().agent_commands;
                commands.enabled && commands.tickets
            }),
            on_invalidated: Some(Rc::new(move |revision| {
                let payload = serde_json::to_vec(&TicketsInvalidatedMessage::new(revision))?;
                ticket_sockets.publish("chat", &payload.into());
                Ok(())
            })),
            clock,
        },
    ));
    let routes = compose_routes([
        &edge_routes,
        &create_executor_connection_routes(
            &executors,
            config.public_url.clone(),
            config.base_path.clone(),
        ),
        &create_ticket_routes(&tickets),
        &providers.routes(&browser_sockets),
        &catalog_routes,
    ])?;
    let router = HttpRouter::new(
        routes,
        HttpRouteOptions {
            base_path: config.base_path.clone(),
            auth_disabled: config.auth_disabled,
            compression_enabled: config.http_compression_enabled,
            server_instance_id: Some(runtime.identity.instance_id.clone()),
            shutting_down,
            unported_log,
        },
        Rc::new(HttpAuthentication::new(
            auth,
            runtime.local_capability.clone(),
        )),
    )?
    .with_browser_sockets(browser_sockets.clone());
    let local = start_local(LocalExecutorContext {
        config,
        workspace_dir: lease.workspace_dir(),
        credentials,
    })?;
    let (listener, address, runtime_file) = match bind_listener(config, &runtime, logger).await {
        Ok(listener) => listener,
        Err(error) => {
            if let Err(dispose) = local.dispose().await {
                logger.warn(&format!("Failed to dispose Local executor: {dispose}"));
            }
            return Err(error);
        }
    };
    Ok(BoundController {
        local,
        listener,
        router,
        address,
        runtime_file,
        instance_id: runtime.identity.instance_id.clone(),
        auth_routes,
        browser_sockets,
        executors,
        tickets,
    })
}

async fn bind_listener(
    config: &ServerConfig,
    runtime: &ServerRuntimeState,
    logger: &ScopedLogger,
) -> Result<(Listener, SocketAddr, String), Box<dyn Error>> {
    let listener = Listener::bind(
        &config.bind_address,
        config.port,
        config.max_request_body_size.0 as usize,
        config.http_idle_timeout_seconds.0 as u8,
    )
    .await?;
    let address = listener.local_addr()?;
    let origin = config
        .runtime_origin
        .clone()
        .unwrap_or_else(|| advertised_server_url(&config.bind_address, f64::from(address.port())));
    let base_url = format!("{origin}{}", config.base_path);
    let published = publish_server_runtime(runtime, &base_url, &config.config_dir).await?;
    logger.info(&format!(
        "Published controller runtime at {} ({base_url})",
        published.file_path
    ));
    Ok((listener, address, published.file_path))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::Duration;

    use super::*;
    use crate::config::{ConfigEnvironment, parse_server_config};
    use garcon_base::workspace_lease::WORKSPACE_LOCK_NAME;
    use garcon_stores::settings::SettingsStoreOptions;
    use serde_json::Value;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::task::LocalSet;

    fn config(root: &Path) -> ServerConfig {
        let args = vec![
            "--port=0".to_string(),
            "--base-path=/fixture".to_string(),
            "--bind-address=0.0.0.0".to_string(),
            format!("--config-dir={}", root.join("config").display()),
            format!("--workspace-dir={}", root.join("workspace").display()),
        ];
        parse_server_config(
            &args,
            &ConfigEnvironment {
                variables: &BTreeMap::new(),
                server_root: "/fixture",
                process_home: "/fixture/home",
            },
        )
        .unwrap()
    }

    #[tokio::test]
    async fn publishes_readiness_state_before_serving_and_removes_it_on_shutdown() {
        LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let config = config(root.path());
            let lock = PathBuf::from(&config.workspace_dir).join(WORKSPACE_LOCK_NAME);
            let controller = Controller::start(config, Rc::new(UnavailableLocalExecutor)).await.unwrap();
            let descriptor = PathBuf::from(&controller.runtime_file);
            let bytes = fs::read(&descriptor).await.unwrap();
            let json: Value = garcon_js::json::from_slice(&bytes).unwrap();
            assert_eq!(json["instanceId"], controller.instance_id);
            assert_eq!(json["baseUrl"], format!("http://127.0.0.1:{}/fixture", controller.address.port()));
            assert!(lock.is_dir());
            let addr = SocketAddr::from(([127, 0, 0, 1], controller.address.port()));
            let mut stream = TcpStream::connect(addr).await.unwrap();
            let token = json["localCapability"].as_str().unwrap();
            stream.write_all(format!("GET /fixture/api/v1/cli/context HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            let mut response = String::new();
            tokio::time::timeout(Duration::from_secs(3), stream.read_to_string(&mut response)).await.unwrap().unwrap();
            assert!(response.starts_with("HTTP/1.1 200 "), "{response}");
            assert!(response.contains(&controller.instance_id));
            let unavailable = controller.local().get_project_service(None).await.err().unwrap();
            assert!(unavailable.to_string().contains("Local executor is unavailable"));

            controller.shutdown().await.unwrap();
            assert!(!descriptor.exists());
            assert!(!lock.exists());
            assert!(TcpStream::connect(addr).await.is_err());
        }).await;
    }

    #[tokio::test]
    async fn initializes_telegram_secrets_before_publishing_readiness() {
        LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let initial = config(root.path());
                let notifications = Path::new(&initial.config_dir).join("notifications.json");
                let controller = Controller::start(initial, Rc::new(UnavailableLocalExecutor))
                    .await
                    .unwrap();
                let bytes = fs::read(&notifications).await.unwrap();
                let value: Value = garcon_js::json::from_slice(&bytes).unwrap();
                assert_eq!(value["version"], 1);
                assert_eq!(value["telegram"]["botToken"], "");
                controller.shutdown().await.unwrap();

                fs::write(&notifications, br#"{"version":2}"#)
                    .await
                    .unwrap();
                let error =
                    Controller::start(config(root.path()), Rc::new(UnavailableLocalExecutor))
                        .await
                        .err()
                        .unwrap();
                assert!(
                    error
                        .to_string()
                        .starts_with("State file notifications.json is corrupt.")
                );
                assert!(!notifications.exists());
                assert!(!notifications.with_file_name("runtime.json").exists());
            })
            .await;
    }

    #[tokio::test]
    async fn serves_the_persisted_app_title_in_the_public_shell_and_manifest() {
        LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let mut config = config(root.path());
            let build = root.path().join("web-build");
            fs::create_dir(&build).await.unwrap();
            fs::write(build.join("index.html"), r#"<html><head><title>Default</title><link href="__GARCON_RUNTIME_BASE_PATH__/site.webmanifest"></head><body></body></html>"#).await.unwrap();
            fs::write(build.join("site.webmanifest"), r#"{"name":"Default","short_name":"Default"}"#).await.unwrap();
            config.web_build_dir = build.to_string_lossy().into_owned();

            fs::create_dir_all(&config.workspace_dir).await.unwrap();
            open_workspace(Path::new(&config.workspace_dir)).await.unwrap();
            let settings = SettingsStore::open(&config.workspace_dir, SettingsStoreOptions::default()).await.unwrap();
            settings.save_settings(&serde_json::json!({
                "ui":{"appIdentity":{"title":"  Tool & <Team>  "}},
                "remoteSettingsVersion": 19,
            })).await.unwrap();
            drop(settings);

            let controller = Controller::start(config, Rc::new(UnavailableLocalExecutor)).await.unwrap();
            let addr = SocketAddr::from(([127, 0, 0, 1], controller.address.port()));
            for path in ["/fixture/", "/fixture/chat/parity", "/fixture/site.webmanifest"] {
                let mut stream = TcpStream::connect(addr).await.unwrap();
                stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                let mut response = String::new();
                tokio::time::timeout(Duration::from_secs(3), stream.read_to_string(&mut response)).await.unwrap().unwrap();
                assert!(response.starts_with("HTTP/1.1 200 "), "{response}");
                if path.ends_with("webmanifest") {
                    let (_, body) = response.split_once("\r\n\r\n").unwrap();
                    let manifest: Value = garcon_js::json::from_str(body).unwrap();
                    assert_eq!(manifest["name"], "Tool & <Team>");
                    assert_eq!(manifest["short_name"], "Tool & <Team>");
                } else {
                    assert!(response.contains("<title>Tool &amp; &lt;Team&gt;</title>"), "{response}");
                    assert!(response.contains(r#"__GARCON_APP_TITLE__={"title":"Tool & \u003cTeam>","version":19}"#), "{response}");
                }
            }
            controller.shutdown().await.unwrap();
        }).await;
    }

    #[tokio::test]
    async fn exports_the_stored_executor_connection_without_running_the_manager() {
        async fn read(address: SocketAddr, path: &str) -> String {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream.write_all(format!("GET /fixture/api/v1/executors{path} HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            let mut response = String::new();
            tokio::time::timeout(Duration::from_secs(3), stream.read_to_string(&mut response))
                .await
                .unwrap()
                .unwrap();
            response
        }

        LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let mut config = config(root.path());
                config.auth_disabled = true;
                config.public_url = Some("https://public.test/fixture/".into());
                let workspace = PathBuf::from(&config.workspace_dir);
                fs::create_dir_all(&workspace).await.unwrap();
                open_workspace(&workspace).await.unwrap();
                let store = ExecutorConfigStore::open(&config.workspace_dir)
                    .await
                    .unwrap();
                let stored = store
                    .create(
                        serde_json::json!({"direction":"executor-connects","label":"Fixture"}),
                        None,
                    )
                    .await
                    .unwrap();
                let path = workspace.join("executors.json");
                let before = fs::read(&path).await.unwrap();
                let controller = Controller::start(config, Rc::new(UnavailableLocalExecutor))
                    .await
                    .unwrap();
                let address = SocketAddr::from(([127, 0, 0, 1], controller.address.port()));
                let connection_path = format!("/{}/connection", stored.id);
                let response = read(address, &connection_path).await;
                let (head, body) = response.split_once("\r\n\r\n").unwrap();
                assert!(head.starts_with("HTTP/1.1 200 "), "{head}");
                assert!(head.contains("\r\ncache-control: no-store"), "{head}");
                let payload = garcon_js::json::parse(body).unwrap();
                assert_eq!(
                    payload["connectionUrl"],
                    format!(
                        "wss://public.test/fixture/executor/{}#secret={}",
                        stored.id, stored.secret
                    )
                );
                let list = read(address, "").await;
                assert!(list.starts_with("HTTP/1.1 501 "), "{list}");
                assert!(list.contains("\r\nx-garcon-rs-unported: 1\r\n"), "{list}");
                assert_eq!(fs::read(path).await.unwrap(), before);
                controller.shutdown().await.unwrap();
            })
            .await;
    }

    #[tokio::test]
    async fn publishes_ticket_invalidation_after_commit_and_marks_missing_chat_authority() {
        async fn exchange(address: SocketAddr, method: &str, path: &str, body: &str) -> String {
            let mut stream = TcpStream::connect(address).await.unwrap();
            let wire = format!(
                "{method} /fixture/api/v1/tickets{path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(wire.as_bytes()).await.unwrap();
            let mut reply = String::new();
            stream.read_to_string(&mut reply).await.unwrap();
            reply
        }

        LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let mut config = config(root.path());
            config.auth_disabled = true;
            let workspace = PathBuf::from(&config.workspace_dir);
            let controller = Controller::start(config, Rc::new(UnavailableLocalExecutor)).await.unwrap();
            let address = SocketAddr::from(([127, 0, 0, 1], controller.address.port()));
            tokio::time::timeout(Duration::from_secs(3), async {
                let mut ws = TcpStream::connect(address).await.unwrap();
                ws.write_all(b"GET /fixture/ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") { head.push(ws.read_u8().await.unwrap()); }
                assert!(head.starts_with(b"HTTP/1.1 101 "));

                let boot = exchange(address, "GET", "/bootstrap", "").await;
                assert!(boot.starts_with("HTTP/1.1 200 "), "{boot}");
                let boot = garcon_js::json::parse(boot.split_once("\r\n\r\n").unwrap().1).unwrap();
                let path = workspace.join("tickets.sqlite");
                let wal = workspace.join("tickets.sqlite-wal");
                let before = (fs::read(&path).await.unwrap(), fs::read(&wal).await.unwrap());
                let mut value = serde_json::json!({"requestId":"00000000-0000-4000-8000-000000000001",
                    "expectedStoreId":boot["storeId"],"payload":{"action":"create","input":{"title":"Fixture","project":"sample",
                    "assignee":{"kind":"chat","chatId":"1000000000000001"}}}});
                let marked = exchange(address, "POST", "/mutate", &value.to_string()).await;
                assert!(marked.starts_with("HTTP/1.1 501 "), "{marked}");
                assert!(marked.contains("\r\nx-garcon-rs-unported: 1\r\n"));
                assert!(marked.ends_with(r#"{"error":"not ported"}"#));
                assert_eq!((fs::read(path).await.unwrap(), fs::read(wal).await.unwrap()), before);
                value["payload"]["input"].as_object_mut().unwrap().shift_remove("assignee");
                let created = exchange(address, "POST", "/mutate", &value.to_string()).await;
                assert!(created.starts_with("HTTP/1.1 201 "), "{created}");
                let created = garcon_js::json::parse(created.split_once("\r\n\r\n").unwrap().1).unwrap();
                assert_eq!(created["ticket"]["id"], "G-1");
                assert_eq!(ws.read_u8().await.unwrap(), 0x81);
                let size = ws.read_u8().await.unwrap() as usize;
                assert!(size < 126);
                let mut event = vec![0; size];
                ws.read_exact(&mut event).await.unwrap();
                let event: Value = garcon_js::json::from_slice(&event).unwrap();
                assert_eq!(event["type"], "tickets-invalidated");
                assert_eq!(event["revision"].as_u64(), Some(1));
            }).await.unwrap();
            controller.shutdown().await.unwrap();
        }).await;
    }

    #[tokio::test]
    async fn mounts_browser_sessions_with_the_controller_instance_identity() {
        LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let mut config = config(root.path());
            config.auth_disabled = true;
            let controller = Controller::start(config, Rc::new(UnavailableLocalExecutor)).await.unwrap();
            let address = SocketAddr::from(([127, 0, 0, 1], controller.address.port()));
            let mut socket = TcpStream::connect(address).await.unwrap();
            socket.write_all(b"GET /fixture/ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").await.unwrap();
            let payload = br#"{"type":"ws-ping","clientRequestId":"fixture"}"#;
            let mask = [1, 2, 3, 4];
            let mut request = vec![0x81, 0x80 | u8::try_from(payload.len()).unwrap()];
            request.extend(mask);
            request.extend(payload.iter().enumerate().map(|(index, byte)| byte ^ mask[index % 4]));
            tokio::time::timeout(Duration::from_secs(3), async {
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    head.push(socket.read_u8().await.unwrap());
                }
                assert!(head.starts_with(b"HTTP/1.1 101 "), "{}", String::from_utf8_lossy(&head));
                socket.write_all(&request).await.unwrap();
                assert_eq!(socket.read_u8().await.unwrap(), 0x81);
                let size = match socket.read_u8().await.unwrap() {
                    126 => usize::from(socket.read_u16().await.unwrap()),
                    size => usize::from(size),
                };
                let mut response = vec![0; size];
                socket.read_exact(&mut response).await.unwrap();
                let response: Value = garcon_js::json::from_slice(&response).unwrap();
                assert_eq!(response["type"], "ws-pong");
                assert_eq!(response["clientRequestId"], "fixture");
                assert_eq!(response["serverInstanceId"], controller.instance_id);
            }).await.unwrap();
            controller.shutdown().await.unwrap();
        }).await;
    }

    #[tokio::test]
    async fn edge_review_validates_the_http_idle_limit_before_websocket_options() {
        LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let mut config = config(root.path());
                config.http_idle_timeout_seconds = garcon_js::Number(256.0);
                config.ws_idle_timeout_seconds = garcon_js::Number(961.0);
                let error = Controller::start(config, Rc::new(UnavailableLocalExecutor))
                    .await
                    .err()
                    .unwrap();
                assert_eq!(
                    error.to_string(),
                    "Bun.serve expects idleTimeout to be 255 or less"
                );
            })
            .await;
    }

    #[tokio::test]
    async fn refuses_a_legacy_workspace_and_releases_the_leases() {
        LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let config = config(root.path());
                let workspace = PathBuf::from(&config.workspace_dir);
                let config_dir = PathBuf::from(&config.config_dir);
                fs::create_dir(&workspace).await.unwrap();
                fs::write(
                    workspace.join("workspace-version.json"),
                    br#"{"version":9}"#,
                )
                .await
                .unwrap();
                let error = Controller::start(config, Rc::new(UnavailableLocalExecutor))
                    .await
                    .err()
                    .unwrap();
                assert!(error.to_string().contains("open it with Garcon 0.4.2"));
                assert!(!workspace.join(WORKSPACE_LOCK_NAME).exists());
                assert!(!config_dir.join(WORKSPACE_LOCK_NAME).exists());
                assert!(!config_dir.join("runtime.json").exists());
            })
            .await;
    }

    #[tokio::test]
    async fn serves_invalid_login_and_rate_limit_errors_with_auth_response_headers() {
        LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let controller = Controller::start(config(root.path()), Rc::new(UnavailableLocalExecutor)).await.unwrap();
                let address = SocketAddr::from(([127, 0, 0, 1], controller.address.port()));
                let body = r#"{"username":"fixture","password":"password"}"#;
                for attempt in 0..=10 {
                    let mut socket = TcpStream::connect(address).await.unwrap();
                    let request = format!(
                        "POST /fixture/api/v1/auth/login HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len(),
                    );
                    socket.write_all(request.as_bytes()).await.unwrap();
                    let mut response = String::new();
                    tokio::time::timeout(Duration::from_secs(3), socket.read_to_string(&mut response)).await.unwrap().unwrap();
                    let (head, body) = response.split_once("\r\n\r\n").unwrap();
                    assert!(head.contains("\r\ncache-control: no-store"), "{head}");
                    let payload = garcon_js::json::parse(body).unwrap();
                    if attempt == 10 {
                        assert!(head.starts_with("HTTP/1.1 429 "), "{response}");
                        assert!(head.contains("\r\nretry-after: 5"), "{head}");
                        assert_eq!(payload["errorCode"], "RATE_LIMITED");
                        assert_eq!(payload["retryable"], true);
                    } else {
                        assert!(head.starts_with("HTTP/1.1 401 "), "{response}");
                        assert!(!head.contains("\r\nretry-after:"), "{head}");
                        assert_eq!(payload["errorCode"], "AUTH_CREDENTIALS_INVALID");
                    }
                }
                controller.shutdown().await.unwrap();
            })
            .await;
    }
}
