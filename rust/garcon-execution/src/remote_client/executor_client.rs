//! Ports `server/remote/client/executor-client.ts`.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use async_trait::async_trait;
use garcon_base::{errors::NamedError, log::Logger};
use garcon_contract::{
    api_providers::ApiProviderModelDiscoveryResponse,
    executors::{ExecutorBulkAvailability, ExecutorBulkStatus, ExecutorError},
    ticket_responses::parse_ticket_project_default,
    tickets::TicketProjectDefault,
};
use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome, AgentIntegrationErrorCode},
    execution_runtime::{
        ApiProviderDiscoveryRequest, ExecutionProjectInspectRequest,
        ExecutionProjectInspectResponse, ExecutionProjectService, ExecutionRuntimeApi,
        ExecutorAvailability, ExecutorInfo, ResolveFileMentionsRequest,
        TicketProjectDefaultRequest,
    },
    files::ExecutionFilesService,
    git::{ExecutionGhService, ExecutionGitService},
    integration::AgentIntegration,
    resources::{ExecutorCallOptions, ExecutorResult},
    terminals::ExecutionTerminalService,
};
use garcon_js::json::Opaque;
use garcon_link::{
    bulk_connection::{BulkConnectionStatus, BulkPhase},
    failure_reason::{Failure, failure_reason},
    limits::EXECUTOR_RECONNECT_GRACE_MS,
    message_session::SessionError,
    rpc::{ParkedRpcCalls, RpcCallOptions},
    rpc_connection::{
        ExecutorRpcConnection, ParkedRpcLanes, RpcConnectionDiagnostics, RpcConnectionOptions,
    },
    rpc_lane::RpcLane,
    rpc_protocol::{ExecutorDescription, IntegrationManifest},
    session_transport::SessionTransport,
    websocket_link::WebSocketLink,
};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

use crate::executor_manager_ports::{
    BindReverseRequests, CreateRemoteExecutor, ManagedRemoteExecutor, RemoteBulkListener,
    RemoteExecutorFactory, RemoteExecutorInventory, ReportRemoteSetupError,
};

use super::{
    listeners::Listeners,
    remote_agent_integration::RemoteAgentIntegration,
    remote_files::RemoteFilesService,
    remote_git::RemoteGitServices,
    remote_terminals::RemoteTerminalService,
    sessions::{RemoteSessionBacking, RemoteSessions},
    wire::{decode, encode, own_rpc_error},
};

struct RemoteExecutorClientOptions {
    reconnect_grace_ms: u64,
    expected_inventory: Option<RemoteExecutorInventory>,
    report_error: ReportRemoteSetupError,
    setup_rpc: BindReverseRequests,
    logger: Rc<dyn Logger>,
}

type Integrations = IndexMap<String, Rc<RemoteAgentIntegration>>;
type ManifestMap = IndexMap<String, IntegrationManifest>;

pub struct RemoteExecutorClientFactory;

impl RemoteExecutorFactory for RemoteExecutorClientFactory {
    fn create(
        &self,
        options: CreateRemoteExecutor,
    ) -> ExecutorResult<Rc<dyn ManagedRemoteExecutor>> {
        Ok(RemoteExecutorClient::new(
            options.executor_id,
            options.link,
            RemoteExecutorClientOptions {
                expected_inventory: options.previous_inventory,
                report_error: options.report_setup_error,
                setup_rpc: options.bind_reverse_requests,
                logger: options.logger,
                reconnect_grace_ms: EXECUTOR_RECONNECT_GRACE_MS,
            },
        )?)
    }
}

