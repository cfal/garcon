//! Ports `server-agents/common/src/acp/protocol.ts`.
//!
//! The agent's answers are untrusted JSON, so the interfaces the original
//! declares for them stay JSON: an object is a `Map<String, Value>`, and a
//! result that need not be an object is a `Value`. A `Value` the agent sent
//! holds every number as a JavaScript double, as `garcon_js::json::Opaque`
//! reads it.

use std::fmt;
use std::ops::Deref;

use garcon_interface::resources::ExecutorResult;
use garcon_js::json::Opaque;
use serde::Serialize;
use serde_json::{Map, Value};

use super::json_values::{is_truthy, member};

/// The capabilities Garcon announces to the agent.
pub type AcpClientCapabilities = Map<String, Value>;

/// One option of the agent's `configOptions` list.
pub type AcpSessionConfigOption = Map<String, Value>;

/// The answer of `session/set_config_option`.
pub type AcpSessionConfigOptionsResult = Map<String, Value>;

/// The agent's model selector, as `session/new` and `session/load` report it.
pub type AcpSessionModelState = Map<String, Value>;

/// The answer of `session/new`.
pub type AcpSessionNewResult = Value;

/// The answer of `session/prompt`.
pub type AcpSessionPromptResult = Value;

/// The answer of `session/load`.
pub type AcpSessionLoadResult = Value;

/// The answer of `initialize`.
pub type AcpInitializeResult = Value;

/// The `params` of `session/request_permission`.
pub type AcpSessionRequestPermission = Map<String, Value>;

/// The `params` of `session/update`.
pub type AcpSessionUpdateNotification = Map<String, Value>;

/// A JSON-RPC request id: a number or a string.
#[derive(Debug, Clone, PartialEq)]
pub enum AcpJsonRpcId {
    Number(f64),
    String(String),
}

impl AcpJsonRpcId {
    /// The id when `value` is one, as [`is_json_rpc_id`] accepts it.
    pub fn of(value: &Value) -> Option<Self> {
        match value {
            Value::Number(_) => garcon_js::json::as_number(value).map(Self::Number),
            Value::String(text) => Some(Self::String(text.clone())),
            _ => None,
        }
    }
}

impl fmt::Display for AcpJsonRpcId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Number(number) => formatter.write_str(&garcon_js::number_to_string(*number)),
            Self::String(text) => formatter.write_str(text),
        }
    }
}

/// Whether `value` is a number or a string.
pub fn is_json_rpc_id(value: &Value) -> bool {
    AcpJsonRpcId::of(value).is_some()
}

/// The parameters of `initialize`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpInitializeParams {
    pub protocol_version: u8,
    pub client_info: AcpClientInfo,
    pub client_capabilities: Opaque,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<Opaque>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpClientInfo {
    pub name: String,
    pub version: String,
}

/// The handshake every Garcon ACP client sends: chat sessions, one-shot
/// queries, and auth probes negotiate identically.
pub fn garcon_initialize_params(options: Option<&Value>) -> ExecutorResult<AcpInitializeParams> {
    let absent = Value::Object(Map::new());
    let options = options.unwrap_or(&absent);
    let client_capabilities = member(options, "clientCapabilities", "options.clientCapabilities")?
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let mcp_servers = member(options, "mcpServers", "options.mcpServers")?
        .filter(|value| is_truthy(value))
        .cloned();
    Ok(AcpInitializeParams {
        protocol_version: 1,
        client_info: AcpClientInfo {
            name: "garcon".to_owned(),
            version: "1.0.0".to_owned(),
        },
        client_capabilities: Opaque::from_value(client_capabilities),
        mcp_servers: mcp_servers.map(Opaque::from_value),
    })
}

/// One JSON-RPC message as the agent sent it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AcpJsonRpcMessage(Opaque);

impl Deref for AcpJsonRpcMessage {
    type Target = Value;

    fn deref(&self) -> &Value {
        &self.0
    }
}

impl AcpJsonRpcMessage {
    /// Wraps JSON the agent sent.
    pub fn new(json: Opaque) -> Self {
        Self(json)
    }

