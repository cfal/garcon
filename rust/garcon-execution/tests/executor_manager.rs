use std::{
    cell::{Cell, RefCell},
    io::Write,
    rc::Rc,
};

use async_trait::async_trait;
use garcon_base::{
    domain_error::{DomainError, as_domain_error},
    event_loop_stalls::ActivityTracker,
    log::create_logger,
};
use garcon_cases::{CaseError, replay, text};
use garcon_contract::{
    api_providers::ApiProviderModelDiscoveryResponse,
    error_codes::ErrorCode,
    executors::{
        AgentExecutionTarget, ExecutorBulkAvailability, ExecutorBulkStatus,
        ExecutorSnapshotAvailability,
    },
};
use garcon_execution::{
    directory::ExecutionIntegrationDirectory,
    executor_manager::{ExecutorConfigGuards, ExecutorManager, ExecutorManagerOptions},
    executor_manager_ports::{
        CreateRemoteExecutor, ManagedRemoteExecutor, RemoteBulkListener, RemoteExecutorFactory,
        RemoteExecutorInventory,
    },
    remote_client::cli_dispatcher::{
        CliRouteResponse, ControllerCliDispatcher, ControllerCliRoutes, DelegatedCliContext,
    },
};
use garcon_interface::{
    execution_runtime::{
        ApiProviderDiscoveryRequest, ExecutionProjectService, ExecutionRuntimeApi,
        ExecutorAvailability, ExecutorInfo, ExecutorServices,
    },
    files::ExecutionFilesService,
    git::{ExecutionGhService, ExecutionGitService},
    integration::AgentIntegration,
    resources::{ExecutorCallOptions, ExecutorResult},
    terminals::ExecutionTerminalService,
};
use garcon_js::json::Opaque;
use garcon_link::{
    cli_protocol::CliHttpRequest,
    link_handshake::LinkRole,
    rpc::{ExecutorRpc, ExecutorRpcContinuity, RpcCallOptions},
    rpc_connection::RpcConnectionDiagnostics,
    websocket_link::{WebSocketLink, WebSocketLinkOptions},
};
use garcon_stores::executors::config_store::ExecutorConfigStore;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::{
    sync::oneshot,
    task::{LocalSet, yield_now},
};

const ID: &str = "11111111-1111-4111-8111-111111111111";
const SECRET: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
type AvailabilityListener = Rc<dyn Fn(ExecutorAvailability)>;

#[path = "executor_manager/availability.rs"]
mod availability;

struct Runtime {
    id: String,
    info: RefCell<ExecutorInfo>,
    availability: Cell<ExecutorAvailability>,
    listener: RefCell<Option<AvailabilityListener>>,
    hold_info: RefCell<Option<oneshot::Receiver<()>>>,
    rpc: RefCell<Option<Rc<ExecutorRpc>>>,
    link: Option<Rc<WebSocketLink>>,
}

impl Runtime {
    fn new(id: &str, availability: ExecutorAvailability) -> Self {
        Self {
            id: id.into(),
            info: RefCell::new(ExecutorInfo {
                executor_id: id.into(),
                instance_id: "synthetic-instance".into(),
                project_base_path: "/synthetic".into(),
                integration_ids: Vec::new(),
                services: ExecutorServices {
                    files: false,
                    git: false,
                    gh: false,
                    terminals: false,
                    directory_creation: id == "local",
                },
            }),
            availability: Cell::new(availability),
            listener: RefCell::default(),
            hold_info: RefCell::default(),
            rpc: RefCell::default(),
            link: None,
        }
    }

    fn set_availability(&self, availability: ExecutorAvailability) {
        self.availability.set(availability);
        let listener = self.listener.borrow().clone();
        if let Some(listener) = listener {
            listener(availability);
        }
    }
}