struct RemoteExecutorClient {
    id: String,
    link: Rc<WebSocketLink>,
    options: RemoteExecutorClientOptions,
    sessions: Rc<RemoteSessions>,
    integrations: RefCell<Option<Integrations>>,
    connection: RefCell<Option<Rc<ExecutorRpcConnection>>>,
    instance_id: RefCell<Option<String>>,
    parked_primary: Rc<ParkedRpcCalls>,
    parked_bulk: Rc<ParkedRpcCalls>,
    primary_reconnect: RefCell<Option<CancellationToken>>,
    bulk_reconnect: RefCell<Option<CancellationToken>>,
    bulk_activated: Cell<bool>,
    bulk_status: RefCell<ExecutorBulkStatus>,
    availability_listeners: Rc<Listeners<dyn Fn(ExecutorAvailability)>>,
    bulk_listeners: Rc<Listeners<dyn Fn(ExecutorBulkStatus)>>,
    unsubscribe: RefCell<Option<Box<dyn Fn()>>>,
    projects: Rc<RemoteProjects>,
    files: Rc<RemoteFilesService>,
    git: Rc<RemoteGitServices>,
    terminals: Rc<RemoteTerminalService>,
}

impl RemoteExecutorClient {
    fn new(
        id: String,
        link: Rc<WebSocketLink>,
        options: RemoteExecutorClientOptions,
    ) -> ExecutorResult<Rc<Self>> {
        let sessions = Rc::new(RemoteSessions::default());
        let client = Rc::new(Self {
            id,
            link,
            options,
            projects: Rc::new(RemoteProjects(sessions.clone())),
            files: Rc::new(RemoteFilesService(sessions.clone())),
            git: Rc::new(RemoteGitServices(sessions.clone())),
            terminals: Rc::new(RemoteTerminalService::new(sessions.clone())),
            sessions,
            integrations: RefCell::default(),
            connection: RefCell::default(),
            instance_id: RefCell::default(),
            parked_primary: Rc::default(),
            parked_bulk: Rc::default(),
            primary_reconnect: RefCell::default(),
            bulk_reconnect: RefCell::default(),
            bulk_activated: Cell::new(false),
            bulk_status: RefCell::new(ExecutorBulkStatus {
                availability: ExecutorBulkAvailability::Offline,
                last_error: None,
            }),
            availability_listeners: Rc::default(),
            bulk_listeners: Rc::default(),
            unsubscribe: RefCell::default(),
        });
        let weak = Rc::downgrade(&client);
        let unsubscribe = client
            .link
            .on_session(Rc::new(move |transport| {
                if let Some(client) = weak.upgrade() {
                    client.begin_install(transport)?;
                }
                Ok(())
            }))
            .map_err(own_rpc_error)?;
        client.unsubscribe.replace(Some(Box::new(unsubscribe)));
        Ok(client)
    }

