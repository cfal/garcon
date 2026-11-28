//! Ports `server/remote/transport/cli-protocol.ts`.

use garcon_base::domain_error::DomainError;
use garcon_contract::api_providers::is_api_provider_id;
use garcon_contract::error_codes::ErrorCode;
use garcon_contract::executors::{is_executor_id, is_remote_executor_id};
use garcon_js::json::{Opaque, as_number, stringify};
use garcon_js::utf16;
use indexmap::IndexMap;
use serde::{Serialize, Serializer};
use serde_json::Value;

use crate::limits::PRIMARY_SMALL_RPC_BYTES;
use crate::rpc_lane::RpcLane;

pub const CLI_REQUEST_BYTES: usize = 1024 * 1024;
pub const CLI_REPLY_BYTES: usize = 8 * 1024 * 1024;
pub const CLI_SMALL_REPLY_BYTES: usize = 64 * 1024;
pub const CLI_ENVELOPE_BYTES: usize = 1024;

pub fn cli_request_bytes(lane: RpcLane) -> usize {
    match lane {
        RpcLane::Primary => PRIMARY_SMALL_RPC_BYTES,
        RpcLane::Bulk => CLI_REQUEST_BYTES,
    }
}

pub fn cli_reply_bytes(lane: RpcLane) -> usize {
    match lane {
        RpcLane::Primary => PRIMARY_SMALL_RPC_BYTES,
        RpcLane::Bulk => CLI_REPLY_BYTES,
    }
}

