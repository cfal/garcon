use std::{collections::VecDeque, future::Future, rc::Rc};

use futures::{StreamExt, TryStreamExt, stream};
use garcon_interface::{
    native_history::{
        AgentHistoryImport, AgentHistoryImportRequest, AgentHistoryStream,
        AgentImportedTranscriptRow,
    },
    resources::{AgentInstanceCallOptions, ExecutorResult, assert_agent_resource_scope},
};
use garcon_js::json::Opaque;
use garcon_link::{
    rpc::{ExecutorRpc, RpcCallOptions, RpcResult, RpcTimeout},
    rpc_lane::RpcLane,
};
use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::{CancellationToken, DropGuard};

use super::{
    sessions::{HeldCallOptions, RemoteSessions},
    wire::{decode_rows, encode, own_rpc_error},
};

const HISTORY_PAGES_IN_FLIGHT: usize = 4;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum HistorySource {
    LegacyHistoryImport,
    NativeHistoryImport,
}

pub(super) struct RemoteHistory {
    pub sessions: Rc<RemoteSessions>,
    pub integration_id: String,
    pub source: HistorySource,
}

impl AgentHistoryImport for RemoteHistory {
    fn load(
        &self,
        request: AgentHistoryImportRequest,
        options: Option<AgentInstanceCallOptions>,
    ) -> AgentHistoryStream<'_> {
        stream::once(self.open(request, options))
            .map_ok(|reader| {
                stream::try_unfold(reader, |mut reader| async move {
                    match reader.next().await? {
                        Some(rows) => Ok(Some((rows, reader))),
                        None => {
                            reader.close().await;
                            Ok(None)
                        }
                    }
                })
            })
            .try_flatten()
            .boxed_local()
    }
}

impl RemoteHistory {
    async fn open(
        &self,
        request: AgentHistoryImportRequest,
        options: Option<AgentInstanceCallOptions>,
    ) -> ExecutorResult<Reader> {
        let instance_id = if let Some(options) = options {
            let scope = self.sessions.scope(&self.integration_id)?;
            assert_agent_resource_scope(&scope, &options.expected_scope).map_err(|error| *error)?;
            Some(options.expected_scope.instance_id)
        } else {
            None
        };
        let signal = request.signal.child_token();
        let stop = signal.clone().drop_guard();
        let options = HeldCallOptions {
            signal: Some(signal.clone()),
            instance_id,
            ..Default::default()
        };
        let held = self.sessions.acquire(RpcLane::Bulk, &options).await?;
        let rpc = held.backing.rpc.clone();
        let mut call = held.rpc_options(&options);
        call.on_late_result = Some(Rc::new({
            let owner = Rc::downgrade(&rpc);
            let integration_id = self.integration_id.clone();
            move |reference| {
                let owner = owner.upgrade();
                let integration_id = integration_id.clone();
                Box::pin(async move {
                    if let Some((owner, reference)) = owner.zip(reference) {
                        close(&owner, &integration_id, reference).await?;
                    }
                    Ok(())
                })
            }
        }));
        #[derive(Serialize)]
        struct Open {
            source: HistorySource,
            request: AgentHistoryImportRequest,
        }
        let open = encode(Open {
            source: self.source,
            request,
        })?;
        let reference = rpc
            .call(&self.integration_id, "history.open", open, call)
            .await
            .map_err(own_rpc_error)?
            .ok_or("Missing history reader")?;
        Ok(Reader {
            rpc,
            integration_id: self.integration_id.clone(),
            reference: Some(reference),
            requested: 0,
            in_flight: VecDeque::with_capacity(HISTORY_PAGES_IN_FLIGHT),
            signal,
            _stop: stop,
        })
    }
}

type PageReply = std::pin::Pin<Box<dyn Future<Output = RpcResult>>>;

struct Reader {
    rpc: Rc<ExecutorRpc>,
    integration_id: String,
    reference: Option<Opaque>,
    requested: u64,
    in_flight: VecDeque<PageReply>,
    signal: CancellationToken,
    _stop: DropGuard,
}

impl Reader {
    async fn next(&mut self) -> ExecutorResult<Option<Vec<AgentImportedTranscriptRow>>> {
        #[derive(Serialize)]
        struct Next<'a> {
            reader: &'a Opaque,
            page: u64,
        }
        let reader = self.reference.as_ref().ok_or("History reader is closed")?;
        while self.in_flight.len() < HISTORY_PAGES_IN_FLIGHT {
            let request = encode(Next {
                reader,
                page: self.requested,
            })?;
            self.requested += 1;
            let call = self.rpc.call(
                &self.integration_id,
                "history.next",
                request,
                RpcCallOptions {
                    signal: Some(self.signal.clone()),
                    ..Default::default()
                },
            );
            self.in_flight.push_back(Box::pin(call));
        }
        // INFALLIBLE: the loop filled the queue before requesting its head.
        let reply = self
            .in_flight
            .pop_front()
            .expect("history page in flight")
            .await
            .map_err(own_rpc_error)?;
        let reply = reply.as_deref().unwrap_or(&Value::Null);
        match reply["done"].as_bool() {
            Some(true) => Ok(None),
            Some(false) => Ok(Some(decode_rows(&reply["rows"])?)),
            None => Err("Invalid history page".into()),
        }
    }

    async fn close(&mut self) {
        if let Some(reference) = self.reference.take() {
            let _ = close(&self.rpc, &self.integration_id, reference).await;
        }
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        if let Some(reference) = self.reference.take() {
            // Calling starts dispatch synchronously; a dropped stream cannot
            // await the response, and a replacement lane cannot use this ref.
            drop(close(&self.rpc, &self.integration_id, reference));
        }
    }
}

fn close(
    rpc: &Rc<ExecutorRpc>,
    integration_id: &str,
    reference: Opaque,
) -> impl Future<Output = RpcResult> + use<> {
    rpc.call(
        integration_id,
        "history.close",
        reference,
        RpcCallOptions {
            timeout: RpcTimeout::Milliseconds(2_000),
            ..Default::default()
        },
    )
}