    fn begin_install(self: &Rc<Self>, transport: Rc<SessionTransport>) -> Result<(), SessionError> {
        let id = self.id.clone();
        let logger = self.options.logger.clone();
        let connection = ExecutorRpcConnection::new(
            self.link.clone(),
            transport.clone(),
            RpcConnectionOptions {
                admission: self.sessions.admission.clone(),
                parked: Some(ParkedRpcLanes {
                    primary: self.parked_primary.clone(),
                    bulk: self.parked_bulk.clone(),
                }),
                bulk_failed: Some(Rc::new(move |failure| {
                    if failure
                        .failure
                        .retries
                        .checked_add(1)
                        .is_some_and(usize::is_power_of_two)
                    {
                        logger.warn(&format!(
                            "Executor bulk setup or recovery failed ({id}): {failure:?}"
                        ));
                    }
                })),
                ..Default::default()
            },
        )?;
        self.connection.replace(Some(connection.clone()));
        let weak = Rc::downgrade(self);
        let candidate = Rc::downgrade(&connection);
        let _off_failure = transport.on_failure(Rc::new(move |_| {
            if let Some((client, candidate)) = weak.upgrade().zip(candidate.upgrade())
                && client.owns_connection(&candidate)
            {
                client.terminals.disconnect();
                client.sessions.set_backing(RpcLane::Primary, None);
                client.sessions.set_backing(RpcLane::Bulk, None);
                if client.availability() == ExecutorAvailability::Ready {
                    client.begin_reconnecting();
                }
            }
        }));
        let terminal_rpc = Rc::downgrade(&connection.primary);
        let terminals = Rc::downgrade(&self.terminals);
        connection.primary.on_terminal(Rc::new(move |frame| {
            if let Some((terminals, rpc)) = terminals.upgrade().zip(terminal_rpc.upgrade()) {
                terminals.receive(frame, &rpc).map_err(Rc::from)?;
            }
            Ok(())
        }));
        let setup = self.options.setup_rpc.clone();
        let _off_endpoint = connection.on_endpoint(Rc::new(move |endpoint| {
            setup(endpoint);
            Ok(())
        }))?;
        let (weak, candidate) = (Rc::downgrade(self), Rc::downgrade(&connection));
        let _off_bulk = connection.on_bulk_changed(Rc::new(move |status| {
            if let Some((client, candidate)) = weak.upgrade().zip(candidate.upgrade())
                && client.owns_connection(&candidate)
            {
                client.change_bulk(&candidate, status);
            }
        }));
        let client = self.clone();
        // Each installing candidate owns its work; a superseded candidate may
        // close only its own transport and cannot publish availability.
        tokio::task::spawn_local(async move {
            let stage = Cell::new("describe");
            if let Err(error) = client.install(&connection, &stage).await {
                if client.owns_connection(&connection) {
                    let cause = transport.channel.failure().unwrap_or_else(|| error.clone());
                    let diagnostics = connection.diagnostics();
                    client.options.logger.warn(&format!(
                        "Executor session setup failed ({}, stage={}, lane=primary, session={}): {}; queues={:?}, diagnostics={diagnostics:?}",
                        client.id, stage.get(), transport.id, failure_reason(Failure::Error(cause.as_ref())), transport.channel.queue_snapshot(),
                    ));
                    let report = error.downcast_ref::<ExecutorConfigurationError>().map_or(
                        "Executor initialization failed; check worker configuration and matching builds",
                        |error| error.0.as_str(),
                    );
                    (client.options.report_error)(report);
                }
                transport.close(Some(error));
            }
        });
        Ok(())
    }

    async fn install(
        self: &Rc<Self>,
        connection: &Rc<ExecutorRpcConnection>,
        stage: &Cell<&'static str>,
    ) -> Result<(), SessionError> {
        let rpc = &connection.primary;
        rpc.transport.ready().await?;
        self.assert_candidate(connection)?;
        let reply = rpc
            .call(
                "",
                "executor.describe",
                Opaque::from_value(Value::Null),
                RpcCallOptions::default(),
            )
            .await?;
        self.assert_candidate(connection)?;
        let (info, manifests) = self
            .describe(&rpc.transport, reply.as_ref())
            .map_err(Rc::from)?;
        if self
            .instance_id
            .borrow()
            .as_ref()
            .is_some_and(|id| id != &info.instance_id)
            && self.availability() == ExecutorAvailability::Reconnecting
        {
            self.abandon_bindings();
        }
        let initial = self.integrations.borrow().is_none();
        let integrations = self.candidate_integrations(manifests).map_err(Rc::from)?;
        let backing = Rc::new(RemoteSessionBacking {
            rpc: rpc.clone(),
            info: Rc::new(info),
        });
        stage.set("start-integrations");
        for integration in integrations.values() {
            integration
                .initialize_replacement(&backing, initial)
                .await?;
            self.assert_candidate(connection)?;
        }
        self.assert_candidate(connection)?;
        if initial {
            self.integrations.replace(Some(integrations.clone()));
        }
        let session = Rc::downgrade(&backing);
        let client = Rc::downgrade(self);
        let candidate = Rc::downgrade(connection);
        rpc.on_producer(Rc::new(move |frame| {
            if let Some(((client, session), candidate)) = client
                .upgrade()
                .zip(session.upgrade())
                .zip(candidate.upgrade())
                && client.owns_connection(&candidate)
            {
                let integration = frame.notification["binding"]["integrationId"]
                    .as_str()
                    .and_then(|id| client.integrations.borrow().as_ref()?.get(id).cloned())
                    .ok_or_else(|| {
                        Rc::new(SessionInstallError("Unknown producer integration")) as SessionError
                    })?;
                integration.receive(frame.notification, frame.seq, &session)?;
            }
            Ok(())
        }));
        stage.set("resume-bindings");
        // Reconciliation is sent first; producer replay can fill the queue.
        let (reconciled, ()) = tokio::try_join!(biased;
            async { Ok::<_, SessionError>(rpc.reconcile_parked().await) },
            async {
                for integration in integrations.values() { integration.resume(&backing).await?; }
                Ok(())
            },
        )?;
        reconciled?;
        self.assert_candidate(connection)?;
        stage.set("activate");
        self.instance_id
            .replace(Some(backing.info.instance_id.clone()));
        cancel_timer(&self.primary_reconnect);
        self.sessions.set_backing(RpcLane::Primary, Some(backing));
        self.set_availability(ExecutorAvailability::Ready);
        self.assert_candidate(connection)?;
        connection.activate()
    }

