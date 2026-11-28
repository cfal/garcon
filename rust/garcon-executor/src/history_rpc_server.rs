//! Ports `server/remote/server/history-rpc-server.ts`.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::pin::pin;
use std::rc::Rc;
use std::time::Duration;

use futures::StreamExt;
use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome, AgentIntegrationErrorCode};
use garcon_interface::execution_v5::AgentExecutionV5;
use garcon_interface::integration::AgentIntegration;
use garcon_interface::native_history::{
    AgentHistoryImport, AgentHistoryImportRequest, AgentImportedTranscriptRow,
};
use garcon_interface::resources::{
    AgentResourceRef, AgentResourceScope, ExecutorCallOptions, create_agent_resource_ref,
    is_agent_resource_ref,
};
use garcon_js::json::{Opaque, as_number};
use garcon_link::history_pages::history_pages;
use garcon_link::message_session::SessionError;
use garcon_link::rpc::RpcResult;
use garcon_link::rpc_protocol::ExecutorRpcRequest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::executor_rpc_server::{decode_opaque, reply, shared_error};

const KIND: &str = "history-reader";
const MAX_READERS: usize = 16;
const READER_IDLE: Duration = Duration::from_secs(120);

pub(crate) struct HistoryIntegration<'a> {
    scope: &'a AgentResourceScope,
    execution: &'a dyn AgentExecutionV5,
    legacy: Option<Rc<dyn AgentHistoryImport>>,
    native: Option<Rc<dyn AgentHistoryImport>>,
}

impl<'a> From<&'a AgentIntegration> for HistoryIntegration<'a> {
    fn from(integration: &'a AgentIntegration) -> Self {
        Self {
            scope: integration.producers.scope(),
            execution: integration.execution.as_ref(),
            legacy: integration.legacy_history_import.clone(),
            native: integration.native_history_import.clone(),
        }
    }
}

#[derive(Default)]
pub(crate) struct HistoryRpcServer {
    readers: RefCell<HashMap<String, HashMap<String, Rc<Reader>>>>,
    closed: CancellationToken,
}

#[derive(Serialize)]
struct Page {
    done: bool,
    rows: Vec<AgentImportedTranscriptRow>,
}

type PageResponse = oneshot::Sender<Result<Page, SessionError>>;

struct Reader {
    requests: mpsc::UnboundedSender<PageResponse>,
    stop: CancellationToken,
    finished: CancellationToken,
    requested: Cell<u64>,
    deadline: Cell<Instant>,
    refreshed: Notify,
}

#[derive(Deserialize)]
struct Open {
    request: AgentHistoryImportRequest,
}

impl HistoryRpcServer {
    pub(crate) async fn handle(
        self: &Rc<Self>,
        integration: HistoryIntegration<'_>,
        call: &ExecutorRpcRequest,
        signal: CancellationToken,
    ) -> RpcResult {
        self.assert_open(&signal)?;
        match call.method.as_str() {
            "history.open" => {
                let reference = self.open(integration, &call.request, &signal).await?;
                reply(Ok(reference))
            }
            "history.next" => {
                let row = self.next(integration.scope, &call.request, &signal).await?;
                reply(Ok(row))
            }
            "history.close" => {
                let reader = self.get(integration.scope, &call.request)?;
                self.retire(
                    integration.scope,
                    call.request["id"].as_str().unwrap_or_default(),
                );
                reader.finished.cancelled().await;
                Ok(None)
            }
            _ => Err(rejected("Unknown history method")),
        }
    }

