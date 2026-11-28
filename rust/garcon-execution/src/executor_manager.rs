//! Owns executor configuration, installed inventories, and reverse-call authority.
//! Composition injects the already-started Local runtime, then installs the
//! configuration guards and CLI dispatcher. Chat processing uses `is_reconnecting`;
//! durable writers use `retain_references` through publication.

mod remote;
mod snapshot_wire;

pub use snapshot_wire::ExecutorSnapshotWire;

use std::{
    cell::{Cell, RefCell},
    collections::HashSet,
    future::Future,
    rc::Rc,
};

use futures::{
    FutureExt,
    future::{LocalBoxFuture, Shared, join_all, try_join_all},
};
use garcon_base::{domain_error::DomainError, log::Logger};
use garcon_contract::{
    error_codes::ErrorCode,
    executors::{
        AgentExecutionTarget, ExecutorBulkAvailability, ExecutorBulkStatus, ExecutorDirection,
        ExecutorError, ExecutorKind, ExecutorServices, ExecutorSnapshot,
        ExecutorSnapshotAvailability, LOCAL_EXECUTOR_ID, LOCAL_EXECUTOR_LABEL,
        effective_executor_id,
    },
    project_resolution::ProjectResolution,
};
use garcon_interface::{
    errors::AgentIntegrationErrorCode,
    execution_runtime::{
        ExecutionProjectInspectRequest, ExecutionProjectService, ExecutionRuntimeApi,
        ExecutorAvailability, ExecutorInfo, ResolveFileMentionsRequest,
    },
    host::{AgentResolveCredentialRequest, AgentResolvedCredential},
    integration::{AGENT_INTEGRATION_API_VERSION, AgentIntegration},
    resources::{ExecutorCallOptions, ExecutorResult},
    testing::{AgentIntegrationConformanceOptions, validate_agent_integration},
};
use garcon_link::{socket_admission::ExecutorSocketAdmission, websocket_link::WebSocketLink};
use garcon_stores::executors::config_store::{
    ExecutorConfigStore, RemoteExecutorConfig, RemoteExecutorConnection,
};
use indexmap::IndexMap;
use serde_json::Value;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::{
    directory::ExecutionIntegrationDirectory,
    executor_manager_ports::{
        ManagedRemoteExecutor, RemoteExecutorFactory, RemoteExecutorInventory,
    },
    reference_writes::{ExecutorReferenceWrites, RetainExecutorReferences},
    remote_client::{cli_dispatcher::ControllerCliDispatcher, listeners::Listeners},
    types::ExecutionOperationResult,
};

type Integrations = Rc<IndexMap<String, Rc<AgentIntegration>>>;
type MutationTail = Shared<LocalBoxFuture<'static, ()>>;
type ChangedListener = dyn Fn();
type AvailabilityListener = dyn Fn(&str, ExecutorAvailability);
pub type AssertExecutorAuthority = Rc<dyn Fn() -> Result<(), DomainError>>;
pub type AssertExecutorConfig = Rc<dyn Fn(&str) -> ExecutionOperationResult<()>>;
pub type ResolveExecutorCredential = Rc<
    dyn Fn(
        String,
        String,
        AgentResolveCredentialRequest,
    ) -> LocalBoxFuture<'static, ExecutorResult<Option<AgentResolvedCredential>>>,
>;

pub struct ExecutorManagerOptions {
    pub local: Rc<dyn ExecutionRuntimeApi>,
    pub config: Rc<ExecutorConfigStore>,
    pub remote_factory: Rc<dyn RemoteExecutorFactory>,
    pub resolve_credential: ResolveExecutorCredential,
    pub logger: Rc<dyn Logger>,
}

pub struct ExecutorConfigGuards {
    pub assert_idle: AssertExecutorConfig,
    pub assert_removable: AssertExecutorConfig,
}

impl Default for ExecutorConfigGuards {
    fn default() -> Self {
        Self {
            assert_idle: Rc::new(|_| Ok(())),
            assert_removable: Rc::new(|_| Ok(())),
        }
    }
}

struct ManagedRemote {
    id: String,
    config: RefCell<RemoteExecutorConfig>,
    executor: RefCell<Option<Rc<dyn ManagedRemoteExecutor>>>,
    link: RefCell<Option<Rc<WebSocketLink>>>,
    integrations: RefCell<Option<Integrations>>,
    known_integrations: RefCell<Option<Integrations>>,
    inventory: RefCell<Option<RemoteExecutorInventory>>,
    info: RefCell<Option<ExecutorInfo>>,
    error: RefCell<Option<ExecutorError>>,
    preparation: RefCell<Option<Rc<()>>>,
    cli_lease: RefCell<Rc<CancellationToken>>,
}

