use std::{
    cell::Cell,
    rc::{Rc, Weak},
    time::Duration,
};

use garcon_base::domain_error::DomainError;
use garcon_contract::{
    agent_execution::AgentCredentialReference, error_codes::ErrorCode, executors::ExecutorError,
};
use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome},
    execution_runtime::ExecutorAvailability,
    host::AgentResolveCredentialRequest,
};
use garcon_link::{
    link_handshake::LinkRole,
    message_session::SessionError,
    rpc::{ExecutorRpc, GuardRpcReply, RpcResult},
    rpc_lane::RpcLane,
    rpc_protocol::ExecutorRpcRequest,
    session_transport::SessionTransport,
    websocket_link::{
        LinkClosureCause, WebSocketLink, WebSocketLinkOptions, should_log_link_failure,
    },
};
use serde::Deserialize;
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;

use crate::{
    executor_manager_ports::CreateRemoteExecutor,
    remote_client::{
        cli_dispatcher::CliDispatchAccess,
        wire::{decode, encode, own_rpc_error},
    },
    types::ExecutionOperationResult,
};

use super::{
    ExecutorManager, ManagedRemote, RemoteExecutorConnection, load_integrations, same_connector,
};

const LINK_FAILURE_NOTICE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone)]
struct RemoteEntry {
    manager: Weak<ExecutorManager>,
    entry: Weak<ManagedRemote>,
}

impl RemoteEntry {
    fn new(manager: &Rc<ExecutorManager>, entry: &Rc<ManagedRemote>) -> Self {
        Self {
            manager: Rc::downgrade(manager),
            entry: Rc::downgrade(entry),
        }
    }

    fn upgrade(&self) -> Option<(Rc<ExecutorManager>, Rc<ManagedRemote>)> {
        Some((self.manager.upgrade()?, self.entry.upgrade()?))
    }

    fn current(&self) -> Option<(Rc<ExecutorManager>, Rc<ManagedRemote>)> {
        self.upgrade()
            .filter(|(manager, entry)| manager.current(entry))
    }
}

impl ExecutorManager {
    pub(super) async fn apply_config(self: &Rc<Self>) -> ExecutionOperationResult<()> {
        let configs = self
            .config
            .list()
            .into_iter()
            .map(|mut config| {
                if !self.config.is_durable(&config.id) {
                    config.enabled = false;
                    config.allow_controller_cli = false;
                    config.allow_executor_management = false;
                }
                (config.id.clone(), config)
            })
            .collect::<indexmap::IndexMap<_, _>>();
        let previous = self.remotes.borrow().clone();
        for (id, entry) in &previous {
            if let Some(next) = configs
                .get(id)
                .filter(|next| same_connector(&entry.config.borrow(), next))
            {
                let old = entry.config.replace(next.clone());
                if next.allow_controller_cli != old.allow_controller_cli
                    || next.allow_executor_management != old.allow_executor_management
                {
                    entry.cli_lease.replace(Rc::default()).cancel();
                }
                continue;
            }
            entry.cli_lease.borrow().cancel();
            self.remotes.borrow_mut().shift_remove(id);
            let executor = entry.executor.borrow().clone();
            if let Some(executor) = executor {
                executor.dispose().await?;
            }
            self.publish_availability(id, ExecutorAvailability::Offline);
        }
        for (id, config) in configs {
            if self.entry(&id).is_some() {
                continue;
            }
            let enabled = config.enabled;
            let entry = Rc::new(ManagedRemote::new(config, previous.get(&id)));
            self.remotes.borrow_mut().insert(id.clone(), entry.clone());
            if !self.config.is_durable(&id) {
                record_error(
                    &entry,
                    "Executor configuration durability is unknown. Restart the controller.",
                );
            }
            if enabled {
                self.install_remote(&entry)?;
            }
        }
        Ok(())
    }