    async fn open(
        self: &Rc<Self>,
        integration: HistoryIntegration<'_>,
        input: &Opaque,
        signal: &CancellationToken,
    ) -> Result<AgentResourceRef<&'static str>, SessionError> {
        let native = match input["source"].as_str() {
            Some("nativeHistoryImport") => true,
            Some("legacyHistoryImport") => false,
            _ => return Err(rejected("Unknown history source")),
        };
        let Open { request } =
            decode_opaque(input).map_err(|_| rejected("Invalid history open request"))?;
        if native {
            let running = integration
                .execution
                .running_sessions(Some(ExecutorCallOptions {
                    signal: Some(signal.clone()),
                    ..Default::default()
                }))
                .await
                .map_err(SessionError::from)?;
            self.assert_open(signal)?;
            if running.iter().any(|session| {
                Some(&session.agent_session_id) == request.chat.agent_session_id.as_ref()
            }) {
                return Err(shared_error(AgentCallError::with_code(
                    AgentDeliveryOutcome::Rejected,
                    "The turn is still running on the executor. Reload from native history after it finishes.",
                    AgentIntegrationErrorCode::SESSION_BUSY,
                )));
            }
        }
        let source = if native {
            integration.native
        } else {
            integration.legacy
        }
        .ok_or_else(|| {
            shared_error(AgentCallError::with_code(
                AgentDeliveryOutcome::Rejected,
                "History capability unavailable",
                AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
            ))
        })?;
        let (reader, ready) = Reader::start(source, request, self.closed.clone(), signal.clone());
        if ready.await.is_err() {
            reader.stop.cancel();
            return Err(stale());
        }
        let reference = create_agent_resource_ref(integration.scope.clone(), KIND, || {
            Uuid::new_v4().to_string()
        });
        let registered = self.assert_open(signal).and_then(|()| {
            let mut readers = self.readers.borrow_mut();
            let table = readers
                .entry(integration.scope.integration_id.clone())
                .or_default();
            if table.contains_key(&reference.id) {
                return Err(stale_scope("Resource is already bound"));
            }
            if table.len() >= MAX_READERS {
                return Err(rejected("Resource budget exhausted"));
            }
            table.insert(reference.id.clone(), Rc::clone(&reader));
            Ok(())
        });
        if let Err(error) = registered {
            reader.stop.cancel();
            reader.finished.cancelled().await;
            return Err(error);
        }
        reader.refresh();
        tokio::task::spawn_local({
            let server = Rc::downgrade(self);
            let scope = integration.scope.clone();
            let id = reference.id.clone();
            async move {
                if reader.expired().await
                    && let Some(server) = server.upgrade()
                {
                    server.retire(&scope, &id);
                }
            }
        });
        Ok(reference)
    }

    async fn next(
        &self,
        scope: &AgentResourceScope,
        request: &Value,
        signal: &CancellationToken,
    ) -> Result<Page, SessionError> {
        let reference = &request["reader"];
        let reader = self.get(scope, reference)?;
        if as_number(&request["page"]) != Some(reader.requested.get() as f64) {
            return Err(rejected("History pages must be requested in order"));
        }
        reader.requested.update(|page| page + 1);
        reader.refresh();
        let (send, mut receive) = oneshot::channel();
        reader.requests.send(send).map_err(|_| stale())?;
        let result = tokio::select! {
            biased;
            () = signal.cancelled() => {
                self.retire(scope, reference["id"].as_str().unwrap_or_default());
                receive.await
            }
            result = &mut receive => result,
        };
        self.assert_open(signal)?;
        if reader.stop.is_cancelled() {
            return Err(stale());
        }
        result.map_err(|_| stale())?
    }

    fn assert_open(&self, signal: &CancellationToken) -> Result<(), SessionError> {
        if self.closed.is_cancelled() || signal.is_cancelled() {
            Err(stale())
        } else {
            Ok(())
        }
    }

    fn get(
        &self,
        scope: &AgentResourceScope,
        reference: &Value,
    ) -> Result<Rc<Reader>, SessionError> {
        if !is_agent_resource_ref(reference, KIND, Some(scope)) {
            return Err(stale_scope("Resource belongs to another execution scope"));
        }
        self.readers
            .borrow()
            .get(&scope.integration_id)
            .and_then(|table| table.get(reference["id"].as_str().unwrap_or_default()))
            .cloned()
            .ok_or_else(|| stale_scope("Resource has retired"))
    }

    fn retire(&self, scope: &AgentResourceScope, id: &str) {
        let reader = self
            .readers
            .borrow_mut()
            .get_mut(&scope.integration_id)
            .and_then(|table| table.remove(id));
        if let Some(reader) = reader {
            reader.stop.cancel();
        }
    }

    pub(crate) fn dispose(&self) {
        if self.closed.is_cancelled() {
            return;
        }
        self.closed.cancel();
        for reader in self
            .readers
            .take()
            .into_values()
            .flat_map(HashMap::into_values)
        {
            reader.stop.cancel();
        }
    }
}

