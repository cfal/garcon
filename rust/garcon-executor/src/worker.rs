//! Process-owned executor services and the worker that serves them.

use std::cell::{Cell, RefCell};
use std::error::Error;
use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::rc::Rc;

use async_trait::async_trait;
use futures::future::join_all;
use garcon_base::errors::{NamedError, SharedDiagnosticError, error_metadata};
use garcon_base::event_loop_stalls::{ActivityTracker, EventLoopStallOptions};
use garcon_base::executor_disconnect::ExecutorSessionLostError;
use garcon_base::workspace_lease::{WorkspaceLeaseOptions, acquire_workspace_lease};
use garcon_contract::api_providers::ApiProviderModelDiscoveryResponse;
use garcon_contract::cli_runtime_paths::{cli_gateway_runtime_file, executor_data_directory};
use garcon_contract::git_execution::GitExecutorScope;
use garcon_interface::errors::{
    AgentCallError, AgentDeliveryOutcome, AgentIntegrationError, AgentIntegrationErrorCode,
};
use garcon_interface::execution_runtime::{
    ApiProviderDiscoveryRequest, ExecutionProjectService, ExecutionRuntimeApi,
    ExecutorAvailability, ExecutorInfo, ExecutorServices,
};
use garcon_interface::files::ExecutionFilesService;
use garcon_interface::git::{ExecutionGhService, ExecutionGitService};
use garcon_interface::host::AgentResolvedCredential;
use garcon_interface::integration::AgentIntegration;
use garcon_interface::resources::{ExecutorCallOptions, ExecutorResult};
use garcon_interface::terminals::ExecutionTerminalService;
use garcon_js::{Number, json::Opaque};
use garcon_link::link_handshake::LinkRole;
use garcon_link::message_session::SessionError;
use garcon_link::rpc::{ExecutorRpc, ExecutorRpcContinuity, RpcCallOptions};
use garcon_link::rpc_admission::RpcAdmissionBudgets;
use garcon_link::rpc_connection::{ExecutorRpcConnection, RpcConnectionOptions};
use garcon_link::rpc_journal::RpcReplyJournal;
use garcon_link::session_transport::SessionTransport;
use garcon_link::websocket_link::{
    ExecutorListenerTls, WebSocketLink, WebSocketLinkOptions, should_log_link_failure,
};
use garcon_runtime::ChildEnvironment;
use garcon_runtime::agents::integration_host::{
    IntegrationHostFactory, IntegrationHostFactoryOptions, ReadIntegrationEnvironment,
    ResolveIntegrationCredential, ResolveIntegrationCredentialRequest,
};
use garcon_runtime::agents::integration_registry::IntegrationRegistry;
use garcon_runtime::files::service::{FilesService, FilesServiceOptions};
use garcon_runtime::git::review_document_registry::GitReviewDocumentRegistry;
use garcon_runtime::git::runtime::{GitRuntime, GitRuntimeOptions};
use garcon_runtime::projects::project_service::ProjectService;
use garcon_runtime::terminals::runtime::{TerminalRuntime, TerminalService};
use garcon_runtime::terminals::terminal_manager::TerminalManagerOptions;
use serde::Serialize;
use serde_json::json;
use tokio::fs;
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

use crate::cli::environment_value;
use crate::cli_gateway::CliGateway;
use crate::default_agent_integrations::default_agent_integrations;
use crate::executor_rpc_server::{ExecutorRpcServer, decode_opaque, describe, not_dispatched};
use crate::listener_secret::load_listener_secret;
use crate::producer_relay::ProducerRelay;

pub enum WorkerConnection {
    Dial {
        url: String,
        secret: String,
    },
    Listen {
        port: u16,
        bind_address: String,
        tls: Option<ExecutorListenerTls>,
    },
}

pub struct ExecutorWorkerOptions {
    pub config_dir: String,
    pub project_base_path: String,
    pub no_tls: bool,
    pub allow_unverified_tls: bool,
    pub connection: WorkerConnection,
    pub advertised_url: Option<String>,
}

pub struct ExecutorOptions {
    pub executor_id: String,
    pub project_base_path: String,
    pub terminal_runtime_id: Option<String>,
    pub user_shell: Option<String>,
    pub child_environment: Option<ChildEnvironment>,
    pub integrations: Option<ExecutorIntegrationOptions>,
}

pub struct ExecutorIntegrationOptions {
    pub workspace_dir: String,
    pub resolve_credential: Rc<ResolveIntegrationCredential>,
}

type AvailabilityListener = Rc<dyn Fn(ExecutorAvailability)>;

#[derive(Default)]
struct ExecutorLifetime {
    disposed: Cell<bool>,
    listeners: RefCell<Vec<AvailabilityListener>>,
}

impl ExecutorLifetime {
    fn available(&self, options: Option<&ExecutorCallOptions>) -> ExecutorResult<()> {
        if options
            .and_then(|opts| opts.signal.as_ref())
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(NamedError {
                name: "AbortError".into(),
                message: "The operation was aborted.".into(),
                code: None,
            }
            .into());
        }
        if self.disposed.get() {
            return Err(AgentCallError::new(
                AgentDeliveryOutcome::NotDispatched,
                "Executor is disposed",
            )
            .into());
        }
        Ok(())
    }
}