    fn install_remote(self: &Rc<Self>, entry: &Rc<ManagedRemote>) -> ExecutionOperationResult<()> {
        let config = entry.config.borrow().clone();
        let mut options = WebSocketLinkOptions::new(LinkRole::Controller, config.secret);
        options.executor_id = Some(config.id.clone());
        options.no_tls = config.no_tls;
        options.allow_unverified_tls = config.allow_unverified_tls;
        options.socket_admission = Some(self.socket_admission.clone());
        let link = WebSocketLink::new(options)?;
        entry.link.replace(Some(link.clone()));
        let captured = RemoteEntry::new(self, entry);
        observe_link(&link, &captured);

        let executor = self.remote_factory.create(CreateRemoteExecutor {
            executor_id: config.id,
            link: link.clone(),
            bind_reverse_requests: {
                let captured = captured.clone();
                Rc::new(move |rpc| bind_reverse_requests(&rpc, &captured))
            },
            report_setup_error: {
                let captured = captured.clone();
                Rc::new(move |message| {
                    if let Some((manager, entry)) = captured.current()
                        && record_error(&entry, message)
                    {
                        manager.changed();
                    }
                })
            },
            previous_inventory: entry.inventory.borrow().clone(),
            logger: self.logger.clone(),
        })?;
        entry.executor.replace(Some(executor.clone()));
        let _off_bulk = executor.on_bulk_changed({
            let captured = captured.clone();
            Rc::new(move |_| {
                if let Some((manager, _)) = captured.current() {
                    manager.changed();
                }
            })
        });
        let _off_availability = executor.on_availability_changed(Rc::new(move |availability| {
            let Some((manager, entry)) = captured.current() else {
                return;
            };
            if availability == ExecutorAvailability::Ready {
                let preparation = Rc::new(());
                entry.preparation.replace(Some(preparation.clone()));
                tokio::task::spawn_local(async move {
                    manager.prepare(entry, preparation).await;
                });
            } else {
                entry.preparation.take();
                manager.publish_availability(&entry.id, availability);
                manager.changed();
            }
        }));
        if let RemoteExecutorConnection::ControllerConnects { target_url } = config.connection {
            link.dial(&target_url).map_err(own_rpc_error)?;
        }
        Ok(())
    }

    async fn prepare(&self, entry: Rc<ManagedRemote>, preparation: Rc<()>) {
        let executor = entry.executor.borrow().clone();
        let Some(executor) = executor else {
            return;
        };
        let result: ExecutionOperationResult<_> = async {
            let info = executor.get_info(None).await?;
            let installed = entry.integrations.borrow().clone();
            let integrations = match installed {
                Some(integrations) => integrations,
                None => load_integrations(executor.as_ref(), &info).await?,
            };
            Ok((info, integrations))
        }
        .await;
        if !self.current(&entry)
            || !entry
                .preparation
                .borrow()
                .as_ref()
                .is_some_and(|current| Rc::ptr_eq(current, &preparation))
        {
            return;
        }
        match result {
            Ok((info, integrations)) if executor.availability() == ExecutorAvailability::Ready => {
                entry.info.replace(Some(info));
                entry.integrations.replace(Some(integrations.clone()));
                entry.known_integrations.replace(Some(integrations));
                entry.inventory.replace(executor.inventory());
                entry.error.take();
                entry.preparation.take();
                self.publish_availability(&entry.id, ExecutorAvailability::Ready);
                self.changed();
            }
            Ok(_) => {}
            Err(_) => {
                if record_error(&entry, "Executor inventory could not be initialized") {
                    self.changed();
                }
                let transport = entry.link.borrow().as_ref().and_then(|link| link.current());
                if let Some(transport) = transport {
                    transport.close(Some(Rc::new(std::io::Error::other(
                        "Executor inventory initialization failed",
                    ))));
                }
            }
        }
    }
}

