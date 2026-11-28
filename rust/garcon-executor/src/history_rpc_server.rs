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
use garcon_interface::producer::AgentProducers;
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
    producers: &'a dyn AgentProducers,
    execution: &'a dyn AgentExecutionV5,
    legacy: Option<Rc<dyn AgentHistoryImport>>,
    native: Option<Rc<dyn AgentHistoryImport>>,
}

impl<'a> From<&'a AgentIntegration> for HistoryIntegration<'a> {
    fn from(integration: &'a AgentIntegration) -> Self {
        Self {
            producers: integration.producers.as_ref(),
            execution: integration.execution.as_ref(),
            legacy: integration.legacy_history_import.clone(),
            native: integration.native_history_import.clone(),
        }
    }
}

#[derive(Default)]
pub(crate) struct HistoryRpcServer {
    tables: RefCell<HashMap<String, Rc<ReaderTable>>>,
    closed: CancellationToken,
}

struct ReaderTable {
    scope: AgentResourceScope,
    readers: RefCell<HashMap<String, Rc<Reader>>>,
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
        &self,
        integration: HistoryIntegration<'_>,
        call: &ExecutorRpcRequest,
        signal: CancellationToken,
    ) -> RpcResult {
        self.assert_open(&signal)?;
        let table = self.table(&call.integration_id, integration.producers)?;
        match call.method.as_str() {
            "history.open" => {
                let reference = self
                    .open(table, integration, &call.request, &signal)
                    .await?;
                reply(Ok(reference))
            }
            "history.next" => {
                let row = self.next(&table, &call.request, &signal).await?;
                reply(Ok(row))
            }
            "history.close" => {
                let reader = table.get(&call.request)?;
                table.retire(call.request["id"].as_str().unwrap_or_default());
                reader.finished.cancelled().await;
                Ok(None)
            }
            _ => Err(rejected("Unknown history method")),
        }
    }

    fn table(
        &self,
        integration_id: &str,
        producers: &dyn AgentProducers,
    ) -> Result<Rc<ReaderTable>, SessionError> {
        if let Some(table) = self.tables.borrow().get(integration_id) {
            return Ok(table.clone());
        }
        let table = Rc::new(ReaderTable {
            scope: producers.scope().map_err(SessionError::from)?,
            readers: RefCell::default(),
        });
        self.tables
            .borrow_mut()
            .insert(integration_id.into(), table.clone());
        Ok(table)
    }

    async fn open(
        &self,
        table: Rc<ReaderTable>,
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
        let reference =
            create_agent_resource_ref(table.scope.clone(), KIND, || Uuid::new_v4().to_string());
        let registered = self.assert_open(signal).and_then(|()| {
            let mut readers = table.readers.borrow_mut();
            if readers.contains_key(&reference.id) {
                return Err(stale_scope("Resource is already bound"));
            }
            if readers.len() >= MAX_READERS {
                return Err(rejected("Resource budget exhausted"));
            }
            readers.insert(reference.id.clone(), Rc::clone(&reader));
            Ok(())
        });
        if let Err(error) = registered {
            reader.stop.cancel();
            reader.finished.cancelled().await;
            return Err(error);
        }
        reader.refresh();
        tokio::task::spawn_local({
            let table = Rc::downgrade(&table);
            let id = reference.id.clone();
            async move {
                if reader.expired().await
                    && let Some(table) = table.upgrade()
                {
                    table.retire(&id);
                }
            }
        });
        Ok(reference)
    }

    async fn next(
        &self,
        table: &ReaderTable,
        request: &Value,
        signal: &CancellationToken,
    ) -> Result<Page, SessionError> {
        let reference = &request["reader"];
        let reader = table.get(reference)?;
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
                table.retire(reference["id"].as_str().unwrap_or_default());
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

    pub(crate) fn dispose(&self) {
        if self.closed.is_cancelled() {
            return;
        }
        self.closed.cancel();
        for table in self.tables.take().into_values() {
            for reader in table.readers.take().into_values() {
                reader.stop.cancel();
            }
        }
    }
}

impl ReaderTable {
    fn get(&self, reference: &Value) -> Result<Rc<Reader>, SessionError> {
        if !is_agent_resource_ref(reference, KIND, Some(&self.scope)) {
            return Err(stale_scope("Resource belongs to another execution scope"));
        }
        self.readers
            .borrow()
            .get(reference["id"].as_str().unwrap_or_default())
            .cloned()
            .ok_or_else(|| stale_scope("Resource has retired"))
    }

    fn retire(&self, id: &str) {
        let reader = self.readers.borrow_mut().remove(id);
        if let Some(reader) = reader {
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
