//! Ports `server-agents/common/src/acp/client.ts`.

use std::cell::RefCell;
use std::future::Future;

use garcon_interface::resources::ExecutorResult;
use serde_json::{Map, Value, json};

use super::errors::plain_error;
use super::json_values::{is_truthy, member};
use super::protocol::{
    AcpInitializeParams, AcpInitializeResult, AcpJsonRpcId, AcpJsonRpcMessage,
    AcpSessionLoadResult, AcpSessionNewResult, AcpSessionPromptResult,
};
use super::reconnect_policy::AcpAdvertisedCapabilities;
use super::transport::{AcpRequestOptions, AcpSpawnSpec, AcpTransport};

pub struct AcpClientOptions {
    pub initialize: AcpInitializeParams,
    pub authenticate_method_id: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct AcpClientConnection {
    pub authenticated_method_id: Option<String>,
}

fn authentication_method<'a>(
    configured: Option<&'a str>,
    advertised: Option<&Value>,
) -> ExecutorResult<Option<&'a str>> {
    let Some(configured) = configured.filter(|method| !method.is_empty()) else {
        return Ok(None);
    };
    let Some(methods) = advertised.and_then(Value::as_array) else {
        return Ok(Some(configured));
    };
    if methods.is_empty() {
        return Ok(None);
    }
    for method in methods {
        if member(method, "id", "method.id")?.and_then(Value::as_str) == Some(configured) {
            return Ok(Some(configured));
        }
    }
    Err(plain_error(format!(
        "ACP agent does not advertise the configured authentication method: {configured}"
    )))
}

pub struct AcpNewSessionParams<'a> {
    pub cwd: &'a str,
    pub mcp_servers: Option<&'a [Value]>,
    pub modes: Option<&'a [String]>,
    pub model: Option<&'a str>,
    pub config: Option<&'a Map<String, Value>>,
}

pub struct AcpLoadSessionParams<'a> {
    pub cwd: &'a str,
    pub mcp_servers: Option<&'a [Value]>,
    pub session_id: &'a str,
}

pub struct AcpPromptSessionParams<'a> {
    pub session_id: &'a str,
    pub prompt: &'a [Value],
    pub config: Option<&'a Map<String, Value>>,
}

pub struct AcpClient {
    transport: AcpTransport,
    options: AcpClientOptions,
    initialize_result: RefCell<Option<AcpInitializeResult>>,
}

impl AcpClient {
    pub fn new(transport: AcpTransport, options: AcpClientOptions) -> Self {
        Self {
            transport,
            options,
            initialize_result: RefCell::new(None),
        }
    }

    pub fn is_connected(&self) -> bool {
        self.transport.is_connected()
    }

    pub async fn connect(&self, spec: &AcpSpawnSpec) -> ExecutorResult<AcpClientConnection> {
        self.transport.connect(spec)?;
        tokio::task::yield_now().await;
        let initialize = serde_json::to_string(&self.options.initialize)?;
        let params = garcon_js::json::parse(&initialize)?;
        let initialized = self.request("initialize", params).await?;
        self.initialize_result.replace(Some(initialized));
        let method_id = {
            let result = self.initialize_result.borrow();
            let advertised = result
                .as_ref()
                .map(|result| member(result, "authMethods", "this.#initializeResult.authMethods"))
                .transpose()?
                .flatten();
            authentication_method(self.options.authenticate_method_id.as_deref(), advertised)?
        };
        if let Some(method_id) = method_id {
            self.request("authenticate", json!({"methodId": method_id}))
                .await?;
        }
        self.transport
            .notify("notifications/initialized", Some(json!({})))?;
        Ok(AcpClientConnection {
            authenticated_method_id: method_id.map(str::to_owned),
        })
    }

    pub fn new_session(
        &self,
        params: AcpNewSessionParams<'_>,
    ) -> impl Future<Output = ExecutorResult<AcpSessionNewResult>> + use<> {
        let mut normalized = Map::from_iter([
            ("cwd".to_owned(), json!(params.cwd)),
            (
                "mcpServers".to_owned(),
                json!(params.mcp_servers.unwrap_or_default()),
            ),
        ]);
        if let Some(modes) = params.modes {
            normalized.insert("modes".to_owned(), json!(modes));
        }
        if let Some(model) = params.model {
            normalized.insert("model".to_owned(), json!(model));
        }
        if let Some(config) = params.config {
            normalized.insert("config".to_owned(), Value::Object(config.clone()));
        }
        self.request("session/new", Value::Object(normalized))
    }

