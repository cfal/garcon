//! The process services exposed on one authenticated executor session.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use base64::{Engine, engine::general_purpose::STANDARD};
use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome, AgentIntegrationErrorCode};
use garcon_interface::execution_runtime::{ExecutionRuntimeApi, ExecutorInfo};
use garcon_interface::execution_v5::{
    AgentExecutionHandle, AgentResumeRequestV5, AgentStartRequestV5,
};
use garcon_interface::files::{ExecutionFileEntry, ExecutionFileTarget};
use garcon_interface::producer::{AgentPermissionRespondRequest, AgentProducerBindRequest};
use garcon_interface::resources::{AgentProducerBinding, ExecutorCallOptions, ExecutorResult};
use garcon_js::{
    is_safe_integer,
    json::{Opaque, as_number},
};
use garcon_link::file_protocol::{decode_file_text, invalid_file_data, validate_file_rpc_request};
use garcon_link::git_protocol::is_git_rpc_method;
use garcon_link::message_session::SessionError;
use garcon_link::rpc::{ExecutorRpc, ObserveUndeliveredReply, RpcResult};
use garcon_link::rpc_lane::RpcLane;
use garcon_link::rpc_protocol::{ExecutorRpcRequest, RpcContinuity, rpc_continuity};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::history_rpc_server::HistoryRpcServer;
use crate::producer_relay::{LaunchRequest, ProducerRelay, ProducerRelaySession, RelayIntegration};
use crate::terminal_rpc_server::TerminalRpcServer;
use crate::worker::ExecutorApi;

pub(crate) struct ExecutorRpcServer {
    api: Rc<ExecutorApi>,
    primary: Weak<ExecutorRpc>,
    relay: Rc<ProducerRelay>,
    producer_session: ProducerRelaySession,
    terminals: Rc<TerminalRpcServer>,
    histories: RefCell<HashMap<String, Rc<HistoryRpcServer>>>,
    disposed: Cell<bool>,
    unsubscribe: RefCell<Vec<Box<dyn Fn()>>>,
}

impl ExecutorRpcServer {
    pub(crate) fn new(
        api: Rc<ExecutorApi>,
        primary: &Rc<ExecutorRpc>,
        relay: Rc<ProducerRelay>,
    ) -> Rc<Self> {
        let producer_session: ProducerRelaySession = Rc::new({
            let primary = Rc::downgrade(primary);
            move |payload| {
                primary
                    .upgrade()
                    .is_some_and(|primary| primary.offer_producer(payload))
            }
        });
        relay.shorten_suspended_grace();
        let server = Rc::new(Self {
            terminals: TerminalRpcServer::new(api.terminals(), primary),
            histories: RefCell::default(),
            api,
            primary: Rc::downgrade(primary),
            relay,
            producer_session,
            disposed: Cell::new(false),
            unsubscribe: RefCell::default(),
        });
        let off_failure = primary.transport.on_failure(Rc::new({
            let server = Rc::downgrade(&server);
            move |_| {
                if let Some(server) = server.upgrade() {
                    server.dispose();
                }
            }
        }));
        let off_availability = primary.transport.on_availability(Rc::new({
            let server = Rc::downgrade(&server);
            move |connected| {
                if !connected && let Some(server) = server.upgrade() {
                    server.disconnect_terminals();
                }
            }
        }));
        server.unsubscribe.borrow_mut().extend([
            Box::new(off_failure) as Box<dyn Fn()>,
            Box::new(off_availability),
        ]);
        primary.on_producer_ack(Rc::new({
            let server = Rc::downgrade(&server);
            move |acknowledgements| {
                if let Some(server) = server.upgrade() {
                    server
                        .relay
                        .acknowledge(&server.producer_session, acknowledgements);
                }
                Ok(())
            }
        }));
        primary.on_terminal_detach(Rc::new({
            let server = Rc::downgrade(&server);
            move |request| {
                let server = server.upgrade();
                Box::pin(async move {
                    if let Some(server) = server.filter(|server| !server.disposed.get()) {
                        server
                            .terminals
                            .handle("terminals.detach", &request)
                            .await?;
                    }
                    Ok(())
                })
            }
        }));
        server
    }