fn observe_link(link: &WebSocketLink, captured: &RemoteEntry) {
    let show_failure = {
        let captured = captured.clone();
        let notify = throttled_notice(captured.clone());
        Rc::new(move |message: &str, reason: Option<&str>| {
            let Some((_, entry)) = captured.current() else {
                return;
            };
            let formatted;
            let message = match reason.filter(|reason| !reason.is_empty()) {
                Some(reason) => {
                    formatted = format!("{message}: {reason}");
                    &formatted
                }
                None => message,
            };
            if record_error(&entry, message) {
                notify();
            }
        })
    };
    let _off_error = link.on_error({
        let captured = captured.clone();
        let show_failure = show_failure.clone();
        Rc::new(move |failure| {
            let Some((manager, entry)) = captured.upgrade() else {
                return;
            };
            if should_log_link_failure(failure) {
                manager
                    .logger
                    .warn(&format!("Executor link failed: {} {failure:?}", entry.id));
            }
            // An unidentified handshake cannot explain the loss of an established primary.
            let availability = entry.remote_availability();
            let unclassified_offline = failure.lane.is_none()
                && availability == Some(ExecutorAvailability::Offline)
                && entry
                    .link
                    .borrow()
                    .as_ref()
                    .is_some_and(|link| link.current().is_none());
            if availability != Some(ExecutorAvailability::Ready)
                && (failure.lane == Some(RpcLane::Primary) || unclassified_offline)
            {
                show_failure(&failure.message, failure.reason.as_deref());
            }
        })
    });
    let captured = captured.clone();
    let _off_closure = link.on_closure(Rc::new(move |closure| {
        let Some((manager, entry)) = captured.upgrade() else {
            return;
        };
        let diagnostics = entry
            .executor
            .borrow()
            .as_ref()
            .and_then(|executor| executor.diagnostics());
        manager.logger.warn(&format!(
            "Executor link closed: {} {closure:?} {diagnostics:?}",
            entry.id
        ));
        if closure.lane == RpcLane::Bulk
            || closure.cause == LinkClosureCause::LocalClose
            || (closure.cause == LinkClosureCause::SessionRetired && entry.error.borrow().is_some())
        {
            return;
        }
        show_failure("Executor connection lost", closure.reason.as_deref());
    }));
}

fn record_error(entry: &ManagedRemote, message: &str) -> bool {
    if entry
        .error
        .borrow()
        .as_ref()
        .is_some_and(|error| error.message == message)
    {
        return false;
    }
    entry.error.replace(Some(ExecutorError {
        code: ErrorCode::EXECUTOR_UNAVAILABLE.as_str().into(),
        message: message.into(),
    }));
    true
}

fn throttled_notice(captured: RemoteEntry) -> impl Fn() {
    let last_notice = Rc::new(Cell::new(None::<Instant>));
    let pending = Rc::new(Cell::new(false));
    move || {
        if pending.get() {
            return;
        }
        let now = Instant::now();
        if let Some(due) = last_notice
            .get()
            .map(|last| last + LINK_FAILURE_NOTICE_INTERVAL)
            .filter(|due| *due > now)
        {
            pending.set(true);
            let (captured, pending, last_notice) =
                (captured.clone(), pending.clone(), last_notice.clone());
            tokio::task::spawn_local(async move {
                sleep_until(due).await;
                pending.set(false);
                last_notice.set(Some(Instant::now()));
                if let Some((manager, _)) = captured.current() {
                    manager.changed();
                }
            });
        } else {
            last_notice.set(Some(now));
            if let Some((manager, _)) = captured.current() {
                manager.changed();
            }
        }
    }
}

fn bind_reverse_requests(rpc: &Rc<ExecutorRpc>, captured: &RemoteEntry) {
    let rpc_weak = Rc::downgrade(rpc);
    let captured = captured.clone();
    rpc.handle(Rc::new(
        move |call, signal, guard_reply, _observe_undelivered| {
            let rpc = rpc_weak.upgrade();
            let captured = captured.clone();
            Box::pin(async move {
                if matches!(
                    call.method.as_str(),
                    "controllerCli.describe" | "controllerCli.request"
                ) {
                    let rpc = rpc.ok_or_else(|| shared_domain(cli_unavailable()))?;
                    return dispatch_cli(&captured, &rpc, &call, signal, &guard_reply).await;
                }
                let (manager, entry) = captured.current().ok_or_else(credential_denied)?;
                if call.method != "credentials.resolve"
                    || !manager
                        .local_integrations
                        .contains_key(&call.integration_id)
                {
                    return Err(credential_denied());
                }
                #[derive(Deserialize)]
                struct CredentialRequest {
                    reference: AgentCredentialReference,
                }
                let CredentialRequest { reference } =
                    decode(Some(&call.request)).map_err(SessionError::from)?;
                let resolved = (manager.resolve_credential)(
                    entry.id.clone(),
                    call.integration_id.clone(),
                    AgentResolveCredentialRequest { reference, signal },
                )
                .await
                .map_err(SessionError::from)?;
                encode(resolved).map(Some).map_err(SessionError::from)
            })
        },
    ));
}