    pub fn load_session(
        &self,
        params: &AcpLoadSessionParams<'_>,
    ) -> impl Future<Output = ExecutorResult<AcpSessionLoadResult>> + use<> {
        self.request("session/load", load_params(params))
    }

    pub fn resume_session(
        &self,
        params: &AcpLoadSessionParams<'_>,
    ) -> impl Future<Output = ExecutorResult<AcpSessionLoadResult>> + use<> {
        self.request("session/resume", load_params(params))
    }

    pub fn prompt_session(
        &self,
        params: AcpPromptSessionParams<'_>,
        mut options: AcpRequestOptions,
    ) -> impl Future<Output = ExecutorResult<AcpSessionPromptResult>> + use<> {
        let mut normalized = Map::from_iter([
            ("sessionId".to_owned(), json!(params.session_id)),
            ("prompt".to_owned(), json!(params.prompt)),
        ]);
        if let Some(config) = params.config {
            normalized.insert("config".to_owned(), Value::Object(config.clone()));
        }
        // A prompt lasts as long as the turn unless the caller sets a deadline.
        options.timeout_ms = Some(options.timeout_ms.unwrap_or(0.0));
        self.transport
            .request("session/prompt", Some(Value::Object(normalized)), options)
    }

    pub fn set_session_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> impl Future<Output = ExecutorResult<Value>> + use<> {
        self.request(
            "session/set_config_option",
            json!({"sessionId": session_id, "configId": config_id, "value": value}),
        )
    }

    pub fn set_session_model(
        &self,
        session_id: &str,
        model_id: &str,
    ) -> impl Future<Output = ExecutorResult<Value>> + use<> {
        self.request(
            "session/set_model",
            json!({"sessionId": session_id, "modelId": model_id}),
        )
    }

    pub fn cancel_session(&self, session_id: &str) -> ExecutorResult<()> {
        self.transport
            .notify("session/cancel", Some(json!({"sessionId": session_id})))
    }

    pub fn get_advertised_capabilities(&self) -> AcpAdvertisedCapabilities {
        let result = self.initialize_result.borrow();
        let caps = result
            .as_ref()
            .and_then(|result| result.get("agentCapabilities"));
        AcpAdvertisedCapabilities {
            load_session: caps
                .and_then(|caps| caps.get("loadSession"))
                .is_some_and(is_truthy),
            session_resume: caps
                .and_then(|caps| caps.get("sessionCapabilities"))
                .and_then(Value::as_object)
                .is_some_and(|caps| caps.contains_key("resume")),
        }
    }

    pub fn on_rpc_message(
        &self,
        callback: impl Fn(&AcpJsonRpcMessage) -> ExecutorResult<()> + 'static,
    ) -> Box<dyn Fn()> {
        self.transport.on_rpc_message(callback)
    }

    pub fn on_stderr(&self, callback: impl Fn(&str) + 'static) -> Box<dyn Fn()> {
        self.transport.on_stderr(callback)
    }

    pub fn on_exit(&self, callback: impl Fn(i32) + 'static) -> Box<dyn Fn()> {
        self.transport.on_exit(callback)
    }

    pub fn respond(&self, id: AcpJsonRpcId, result: Value) -> ExecutorResult<()> {
        self.transport.respond(id, result)
    }

    pub fn respond_error(
        &self,
        id: AcpJsonRpcId,
        code: f64,
        message: &str,
        data: Option<Value>,
    ) -> ExecutorResult<()> {
        self.transport.respond_error(id, code, message, data)
    }

    pub fn close(&self) {
        self.transport.close();
    }

    fn request(
        &self,
        method: &str,
        params: Value,
    ) -> impl Future<Output = ExecutorResult<Value>> + use<> {
        self.transport
            .request(method, Some(params), AcpRequestOptions::default())
    }
}

fn load_params(params: &AcpLoadSessionParams<'_>) -> Value {
    json!({
        "cwd": params.cwd,
        "mcpServers": params.mcp_servers.unwrap_or_default(),
        "sessionId": params.session_id,
    })
}

#[cfg(test)]
mod tests;