    fn describe(
        &self,
        transport: &SessionTransport,
        reply: Option<&Opaque>,
    ) -> ExecutorResult<(ExecutorInfo, ManifestMap)> {
        let raw = reply.map_or(&Value::Null, Opaque::as_value);
        let info = &raw["info"];
        if let Some(id) = info["executorId"].as_str()
            && (id != self.id || transport.executor_id != self.id)
        {
            return Err(ExecutorConfigurationError(format!(
                "Executor identity mismatch: worker serves {id}; restart the worker to serve {}",
                self.id
            ))
            .into());
        }
        if !info["projectBasePath"]
            .as_str()
            .is_some_and(|path| !path.is_empty())
        {
            return Err(
                ExecutorConfigurationError("Executor project base is missing".into()).into(),
            );
        }
        if ["files", "git", "gh", "terminals", "directoryCreation"]
            .into_iter()
            .any(|key| !info["services"][key].is_boolean())
        {
            return Err(ExecutorConfigurationError(
                "Executor service capabilities are invalid".into(),
            )
            .into());
        }
        let ExecutorDescription { info, integrations } = decode(reply)?;
        let mut manifests = IndexMap::with_capacity(integrations.len());
        for manifest in integrations {
            let id = &manifest.descriptor.id;
            if manifest.scope.executor_id != info.executor_id
                || manifest.scope.instance_id != info.instance_id
                || manifest.scope.integration_id != *id
                || manifests.contains_key(id)
            {
                return Err(ExecutorConfigurationError(
                    "Executor integration scope mismatch".into(),
                )
                .into());
            }
            manifests.insert(id.clone(), manifest);
        }
        if manifests.len() != info.integration_ids.len()
            || info
                .integration_ids
                .iter()
                .any(|id| !manifests.contains_key(id))
        {
            return Err(ExecutorConfigurationError(
                "Executor integration inventory mismatch".into(),
            )
            .into());
        }
        if self
            .options
            .expected_inventory
            .as_ref()
            .is_some_and(|expected| {
                manifests.len() != expected.integrations.len()
                    || expected.integrations.iter().any(|expected| {
                        !manifests
                            .get(&expected.descriptor.id)
                            .is_some_and(|replacement| same_manifest(expected, replacement))
                    })
            })
        {
            return Err(ExecutorConfigurationError(INVENTORY_CHANGED.into()).into());
        }
        Ok((info, manifests))
    }