#[async_trait(?Send)]
impl ExecutionRuntimeApi for Runtime {
    fn id(&self) -> &str {
        &self.id
    }
    fn availability(&self) -> ExecutorAvailability {
        self.availability.get()
    }
    async fn get_info(&self, _: Option<ExecutorCallOptions>) -> ExecutorResult<ExecutorInfo> {
        let hold = self.hold_info.take();
        if let Some(hold) = hold {
            hold.await?;
        }
        Ok(self.info.borrow().clone())
    }
    async fn get_agent_integration(
        &self,
        _: &str,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<AgentIntegration>> {
        Err("unexpected integration request".into())
    }
    async fn get_project_service(
        &self,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionProjectService>> {
        Err("unexpected project service request".into())
    }
    async fn discover_api_provider_models(
        &self,
        _: ApiProviderDiscoveryRequest,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ApiProviderModelDiscoveryResponse> {
        Err("unexpected discovery request".into())
    }
    async fn get_files_service(
        &self,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionFilesService>> {
        Err("unexpected files service request".into())
    }
    async fn get_git_service(
        &self,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionGitService>> {
        Err("unexpected Git service request".into())
    }
    async fn get_gh_service(
        &self,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionGhService>> {
        Err("unexpected GH service request".into())
    }
    async fn get_terminal_service(
        &self,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionTerminalService>> {
        Err("unexpected terminal service request".into())
    }
    fn on_availability_changed(&self, listener: AvailabilityListener) -> Box<dyn Fn()> {
        self.listener.replace(Some(listener));
        Box::new(|| ())
    }
    async fn dispose(&self) -> ExecutorResult<()> {
        self.set_availability(ExecutorAvailability::Disposed);
        if let Some(link) = &self.link {
            link.dispose().await;
        }
        Ok(())
    }
}

impl ManagedRemoteExecutor for Runtime {
    fn inventory(&self) -> Option<RemoteExecutorInventory> {
        Some(RemoteExecutorInventory {
            integrations: Vec::new(),
        })
    }
    fn bulk_status(&self) -> ExecutorBulkStatus {
        ExecutorBulkStatus {
            availability: ExecutorBulkAvailability::Offline,
            last_error: None,
        }
    }
    fn on_bulk_changed(&self, _: RemoteBulkListener) -> Box<dyn Fn()> {
        Box::new(|| ())
    }
    fn diagnostics(&self) -> Option<RpcConnectionDiagnostics> {
        None
    }
}

#[derive(Default)]
struct Factory(RefCell<Option<Rc<Runtime>>>);

impl RemoteExecutorFactory for Factory {
    fn create(
        &self,
        options: CreateRemoteExecutor,
    ) -> ExecutorResult<Rc<dyn ManagedRemoteExecutor>> {
        let runtime = Rc::new(Runtime {
            link: Some(options.link.clone()),
            ..Runtime::new(&options.executor_id, ExecutorAvailability::Offline)
        });
        let weak = Rc::downgrade(&runtime);
        let _off = options
            .link
            .on_session(Rc::new(move |transport| {
                if let Some(runtime) = weak.upgrade() {
                    let rpc = ExecutorRpc::new(transport, ExecutorRpcContinuity::default());
                    (options.bind_reverse_requests)(rpc.clone());
                    runtime.rpc.replace(Some(rpc));
                    runtime.set_availability(ExecutorAvailability::Ready);
                }
                Ok(())
            }))
            .map_err(|error| error.to_string())?;
        self.0.replace(Some(runtime.clone()));
        Ok(runtime)
    }
}

async fn fixture() -> (TempDir, Rc<ExecutorManager>, Rc<Runtime>) {
    let root = tempfile::tempdir().unwrap();
    let snapshot = json!({"version":1,"executors":[{
        "id":ID,"label":"Synthetic worker","enabled":true,
        "secret":SECRET,"noTls":true,
        "connection":{"kind":"executor-connects","advertisedUrl":null},
    }]});
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(root.path().join("executors.json"))
        .unwrap()
        .write_all(snapshot.to_string().as_bytes())
        .unwrap();
    let config = ExecutorConfigStore::open(root.path().to_str().unwrap())
        .await
        .unwrap();
    let factory = Rc::new(Factory::default());
    let manager = ExecutorManager::start(ExecutorManagerOptions {
        local: Rc::new(Runtime::new("local", ExecutorAvailability::Ready)),
        config,
        remote_factory: factory.clone(),
        resolve_credential: Rc::new(|_, _, _| Box::pin(async { Ok(None) })),
        logger: Rc::new(create_logger("executor-manager-test")),
    })
    .await
    .unwrap();
    let remote = factory.0.take().unwrap();
    (root, manager, remote)
}

fn domain_result<T>(result: ExecutorResult<T>) -> Value {
    if let Err(error) = result {
        let error = as_domain_error(error.as_ref()).unwrap();
        json!({ "code": error.code.as_str(), "message": error.message, "status": error.status, "retryable": error.retryable })
    } else {
        Value::Null
    }
}

async fn trace(scenario: &str) -> Value {
    let (_root, manager, _remote) = fixture().await;
    if scenario == "wire" {
        let bytes = serde_json::to_string(&manager.list_wire()).unwrap();
        manager.dispose().await.unwrap();
        return Value::String(bytes);
    }
    let effects = Rc::new(RefCell::new(Vec::<Value>::new()));
    let off = manager.on_changed(Rc::new({
        let effects = effects.clone();
        move || effects.borrow_mut().push(json!("changed"))
    }));
    let off_availability = manager.on_availability_changed(Rc::new({
        let effects = effects.clone();
        move |_, availability| effects.borrow_mut().push(json!(availability))
    }));
    let initial_link = manager.inbound_link(ID).unwrap();
    let retain = manager.retain_references();
    let error;
    match scenario {
        "offline" => error = domain_result(manager.require_executor(ID).map_err(Into::into)),
        "retain" => {
            let release = retain(&[Some(ID)], &[]).unwrap();
            error = domain_result(manager.remove(ID.into(), None).await);
            release();
            manager.remove(ID.into(), None).await.unwrap();
        }
        "disruptive" | "grants" => {
            manager.set_guards(ExecutorConfigGuards {
                assert_idle: Rc::new({
                    let effects = effects.clone();
                    move |_| {
                        effects.borrow_mut().push(json!("idle"));
                        Err(DomainError::new(
                            ErrorCode::EXECUTOR_IN_USE,
                            "Synthetic active work",
                            409,
                            false,
                        )
                        .into())
                    }
                }),
                ..ExecutorConfigGuards::default()
            });
            let request = if scenario == "disruptive" {
                json!({"enabled":false})
            } else {
                json!({"allowControllerCli":true,"allowExecutorManagement":true})
            };
            error = domain_result(manager.update(ID.into(), request, None).await);
        }
        "quiesced" | "disposed" => {
            if scenario == "quiesced" {
                manager.quiesce();
            } else {
                manager.dispose().await.unwrap();
            }
            error = domain_result(retain(&[Some(ID)], &[]));
            retain(&[], &[Some(ID)]).unwrap()();
            let result = domain_result(manager.remove(ID.into(), None).await);
            effects.borrow_mut().push(result["code"].clone());
        }
        "deleted" => {
            manager.remove(ID.into(), None).await.unwrap();
            error = domain_result(retain(&[Some(ID)], &[]));
        }
        "changing" => {
            let result = Rc::new(RefCell::new(Value::Null));
            manager.set_guards(ExecutorConfigGuards {
                assert_removable: Rc::new({
                    let result = result.clone();
                    move |id| {
                        result.replace(domain_result(retain(&[Some(id)], &[])));
                        Ok(())
                    }
                }),
                ..ExecutorConfigGuards::default()
            });
            manager.remove(ID.into(), None).await.unwrap();
            error = result.take();
        }
        "revoked" => {
            let first = manager.update(ID.into(), json!({"label":"Renamed"}), None);
            error = domain_result(
                manager
                    .remove(
                        ID.into(),
                        Some(Rc::new({
                            let (effects, config) = (effects.clone(), manager.config.clone());
                            move || {
                                effects
                                    .borrow_mut()
                                    .push(json!(config.require(ID).unwrap().label));
                                Err(DomainError::new(
                                    ErrorCode::CLI_ACCESS_DENIED,
                                    "Synthetic grant revoked",
                                    403,
                                    false,
                                ))
                            }
                        })),
                    )
                    .await,
            );
            first.await.unwrap();
        }
        _ => panic!("unknown manager trace: {scenario}"),
    }
    let snapshots: Vec<_> = manager.list().into_iter().map(|entry| json!({
        "id":entry.id, "label":entry.label, "availability":entry.availability, "enabled":entry.enabled,
        "allowControllerCli":entry.allow_controller_cli, "allowExecutorManagement":entry.allow_executor_management,
    })).collect();
    let result = json!({"snapshots":snapshots,"error":error,"effects":effects.take(),"localReady":manager.is_ready("local"),
        "reconnecting":manager.is_reconnecting(ID),"known":manager.known_integration(&AgentExecutionTarget {agent_id:"test".into(),executor_id:ID.into()}).is_some(),
        "retainedLink":manager.inbound_link(ID).is_some_and(|link| Rc::ptr_eq(&link,&initial_link)),
    });
    off();
    off_availability();
    manager.dispose().await.unwrap();
    result
}

#[test]
fn executor_manager_matches_recorded_bun_traces() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = LocalSet::new();
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/executor-manager"),
        |function, args| {
            if function != "executorManagerTrace" {
                return Err(CaseError::unhandled(function));
            }
            let scenario = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("missing scenario"))?;
            Ok(local.block_on(&runtime, trace(scenario)))
        },
    );
}

#[tokio::test]
async fn manager_readiness_waits_for_replacement_metadata_publication() {
    LocalSet::new()
        .run_until(async {
            let (_root, manager, remote) = fixture().await;
            assert!(!manager.is_ready(ID));
            assert!(manager.require_executor(ID).is_err());
            remote.set_availability(ExecutorAvailability::Ready);
            yield_now().await;
            assert!(manager.is_ready(ID));
            let original = manager.require_executor(ID).unwrap();
            remote.set_availability(ExecutorAvailability::Reconnecting);
            assert!(manager.is_reconnecting(ID));
            assert!(!manager.is_ready(ID));
            assert!(manager.ready_instance_id(ID).is_err());
            assert!(Rc::ptr_eq(
                &manager.require_executor(ID).unwrap(),
                &original
            ));
            let (release, hold) = oneshot::channel();
            remote.hold_info.replace(Some(hold));
            remote.info.borrow_mut().project_base_path = "/replacement".into();
            remote.set_availability(ExecutorAvailability::Ready);
            yield_now().await;
            assert!(!manager.is_ready(ID));
            assert!(!manager.is_reconnecting(ID));
            let pending = &manager.list()[1];
            assert_eq!(
                pending.availability,
                ExecutorSnapshotAvailability::Reconnecting
            );
            assert_eq!(pending.project_base_path.as_deref(), Some("/synthetic"));
            assert!(Rc::ptr_eq(
                &manager.require_executor(ID).unwrap(),
                &original
            ));
            release.send(()).unwrap();
            yield_now().await;
            assert!(manager.is_ready(ID));
            assert_eq!(
                manager.list()[1].project_base_path.as_deref(),
                Some("/replacement")
            );
            manager.dispose().await.unwrap();
            assert!(!manager.is_reconnecting(ID));
        })
        .await;
}

#[tokio::test]
async fn dropping_the_mutation_waiter_does_not_drop_reconciliation() {
    LocalSet::new()
        .run_until(async {
            let (_root, manager, _remote) = fixture().await;
            drop(manager.remove(ID.into(), None));
            let follow = manager.remove(ID.into(), None).await;
            assert_eq!(domain_result(follow)["code"], "EXECUTOR_NOT_FOUND");
            assert_eq!(manager.list().len(), 1);
            manager.dispose().await.unwrap();
        })
        .await;
}

struct NoRoutes;

#[async_trait(?Send)]
impl ControllerCliRoutes for NoRoutes {
    async fn invoke(&self, _: CliHttpRequest, _: DelegatedCliContext) -> Option<CliRouteResponse> {
        None
    }
}

#[tokio::test]
async fn reverse_cli_dispatch_checks_initialization_grant_revocation_and_quiescence_on_the_live_link()
 {
    LocalSet::new()
        .run_until(tokio::time::timeout(
            std::time::Duration::from_secs(15),
            async {
                let (_root, manager, _remote) = fixture().await;
                let controller = manager.inbound_link(ID).unwrap();
                let address = controller.listen(0, "0.0.0.0", None).await.unwrap();
                let mut options = WebSocketLinkOptions::new(LinkRole::Worker, SECRET.into());
                options.no_tls = true;
                let worker = WebSocketLink::new(options).unwrap();
                let (publish, await_rpc) = oneshot::channel();
                let publish = Cell::new(Some(publish));
                let _off = worker
                    .on_session(Rc::new(move |transport| {
                        if let Some(publish) = publish.take() {
                            let _ = publish.send(ExecutorRpc::new(
                                transport,
                                ExecutorRpcContinuity::default(),
                            ));
                        }
                        Ok(())
                    }))
                    .unwrap();
                let ready = Rc::new(tokio::sync::Notify::new());
                let off_ready = manager.on_availability_changed(Rc::new({
                    let ready = ready.clone();
                    move |id, state| {
                        if id == ID && state == ExecutorAvailability::Ready {
                            ready.notify_one();
                        }
                    }
                }));
                worker.dial(&address).unwrap();
                let rpc = await_rpc.await.unwrap();
                ready.notified().await;
                off_ready();
                let describe = || {
                    rpc.call(
                        "",
                        "controllerCli.describe",
                        Opaque::from_value(Value::Null),
                        RpcCallOptions::default(),
                    )
                };
                let error_code = |error: garcon_link::message_session::SessionError| {
                    as_domain_error(error.as_ref()).unwrap().code
                };
                assert_eq!(
                    describe().await.map_err(error_code).unwrap_err(),
                    ErrorCode::CLI_ACCESS_DENIED
                );
                manager
                    .update(ID.into(), json!({"allowControllerCli":true}), None)
                    .await
                    .unwrap();
                let initializing = describe().await.unwrap_err();
                assert_eq!(initializing.to_string(), "Controller CLI is initializing");
                assert_eq!(
                    error_code(initializing),
                    ErrorCode::CLI_CONTROLLER_UNAVAILABLE
                );
                manager.set_cli_dispatcher(Rc::new(ControllerCliDispatcher::new(
                    Rc::new(NoRoutes),
                    "synthetic-controller".into(),
                    None,
                    Rc::new(|| false),
                    Rc::new(ActivityTracker::default()),
                )));
                let context = describe().await.unwrap().unwrap();
                assert_eq!(context.as_value()["defaultExecutorId"], ID);
                assert_eq!(
                    context.as_value()["serverInstanceId"],
                    "synthetic-controller"
                );
                manager
                    .update(ID.into(), json!({"allowControllerCli":false}), None)
                    .await
                    .unwrap();
                assert_eq!(
                    describe().await.map_err(error_code).unwrap_err(),
                    ErrorCode::CLI_ACCESS_DENIED
                );
                manager
                    .update(ID.into(), json!({"allowControllerCli":true}), None)
                    .await
                    .unwrap();
                manager.quiesce();
                assert_eq!(
                    describe().await.map_err(error_code).unwrap_err(),
                    ErrorCode::CLI_CONTROLLER_UNAVAILABLE
                );
                assert!(manager.inbound_link(ID).is_none());
                manager.dispose().await.unwrap();
                worker.dispose().await;
            },
        ))
        .await
        .unwrap();
}