impl ManagedRemote {
    fn new(config: RemoteExecutorConfig, known: Option<&Rc<Self>>) -> Self {
        Self {
            id: config.id.clone(),
            config: RefCell::new(config),
            executor: RefCell::default(),
            link: RefCell::default(),
            integrations: RefCell::default(),
            known_integrations: RefCell::new(
                known.and_then(|entry| entry.known_integrations.borrow().clone()),
            ),
            inventory: RefCell::new(known.and_then(|entry| entry.inventory.borrow().clone())),
            info: RefCell::new(known.and_then(|entry| entry.info.borrow().clone())),
            error: RefCell::default(),
            preparation: RefCell::default(),
            cli_lease: RefCell::default(),
        }
    }

    fn remote_availability(&self) -> Option<ExecutorAvailability> {
        self.executor
            .borrow()
            .as_ref()
            .map(|executor| executor.availability())
    }
}

pub struct ExecutorManager {
    pub local: Rc<dyn ExecutionRuntimeApi>,
    pub config: Rc<ExecutorConfigStore>,
    local_integrations: Integrations,
    local_info: Option<ExecutorInfo>,
    remotes: RefCell<IndexMap<String, Rc<ManagedRemote>>>,
    socket_admission: Rc<ExecutorSocketAdmission>,
    changes: Rc<Listeners<ChangedListener>>,
    availability: Rc<Listeners<AvailabilityListener>>,
    changing: RefCell<HashSet<String>>,
    reference_writes: Rc<ExecutorReferenceWrites>,
    mutations: RefCell<Option<MutationTail>>,
    disposed: Cell<bool>,
    quiescing: Cell<bool>,
    cli_dispatcher: RefCell<Option<Rc<ControllerCliDispatcher>>>,
    guards: RefCell<ExecutorConfigGuards>,
    remote_factory: Rc<dyn RemoteExecutorFactory>,
    resolve_credential: ResolveExecutorCredential,
    logger: Rc<dyn Logger>,
}

impl ExecutorManager {
    pub async fn start(options: ExecutorManagerOptions) -> ExecutionOperationResult<Rc<Self>> {
        let local = options.local.clone();
        let result = Self::initialize(options).await;
        if result.is_err() {
            local.dispose().await?;
        }
        result
    }

    async fn initialize(options: ExecutorManagerOptions) -> ExecutionOperationResult<Rc<Self>> {
        let (local_info, local_integrations) =
            if options.local.availability() == ExecutorAvailability::Ready {
                let info = options.local.get_info(None).await?;
                let integrations = load_integrations(options.local.as_ref(), &info).await?;
                (Some(info), integrations)
            } else {
                (None, Rc::default())
            };
        let manager = Rc::new_cyclic(|weak: &std::rc::Weak<Self>| {
            let owner = weak.clone();
            let config = options.config;
            Self {
                local: options.local,
                config,
                local_info,
                local_integrations,
                remotes: RefCell::default(),
                socket_admission: Rc::default(),
                changes: Rc::default(),
                availability: Rc::default(),
                changing: RefCell::default(),
                reference_writes: Rc::new(ExecutorReferenceWrites::new(move |id| {
                    let manager = owner.upgrade().ok_or_else(reference_unavailable)?;
                    if manager.disposed.get() || manager.quiescing.get() || manager.is_changing(id)
                    {
                        return Err(reference_unavailable().into());
                    }
                    manager.config.require(id)?;
                    Ok(())
                })),
                mutations: RefCell::default(),
                disposed: Cell::default(),
                quiescing: Cell::default(),
                cli_dispatcher: RefCell::default(),
                guards: RefCell::default(),
                remote_factory: options.remote_factory,
                resolve_credential: options.resolve_credential,
                logger: options.logger,
            }
        });
        manager.apply_config().await?;
        Ok(manager)
    }

    pub fn set_guards(&self, guards: ExecutorConfigGuards) {
        self.guards.replace(guards);
    }

    pub fn set_cli_dispatcher(&self, dispatcher: Rc<ControllerCliDispatcher>) {
        self.cli_dispatcher.replace(Some(dispatcher));
    }

    pub fn retain_references(&self) -> RetainExecutorReferences {
        self.reference_writes.retention_callback()
    }