async fn dispatch_cli(
    captured: &RemoteEntry,
    rpc: &ExecutorRpc,
    call: &ExecutorRpcRequest,
    signal: CancellationToken,
    guard_reply: &GuardRpcReply,
) -> RpcResult {
    let (manager, entry) = captured
        .current()
        .ok_or_else(|| shared_domain(cli_unavailable()))?;
    let lease = entry.cli_lease.borrow().clone();
    let assert_current = {
        let (captured, transport, lease) = (captured.clone(), rpc.transport.clone(), lease.clone());
        let has_integration = !call.integration_id.is_empty();
        Rc::new(move || assert_cli_current(&captured, &transport, &lease, has_integration))
    };
    assert_current().map_err(shared_domain)?;
    let dispatcher = manager.cli_dispatcher.borrow().clone().ok_or_else(|| {
        shared_domain(DomainError::new(
            ErrorCode::CLI_CONTROLLER_UNAVAILABLE,
            "Controller CLI is initializing",
            503,
            true,
        ))
    })?;
    let assert_management = {
        let captured = captured.clone();
        let assert_current = assert_current.clone();
        Rc::new(move || {
            assert_current()?;
            if captured
                .current()
                .is_some_and(|(_, entry)| entry.config.borrow().allow_executor_management)
            {
                return Ok(());
            }
            Err(DomainError::new(
                ErrorCode::CLI_ACCESS_DENIED,
                "Executor management is not enabled for this executor",
                403,
                false,
            ))
        })
    };
    let combined = lease.child_token();
    if signal.is_cancelled() {
        combined.cancel();
    }
    let access =
        CliDispatchAccess::from_rpc(rpc, combined.clone(), assert_current, assert_management);
    if call.method == "controllerCli.describe" {
        if !call.request.as_value().is_null() {
            return Err(shared_domain(DomainError::new(
                ErrorCode::VALIDATION_FAILED,
                "Invalid CLI context request",
                400,
                false,
            )));
        }
        let context = dispatcher
            .describe(&access, guard_reply)
            .map_err(shared_domain)?;
        return encode(context).map(Some).map_err(SessionError::from);
    }
    let mut request =
        std::pin::pin!(dispatcher.request(call.request.as_value(), &access, guard_reply));
    let reply = tokio::select! {
        biased;
        () = signal.cancelled() => { combined.cancel(); request.await }
        result = &mut request => result,
    }
    .map_err(SessionError::from)?;
    encode(reply).map(Some).map_err(SessionError::from)
}

fn assert_cli_current(
    captured: &RemoteEntry,
    transport: &Rc<SessionTransport>,
    lease: &Rc<CancellationToken>,
    has_integration: bool,
) -> Result<(), DomainError> {
    let (manager, entry) = captured.current().ok_or_else(cli_unavailable)?;
    let link = entry.link.borrow().clone().ok_or_else(cli_unavailable)?;
    let primary = link.current();
    let lane = if transport.lane == RpcLane::Primary {
        primary.clone()
    } else {
        link.bulk()
    };
    if manager.quiescing.get()
        || !lane.is_some_and(|lane| Rc::ptr_eq(&lane, transport))
        || !primary.is_some_and(|primary| primary.id == transport.primary_session_id)
        || !manager.is_ready(&entry.id)
    {
        return Err(cli_unavailable());
    }
    if has_integration
        || !entry.config.borrow().allow_controller_cli
        || lease.is_cancelled()
        || !Rc::ptr_eq(&entry.cli_lease.borrow(), lease)
    {
        return Err(DomainError::new(
            ErrorCode::CLI_ACCESS_DENIED,
            "Workspace CLI access is not enabled for this executor",
            403,
            false,
        ));
    }
    Ok(())
}

fn credential_denied() -> SessionError {
    Rc::new(AgentCallError::new(
        AgentDeliveryOutcome::Rejected,
        "Operation is not permitted on the controller",
    ))
}

fn shared_domain(error: DomainError) -> SessionError {
    Rc::new(error)
}

fn cli_unavailable() -> DomainError {
    DomainError::new(
        ErrorCode::CLI_CONTROLLER_UNAVAILABLE,
        "Controller CLI connection is unavailable",
        503,
        true,
    )
}