    pub(crate) fn install(self: &Rc<Self>, endpoint: &ExecutorRpc) -> Result<(), SessionError> {
        let history = if endpoint.transport.lane == RpcLane::Bulk {
            if self.disposed.get()
                || !self.primary.upgrade().is_some_and(|primary| {
                    endpoint.transport.primary_session_id == primary.transport.id
                })
            {
                return Err(not_dispatched(
                    "Bulk endpoint does not belong to this runtime generation",
                ));
            }
            let history = Rc::new(HistoryRpcServer::default());
            self.histories
                .borrow_mut()
                .insert(endpoint.transport.id.clone(), Rc::clone(&history));
            let _off = endpoint.transport.on_failure(Rc::new({
                let server = Rc::downgrade(self);
                let id = endpoint.transport.id.clone();
                move |_| {
                    if let Some(server) = server.upgrade() {
                        let history = server.histories.borrow_mut().remove(&id);
                        if let Some(history) = history {
                            history.dispose();
                        }
                    }
                }
            }));
            Some(history)
        } else {
            None
        };
        let server = Rc::clone(self);
        endpoint.handle(Rc::new(move |call, signal, _, observe| {
            let server = Rc::clone(&server);
            let history = history.clone();
            Box::pin(async move {
                server
                    .handle(&call, signal, history.as_ref(), observe)
                    .await
            })
        }));
        Ok(())
    }

    fn disconnect_terminals(&self) {
        self.terminals.disconnect();
        self.api.terminals().disconnect();
    }

    pub(crate) fn dispose(&self) {
        if self.disposed.replace(true) {
            return;
        }
        self.relay.suspend(&self.producer_session);
        for unsubscribe in self.unsubscribe.take() {
            unsubscribe();
        }
        self.disconnect_terminals();
        for (_, history) in self.histories.take() {
            history.dispose();
        }
        if let Some(primary) = self.primary.upgrade() {
            primary.retire_unknown();
        }
    }

    async fn handle(
        &self,
        call: &ExecutorRpcRequest,
        signal: CancellationToken,
        history: Option<&Rc<HistoryRpcServer>>,
        observe: ObserveUndeliveredReply,
    ) -> RpcResult {
        if signal.is_cancelled()
            || self.disposed.get() && rpc_continuity(&call.method) != RpcContinuity::Journaled
        {
            return Err(not_dispatched(
                "Worker session retired or request cancelled",
            ));
        }
        let method = call.method.as_str();
        let request = &call.request;
        match method {
            "executor.describe" => describe(self.api.info()),
            "controllerCli.describe" | "controllerCli.request" => {
                Err(rejected("CLI dispatch is controller-owned"))
            }
            "projects.inspect" => {
                let request =
                    decode(request).map_err(|_| rejected("Invalid project inspection request"))?;
                reply(self.api.projects().inspect(request, options(signal)).await)
            }
            "projects.ticketProjectDefault" => {
                if !call.integration_id.is_empty() {
                    return Err(rejected("Project operations are executor services"));
                }
                reply(
                    self.api
                        .projects
                        .ticket_project_default_raw(request, options(signal))
                        .await,
                )
            }
            "projects.resolveFileMentions" => {
                let request =
                    decode(request).map_err(|_| rejected("Invalid file mention request"))?;
                reply(
                    self.api
                        .projects()
                        .resolve_file_mentions(request, options(signal))
                        .await,
                )
            }
            "terminals.list"
            | "terminals.create"
            | "terminals.rename"
            | "terminals.terminate"
            | "terminals.attach"
            | "terminals.input"
            | "terminals.resize"
            | "terminals.detach" => {
                if !call.integration_id.is_empty() {
                    return Err(rejected("Terminals are executor services"));
                }
                self.terminals.handle(method, request).await
            }
            "history.open" | "history.next" | "history.close" => {
                let integration = self
                    .api
                    .get_agent_integration(&call.integration_id, options(signal.clone()))
                    .await
                    .map_err(|_| {
                        shared_error(AgentCallError::with_code(
                            AgentDeliveryOutcome::NotDispatched,
                            "Unknown integration",
                            AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
                        ))
                    })?;
                let history = history.ok_or_else(|| {
                    shared_error(AgentCallError::with_code(
                        AgentDeliveryOutcome::Rejected,
                        "Integration capability unavailable",
                        AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
                    ))
                })?;
                history
                    .handle(integration.as_ref().into(), call, signal)
                    .await
            }
            "producers.bind"
            | "producers.close"
            | "producers.resume"
            | "producers.cancelLaunch"
            | "execution.start"
            | "execution.resume"
            | "execution.abort"
            | "execution.runningSessions"
            | "compaction.compact"
            | "permissions.respond" => self.handle_producer(call, signal, observe).await,
            method if method.starts_with("files.") => {
                if !call.integration_id.is_empty() {
                    return Err(shared_error(invalid_file_data()));
                }
                validate_file_rpc_request(method, request).map_err(shared_error)?;
                self.handle_files(method, request, signal).await
            }
            method if is_git_rpc_method(method) && !call.integration_id.is_empty() => {
                Err(rejected("Git operations are executor services"))
            }
            method => Err(not_ported(method)),
        }
    }