    /// `message.id`, as the transport reads it first: on `null` the original
    /// throws.
    pub fn read_id(&self) -> ExecutorResult<Option<AcpJsonRpcId>> {
        Ok(member(&self.0, "id", "message.id")?.and_then(AcpJsonRpcId::of))
    }

    /// `message.id` for a listener, which never receives `null`.
    pub fn id(&self) -> Option<AcpJsonRpcId> {
        self.get("id").and_then(AcpJsonRpcId::of)
    }

    /// `message.method` when it is a string.
    pub fn method(&self) -> Option<&str> {
        self.get("method").and_then(Value::as_str)
    }

    /// `message.params`; absent reads as `null`.
    pub fn params(&self) -> &Value {
        self.get("params").unwrap_or(&Value::Null)
    }

    /// `'key' in message`: whether an object owns the member.
    pub fn has(&self, key: &str) -> bool {
        self.as_object()
            .is_some_and(|entries| entries.contains_key(key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_base::errors::error_metadata;
    use serde_json::json;

    #[test]
    fn an_id_is_a_number_or_a_string() {
        assert!(is_json_rpc_id(&json!(1.5)));
        assert!(is_json_rpc_id(&json!("")));
        for value in [Value::Null, json!(true), json!([]), json!({})] {
            assert!(!is_json_rpc_id(&value));
        }
        // Request ids match as JavaScript map keys: by value, and a number
        // never equals its text.
        assert_eq!(AcpJsonRpcId::Number(1.0), AcpJsonRpcId::Number(1.0));
        assert_eq!(AcpJsonRpcId::Number(-0.0), AcpJsonRpcId::Number(0.0));
        assert_ne!(
            AcpJsonRpcId::Number(1.0),
            AcpJsonRpcId::String("1".to_owned())
        );
        assert_eq!(AcpJsonRpcId::Number(-0.0).to_string(), "0");
        assert_eq!(AcpJsonRpcId::Number(1e21).to_string(), "1e+21");
        assert_eq!(AcpJsonRpcId::String("a".to_owned()).to_string(), "a");
    }

    #[test]
    fn a_null_message_has_no_member_to_read() {
        let message = AcpJsonRpcMessage::new(Opaque::from_value(Value::Null));
        let error = message.read_id().unwrap_err();
        assert_eq!(error_metadata(error.as_ref()).name, "TypeError");
        assert_eq!(
            error.to_string(),
            "null is not an object (evaluating 'message.id')"
        );
    }

    #[test]
    fn a_message_reads_only_the_members_the_agent_sent() {
        let request = AcpJsonRpcMessage::new(
            Opaque::parse(
                r#"{"jsonrpc":"2.0","id":"permission-1","method":"session/request_permission","params":{"sessionId":"session-1"}}"#,
            )
            .unwrap(),
        );
        assert_eq!(
            request.read_id().unwrap(),
            Some(AcpJsonRpcId::String("permission-1".to_owned()))
        );
        assert_eq!(request.method(), Some("session/request_permission"));
        assert_eq!(request.params()["sessionId"], "session-1");
        assert!(!request.has("result"));
        assert!(!request.has("error"));

        // `'result' in message` is true for a reply that carries `null`.
        let reply = AcpJsonRpcMessage::new(Opaque::parse(r#"{"id":1,"result":null}"#).unwrap());
        assert_eq!(reply.read_id().unwrap(), Some(AcpJsonRpcId::Number(1.0)));
        assert!(reply.has("result"));
        assert_eq!(reply.method(), None);
        assert_eq!(reply.params(), &Value::Null);
        assert_eq!(reply.id(), reply.read_id().unwrap());

        // Any other JSON value has no members, and reading them throws nothing.
        let other = AcpJsonRpcMessage::new(Opaque::from_value(json!(42)));
        assert_eq!(other.read_id().unwrap(), None);
        assert_eq!(other.id(), None);
        assert!(!other.has("result"));
    }

    #[test]
    fn a_null_option_object_is_not_an_option() {
        let options = json!(null);
        let error = garcon_initialize_params(Some(&options)).unwrap_err();
        assert_eq!(
            error.to_string(),
            "null is not an object (evaluating 'options.clientCapabilities')"
        );
    }
}