    fn candidate_integrations(&self, manifests: ManifestMap) -> ExecutorResult<Integrations> {
        let existing = self.integrations.borrow();
        if let Some(existing) = existing.as_ref() {
            if existing.len() != manifests.len() {
                return Err(ExecutorConfigurationError(INVENTORY_CHANGED.into()).into());
            }
            if existing.iter().any(|(id, integration)| {
                !manifests
                    .get(id)
                    .is_some_and(|incoming| same_manifest(integration.manifest(), incoming))
            }) {
                return Err(ExecutorConfigurationError(
                    "Executor provider capabilities changed; restart the controller to accept them"
                        .into(),
                )
                .into());
            }
            return Ok(existing.clone());
        }
        manifests
            .into_iter()
            .map(|(id, manifest)| {
                let integration = RemoteAgentIntegration::new(
                    manifest,
                    self.sessions.clone(),
                    self.options.logger.clone(),
                )?;
                Ok((id, integration))
            })
            .collect()
    }

    fn owns_connection(&self, candidate: &Rc<ExecutorRpcConnection>) -> bool {
        self.availability() != ExecutorAvailability::Disposed
            && self
                .connection
                .borrow()
                .as_ref()
                .is_some_and(|active| Rc::ptr_eq(active, candidate))
    }

    fn assert_candidate(&self, candidate: &Rc<ExecutorRpcConnection>) -> Result<(), SessionError> {
        if self.owns_connection(candidate) && candidate.primary.transport.connected() {
            Ok(())
        } else {
            Err(Rc::new(SessionInstallError(
                "Executor candidate session retired",
            )))
        }
    }

    fn begin_reconnecting(self: &Rc<Self>) {
        self.set_availability(ExecutorAvailability::Reconnecting);
        self.arm_timer(&self.primary_reconnect, |client| {
            if client.availability() == ExecutorAvailability::Reconnecting {
                client.abandon_bindings();
            }
        });
    }

    fn abandon_bindings(&self) {
        cancel_timer(&self.primary_reconnect);
        self.retire_integrations();
        self.parked_primary.reject_all();
        self.parked_bulk.reject_all();
        cancel_timer(&self.bulk_reconnect);
        self.set_availability(ExecutorAvailability::Offline);
    }

    fn retire_integrations(&self) {
        if let Some(integrations) = self.integrations.borrow().as_ref() {
            for integration in integrations.values() {
                integration.retire();
            }
        }
    }

    fn change_bulk(
        self: &Rc<Self>,
        connection: &ExecutorRpcConnection,
        status: &BulkConnectionStatus,
    ) {
        let previous = self.sessions.current(RpcLane::Bulk).take();
        if status.phase == BulkPhase::Ready
            && let Some(primary) = self.sessions.current(RpcLane::Primary).borrow().as_ref()
            && let Some(rpc) = connection.bulk.current()
        {
            self.sessions.set_backing(
                RpcLane::Bulk,
                Some(Rc::new(RemoteSessionBacking {
                    rpc,
                    info: primary.info.clone(),
                })),
            );
            cancel_timer(&self.bulk_reconnect);
        } else if previous.is_some() && self.bulk_reconnect.borrow().is_none() {
            self.arm_timer(&self.bulk_reconnect, |client| {
                client.bulk_reconnect.take();
                client.link.fence_bulk();
                client.parked_bulk.reject_all();
            });
        }
        let availability = match status.phase {
            BulkPhase::Ready => {
                self.bulk_activated.set(true);
                ExecutorBulkAvailability::Ready
            }
            BulkPhase::Offline => ExecutorBulkAvailability::Offline,
            _ if self.bulk_activated.get() => ExecutorBulkAvailability::Reconnecting,
            _ => ExecutorBulkAvailability::Connecting,
        };
        let last_error = if availability == ExecutorBulkAvailability::Ready {
            None
        } else {
            status
                .error
                .as_ref()
                .map(|error| ExecutorError {
                    code: "EXECUTOR_BULK_UNAVAILABLE".into(),
                    message: failure_reason(Failure::Error(error.as_ref())),
                })
                .or_else(|| self.bulk_status.borrow().last_error.clone())
        };
        let next = ExecutorBulkStatus {
            availability,
            last_error,
        };
        if self.bulk_status.replace(next.clone()) != next {
            self.bulk_listeners
                .for_each(|listener| listener(next.clone()));
        }
    }