    pub fn is_ready(&self, executor_id: &str) -> bool {
        if self.disposed.get() || self.is_changing(executor_id) {
            return false;
        }
        if executor_id == LOCAL_EXECUTOR_ID {
            return self.local_info.is_some()
                && self.local.availability() == ExecutorAvailability::Ready;
        }
        self.entry(executor_id).is_some_and(|entry| {
            entry.config.borrow().enabled
                && entry.preparation.borrow().is_none()
                && entry.integrations.borrow().is_some()
                && entry.remote_availability() == Some(ExecutorAvailability::Ready)
        })
    }

    pub fn is_reconnecting(&self, executor_id: &str) -> bool {
        !self.disposed.get()
            && self
                .entry(executor_id)
                .and_then(|entry| entry.remote_availability())
                == Some(ExecutorAvailability::Reconnecting)
    }

    pub fn ready_instance_id(&self, executor_id: &str) -> Result<String, DomainError> {
        if !self.is_ready(executor_id) {
            return Err(unavailable());
        }
        self.instance_id(executor_id)
    }

    pub fn instance_id(&self, executor_id: &str) -> Result<String, DomainError> {
        self.require_executor(executor_id)?;
        let id = if executor_id == LOCAL_EXECUTOR_ID {
            self.local_info
                .as_ref()
                .map(|info| info.instance_id.clone())
        } else {
            self.entry(executor_id).and_then(|entry| {
                entry
                    .info
                    .borrow()
                    .as_ref()
                    .map(|info| info.instance_id.clone())
            })
        };
        id.filter(|id| !id.is_empty()).ok_or_else(unavailable)
    }

    pub fn require_executor(
        &self,
        executor_id: &str,
    ) -> Result<Rc<dyn ExecutionRuntimeApi>, DomainError> {
        if !self.is_ready(executor_id) && !self.holds_calls(executor_id) {
            return Err(unavailable());
        }
        if executor_id == LOCAL_EXECUTOR_ID {
            return Ok(self.local.clone());
        }
        self.entry(executor_id)
            .and_then(|entry| entry.executor.borrow().clone())
            .map(|executor| executor as Rc<dyn ExecutionRuntimeApi>)
            .ok_or_else(unavailable)
    }

    fn integrations(&self, executor_id: &str) -> Result<Integrations, DomainError> {
        self.require_executor(executor_id)?;
        if executor_id == LOCAL_EXECUTOR_ID {
            return Ok(self.local_integrations.clone());
        }
        self.entry(executor_id)
            .and_then(|entry| entry.integrations.borrow().clone())
            .ok_or_else(unavailable)
    }

    pub async fn project_service(
        &self,
        executor_id: &str,
    ) -> ExecutorResult<Rc<dyn ExecutionProjectService>> {
        self.require_executor(executor_id)?
            .get_project_service(None)
            .await
    }