pub(crate) struct ExecutorApi {
    info: ExecutorInfo,
    integrations: IntegrationRegistry,
    pub(crate) projects: Rc<ProjectService>,
    pub(crate) files: Rc<FilesService>,
    git: Rc<GitRuntime>,
    terminals: Rc<TerminalService>,
    terminal_runtime: TerminalRuntime,
    lifetime: Rc<ExecutorLifetime>,
}

impl ExecutorApi {
    pub(crate) fn info(&self) -> &ExecutorInfo {
        &self.info
    }

    pub(crate) fn projects(&self) -> &dyn ExecutionProjectService {
        self.projects.as_ref()
    }

    pub(crate) fn files(&self) -> &dyn ExecutionFilesService {
        self.files.as_ref()
    }

    pub(crate) fn terminals(&self) -> Rc<dyn ExecutionTerminalService> {
        self.terminals.clone()
    }

    pub(crate) fn integrations(&self) -> Vec<Rc<AgentIntegration>> {
        self.integrations.list()
    }

    fn dispose_services(&self) -> bool {
        if self.lifetime.disposed.replace(true) {
            return false;
        }
        self.git.dispose();
        self.terminals.dispose();
        self.terminal_runtime.shutdown();
        let listeners = self.lifetime.listeners.borrow().clone();
        for listener in listeners {
            if self
                .lifetime
                .listeners
                .borrow()
                .iter()
                .any(|registered| Rc::ptr_eq(registered, &listener))
            {
                listener(ExecutorAvailability::Disposed);
            }
        }
        self.lifetime.listeners.borrow_mut().clear();
        true
    }
}

#[async_trait(?Send)]
impl ExecutionRuntimeApi for ExecutorApi {
    fn id(&self) -> &str {
        &self.info.executor_id
    }

    fn availability(&self) -> ExecutorAvailability {
        if self.lifetime.disposed.get() {
            ExecutorAvailability::Disposed
        } else {
            ExecutorAvailability::Ready
        }
    }

    async fn get_info(&self, options: Option<ExecutorCallOptions>) -> ExecutorResult<ExecutorInfo> {
        self.lifetime.available(options.as_ref())?;
        Ok(self.info.clone())
    }