    fn arm_timer(self: &Rc<Self>, slot: &RefCell<Option<CancellationToken>>, expired: fn(&Self)) {
        cancel_timer(slot);
        let stop = CancellationToken::new();
        slot.replace(Some(stop.clone()));
        let delay = Duration::from_millis(self.options.reconnect_grace_ms);
        let client = Rc::downgrade(self);
        tokio::task::spawn_local(async move {
            tokio::select! {
                biased;
                () = stop.cancelled() => {},
                () = sleep(delay) => {
                    if let Some(client) = client.upgrade() { expired(&client); }
                }
            }
        });
    }

    fn set_availability(&self, value: ExecutorAvailability) {
        if self.sessions.set_availability(value) {
            self.availability_listeners
                .for_each(|listener| listener(value));
        }
    }

    fn check_service(
        &self,
        options: Option<ExecutorCallOptions>,
        name: &str,
        available: impl FnOnce(&ExecutorInfo) -> bool,
    ) -> ExecutorResult<()> {
        check_cancelled(options)?;
        let backing = self.sessions.latest()?;
        if available(&backing.info) {
            Ok(())
        } else {
            Err(unsupported(format!("Executor {name} service is unavailable")).into())
        }
    }
}

impl ManagedRemoteExecutor for RemoteExecutorClient {
    fn inventory(&self) -> Option<RemoteExecutorInventory> {
        self.integrations
            .borrow()
            .as_ref()
            .map(|integrations| RemoteExecutorInventory {
                integrations: integrations
                    .values()
                    .map(|integration| integration.manifest().clone())
                    .collect(),
            })
    }

    fn bulk_status(&self) -> ExecutorBulkStatus {
        self.bulk_status.borrow().clone()
    }

    fn diagnostics(&self) -> Option<RpcConnectionDiagnostics> {
        self.connection
            .borrow()
            .as_ref()
            .map(|connection| connection.diagnostics())
    }

    fn on_bulk_changed(&self, listener: RemoteBulkListener) -> Box<dyn Fn()> {
        self.bulk_listeners.subscribe(listener)
    }
}

#[async_trait(?Send)]
impl ExecutionRuntimeApi for RemoteExecutorClient {
    fn id(&self) -> &str {
        &self.id
    }

    fn availability(&self) -> ExecutorAvailability {
        self.sessions.availability()
    }

    async fn get_info(&self, options: Option<ExecutorCallOptions>) -> ExecutorResult<ExecutorInfo> {
        check_cancelled(options)?;
        Ok((*self.sessions.latest()?.info).clone())
    }