impl Drop for HistoryRpcServer {
    fn drop(&mut self) {
        self.dispose();
    }
}

impl Reader {
    fn start(
        history: Rc<dyn AgentHistoryImport>,
        mut request: AgentHistoryImportRequest,
        scope: CancellationToken,
        opening: CancellationToken,
    ) -> (Rc<Self>, oneshot::Receiver<()>) {
        let (requests, mut pages_requested) = mpsc::unbounded_channel::<PageResponse>();
        let (ready, opened) = oneshot::channel();
        let stop = CancellationToken::new();
        let finished = CancellationToken::new();
        request.signal = stop.clone();
        tokio::task::spawn_local({
            let stop = stop.clone();
            let finished = finished.clone().drop_guard();
            async move {
                let _finished = finished;
                if scope.is_cancelled() || opening.is_cancelled() {
                    return;
                }
                // The task owns the provider so a stream may borrow it across page requests.
                let source = history.load(request, None).then(|result| {
                    let stop = stop.clone();
                    async move {
                        tokio::task::yield_now().await;
                        if stop.is_cancelled() {
                            return Err(stale());
                        }
                        result.map_err(SessionError::from)
                    }
                });
                let mut pages = pin!(history_pages(source).fuse());
                if ready.send(()).is_err() {
                    return;
                }
                loop {
                    let reply = tokio::select! {
                        biased;
                        () = stop.cancelled() => break,
                        reply = pages_requested.recv() => reply,
                    };
                    let Some(reply) = reply else { break };
                    // A close aborts the source but waits for an already submitted read to settle.
                    let page = pages.next().await;
                    let result = if stop.is_cancelled() {
                        Err(stale())
                    } else {
                        match page {
                            Some(rows) => rows.map(|rows| Page { done: false, rows }),
                            None => Ok(Page {
                                done: true,
                                rows: Vec::new(),
                            }),
                        }
                    };
                    let _ = reply.send(result);
                }
            }
        });
        (
            Rc::new(Self {
                requests,
                stop,
                finished,
                requested: Cell::new(0),
                deadline: Cell::new(Instant::now() + READER_IDLE),
                refreshed: Notify::new(),
            }),
            opened,
        )
    }

    fn refresh(&self) {
        self.deadline.set(Instant::now() + READER_IDLE);
        self.refreshed.notify_one();
    }

    async fn expired(&self) -> bool {
        loop {
            tokio::select! {
                biased;
                () = self.stop.cancelled() => return false,
                () = self.refreshed.notified() => {},
                () = sleep_until(self.deadline.get()) => return true,
            }
        }
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

fn rejected(message: &str) -> SessionError {
    shared_error(AgentCallError::new(AgentDeliveryOutcome::Rejected, message))
}

fn stale_scope(message: &str) -> SessionError {
    shared_error(AgentCallError::with_code(
        AgentDeliveryOutcome::Rejected,
        message,
        AgentIntegrationErrorCode::STALE_RESOURCE,
    ))
}

fn stale() -> SessionError {
    shared_error(AgentCallError::with_code(
        AgentDeliveryOutcome::NotDispatched,
        "History reader session retired or request cancelled",
        AgentIntegrationErrorCode::STALE_RESOURCE,
    ))
}

#[cfg(test)]
mod tests;
