mod runtime_environment;

use std::cell::Cell;
use std::error::Error;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::rc::Rc;

use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_base::server_runtime::{
    ServerListener, advertised_server_url, create_server_runtime_state, log_server_ready,
    publish_server_runtime, remove_server_runtime,
};
use garcon_contract::cli_runtime_paths::{RuntimeKind, cli_runtime_file};
use garcon_contract::tickets::TicketProjectDefault;
use garcon_http::app_title::PublicAppTitle;
use garcon_http::http_request::HttpAuthentication;
use garcon_http::http_route::{HttpRouteOptions, HttpRouter};
use garcon_http::listener::Listener;
use garcon_http::routes::{auth::AuthRoutes, create_edge_routes, r#static::StaticRoutes};
use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome};
use garcon_interface::execution_runtime::{
    ExecutionProjectInspectRequest, ExecutionProjectInspectResponse, ExecutionProjectService,
    ResolveFileMentionsRequest, TicketProjectDefaultRequest,
};
use garcon_interface::resources::{ExecutorCallOptions, ExecutorResult};
use garcon_js::SystemClock;
use garcon_stores::auth::passwords::BunPasswords;
use garcon_stores::auth::service::AuthService;
use garcon_stores::auth::store::AuthAccountStore;
use garcon_stores::auth::token::AuthTokens;
use tokio::fs;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::config::{HELP_TEXT, ServerConfig, initialize_server_config, is_help_requested};
use super::workspace_lease::{ControllerLease, acquire_controller_lease};
use super::workspace_version::open_workspace;

pub struct Controller {
    pub address: SocketAddr,
    pub runtime_file: String,
    pub instance_id: String,
    local: Rc<dyn ExecutionProjectService>,
    lease: ControllerLease,
    listener: JoinHandle<()>,
    auth_routes: Rc<AuthRoutes>,
    listener_shutdown: CancellationToken,
    lease_lost: CancellationToken,
    shutting_down: Rc<Cell<bool>>,
    logger: ScopedLogger,
}

/// Runs the native controller in the calling process.
///
/// # Safety
/// Call before starting other threads; startup changes the process environment.
pub unsafe fn run_native(args: &[String], local: Rc<dyn ExecutionProjectService>) -> ExitCode {
    if is_help_requested(args) {
        print!("{HELP_TEXT}");
        return ExitCode::SUCCESS;
    }
    // SAFETY: callers guarantee the startup environment can be changed.
    match unsafe { run_process(args, local) } {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            create_logger("server").error(&format!("Failed to start or stop server: {error}"));
            ExitCode::FAILURE
        }
    }
}

unsafe fn run_process(
    args: &[String],
    local: Rc<dyn ExecutionProjectService>,
) -> Result<(), Box<dyn Error>> {
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
    tokio::task::LocalSet::new().block_on(&runtime, run_until_shutdown(config, local))
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
    local: Rc<dyn ExecutionProjectService>,
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
    let controller = Controller::start(config, local).await?;
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
        local: Rc<dyn ExecutionProjectService>,
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
        let result = bind_controller(&config, &lease, Rc::clone(&shutting_down), &logger).await;
        let BoundController {
            listener,
            router,
            address,
            runtime_file,
            instance_id,
            auth_routes,
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
            listener_shutdown,
            lease_lost,
            shutting_down,
            logger,
        })
    }

    pub fn local(&self) -> &dyn ExecutionProjectService {
        &*self.local
    }

    pub async fn lease_lost(&self) {
        self.lease_lost.cancelled().await;
    }

    pub async fn shutdown(self) -> Result<(), Box<dyn Error>> {
        self.shutting_down.set(true);
        self.logger.info("server: shutting down...");
        self.listener_shutdown.cancel();
        let listener = self.listener.await;
        self.auth_routes.drain().await;
        let runtime = remove_server_runtime(self.runtime_file, &self.instance_id).await;
        let lease = self.lease.release().await;
        listener?;
        runtime?;
        lease?;
        Ok(())
    }
}

struct BoundController {
    listener: Listener,
    router: HttpRouter,
    address: SocketAddr,
    runtime_file: String,
    instance_id: String,
    auth_routes: Rc<AuthRoutes>,
}

async fn bind_controller(
    config: &ServerConfig,
    lease: &ControllerLease,
    shutting_down: Rc<Cell<bool>>,
    logger: &ScopedLogger,
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
        clock,
    ));
    let auth_routes = AuthRoutes::new(
        auth.clone(),
        config.auth_disabled,
        config.trust_proxy_enabled,
    )?;
    let routes = create_edge_routes(
        Rc::clone(&runtime),
        config.workspace_name.clone(),
        StaticRoutes {
            web_build_dir: PathBuf::from(&config.web_build_dir),
            base_path: config.base_path.clone(),
            app_title: Rc::new(PublicAppTitle::default),
        },
        &auth_routes,
    )?;
    let router = HttpRouter::new(
        routes,
        HttpRouteOptions {
            base_path: config.base_path.clone(),
            auth_disabled: config.auth_disabled,
            compression_enabled: config.http_compression_enabled,
            server_instance_id: Some(runtime.identity.instance_id.clone()),
            shutting_down,
            unported_log: std::env::var_os("GARCON_RS_UNPORTED_LOG")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
        },
        Rc::new(HttpAuthentication::new(
            auth,
            runtime.local_capability.clone(),
        )),
    )?;
    if config.http_idle_timeout_seconds.0 > f64::from(u8::MAX) {
        return Err("Bun.serve expects idleTimeout to be 255 or less".into());
    }
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
    let published = publish_server_runtime(&runtime, &base_url, &config.config_dir).await?;
    logger.info(&format!(
        "Published controller runtime at {} ({base_url})",
        published.file_path
    ));
    Ok(BoundController {
        listener,
        router,
        address,
        runtime_file: published.file_path,
        instance_id: runtime.identity.instance_id.clone(),
        auth_routes,
    })
}

pub struct UnavailableLocalExecutor;

fn unavailable() -> Box<dyn Error> {
    Box::new(AgentCallError::new(
        AgentDeliveryOutcome::NotDispatched,
        "Local executor is unavailable",
    ))
}

#[async_trait::async_trait(?Send)]
impl ExecutionProjectService for UnavailableLocalExecutor {
    async fn ticket_project_default(
        &self,
        _: TicketProjectDefaultRequest,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TicketProjectDefault> {
        Err(unavailable())
    }

    async fn inspect(
        &self,
        _: ExecutionProjectInspectRequest,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionProjectInspectResponse> {
        Err(unavailable())
    }

    async fn resolve_file_mentions(
        &self,
        _: ResolveFileMentionsRequest,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<String> {
        Err(unavailable())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::Duration;

    use super::*;
    use crate::config::{ConfigEnvironment, parse_server_config};
    use garcon_base::workspace_lease::WORKSPACE_LOCK_NAME;
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
            let unavailable = controller.local().resolve_file_mentions(ResolveFileMentionsRequest {
                project_path: "/fixture".into(),
                command: "probe".into(),
            }, None).await.unwrap_err();
            assert!(unavailable.to_string().contains("Local executor is unavailable"));

            controller.shutdown().await.unwrap();
            assert!(!descriptor.exists());
            assert!(!lock.exists());
            assert!(TcpStream::connect(addr).await.is_err());
        }).await;
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