    async fn get_agent_integration(
        &self,
        agent_id: &str,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<AgentIntegration>> {
        check_cancelled(options)?;
        self.sessions.latest()?;
        self.integrations
            .borrow()
            .as_ref()
            .and_then(|integrations| integrations.get(agent_id))
            .map(|integration| integration.api())
            .ok_or_else(|| unsupported("Integration is unavailable on this executor").into())
    }

    async fn get_project_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionProjectService>> {
        self.check_service(options, "projects", |_| true)?;
        Ok(self.projects.clone())
    }

    async fn discover_api_provider_models(
        &self,
        request: ApiProviderDiscoveryRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ApiProviderModelDiscoveryResponse> {
        let mut options = options.unwrap_or_default();
        options.timeout_ms.get_or_insert(15_000.0);
        let reply = self
            .sessions
            .call(
                "",
                "apiProviders.discoverModels",
                encode(request)?,
                Some(options).into(),
            )
            .await?;
        decode(reply.as_ref())
    }

    async fn get_files_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionFilesService>> {
        self.check_service(options, "files", |info| info.services.files)?;
        Ok(self.files.clone())
    }

    async fn get_git_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionGitService>> {
        self.check_service(options, "git", |info| info.services.git)?;
        Ok(self.git.clone())
    }

    async fn get_gh_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionGhService>> {
        self.check_service(options, "gh", |info| info.services.gh)?;
        Ok(self.git.clone())
    }

    async fn get_terminal_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionTerminalService>> {
        self.check_service(options, "terminals", |info| info.services.terminals)?;
        Ok(self.terminals.clone())
    }

    fn on_availability_changed(&self, listener: Rc<dyn Fn(ExecutorAvailability)>) -> Box<dyn Fn()> {
        self.availability_listeners.subscribe(listener)
    }

    async fn dispose(&self) -> ExecutorResult<()> {
        if self.availability() == ExecutorAvailability::Disposed {
            return Ok(());
        }
        cancel_timer(&self.primary_reconnect);
        self.set_availability(ExecutorAvailability::Disposed);
        if let Some(unsubscribe) = self.unsubscribe.take() {
            unsubscribe();
        }
        self.terminals.disconnect();
        self.sessions.set_backing(RpcLane::Primary, None);
        self.sessions.set_backing(RpcLane::Bulk, None);
        cancel_timer(&self.bulk_reconnect);
        self.parked_primary.close();
        self.parked_bulk.close();
        self.retire_integrations();
        self.link.dispose().await;
        self.availability_listeners.clear();
        self.bulk_listeners.clear();
        Ok(())
    }
}

const INVENTORY_CHANGED: &str =
    "Executor provider inventory changed; restart the controller to accept it";

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct ExecutorConfigurationError(String);

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct SessionInstallError(&'static str);

fn same_manifest(expected: &IntegrationManifest, incoming: &IntegrationManifest) -> bool {
    let mut incoming = incoming.clone();
    incoming.scope = expected.scope.clone();
    expected == &incoming
}

fn cancel_timer(slot: &RefCell<Option<CancellationToken>>) {
    if let Some(stop) = slot.take() {
        stop.cancel();
    }
}

fn check_cancelled(options: Option<ExecutorCallOptions>) -> ExecutorResult<()> {
    if options
        .and_then(|options| options.signal)
        .is_some_and(|signal| signal.is_cancelled())
    {
        Err(NamedError {
            name: "AbortError".into(),
            code: None,
            message: "The operation was aborted.".into(),
        }
        .into())
    } else {
        Ok(())
    }
}

fn unsupported(message: impl Into<String>) -> AgentCallError {
    AgentCallError::with_code(
        AgentDeliveryOutcome::NotDispatched,
        message,
        AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
    )
}

struct RemoteProjects(Rc<RemoteSessions>);

impl RemoteProjects {
    async fn call(
        &self,
        method: &str,
        request: impl Serialize,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Option<Opaque>> {
        self.0
            .call("", method, encode(request)?, options.into())
            .await
    }
}

#[async_trait(?Send)]
impl ExecutionProjectService for RemoteProjects {
    async fn ticket_project_default(
        &self,
        request: TicketProjectDefaultRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TicketProjectDefault> {
        let reply = self
            .call("projects.ticketProjectDefault", request, options)
            .await?;
        Ok(parse_ticket_project_default(
            reply.as_deref().unwrap_or(&Value::Null),
        )?)
    }

    async fn inspect(
        &self,
        request: ExecutionProjectInspectRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionProjectInspectResponse> {
        let reply = self.call("projects.inspect", request, options).await?;
        decode(reply.as_ref())
    }

    async fn resolve_file_mentions(
        &self,
        request: ResolveFileMentionsRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<String> {
        let reply = self
            .call("projects.resolveFileMentions", request, options)
            .await?;
        decode(reply.as_ref())
    }
}
