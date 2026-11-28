//! Ports `server-agents/common/src/acp/single-query.ts`.

use std::cell::RefCell;
use std::rc::Rc;

use futures::future::LocalBoxFuture;
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::resources::ExecutorResult;
use garcon_js::trim;
use indexmap::IndexSet;
use serde_json::{Map, Value, json};
use tokio::task::{JoinHandle, spawn_local};
use tokio_util::sync::CancellationToken;

use crate::execution::admission::check_signal;

use super::client::{AcpClient, AcpClientOptions, AcpNewSessionParams};
use super::event_converter::{acp_content_text, as_object, as_string};
use super::in_band_failure::{
    AcpFailureSplitter, AcpInBandFailure, AcpSplitChunk, acp_output_update_type,
};
use super::json_values::{is_truthy, member};
use super::protocol::{AcpInitializeParams, AcpJsonRpcMessage, AcpSessionNewResult};
use super::runtime_helpers::{AcpPermissionChoice, permission_choice_outcome};
use super::transport::{AcpRequestOptions, AcpSpawnSpec, AcpTransport, AcpTransportOptions};

pub type ConfigureQuerySession =
    Rc<dyn Fn(Rc<AcpClient>, AcpSessionNewResult) -> LocalBoxFuture<'static, ExecutorResult<()>>>;
pub type RespondToRequest = Rc<dyn Fn(&str) -> Option<Value>>;

pub struct AcpSingleQueryOptions {
    pub spawn: AcpSpawnSpec,
    pub initialize: AcpInitializeParams,
    pub authenticate_method_id: Option<String>,
    pub prompt: String,
    pub signal: CancellationToken,
    pub request_timeout_ms: Option<f64>,
    pub create_transport: Option<Rc<dyn Fn() -> AcpTransport>>,
    pub configure: Option<ConfigureQuerySession>,
    pub respond_to_request: Option<RespondToRequest>,
    pub split_failure: Option<AcpFailureSplitter>,
}

const DEFAULT_SINGLE_QUERY_PROMPT_TIMEOUT_MS: f64 = 120_000.0;

struct QueryOutput {
    assistant_chunks: Vec<String>,
    seen_calls: IndexSet<String>,
    failure: AcpInBandFailure,
}

impl QueryOutput {
    fn update(&mut self, params: &Value) {
        let update = as_object(as_object(params).get("update").unwrap_or(&Value::Null));
        let update_type = update.get("sessionUpdate").and_then(as_string);
        let output_type = acp_output_update_type(update, |id| self.seen_calls.contains(id));
        self.assistant_chunks
            .push(self.failure.continue_on(output_type.as_deref()));
        if let Some(id) = update
            .get("toolCallId")
            .and_then(as_string)
            .filter(|id| !id.is_empty())
            && matches!(update_type, Some("tool_call" | "tool_call_update"))
        {
            self.seen_calls.insert(id.to_owned());
        }
        if matches!(update_type, Some("agent_message_chunk" | "agent_message")) {
            let content = acp_content_text(update.get("content").unwrap_or(&Value::Null));
            self.assistant_chunks.push(self.failure.offer(&content));
        }
    }
}

struct QueryConnection {
    client: Rc<AcpClient>,
    detach: Rc<dyn Fn()>,
    abort: JoinHandle<()>,
}

impl Drop for QueryConnection {
    fn drop(&mut self) {
        (self.detach)();
        self.abort.abort();
        self.client.close();
    }
}

/// Runs one prompt in a disposable ACP session, denying all permission requests.
pub async fn run_acp_single_query(options: AcpSingleQueryOptions) -> ExecutorResult<String> {
    check_signal(Some(&options.signal))?;
    let transport = options.create_transport.map_or_else(
        || {
            AcpTransport::new(AcpTransportOptions {
                request_timeout_ms: options.request_timeout_ms,
                ..Default::default()
            })
        },
        |create| create(),
    );
    let client = Rc::new(AcpClient::new(
        transport,
        AcpClientOptions {
            initialize: options.initialize,
            authenticate_method_id: options.authenticate_method_id,
        },
    ));
    let output = Rc::new(RefCell::new(QueryOutput {
        assistant_chunks: Vec::new(),
        seen_calls: IndexSet::new(),
        failure: AcpInBandFailure::new(options.split_failure.unwrap_or_else(|| {
            Rc::new(|chunk| AcpSplitChunk {
                text: chunk.to_owned(),
                failure: None,
            })
        })),
    }));
    let abort = spawn_local({
        let client = Rc::downgrade(&client);
        async move {
            options.signal.cancelled().await;
            if let Some(client) = client.upgrade() {
                client.close();
            }
        }
    });
    let detach: Rc<dyn Fn()> = Rc::from(client.on_rpc_message({
        let client = Rc::downgrade(&client);
        let output = Rc::clone(&output);
        let respond_to_request = options.respond_to_request;
        move |message| match client.upgrade() {
            Some(client) => on_rpc_message(&client, &output, respond_to_request.as_ref(), message),
            None => Ok(()),
        }
    }));
    let connection = QueryConnection {
        client: Rc::clone(&client),
        detach: Rc::clone(&detach),
        abort,
    };
    client.connect(&options.spawn).await?;
    let created = client
        .new_session(AcpNewSessionParams {
            cwd: &options.spawn.cwd,
            mcp_servers: Some(&[]),
            modes: None,
            model: None,
            config: None,
        })
        .await?;
    if let Some(configure) = options.configure {
        configure(Rc::clone(&client), created.clone()).await?;
    }
    let mut params = Map::new();
    if let Some(id) = member(&created, "sessionId", "created.sessionId")? {
        params.insert("sessionId".to_owned(), id.clone());
    }
    params.insert(
        "prompt".to_owned(),
        json!([{"type": "text", "text": trim(&options.prompt)}]),
    );
    client
        .send_prompt(
            params,
            AcpRequestOptions {
                on_reply: Some(Rc::new(move |_| {
                    detach();
                    Ok(())
                })),
                timeout_ms: Some(
                    options
                        .request_timeout_ms
                        .unwrap_or(DEFAULT_SINGLE_QUERY_PROMPT_TIMEOUT_MS),
                ),
                ..Default::default()
            },
        )
        .await?;

    let mut output = output.borrow_mut();
    if let Some(reported) = output.failure.take() {
        return Err(AgentIntegrationError::new(
            AgentIntegrationErrorCode::PROVIDER_FAILURE,
            reported,
            false,
            None,
        )
        .into());
    }
    let text = output.assistant_chunks.concat();
    drop(output);
    drop(connection);
    Ok(trim(&text).to_owned())
}

fn on_rpc_message(
    client: &AcpClient,
    output: &RefCell<QueryOutput>,
    respond_to_request: Option<&RespondToRequest>,
    message: &AcpJsonRpcMessage,
) -> ExecutorResult<()> {
    if let Some(method) = message.method()
        && let Some(id) = message.id()
    {
        if method == "session/request_permission" {
            let params = as_object(message.params());
            let options: Vec<_> = params
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(as_object)
                .collect();
            return client.respond(
                id,
                permission_choice_outcome(&options, AcpPermissionChoice::Reject),
            );
        }
        return if let Some(response) = respond_to_request
            .and_then(|respond| respond(method))
            .filter(is_truthy)
        {
            client.respond(id, response)
        } else {
            client.respond_error(
                id,
                -32601.0,
                &format!("Unsupported ACP request method: {method}"),
                None,
            )
        };
    }
    if message.method() == Some("session/update") {
        output.borrow_mut().update(message.params());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