    async fn get_agent_integration(
        &self,
        agent_id: &str,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<AgentIntegration>> {
        self.lifetime.available(options.as_ref())?;
        self.integrations.require(agent_id)
    }

    async fn get_project_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionProjectService>> {
        self.lifetime.available(options.as_ref())?;
        Ok(self.projects.clone())
    }

    async fn discover_api_provider_models(
        &self,
        _request: ApiProviderDiscoveryRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ApiProviderModelDiscoveryResponse> {
        self.lifetime.available(options.as_ref())?;
        Err(unported_service("API provider model discovery"))
    }

    async fn get_files_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionFilesService>> {
        self.lifetime.available(options.as_ref())?;
        Ok(self.files.clone())
    }

    async fn get_git_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionGitService>> {
        self.lifetime.available(options.as_ref())?;
        Ok(self.git.clone())
    }

    async fn get_gh_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionGhService>> {
        self.lifetime.available(options.as_ref())?;
        Err(unported_service("GitHub"))
    }

    async fn get_terminal_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionTerminalService>> {
        self.lifetime.available(options.as_ref())?;
        Ok(self.terminals())
    }

    fn on_availability_changed(&self, listener: AvailabilityListener) -> Box<dyn Fn()> {
        if !self
            .lifetime
            .listeners
            .borrow()
            .iter()
            .any(|registered| Rc::ptr_eq(registered, &listener))
        {
            self.lifetime
                .listeners
                .borrow_mut()
                .push(Rc::clone(&listener));
        }
        let lifetime = Rc::downgrade(&self.lifetime);
        Box::new(move || {
            if let Some(lifetime) = lifetime.upgrade() {
                lifetime
                    .listeners
                    .borrow_mut()
                    .retain(|registered| !Rc::ptr_eq(registered, &listener));
            }
        })
    }

    async fn dispose(&self) -> ExecutorResult<()> {
        if self.dispose_services() {
            let _ = join_all(
                self.integrations
                    .list()
                    .into_iter()
                    .map(|integration| async move { integration.lifecycle.stop().await }),
            )
            .await;
        }
        Ok(())
    }
}

fn unported_service(service: &str) -> Box<dyn Error> {
    AgentCallError::with_code(
        AgentDeliveryOutcome::NotDispatched,
        format!("Executor {service} service is not ported yet"),
        AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
    )
    .into()
}

pub struct Executor {
    api: Rc<ExecutorApi>,
}

impl Executor {
    pub fn start(options: ExecutorOptions) -> ExecutorResult<Self> {
        let instance_id = Uuid::new_v4().to_string();
        let integrations = match options.integrations {
            Some(integrations) => {
                let host = IntegrationHostFactory::new(IntegrationHostFactoryOptions {
                    workspace_dir: integrations.workspace_dir,
                    executor_id: Some(options.executor_id.clone()),
                    instance_id: Some(instance_id.clone()),
                    resolve_credential: integrations.resolve_credential,
                    read_environment: options.child_environment.as_ref().map(|environment| {
                        let environment = environment.clone();
                        Rc::new(move |name: &str| environment_value(&environment, name))
                            as Rc<ReadIntegrationEnvironment>
                    }),
                    logger_factory: None,
                });
                IntegrationRegistry::from_classes(&default_agent_integrations(), &host)?
            }
            None => IntegrationRegistry::from_instances([])?,
        };
        let lifetime: Rc<ExecutorLifetime> = Rc::default();
        let available = Rc::new({
            let lifetime = Rc::clone(&lifetime);
            move |options: Option<&ExecutorCallOptions>| lifetime.available(options)
        });
        let mut projects = ProjectService::new(&options.project_base_path, available.clone())?;
        if let Some(environment) = options.child_environment.clone() {
            projects = projects.with_child_environment(environment);
        }
        let files = FilesService::new(FilesServiceOptions {
            executor_id: options.executor_id.clone(),
            project_base_path: options.project_base_path.clone(),
            assert_available: Some(available.clone()),
            ..Default::default()
        });
        let mut terminal_options = TerminalManagerOptions::new(options.project_base_path);
        terminal_options.terminal_runtime_id = options.terminal_runtime_id;
        terminal_options.user_shell = options.user_shell;
        terminal_options.child_environment = options.child_environment.clone();
        let terminal_runtime = TerminalRuntime::new(terminal_options);
        let terminals = Rc::new(terminal_runtime.service(&options.executor_id)?);
        let git = Rc::new(GitRuntime::new(GitRuntimeOptions {
            scope: GitExecutorScope {
                executor_id: options.executor_id.clone(),
                instance_id: instance_id.clone(),
            },
            project_base_path: projects.project_base_path.clone(),
            child_environment: options.child_environment,
            review_registry: Some(Rc::new(GitReviewDocumentRegistry::new(Default::default()))),
            assert_available: Some(available),
        }));
        let info = ExecutorInfo {
            executor_id: options.executor_id,
            instance_id,
            integration_ids: integrations
                .list()
                .iter()
                .map(|integration| integration.descriptor.id.clone())
                .collect(),
            project_base_path: projects.project_base_path.clone(),
            services: ExecutorServices {
                files: true,
                git: true,
                gh: false,
                terminals: true,
                directory_creation: files.can_create_directories(),
            },
        };
        let api = Rc::new(ExecutorApi {
            info,
            integrations,
            projects: Rc::new(projects),
            files: Rc::new(files),
            git,
            terminals,
            terminal_runtime,
            lifetime,
        });
        Ok(Self { api })
    }

    pub fn api(&self) -> Rc<dyn ExecutionRuntimeApi> {
        self.api.clone()
    }

    /// Runs the remote worker until shutdown. The authenticated controller
    /// supplies its executor identity before the process services are started.
    pub async fn serve(
        options: ExecutorWorkerOptions,
        environment: Vec<(OsString, OsString)>,
    ) -> ExecutorResult<()> {
        let data_dir = executor_data_directory(&options.config_dir);
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(&data_dir).await?;
        let stop = CancellationToken::new();
        let lease = acquire_workspace_lease(
            &data_dir,
            WorkspaceLeaseOptions {
                on_compromised: Some(Box::new({
                    let stop = stop.clone();
                    move |error| {
                        eprintln!("Executor storage lease was compromised: {error}");
                        stop.cancel();
                    }
                })),
                ..Default::default()
            },
        )
        .await?;
        let environment =
            crate::cli::Environment::from(environment).for_worker(&options.config_dir);
        let result = serve_leased(options, environment.into(), &lease.workspace_dir, stop).await;
        let release = lease.release().await.map_err(Box::<dyn Error>::from);
        result.and(release)
    }
}

impl Drop for Executor {
    fn drop(&mut self) {
        self.api.dispose_services();
    }
}

struct Serving {
    connection: Rc<ExecutorRpcConnection>,
    server: Rc<ExecutorRpcServer>,
}

struct Worker {
    link: Rc<WebSocketLink>,
    project_base_path: String,
    data_dir: String,
    child_environment: ChildEnvironment,
    executor: RefCell<Option<Executor>>,
    serving: RefCell<Option<Serving>>,
    mismatched: RefCell<Option<Rc<ExecutorRpc>>>,
    relay: Rc<ProducerRelay>,
    journal: Rc<RpcReplyJournal>,
    admission: Rc<RpcAdmissionBudgets>,
    activity: Rc<ActivityTracker>,
}

impl Worker {
    fn new(
        link: Rc<WebSocketLink>,
        project_base_path: String,
        data_dir: String,
        child_environment: ChildEnvironment,
    ) -> Rc<Self> {
        Rc::new(Self {
            link,
            project_base_path,
            data_dir,
            child_environment,
            executor: RefCell::default(),
            serving: RefCell::default(),
            mismatched: RefCell::default(),
            relay: ProducerRelay::new(Default::default()),
            journal: RpcReplyJournal::new(Default::default()),
            admission: Rc::default(),
            activity: Rc::new(ActivityTracker::default()),
        })
    }

    fn on_session(self: &Rc<Self>) -> Result<impl Fn() + use<>, SessionError> {
        let worker = Rc::downgrade(self);
        self.link.on_session(Rc::new(move |transport| {
            if let Some(worker) = worker.upgrade() {
                worker.install(transport)
            } else {
                Err(not_dispatched("Worker session retired"))
            }
        }))
    }

    fn install(self: &Rc<Self>, transport: Rc<SessionTransport>) -> Result<(), SessionError> {
        if let Some(prior) = self.serving.take() {
            prior.server.dispose();
        }
        if let Some(prior) = self.mismatched.take() {
            prior.retire_unknown();
        }
        let api = self
            .executor
            .borrow()
            .as_ref()
            .map(|executor| Rc::clone(&executor.api));
        let api = if let Some(api) = api {
            if api.info().executor_id != transport.executor_id {
                let rpc = ExecutorRpc::new(transport, ExecutorRpcContinuity::default());
                rpc.handle(Rc::new(move |call, _, _, _| {
                    let api = Rc::clone(&api);
                    Box::pin(async move {
                        if call.method == "executor.describe" {
                            describe(api.info(), &[])
                        } else {
                            Err(not_dispatched(
                                "Restart the worker to serve a different executor",
                            ))
                        }
                    })
                }));
                rpc.activate();
                self.mismatched.replace(Some(rpc));
                return Ok(());
            }
            api
        } else {
            let executor = Executor::start(ExecutorOptions {
                executor_id: transport.executor_id.clone(),
                project_base_path: self.project_base_path.clone(),
                terminal_runtime_id: Some(self.link.runtime_id.clone()),
                user_shell: None,
                child_environment: Some(Rc::clone(&self.child_environment)),
                integrations: Some(ExecutorIntegrationOptions {
                    workspace_dir: self.data_dir.clone(),
                    resolve_credential: Rc::new({
                        let worker = Rc::downgrade(self);
                        move |request| {
                            let connection = worker.upgrade().and_then(|worker| {
                                worker
                                    .serving
                                    .borrow()
                                    .as_ref()
                                    .map(|serving| serving.connection.clone())
                            });
                            Box::pin(resolve_credential(connection, request))
                        }
                    }),
                }),
            })
            .map_err(Rc::from)?;
            let api = Rc::clone(&executor.api);
            self.executor.replace(Some(executor));
            api
        };
        let connection = ExecutorRpcConnection::new(
            Rc::clone(&self.link),
            Rc::clone(&transport),
            RpcConnectionOptions {
                admission: Rc::clone(&self.admission),
                journal: Some(Rc::clone(&self.journal)),
                activity: Some(Rc::clone(&self.activity)),
                bulk_failed: Some(Rc::new(|failure| {
                    if failure
                        .failure
                        .retries
                        .checked_add(1)
                        .is_some_and(usize::is_power_of_two)
                    {
                        warn_frame("executor-bulk-failed", failure);
                    }
                })),
                ..Default::default()
            },
        )?;
        let server = ExecutorRpcServer::new(api, &connection.primary, Rc::clone(&self.relay));
        let _off_endpoint = connection.on_endpoint(Rc::new({
            let server = Rc::downgrade(&server);
            move |endpoint| {
                if let Some(server) = server.upgrade() {
                    server.install(&endpoint)?;
                }
                Ok(())
            }
        }))?;
        let _off_failure = transport.on_failure(Rc::new({
            let worker = Rc::downgrade(self);
            let connection = Rc::downgrade(&connection);
            move |_| {
                if let Some((worker, connection)) = worker.upgrade().zip(connection.upgrade()) {
                    let current = worker
                        .serving
                        .borrow()
                        .as_ref()
                        .is_some_and(|current| Rc::ptr_eq(&current.connection, &connection));
                    if current {
                        worker.serving.take();
                    }
                }
            }
        }));
        let _off_availability = transport.on_availability(Rc::new({
            let executor_id = transport.executor_id.clone();
            let runtime_id = self.link.runtime_id.clone();
            move |available| {
                if available {
                    frame(
                        "executor-connected",
                        Connected {
                            executor_id: &executor_id,
                            runtime_id: &runtime_id,
                        },
                    );
                }
            }
        }));
        self.serving.replace(Some(Serving {
            connection: Rc::clone(&connection),
            server,
        }));
        connection.activate()
    }
}

async fn resolve_credential(
    connection: Option<Rc<ExecutorRpcConnection>>,
    request: ResolveIntegrationCredentialRequest,
) -> ExecutorResult<Option<AgentResolvedCredential>> {
    let connection = connection.ok_or_else(|| {
        AgentCallError::new(
            AgentDeliveryOutcome::NotDispatched,
            "Executor controller is disconnected",
        )
    })?;
    let value = connection
        .primary
        .call(
            &request.agent_id,
            "credentials.resolve",
            Opaque::from_value(json!({"reference": request.reference})),
            RpcCallOptions {
                signal: Some(request.signal),
                ..Default::default()
            },
        )
        .await
        .map_err(own_rpc_error)?;
    Ok(value
        .as_ref()
        .map(decode_opaque::<Option<AgentResolvedCredential>>)
        .transpose()
        .map_err(|_| "Invalid provider credential reply")?
        .flatten())
}

fn own_rpc_error(error: SessionError) -> Box<dyn Error> {
    if let Some(call) = error.downcast_ref::<AgentCallError>() {
        return Box::new(call.clone());
    }
    if let Some(lost) = error.downcast_ref::<ExecutorSessionLostError>() {
        return Box::new(lost.clone());
    }
    if let Some(integration) = error.downcast_ref::<AgentIntegrationError>() {
        return Box::new(integration.clone());
    }
    let metadata = error_metadata(error.as_ref());
    Box::new(SharedDiagnosticError::new(error.clone(), metadata))
}

async fn serve_leased(
    options: ExecutorWorkerOptions,
    child_environment: ChildEnvironment,
    data_dir: &Path,
    stop: CancellationToken,
) -> ExecutorResult<()> {
    let data_dir = data_dir.to_string_lossy();
    let gateway_file = cli_gateway_runtime_file(&data_dir);
    match fs::remove_file(gateway_file).await {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let secret = match &options.connection {
        WorkerConnection::Dial { secret, .. } => secret.clone(),
        WorkerConnection::Listen { .. } => load_listener_secret(&data_dir).await?,
    };
    let mut link_options = WebSocketLinkOptions::new(LinkRole::Worker, secret);
    link_options.no_tls = options.no_tls;
    link_options.allow_unverified_tls = options.allow_unverified_tls;
    let link = WebSocketLink::new(link_options)?;
    let worker = Worker::new(
        Rc::clone(&link),
        options.project_base_path,
        data_dir.to_string(),
        child_environment,
    );
    let stop_monitor = worker.activity.monitor_event_loop_stalls(
        |stall| {
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct Stalled {
                stall_ms: Number,
                heap_used_mb: u64,
                activities: Vec<String>,
            }
            warn_frame(
                "executor-event-loop-stalled",
                Stalled {
                    stall_ms: Number(stall.stall_ms),
                    heap_used_mb: stall.heap_used_mb,
                    activities: stall.activities,
                },
            )
        },
        EventLoopStallOptions::default(),
    );
    let gateway = match CliGateway::start(
        &data_dir,
        Rc::new({
            let worker = Rc::downgrade(&worker);
            move || {
                worker.upgrade().and_then(|worker| {
                    worker
                        .serving
                        .borrow()
                        .as_ref()
                        .map(|serving| Rc::clone(&serving.connection))
                })
            }
        }),
    )
    .await
    {
        Ok(gateway) => Some(gateway),
        Err(error) => {
            warn_frame(
                "executor-cli-unavailable",
                serde_json::json!({ "message": error.to_string() }),
            );
            None
        }
    };
    let _off_error = link.on_error(Rc::new(|failure| {
        if should_log_link_failure(failure) {
            warn_frame("executor-unavailable", failure);
        }
    }));
    let _off_closure = link.on_closure(Rc::new({
        let worker = Rc::downgrade(&worker);
        move |closure| {
            let diagnostics = worker.upgrade().and_then(|worker| {
                worker
                    .serving
                    .borrow()
                    .as_ref()
                    .map(|current| current.connection.diagnostics())
            });
            #[derive(Serialize)]
            struct Closed<'a> {
                #[serde(flatten)]
                closure: &'a garcon_link::websocket_link::LinkClosure,
                #[serde(flatten)]
                diagnostics: Option<garcon_link::rpc_connection::RpcConnectionDiagnostics>,
            }
            warn_frame(
                "executor-link-closed",
                Closed {
                    closure,
                    diagnostics,
                },
            );
        }
    }));
    let session = worker.on_session();
    let result = async {
        let off_session = session.map_err(startup_link_error)?;
        let signal = ShutdownSignal::new()?;
        match options.connection {
            WorkerConnection::Listen {
                port,
                bind_address,
                tls,
            } => {
                let url = link
                    .listen(port, &bind_address, tls)
                    .await
                    .map_err(startup_link_error)?;
                let mut url = Url::parse(&url)?;
                if bind_address == "0.0.0.0" {
                    url.set_host(Some(&bind_address))?;
                }
                frame(
                    "executor-listening",
                    Listening {
                        url: url.as_str(),
                        advertised_url: options.advertised_url.as_deref(),
                    },
                );
            }
            WorkerConnection::Dial { url, .. } => {
                link.dial(&url).map_err(startup_link_error)?;
                frame(
                    "executor-started",
                    serde_json::json!({ "direction": "executor-connects" }),
                );
            }
        }
        tokio::select! {
            () = stop.cancelled() => {}
            () = signal.wait() => {}
        }
        off_session();
        Ok(())
    }
    .await;
    stop_monitor();
    let gateway_cleanup = match gateway {
        Some(gateway) => gateway.dispose().await,
        None => Ok(()),
    };
    link.dispose().await;
    if let Some(serving) = worker.serving.take() {
        serving.server.dispose();
    }
    if let Some(rpc) = worker.mismatched.take() {
        rpc.retire_unknown();
    }
    worker.relay.dispose();
    worker.journal.dispose();
    let executor = worker.executor.take();
    let executor_cleanup = match executor {
        Some(executor) => executor.api.dispose().await,
        None => Ok(()),
    };
    result.and(gateway_cleanup).and(executor_cleanup)
}

fn startup_link_error(error: SessionError) -> Box<dyn Error> {
    error.to_string().into()
}

struct ShutdownSignal {
    #[cfg(unix)]
    terminate: tokio::signal::unix::Signal,
    #[cfg(unix)]
    interrupt: tokio::signal::unix::Signal,
    #[cfg(windows)]
    interrupt: tokio::signal::windows::CtrlC,
}

impl ShutdownSignal {
    fn new() -> io::Result<Self> {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            Ok(Self {
                terminate: signal(SignalKind::terminate())?,
                interrupt: signal(SignalKind::interrupt())?,
            })
        }
        #[cfg(windows)]
        {
            Ok(Self {
                interrupt: tokio::signal::windows::ctrl_c()?,
            })
        }
    }

    async fn wait(mut self) {
        #[cfg(unix)]
        tokio::select! {
            _ = self.terminate.recv() => {}
            _ = self.interrupt.recv() => {}
        }
        #[cfg(windows)]
        let _ = self.interrupt.recv().await;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Listening<'a> {
    url: &'a str,
    advertised_url: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Connected<'a> {
    executor_id: &'a str,
    runtime_id: &'a str,
}

fn frame(kind: &str, payload: impl Serialize) {
    if let Ok(line) = wire_frame(kind, payload) {
        println!("{line}");
    }
}

fn warn_frame(kind: &str, payload: impl Serialize) {
    if let Ok(line) = wire_frame(kind, payload) {
        eprintln!("{line}");
    }
}

fn wire_frame(kind: &str, payload: impl Serialize) -> Result<String, serde_json::Error> {
    #[derive(Serialize)]
    struct Frame<'a, T> {
        r#type: &'a str,
        #[serde(flatten)]
        payload: T,
    }
    serde_json::to_string(&Frame {
        r#type: kind,
        payload,
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use garcon_base::domain_error::DomainError;
    use garcon_contract::error_codes::ErrorCode;
    use garcon_interface::errors::AgentIntegrationErrorCode;
    use garcon_js::json::Opaque;
    use garcon_link::connection_url::create_executor_secret;
    use garcon_link::rpc::{RpcCallOptions, RpcTimeout};
    use serde_json::json;
    use tokio::{sync::mpsc, task::LocalSet, time::timeout};

    use super::*;

    #[tokio::test]
    async fn shared_runtime_api_returns_stable_services_and_notifies_disposal_once() {
        LocalSet::new()
            .run_until(async {
                let project = tempfile::tempdir().unwrap();
                let root = project.path().to_str().unwrap();
                let executor = Executor::start(ExecutorOptions {
                    executor_id: "local".to_owned(),
                    project_base_path: root.to_owned(),
                    terminal_runtime_id: None,
                    user_shell: None,
                    child_environment: None,
                    integrations: None,
                })
                .unwrap();
                let api: Rc<dyn ExecutionRuntimeApi> = executor.api();
                assert_eq!(api.id(), "local");
                assert_eq!(api.availability(), ExecutorAvailability::Ready);
                let info = api.get_info(None).await.unwrap();
                assert!(info.services.files && info.services.terminals);
                assert!(info.services.git && !info.services.gh);
                assert!(Rc::ptr_eq(
                    &api.get_project_service(None).await.unwrap(),
                    &api.get_project_service(None).await.unwrap(),
                ));
                assert!(Rc::ptr_eq(
                    &api.get_files_service(None).await.unwrap(),
                    &api.get_files_service(None).await.unwrap(),
                ));
                assert!(Rc::ptr_eq(
                    &api.get_terminal_service(None).await.unwrap(),
                    &api.get_terminal_service(None).await.unwrap(),
                ));
                assert!(Rc::ptr_eq(
                    &api.get_git_service(None).await.unwrap(),
                    &api.get_git_service(None).await.unwrap()
                ));
                let unknown = api
                    .get_agent_integration("missing", None)
                    .await
                    .err()
                    .unwrap();
                assert_eq!(
                    unknown.to_string(),
                    "Unsupported agent integration: missing"
                );

                let changes = Rc::new(RefCell::new(Vec::new()));
                let off = api.on_availability_changed(Rc::new(|_| panic!("unsubscribed callback")));
                off();
                let projects = api.get_project_service(None).await.unwrap();
                let _off = api.on_availability_changed(Rc::new({
                    let api = Rc::clone(&api);
                    let changes = Rc::clone(&changes);
                    move |state| {
                        assert_eq!(api.availability(), state);
                        changes.borrow_mut().push(state);
                    }
                }));
                api.dispose().await.unwrap();
                drop(executor);
                assert_eq!(&*changes.borrow(), &[ExecutorAvailability::Disposed]);
                let error = projects
                    .inspect(
                        garcon_interface::execution_runtime::ExecutionProjectInspectRequest {
                            project_path: root.to_owned(),
                            include_git_repository: None,
                        },
                        None,
                    )
                    .await
                    .unwrap_err();
                assert_eq!(error.to_string(), "Executor is disposed");
                let signal = CancellationToken::new();
                signal.cancel();
                let error = api
                    .get_info(Some(ExecutorCallOptions {
                        signal: Some(signal),
                        ..Default::default()
                    }))
                    .await
                    .unwrap_err();
                assert_eq!(
                    error.downcast_ref::<NamedError>().unwrap().name,
                    "AbortError"
                );
            })
            .await;
    }

    #[tokio::test]
    async fn authenticated_worker_describes_its_services_and_refuses_unported_calls() {
        LocalSet::new()
            .run_until(async {
                let secret = create_executor_secret();
                let project = tempfile::tempdir().unwrap();
                let root = project.path().to_str().unwrap();
                let mut listener = WebSocketLinkOptions::new(LinkRole::Worker, secret.clone());
                listener.no_tls = true;
                let listener = WebSocketLink::new(listener).unwrap();
                let worker = Worker::new(Rc::clone(&listener), root.to_owned(), root.to_owned(), Vec::new().into());
                let _unsubscribe = worker.on_session().unwrap();
                let address = listener.listen(0, "0.0.0.0", None).await.unwrap();

                let executor_id = "22222222-2222-4222-8222-222222222222";
                let mut controller = WebSocketLinkOptions::new(LinkRole::Controller, secret);
                controller.no_tls = true;
                controller.executor_id = Some(executor_id.to_owned());
                let controller = WebSocketLink::new(controller).unwrap();
                let (send, mut recv) = mpsc::unbounded_channel();
                let _unsubscribe = controller
                    .on_session(Rc::new({
                        let weak = Rc::downgrade(&controller);
                        move |session| {
                            let controller = weak.upgrade().unwrap();
                            let connection = ExecutorRpcConnection::new(
                                controller,
                                session,
                                Default::default(),
                            )?;
                            let _ = send.send(connection);
                            Ok(())
                        }
                    }))
                    .unwrap();
                controller.dial(&address).unwrap();
                let connection = timeout(Duration::from_secs(5), recv.recv())
                    .await
                    .unwrap()
                    .unwrap();
                timeout(Duration::from_secs(5), connection.primary.transport.ready())
                    .await
                    .unwrap()
                    .unwrap();
                let credential_requests = Rc::new(Cell::new(0));
                let reference = json!({"kind":"api-provider-endpoint","apiProviderId":"provider","endpointId":"endpoint","revision":7});
                connection.primary.handle(Rc::new({
                    let credential_requests = credential_requests.clone();
                    let reference = reference.clone();
                    move |call, _, _, _| {
                        let credential_requests = credential_requests.clone();
                        let reference = reference.clone();
                        Box::pin(async move {
                            assert_eq!(call.method, "credentials.resolve");
                            assert_eq!(call.integration_id, "direct-openai-compatible");
                            assert_eq!(call.request, Opaque::from_value(json!({"reference":reference})));
                            let count = credential_requests.get();
                            credential_requests.set(count + 1);
                            match count {
                                0 => Ok(Some(Opaque::from_value(json!({"kind":"api-key","value":"synthetic-secret"})))),
                                1 => Err(Rc::new(AgentIntegrationError::new(
                                    AgentIntegrationErrorCode::API_PROVIDER_CONFIGURATION_CHANGED,
                                    "Fixture profile changed", false, None,
                                )) as SessionError),
                                _ => Ok(Some(Opaque::from_value(json!("synthetic-malformed-credential")))),
                            }
                        })
                    }
                }));
                connection.activate().unwrap();
                let options = || RpcCallOptions {
                    timeout: RpcTimeout::Milliseconds(2000),
                    ..Default::default()
                };
                let request = || Opaque::from_value(json!({}));
                let describe = connection
                    .primary
                    .call("", "executor.describe", request(), options())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(describe["info"]["executorId"], executor_id);
                assert_eq!(describe["info"]["services"]["files"], true);
                assert_eq!(describe["info"]["services"]["terminals"], true);
                let id = "direct-openai-compatible";
                let manifests = describe["integrations"].as_array().unwrap();
                let advertised_ids: Vec<_> = manifests.iter().map(|entry| entry["descriptor"]["id"].as_str().unwrap()).collect();
                assert_eq!(describe["info"]["integrationIds"], json!(advertised_ids));
                let manifest = manifests.iter().find(|entry| entry["descriptor"]["id"] == id).unwrap();
                assert_eq!(manifest["scope"]["instanceId"], describe["info"]["instanceId"]);
                assert_eq!(manifest["capabilities"]["singleQuery"], true);
                assert_eq!(manifest["capabilities"]["forking"], false);
                let catalog = connection.primary.call(id, "catalog.snapshot", Opaque::from_value(json!({"strict":false})), options()).await.unwrap().unwrap();
                assert_eq!(&catalog["generation"], Opaque::from_value(json!({"priority":50,"model":""})).as_value());
                let settings = Opaque::from_value(json!({"ownerId":id,"schemaVersion":1,"values":{}}));
                assert_eq!(connection.primary.call(id, "settings.migrate", settings.clone(), options()).await.unwrap(), Some(settings));
                assert!(connection.primary.call(id, "lifecycle.start", request(), options()).await.unwrap().is_none());
                assert!(connection.primary.call(id, "lifecycle.stop", request(), options()).await.unwrap().is_none());
                let absent = connection.primary.call(id, "forking.fork", request(), options()).await.unwrap_err();
                let absent = absent.downcast_ref::<AgentCallError>().unwrap();
                assert_eq!(absent.outcome, AgentDeliveryOutcome::Rejected);
                assert_eq!(absent.code, AgentIntegrationErrorCode::OPERATION_UNSUPPORTED);
                assert_eq!(absent.message, "Integration capability unavailable");
                let current = worker.serving.borrow().as_ref().unwrap().connection.clone();
                let credential = resolve_credential(Some(current), ResolveIntegrationCredentialRequest {
                    executor_id: executor_id.into(), agent_id: id.into(),
                    reference: serde_json::from_value(reference.clone()).unwrap(), signal: CancellationToken::new(),
                }).await.unwrap().unwrap();
                assert_eq!(credential.value, "synthetic-secret");
                let denied = connection.primary.call(id, "singleQuery.run", Opaque::from_value(json!({
                    "prompt":"synthetic", "model":"fixture", "thinkingMode":"none",
                    "settings":{"ownerId":id,"schemaVersion":1,"values":{}},
                    "endpoint":{
                        "apiProviderId":"provider", "endpointId":"endpoint", "providerLabel":"Synthetic", "protocol":"openai-compatible",
                        "baseUrl":"http://127.0.0.1:0/v1", "model":"fixture", "isLocal":true, "headers":{}, "capabilities":null, "credential":reference,
                    },
                })), options()).await.unwrap_err();
                let denied = denied.downcast_ref::<AgentIntegrationError>().unwrap();
                assert_eq!(denied.code, AgentIntegrationErrorCode::API_PROVIDER_CONFIGURATION_CHANGED);
                assert_eq!(denied.message, "Fixture profile changed");
                let current = worker.serving.borrow().as_ref().unwrap().connection.clone();
                let malformed = resolve_credential(Some(current), ResolveIntegrationCredentialRequest {
                    executor_id: executor_id.into(), agent_id: id.into(),
                    reference: serde_json::from_value(reference).unwrap(), signal: CancellationToken::new(),
                }).await.err().unwrap();
                assert_eq!(malformed.to_string(), "Invalid provider credential reply");
                assert_eq!(credential_requests.get(), 3);
                let inspected = connection
                    .primary
                    .call(
                        "",
                        "projects.inspect",
                        Opaque::from_value(json!({ "projectPath": root })),
                        options(),
                    )
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(inspected["resolution"]["kind"], "available");
                for path in [project.path().join("missing"), project.path().parent().unwrap().into()] {
                    let error = connection.primary.call(
                        "", "projects.ticketProjectDefault",
                        Opaque::from_value(json!({"projectPath": path.to_str().unwrap()})),
                        options(),
                    ).await.unwrap_err();
                    let error = error.downcast_ref::<DomainError>().unwrap();
                    assert_eq!(error.code, ErrorCode::TICKET_PROJECT_UNAVAILABLE);
                    assert_eq!(error.status, 503);
                    assert!(error.retryable);
                    assert_eq!(error.message, "Cannot resolve the project default. Check the context directory, or enter an explicit project.");
                }
                for (request, message) in [
                    (json!({"projectPath": root, "extra": true}), "Unexpected ticket field."),
                    (json!({}), "projectPath must be well-formed Unicode text."),
                    (json!({"projectPath": 3}), "projectPath must be well-formed Unicode text."),
                ] {
                    let error = connection.primary.call(
                        "", "projects.ticketProjectDefault", Opaque::from_value(request), options(),
                    ).await.unwrap_err();
                    let error = error.downcast_ref::<garcon_interface::errors::AgentIntegrationError>().unwrap();
                    assert_eq!(error.code, AgentIntegrationErrorCode::PROVIDER_FAILURE);
                    assert_eq!(error.message, message);
                    assert!(!error.retryable);
                }
                let error = connection
                    .primary
                    .call(
                        "unknown-integration",
                        "execution.start",
                        request(),
                        options(),
                    )
                    .await
                    .unwrap_err();
                let error = error.downcast_ref::<AgentCallError>().unwrap();
                assert_eq!(error.outcome, AgentDeliveryOutcome::NotDispatched);
                assert_eq!(error.code, AgentIntegrationErrorCode::OPERATION_UNSUPPORTED);
                assert_eq!(error.message, "Unknown integration");
                let error = connection
                    .primary
                    .call("", "apiProviders.discoverModels", request(), options())
                    .await
                    .unwrap_err();
                let error = error.downcast_ref::<AgentCallError>().unwrap();
                assert_eq!(error.outcome, AgentDeliveryOutcome::NotDispatched);
                assert_eq!(error.code, AgentIntegrationErrorCode::OPERATION_UNSUPPORTED);
                assert_eq!(
                    error.message,
                    "Executor method apiProviders.discoverModels is not ported yet"
                );
                assert!(connection.primary.active());
                controller.dispose().await;
                listener.dispose().await;
            })
            .await;
    }
}