pub fn cli_request_too_large(lane: RpcLane) -> DomainError {
    DomainError::new(
        ErrorCode::CLI_REQUEST_TOO_LARGE,
        match lane {
            RpcLane::Primary => "CLI request exceeds 64 KiB",
            RpcLane::Bulk => "CLI request exceeds 1 MiB",
        },
        413,
        false,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CliPool {
    Short,
    Long,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliPolicy {
    pub mutation: bool,
    pub management: bool,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
    pub pool: CliPool,
    pub lane: RpcLane,
}

const READ: CliPolicy = CliPolicy {
    mutation: false,
    management: false,
    timeout_ms: Some(30_000),
    pool: CliPool::Short,
    lane: RpcLane::Bulk,
};
const WRITE: CliPolicy = CliPolicy {
    mutation: true,
    ..READ
};
const DOCUMENT: CliPolicy = CliPolicy {
    timeout_ms: Some(120_000),
    pool: CliPool::Long,
    ..READ
};
const MAINTENANCE: CliPolicy = CliPolicy {
    timeout_ms: None,
    pool: CliPool::Long,
    ..WRITE
};
const READ_MANAGEMENT: CliPolicy = CliPolicy {
    management: true,
    ..READ
};
const WRITE_MANAGEMENT: CliPolicy = CliPolicy {
    management: true,
    ..WRITE
};
const READ_PRIMARY: CliPolicy = CliPolicy {
    lane: RpcLane::Primary,
    ..READ
};
const WRITE_PRIMARY: CliPolicy = CliPolicy {
    lane: RpcLane::Primary,
    ..WRITE
};

pub const CLI_OPERATIONS: &[(&str, CliPolicy)] = &[
    ("GET /api/v1/scheduled-prompts", READ),
    ("POST /api/v1/scheduled-prompts", WRITE),
    ("PUT /api/v1/scheduled-prompts", WRITE),
    ("DELETE /api/v1/scheduled-prompts", WRITE),
    ("PUT /api/v1/scheduled-prompts/enabled", WRITE),
    ("GET /api/v1/executors", READ),
    ("POST /api/v1/executors", WRITE_MANAGEMENT),
    ("PATCH /api/v1/executors/:executorId", WRITE_MANAGEMENT),
    ("DELETE /api/v1/executors/:executorId", WRITE_MANAGEMENT),
    (
        "GET /api/v1/executors/:executorId/connection",
        READ_MANAGEMENT,
    ),
    ("GET /api/v1/api-provider-assignments", READ_MANAGEMENT),
    ("PUT /api/v1/api-provider-assignments", WRITE_MANAGEMENT),
    ("DELETE /api/v1/api-provider-assignments", WRITE_MANAGEMENT),
    ("GET /api/v1/models", READ),
    ("GET /api/v1/app/settings", READ),
    ("GET /api/v1/preambles", READ),
    ("GET /api/v1/chats", READ),
    ("GET /api/v1/chats/messages", READ),
    ("GET /api/v1/chats/snapshot", READ),
    ("GET /api/v1/chats/turn-receipt", READ_PRIMARY),
    ("GET /api/v1/chats/export", DOCUMENT),
    ("GET /api/v1/chats/handoff-artifact", DOCUMENT),
    ("POST /api/v1/chats/lookup-native-session", READ),
    ("POST /api/v1/chats/search", READ),
    ("GET /api/v1/chats/search/status", READ),
    ("POST /api/v1/chats/search/rebuild", MAINTENANCE),
    ("PUT /api/v1/app/settings", MAINTENANCE),
    ("POST /api/v1/chats/start", WRITE),
    ("POST /api/v1/chats/run", WRITE),
    ("POST /api/v1/chats/fork", MAINTENANCE),
    ("POST /api/v1/chats/fork-run", MAINTENANCE),
    ("POST /api/v1/chats/steer", WRITE),
    ("POST /api/v1/chats/stop", WRITE_PRIMARY),
    ("POST /api/v1/chats/permissions/decision", WRITE_PRIMARY),
    ("GET /api/v1/chats/rows", READ),
    ("POST /api/v1/chats/rows", WRITE),
    ("PUT /api/v1/app/session-name", WRITE),
    ("PUT /api/v1/chats/pin", WRITE),
    ("PUT /api/v1/chats/archive", WRITE),
    ("GET /api/v1/chats/tags", READ),
    ("PUT /api/v1/chats/tags", WRITE),
    ("PUT /api/v1/chats/parent", WRITE),
    ("GET /api/v1/tickets/bootstrap", READ),
    ("GET /api/v1/tickets", READ),
    ("GET /api/v1/tickets/detail", READ),
    ("GET /api/v1/tickets/history", READ),
    ("POST /api/v1/tickets/project-default", READ),
    ("POST /api/v1/tickets/mutate", WRITE),
];

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct CliOperation(&'static str, CliPolicy);

impl CliOperation {
    pub fn parse(key: &str) -> Option<Self> {
        CLI_OPERATIONS
            .iter()
            .find(|(name, _)| key == *name)
            .map(|(name, policy)| Self(name, *policy))
    }

    pub fn as_str(self) -> &'static str {
        self.0
    }

    pub fn policy(self) -> CliPolicy {
        self.1
    }
}

impl Serialize for CliOperation {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliHttpRequest {
    pub operation: CliOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<String>,
    pub query: Vec<[String; 2]>,
    pub body: Opaque,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerCliRequest {
    pub expected_server_instance_id: String,
    pub http: CliHttpRequest,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliHttpResponse {
    pub status: u16,
    pub body: Opaque,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<String>,
    #[serde(flatten)]
    pub extra: IndexMap<String, Opaque>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRoute {
    pub operation: CliOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<String>,
}

pub fn cli_operation(method: &str, pathname: &str) -> Result<CliOperation, DomainError> {
    CliOperation::parse(&format!("{method} {pathname}"))
        .ok_or_else(|| denied("This operation is not available through the CLI gateway"))
}

pub fn cli_route(method: &str, pathname: &str) -> Result<CliRoute, DomainError> {
    if let Some(path) = pathname.strip_prefix("/api/v1/executors/") {
        let (id, template) = match path.strip_suffix("/connection") {
            Some(id) => (id, "/api/v1/executors/:executorId/connection"),
            None => (path, "/api/v1/executors/:executorId"),
        };
        if is_remote_executor_id(&Value::String(id.to_owned())) {
            return Ok(CliRoute {
                operation: cli_operation(method, template)?,
                executor_id: Some(id.to_owned()),
            });
        }
    }
    Ok(CliRoute {
        operation: cli_operation(method, pathname)?,
        executor_id: None,
    })
}

pub fn cli_policy(operation: CliOperation, body: &Value) -> CliPolicy {
    if operation.as_str() == "POST /api/v1/chats/run"
        && body
            .as_object()
            .and_then(|body| body.get("handoff"))
            .is_some_and(truthy)
    {
        return CliPolicy {
            timeout_ms: Some(600_000),
            ..MAINTENANCE
        };
    }
    operation.policy()
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn exact(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|fields| {
        fields.len() == keys.len() && keys.iter().all(|key| fields.contains_key(*key))
    })
}

fn invalid() -> DomainError {
    DomainError::new(
        ErrorCode::VALIDATION_FAILED,
        "Invalid CLI request",
        400,
        false,
    )
}

fn denied(message: &'static str) -> DomainError {
    DomainError::new(ErrorCode::CLI_ACCESS_DENIED, message, 403, false)
}

pub fn parse_controller_cli_request(value: &Value) -> Result<ControllerCliRequest, DomainError> {
    if !exact(value, &["expectedServerInstanceId", "http"]) {
        return Err(invalid());
    }
    let expected_server_instance_id = value["expectedServerInstanceId"]
        .as_str()
        .filter(|id| !id.is_empty() && utf16::len(id) <= 128)
        .ok_or_else(invalid)?;
    let http = &value["http"];
    let operation = http
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let operation =
        CliOperation::parse(operation).ok_or_else(|| denied("CLI operation is not permitted"))?;
    let method = operation.as_str();
    let parameterized = method.contains(":executorId");
    let keys: &[&str] = if parameterized {
        &["operation", "executorId", "query", "body"]
    } else {
        &["operation", "query", "body"]
    };
    if !exact(http, keys) || parameterized && !is_remote_executor_id(&http["executorId"]) {
        return Err(invalid());
    }
    let query = http["query"]
        .as_array()
        .filter(|query| query.len() <= 128)
        .ok_or_else(invalid)?;
    let query: Vec<[&str; 2]> = query
        .iter()
        .map(|pair| {
            let [name, value] = pair.as_array().map(Vec::as_slice).ok_or_else(invalid)? else {
                return Err(invalid());
            };
            let name = name
                .as_str()
                .filter(|value| utf16::len(value) <= 8192)
                .ok_or_else(invalid)?;
            let value = value
                .as_str()
                .filter(|value| utf16::len(value) <= 8192)
                .ok_or_else(invalid)?;
            Ok([name, value])
        })
        .collect::<Result<_, DomainError>>()?;
    let body = &http["body"];
    let get = method.starts_with("GET ");
    if !(body.is_null() || !get && body.is_object()) {
        return Err(invalid());
    }
    let lane = operation.policy().lane;
    if stringify(value).len() + CLI_ENVELOPE_BYTES > cli_request_bytes(lane) {
        return Err(cli_request_too_large(lane));
    }
    validate_operation(method, get, &query, body)?;
    Ok(ControllerCliRequest {
        expected_server_instance_id: expected_server_instance_id.to_owned(),
        http: CliHttpRequest {
            operation,
            executor_id: http
                .get("executorId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            query: query
                .into_iter()
                .map(|pair| pair.map(str::to_owned))
                .collect(),
            body: Opaque::from_value(body.clone()),
        },
    })
}

fn validate_operation(
    method: &str,
    get: bool,
    query: &[[&str; 2]],
    body: &Value,
) -> Result<(), DomainError> {
    let query_param = |name| {
        let mut selected = query.iter().filter(|pair| pair[0] == name);
        let value = selected.next()?[1];
        selected
            .next()
            .is_none()
            .then(|| Value::String(value.to_owned()))
    };
    if method == "PUT /api/v1/app/settings"
        && (!exact(body, &["features"])
            || !exact(&body["features"], &["transcriptSearch"])
            || !exact(&body["features"]["transcriptSearch"], &["enabled"])
            || !body["features"]["transcriptSearch"]["enabled"].is_boolean())
    {
        return Err(denied(
            "Only transcript search enablement can be changed through this endpoint",
        ));
    }
    if method == "GET /api/v1/models"
        && !query_param("executorId").is_some_and(|id| is_executor_id(&id))
    {
        return Err(invalid());
    }
    if matches!(
        method,
        "POST /api/v1/chats/start"
            | "POST /api/v1/chats/lookup-native-session"
            | "POST /api/v1/tickets/project-default"
    ) && !body.get("executorId").is_some_and(is_executor_id)
    {
        return Err(invalid());
    }
    if matches!(
        method,
        "POST /api/v1/scheduled-prompts" | "PUT /api/v1/scheduled-prompts"
    ) {
        let target = &body["scheduledPrompt"]["target"];
        if target["type"] == "new-chat" && !is_executor_id(&target["executorId"]) {
            return Err(invalid());
        }
    }
    if method.contains("/api/v1/executors") && !query.is_empty()
        || method == "DELETE /api/v1/executors/:executorId" && !body.is_null()
    {
        return Err(invalid());
    }
    if method.contains("/api/v1/api-provider-assignments")
        && (!body.is_null()
            || if get {
                !query.is_empty()
            } else {
                query.len() != 2
                    || !query_param("executorId").is_some_and(|id| is_executor_id(&id))
                    || !query_param("apiProviderId").is_some_and(|id| is_api_provider_id(&id))
            })
    {
        return Err(invalid());
    }
    Ok(())
}

pub fn parse_cli_http_response(value: &Value) -> Result<CliHttpResponse, DomainError> {
    let invalid_response = || {
        DomainError::new(
            ErrorCode::CLI_OUTCOME_UNKNOWN,
            "The controller CLI response could not be confirmed",
            503,
            false,
        )
    };
    let fields = value.as_object().ok_or_else(invalid_response)?;
    let status = fields
        .get("status")
        .and_then(as_number)
        .filter(|status| {
            status.fract() == 0.0
                && ((200.0..=299.0).contains(status) || (400.0..=599.0).contains(status))
        })
        .ok_or_else(invalid_response)?;
    let body = fields.get("body").ok_or_else(invalid_response)?;
    let retry_after = fields
        .get("retryAfter")
        .map(|value| {
            value
                .as_str()
                .filter(|text| {
                    !text.is_empty()
                        && text.len() <= 5
                        && text.bytes().all(|byte| byte.is_ascii_digit())
                })
                .ok_or_else(invalid_response)
        })
        .transpose()?;
    if stringify(value).len() + CLI_ENVELOPE_BYTES > CLI_REPLY_BYTES {
        return Err(invalid_response());
    }
    Ok(CliHttpResponse {
        status: status as u16,
        body: Opaque::from_value(body.clone()),
        retry_after: retry_after.map(str::to_owned),
        extra: fields
            .iter()
            .filter(|(key, _)| !matches!(key.as_str(), "status" | "body" | "retryAfter"))
            .map(|(key, value)| (key.clone(), Opaque::from_value(value.clone())))
            .collect(),
    })
}