    pub async fn inspect_project(
        &self,
        project_path: String,
        executor_id: Option<&str>,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ProjectResolution> {
        Ok(self
            .project_service(&effective_executor_id(executor_id))
            .await?
            .inspect(
                ExecutionProjectInspectRequest {
                    project_path,
                    include_git_repository: None,
                },
                options,
            )
            .await?
            .resolution)
    }

    pub async fn resolve_file_mentions(
        &self,
        command: String,
        project_path: String,
        executor_id: Option<&str>,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<String> {
        self.project_service(&effective_executor_id(executor_id))
            .await?
            .resolve_file_mentions(
                ResolveFileMentionsRequest {
                    project_path,
                    command,
                },
                options,
            )
            .await
    }

    pub fn list(&self) -> Vec<ExecutorSnapshot> {
        let local_info = self
            .local_info
            .as_ref()
            .filter(|_| self.is_ready(LOCAL_EXECUTOR_ID));
        let local = ExecutorSnapshot {
            id: LOCAL_EXECUTOR_ID.into(),
            label: LOCAL_EXECUTOR_LABEL.into(),
            kind: ExecutorKind::Local,
            enabled: true,
            direction: None,
            allow_controller_cli: true,
            allow_executor_management: true,
            availability: if local_info.is_some() {
                ExecutorSnapshotAvailability::Ready
            } else {
                ExecutorSnapshotAvailability::Offline
            },
            project_base_path: local_info.map(|info| info.project_base_path.clone()),
            instance_id: local_info.map(|info| info.instance_id.clone()),
            bulk: None,
            last_error: local_info.is_none().then(|| ExecutorError {
                code: AgentIntegrationErrorCode::UNAVAILABLE.as_str().into(),
                message: "Local executor is unavailable".into(),
            }),
            executor_services: ExecutorServices {
                files: local_info.is_some(),
                git: local_info.is_some(),
                gh: local_info.is_some(),
                terminals: local_info.is_some(),
                directory_creation: local_info.is_some_and(|info| info.services.directory_creation),
            },
        };
        std::iter::once(local)
            .chain(self.remotes.borrow().values().map(|entry| {
                let config = entry.config.borrow();
                let info = entry.info.borrow();
                let services = info.as_ref().map(|info| &info.services);
                ExecutorSnapshot {
                    id: entry.id.clone(),
                    label: config.label.clone(),
                    kind: ExecutorKind::Remote,
                    enabled: config.enabled,
                    allow_controller_cli: config.allow_controller_cli,
                    allow_executor_management: config.allow_executor_management,
                    direction: Some(match &config.connection {
                        RemoteExecutorConnection::ExecutorConnects { .. } => {
                            ExecutorDirection::ExecutorConnects
                        }
                        RemoteExecutorConnection::ControllerConnects { .. } => {
                            ExecutorDirection::ControllerConnects
                        }
                    }),
                    availability: self.snapshot_availability(&entry.id),
                    project_base_path: info.as_ref().map(|info| info.project_base_path.clone()),
                    instance_id: info.as_ref().map(|info| info.instance_id.clone()),
                    last_error: entry.error.borrow().clone(),
                    bulk: Some(entry.executor.borrow().as_ref().map_or(
                        ExecutorBulkStatus {
                            availability: ExecutorBulkAvailability::Offline,
                            last_error: None,
                        },
                        |executor| executor.bulk_status(),
                    )),
                    executor_services: ExecutorServices {
                        files: services.is_some_and(|s| s.files),
                        git: services.is_some_and(|s| s.git),
                        gh: services.is_some_and(|s| s.gh),
                        terminals: services.is_some_and(|s| s.terminals),
                        directory_creation: services.is_some_and(|s| s.directory_creation),
                    },
                }
            }))
            .collect()
    }

    pub fn inbound_link(&self, executor_id: &str) -> Option<Rc<WebSocketLink>> {
        if self.disposed.get() || self.is_changing(executor_id) {
            return None;
        }
        let entry = self.entry(executor_id)?;
        let config = entry.config.borrow();
        if !config.enabled
            || !matches!(
                config.connection,
                RemoteExecutorConnection::ExecutorConnects { .. }
            )
        {
            return None;
        }
        entry
            .link
            .borrow()
            .clone()
            .filter(|link| link.accepts_socket())
    }

    pub fn on_changed(&self, listener: Rc<ChangedListener>) -> Box<dyn Fn()> {
        self.changes.subscribe(listener)
    }

    pub fn on_availability_changed(&self, listener: Rc<AvailabilityListener>) -> Box<dyn Fn()> {
        self.availability.subscribe(listener)
    }

    pub fn create(
        self: &Rc<Self>,
        request: Value,
        public_base: Option<String>,
        assert_current: Option<AssertExecutorAuthority>,
    ) -> impl Future<Output = ExecutionOperationResult<RemoteExecutorConfig>> + use<> {
        self.mutate(assert_current, move |manager, _| async move {
            manager.config.create(request, public_base).await
        })
    }

    pub fn update(
        self: &Rc<Self>,
        id: String,
        request: Value,
        assert_current: Option<AssertExecutorAuthority>,
    ) -> impl Future<Output = ExecutionOperationResult<RemoteExecutorConfig>> + use<> {
        self.mutate(assert_current, move |manager, changing| async move {
            let owner = manager.clone();
            manager
                .config
                .update(
                    id,
                    request,
                    Some(Box::new(move |previous, next| {
                        if !same_connector(previous, next) {
                            owner.require_idle(&previous.id, &changing)?;
                        }
                        Ok(())
                    })),
                )
                .await
        })
    }

    pub fn remove(
        self: &Rc<Self>,
        id: String,
        assert_current: Option<AssertExecutorAuthority>,
    ) -> impl Future<Output = ExecutionOperationResult<()>> + use<> {
        self.mutate(assert_current, move |manager, changing| async move {
            manager.require_idle(&id, &changing)?;
            manager.reference_writes.assert_no_writes(&id)?;
            let assert_removable = manager.guards.borrow().assert_removable.clone();
            assert_removable(&id)?;
            manager.config.remove(id).await
        })
    }

    fn mutate<
        T: 'static,
        F: Future<Output = ExecutionOperationResult<T>> + 'static,
        O: FnOnce(Rc<Self>, Rc<RefCell<Option<String>>>) -> F + 'static,
    >(
        self: &Rc<Self>,
        assert_current: Option<AssertExecutorAuthority>,
        operation: O,
    ) -> impl Future<Output = ExecutionOperationResult<T>> + use<T, F, O> {
        let (finished, wait) = oneshot::channel::<()>();
        let previous = self.mutations.replace(Some(
            async move {
                let _ = wait.await;
            }
            .boxed_local()
            .shared(),
        ));
        let manager = self.clone();
        // The process owns the mutation through reconciliation even if its HTTP/RPC waiter drops.
        let task = tokio::task::spawn_local(async move {
            let _finished = finished;
            if let Some(previous) = previous {
                previous.await;
            }
            if manager.disposed.get() || manager.quiescing.get() {
                return Err(DomainError::new(
                    ErrorCode::SERVER_SHUTTING_DOWN,
                    "Executors are stopping",
                    503,
                    false,
                )
                .into());
            }
            if let Some(assert_current) = assert_current {
                assert_current()?;
            }
            let changing = Rc::new(RefCell::new(None));
            let result = operation(manager.clone(), changing.clone()).await;
            let applied = if manager.disposed.get() {
                Ok(())
            } else {
                manager.apply_config().await
            };
            if let Some(id) = changing.take() {
                manager.changing.borrow_mut().remove(&id);
                if manager.is_ready(&id) {
                    manager.publish_availability(&id, ExecutorAvailability::Ready);
                }
            }
            manager.changed();
            applied?;
            result
        });
        async move { task.await? }
    }

    fn require_idle(
        &self,
        id: &str,
        changing: &RefCell<Option<String>>,
    ) -> ExecutionOperationResult<()> {
        self.config.require(id)?;
        let assert_idle = self.guards.borrow().assert_idle.clone();
        assert_idle(id)?;
        self.changing.borrow_mut().insert(id.to_owned());
        changing.replace(Some(id.to_owned()));
        Ok(())
    }

    pub async fn dispose(self: &Rc<Self>) -> ExecutorResult<()> {
        if self.disposed.replace(true) {
            return Ok(());
        }
        for entry in self.remotes.borrow().values() {
            entry.cli_lease.borrow().cancel();
        }
        let manager = self.clone();
        tokio::task::spawn_local(async move {
            let mutations = manager.mutations.borrow().clone();
            if let Some(mutations) = mutations {
                mutations.await;
            }
            let remotes: Vec<_> = manager
                .remotes
                .borrow()
                .values()
                .filter_map(|entry| entry.executor.borrow().clone())
                .collect();
            join_all(remotes.iter().map(|executor| executor.dispose())).await;
            manager.remotes.borrow_mut().clear();
            manager.local.dispose().await?;
            manager.changes.clear();
            manager.availability.clear();
            Ok(())
        })
        .await?
    }

    pub fn quiesce(&self) {
        self.quiescing.set(true);
        let remotes: Vec<_> = self.remotes.borrow().values().cloned().collect();
        for entry in remotes {
            entry.cli_lease.borrow().cancel();
            let link = entry.link.borrow().clone();
            if let Some(link) = link {
                link.quiesce();
            }
        }
    }

    fn holds_calls(&self, executor_id: &str) -> bool {
        if self.disposed.get() || self.is_changing(executor_id) {
            return false;
        }
        self.entry(executor_id).is_some_and(|entry| {
            entry.config.borrow().enabled
                && entry.integrations.borrow().is_some()
                && matches!(
                    entry.remote_availability(),
                    Some(ExecutorAvailability::Reconnecting | ExecutorAvailability::Ready)
                )
        })
    }

    fn entry(&self, id: &str) -> Option<Rc<ManagedRemote>> {
        self.remotes.borrow().get(id).cloned()
    }

    fn is_changing(&self, id: &str) -> bool {
        self.changing.borrow().contains(id)
    }

    fn current(&self, entry: &Rc<ManagedRemote>) -> bool {
        !self.disposed.get()
            && self
                .entry(&entry.id)
                .is_some_and(|current| Rc::ptr_eq(&current, entry))
    }

    fn changed(&self) {
        if !self.disposed.get() {
            self.changes.for_each(|listener| listener());
        }
    }

    fn publish_availability(&self, id: &str, value: ExecutorAvailability) {
        if !self.disposed.get() && !self.quiescing.get() {
            self.availability.for_each(|listener| listener(id, value));
        }
    }

    fn snapshot_availability(&self, id: &str) -> ExecutorSnapshotAvailability {
        if self.is_ready(id) {
            ExecutorSnapshotAvailability::Ready
        } else if self.is_reconnecting(id) || self.holds_calls(id) {
            ExecutorSnapshotAvailability::Reconnecting
        } else {
            ExecutorSnapshotAvailability::Offline
        }
    }
}

impl ExecutionIntegrationDirectory for ExecutorManager {
    fn require_integration(
        &self,
        target: &AgentExecutionTarget,
    ) -> ExecutionOperationResult<Rc<AgentIntegration>> {
        self.integrations(&target.executor_id)?
            .get(&target.agent_id)
            .cloned()
            .ok_or_else(|| format!("Unsupported agent integration: {}", target.agent_id).into())
    }

    fn known_integration(&self, target: &AgentExecutionTarget) -> Option<Rc<AgentIntegration>> {
        let integrations = if target.executor_id == LOCAL_EXECUTOR_ID {
            self.local_integrations.clone()
        } else {
            self.entry(&target.executor_id)?
                .known_integrations
                .borrow()
                .clone()?
        };
        integrations.get(&target.agent_id).cloned()
    }

    fn integrations_for(
        &self,
        executor_id: &str,
    ) -> ExecutionOperationResult<Vec<Rc<AgentIntegration>>> {
        Ok(self.integrations(executor_id)?.values().cloned().collect())
    }

    fn is_ready(&self, executor_id: &str) -> bool {
        Self::is_ready(self, executor_id)
    }
}

async fn load_integrations(
    executor: &dyn ExecutionRuntimeApi,
    info: &ExecutorInfo,
) -> ExecutorResult<Integrations> {
    let mut integrations = IndexMap::new();
    for integration in try_join_all(
        info.integration_ids
            .iter()
            .map(|id| executor.get_agent_integration(id, None)),
    )
    .await?
    {
        let id = &integration.descriptor.id;
        if integrations.contains_key(id) {
            return Err(format!("Duplicate agent integration ID: {id}").into());
        }
        validate_agent_integration(AgentIntegrationConformanceOptions {
            integration_id: id,
            api_version: AGENT_INTEGRATION_API_VERSION,
            integration: &integration,
        })?;
        if garcon_js::trim(&integration.descriptor.label).is_empty() {
            return Err(format!("Agent integration {id} has an empty label").into());
        }
        let mut keys = HashSet::new();
        for entry in &integration.descriptor.configuration {
            if garcon_js::trim(&entry.key).is_empty() {
                return Err(format!(
                    "Agent integration {id} has an invalid configuration descriptor"
                )
                .into());
            }
            if !keys.insert(&entry.key) {
                return Err(format!(
                    "Agent integration {id} declares configuration {} twice",
                    entry.key
                )
                .into());
            }
        }
        let defaults = integration.settings.defaults()?;
        if defaults.owner_id != *id || defaults.schema_version < 1 {
            return Err(format!("Agent integration {id} returned invalid default settings").into());
        }
        integrations.insert(id.clone(), integration);
    }
    Ok(Rc::new(integrations))
}

fn same_connector(left: &RemoteExecutorConfig, right: &RemoteExecutorConfig) -> bool {
    left.enabled == right.enabled
        && left.secret == right.secret
        && left.no_tls == right.no_tls
        && left.allow_unverified_tls == right.allow_unverified_tls
        && match (&left.connection, &right.connection) {
            (
                RemoteExecutorConnection::ExecutorConnects { .. },
                RemoteExecutorConnection::ExecutorConnects { .. },
            ) => true,
            (
                RemoteExecutorConnection::ControllerConnects { target_url: left },
                RemoteExecutorConnection::ControllerConnects { target_url: right },
            ) => left == right,
            _ => false,
        }
}

fn unavailable() -> DomainError {
    DomainError::new(
        ErrorCode::EXECUTOR_UNAVAILABLE,
        "Executor is unavailable",
        503,
        true,
    )
}

fn reference_unavailable() -> DomainError {
    DomainError::new(
        ErrorCode::EXECUTOR_IN_USE,
        "This executor is being changed. Try saving again after the change finishes.",
        409,
        true,
    )
}