    async fn handle_files(
        &self,
        method: &str,
        request: &Value,
        signal: CancellationToken,
    ) -> RpcResult {
        let files = self.api.files();
        let options = options(signal);
        let invalid = |_| shared_error(invalid_file_data());
        match method {
            "files.tree" => reply(files.tree(decode(request).map_err(invalid)?, options).await),
            "files.browse" => reply(
                files
                    .browse(decode(request).map_err(invalid)?, options)
                    .await,
            ),
            "files.list" => {
                #[derive(Serialize)]
                struct Listed {
                    files: Vec<ExecutionFileEntry>,
                    truncated: bool,
                }
                reply(
                    files
                        .list(decode(request).map_err(invalid)?, options)
                        .await
                        .map(|result| Listed {
                            files: result.files,
                            truncated: result.truncated,
                        }),
                )
            }
            "files.identity" => reply(
                files
                    .identity(decode(request).map_err(invalid)?, options)
                    .await,
            ),
            "files.revision" => reply(
                files
                    .revision(decode(request).map_err(invalid)?, options)
                    .await,
            ),
            "files.read" => {
                #[derive(Serialize)]
                struct Read {
                    path: String,
                    revision: String,
                    data: String,
                }
                reply(
                    files
                        .read(decode(request).map_err(invalid)?, options)
                        .await
                        .map(|result| Read {
                            path: result.path,
                            revision: result.revision,
                            data: STANDARD.encode(result.bytes),
                        }),
                )
            }
            "files.save" => {
                let target: ExecutionFileTarget = decode(request).map_err(invalid)?;
                let content = decode_file_text(&request["data"]).map_err(shared_error)?;
                let request = Value::Object(
                    [
                        ("content".to_owned(), Value::String(content)),
                        (
                            "expectedRevision".to_owned(),
                            request["expectedRevision"].clone(),
                        ),
                        (
                            "conflictResolution".to_owned(),
                            request["conflictResolution"].clone(),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                );
                reply(self.api.files.save_raw(target, request, options).await)
            }
            "files.createDirectory" => reply(
                files
                    .create_directory(decode(request).map_err(invalid)?, options)
                    .await,
            ),
            method => Err(not_ported(method)),
        }
    }
    async fn handle_producer(
        &self,
        call: &ExecutorRpcRequest,
        signal: CancellationToken,
        observe: ObserveUndeliveredReply,
    ) -> RpcResult {
        let method = call.method.as_str();
        let request = &call.request;
        let integration = self
            .api
            .get_agent_integration(&call.integration_id, options(signal.clone()))
            .await
            .map_err(|_| not_ported(method))?;
        let owner = RelayIntegration::from(integration.as_ref());
        let session = &self.producer_session;
        let invalid = |_| rejected("Invalid producer or execution request");
        match method {
            "producers.bind" => {
                let request: AgentProducerBindRequest = decode_opaque(request).map_err(invalid)?;
                let binding = request.binding.clone();
                integration
                    .producers
                    .bind(request, options(signal))
                    .await
                    .map_err(SessionError::from)?;
                if self.disposed.get() {
                    integration.producers.detach(binding);
                } else {
                    self.relay.track(&owner);
                    self.relay.bind(session, &owner, binding);
                }
                Ok(None)
            }
            "producers.close" => {
                let stale = || {
                    shared_error(AgentCallError::with_code(
                        AgentDeliveryOutcome::Rejected,
                        "Producer binding belongs to a retired session",
                        AgentIntegrationErrorCode::STALE_RESOURCE,
                    ))
                };
                let binding: AgentProducerBinding = decode_opaque(request).map_err(|_| stale())?;
                if !self.relay.owns(session, &owner, &binding)
                    && !self.relay.suspended(&owner, &binding)
                {
                    return Err(stale());
                }
                integration
                    .producers
                    .close(binding.clone(), options(signal))
                    .await
                    .map_err(SessionError::from)?;
                self.relay.close(&binding);
                Ok(None)
            }
            "producers.cancelLaunch" => {
                let (Some(binding), Some(run_id)) =
                    (request["binding"]["id"].as_str(), request["runId"].as_str())
                else {
                    return Err(rejected("Invalid launch cancellation request"));
                };
                self.relay.cancel_launch(&owner, binding, run_id);
                Ok(None)
            }
            "producers.resume" => {
                #[derive(Serialize)]
                struct Resumed {
                    resumed:
                        Vec<garcon_link::rpc_protocol::ProducerResumeState<AgentExecutionHandle>>,
                }
                reply(Ok(Resumed {
                    resumed: self
                        .relay
                        .resume(session, &owner, producer_resume_requests(request)?),
                }))
            }
            "execution.start" => {
                let request: AgentStartRequestV5 = decode_opaque(request).map_err(invalid)?;
                let producer_binding = request.context.producer_binding.clone();
                let run_id = request.context.run_id.clone();
                reply(
                    self.relay
                        .launch(
                            session,
                            &owner,
                            LaunchRequest {
                                producer_binding: &producer_binding,
                                run_id: &run_id,
                            },
                            signal,
                            observe,
                            |signal| integration.execution.start(request, options(signal)),
                        )
                        .await,
                )
            }
            "execution.resume" | "compaction.compact" => {
                let request: AgentResumeRequestV5 = decode_opaque(request).map_err(invalid)?;
                let producer_binding = request.context.producer_binding.clone();
                let run_id = request.context.run_id.clone();
                let launch = LaunchRequest {
                    producer_binding: &producer_binding,
                    run_id: &run_id,
                };
                if method == "compaction.compact" {
                    let compaction = integration.compaction.as_ref().ok_or_else(|| {
                        shared_error(AgentCallError::with_code(
                            AgentDeliveryOutcome::Rejected,
                            "Integration capability unavailable",
                            AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
                        ))
                    })?;
                    reply(
                        self.relay
                            .launch(session, &owner, launch, signal, observe, |signal| {
                                compaction.compact(request, options(signal))
                            })
                            .await,
                    )
                } else {
                    reply(
                        self.relay
                            .launch(session, &owner, launch, signal, observe, |signal| {
                                integration.execution.resume(request, options(signal))
                            })
                            .await,
                    )
                }
            }
            "execution.abort" => reply(
                integration
                    .execution
                    .abort(decode_opaque(request).map_err(invalid)?, options(signal))
                    .await,
            ),
            "execution.runningSessions" => reply(
                integration
                    .execution
                    .running_sessions(options(signal))
                    .await,
            ),
            "permissions.respond" => {
                let request: AgentPermissionRespondRequest =
                    decode_opaque(request).map_err(invalid)?;
                integration
                    .permissions
                    .respond(request, options(signal))
                    .await
                    .map_err(SessionError::from)?;
                Ok(None)
            }
            _ => Err(not_ported(method)),
        }
    }
}

fn producer_resume_requests(request: &Value) -> Result<Vec<(String, u64)>, SessionError> {
    let invalid = || rejected("Invalid producer resume request");
    let entries = request["bindings"].as_array().ok_or_else(invalid)?;
    let mut requests = Vec::new();
    for entry in entries {
        let binding = &entry["binding"];
        let present = match binding {
            Value::Null => false,
            Value::Bool(value) => *value,
            Value::Number(_) => as_number(binding).is_some_and(|number| number != 0.0),
            Value::String(value) => !value.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        };
        let seq = as_number(&entry["acknowledgedSeq"])
            .filter(|seq| is_safe_integer(*seq) && *seq >= 0.0)
            .filter(|_| present)
            .ok_or_else(invalid)?;
        if let Some(id) = binding["id"].as_str() {
            requests.push((id.to_owned(), seq as u64));
        }
    }
    Ok(requests)
}

fn decode<T: DeserializeOwned>(request: &Value) -> Result<T, serde_json::Error> {
    T::deserialize(request)
}

pub(crate) fn decode_opaque<T: DeserializeOwned>(request: &Opaque) -> Result<T, serde_json::Error> {
    // Opaque keeps JavaScript numbers as doubles; its wire form writes integral fields without ".0".
    garcon_js::json::from_slice(&serde_json::to_vec(request)?)
}

fn options(signal: CancellationToken) -> Option<ExecutorCallOptions> {
    Some(ExecutorCallOptions {
        signal: Some(signal),
        ..Default::default()
    })
}

pub(crate) fn reply<T: Serialize>(value: ExecutorResult<T>) -> RpcResult {
    let value = value.map_err(Rc::from)?;
    let bytes = serde_json::to_vec(&value).map_err(shared_error)?;
    Ok(Some(
        garcon_js::json::from_slice::<Opaque>(&bytes).map_err(shared_error)?,
    ))
}

pub(crate) fn shared_error(error: impl std::error::Error + 'static) -> SessionError {
    Rc::new(error)
}

pub(crate) fn not_dispatched(message: &str) -> SessionError {
    shared_error(AgentCallError::new(
        AgentDeliveryOutcome::NotDispatched,
        message,
    ))
}

fn rejected(message: &str) -> SessionError {
    shared_error(AgentCallError::new(AgentDeliveryOutcome::Rejected, message))
}

fn not_ported(method: &str) -> SessionError {
    shared_error(AgentCallError::with_code(
        AgentDeliveryOutcome::NotDispatched,
        format!("Executor method {method} is not ported yet"),
        AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
    ))
}

pub(crate) fn describe(info: &ExecutorInfo) -> RpcResult {
    #[derive(Serialize)]
    struct Describe<'a> {
        info: &'a ExecutorInfo,
        integrations: [(); 0],
    }
    reply(Ok(Describe {
        info,
        integrations: [],
    }))
}
