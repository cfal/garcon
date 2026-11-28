//! Runtime descriptor and discovery response contracts.

use garcon_js::{date_parse::date_parse, is_safe_integer, json::as_number, trim};
use serde::Serialize;
use serde_json::Value;
use url::Url;

use crate::executors::{ExecutorId, is_executor_id};
use crate::json::JsonObject;

pub const SERVER_RUNTIME_SCHEMA_VERSION: u8 = 1;
pub const SERVER_RUNTIME_FILENAME: &str = "runtime.json";
pub const LOCAL_CAPABILITY_PREFIX: &str = "garcon_local_";
pub const SERVER_RUNTIME_PROOF_CONTEXT: &str = "garcon-runtime-proof-v1";
pub const CLI_SERVER_INSTANCE_HEADER: &str = "X-Garcon-Server-Instance";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliContext {
    pub server_instance_id: String,
    pub default_executor_id: ExecutorId,
    pub workspace_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRuntimeProbe {
    pub schema_version: u8,
    pub instance_id: String,
    pub proof: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRuntimeIdentity {
    pub schema_version: u8,
    pub instance_id: String,
    pub workspace_dir: String,
    pub started_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEndpoint {
    pub schema_version: u8,
    pub instance_id: String,
    pub started_at: String,
    pub pid: u64,
    pub base_url: String,
    pub local_capability: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRuntimeDescriptor {
    #[serde(flatten)]
    pub endpoint: RuntimeEndpoint,
    pub workspace_dir: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum CliGatewayKind {
    #[serde(rename = "executor-cli")]
    ExecutorCli,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CliGatewayDescriptor {
    #[serde(flatten)]
    pub endpoint: RuntimeEndpoint,
    pub kind: CliGatewayKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum CliRuntimeDescriptor {
    Controller(ServerRuntimeDescriptor),
    ExecutorCli(CliGatewayDescriptor),
}

impl CliRuntimeDescriptor {
    pub fn endpoint(&self) -> &RuntimeEndpoint {
        match self {
            Self::Controller(descriptor) => &descriptor.endpoint,
            Self::ExecutorCli(descriptor) => &descriptor.endpoint,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ServerRuntimeContractError(String);

impl ServerRuntimeContractError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

fn invalid(message: impl Into<String>) -> ServerRuntimeContractError {
    ServerRuntimeContractError::new(message)
}

pub fn parse_cli_context(value: &Value) -> Result<CliContext, ServerRuntimeContractError> {
    let raw = runtime_record(value)?;
    let default_executor_id = raw
        .get("defaultExecutorId")
        .filter(|value| is_executor_id(value))
        .and_then(Value::as_str);
    let workspace_name = match raw.get("workspaceName") {
        Some(Value::Null) => None,
        Some(Value::String(name)) if !name.is_empty() => Some(name.clone()),
        _ => return Err(invalid("invalid CLI context")),
    };
    let default_executor_id = default_executor_id.ok_or_else(|| invalid("invalid CLI context"))?;
    Ok(CliContext {
        server_instance_id: required_string(raw, "serverInstanceId")?.to_owned(),
        default_executor_id: default_executor_id.to_owned(),
        workspace_name,
    })
}

pub fn parse_server_runtime_probe(
    value: &Value,
) -> Result<ServerRuntimeProbe, ServerRuntimeContractError> {
    let raw = runtime_record(value)?;
    require_schema(raw)?;
    let instance_id = required_string(raw, "instanceId")?.to_owned();
    let proof = required_string(raw, "proof")?;
    if !is_runtime_probe_challenge_text(proof) {
        return Err(invalid("proof must be 32-byte base64url data"));
    }
    Ok(ServerRuntimeProbe {
        schema_version: SERVER_RUNTIME_SCHEMA_VERSION,
        instance_id,
        proof: proof.to_owned(),
    })
}

pub fn parse_server_runtime_descriptor(
    value: &Value,
) -> Result<ServerRuntimeDescriptor, ServerRuntimeContractError> {
    let raw = runtime_record(value)?;
    Ok(ServerRuntimeDescriptor {
        endpoint: parse_runtime_endpoint(raw)?,
        workspace_dir: required_string(raw, "workspaceDir")?.to_owned(),
    })
}

pub fn parse_cli_runtime_descriptor(
    value: &Value,
) -> Result<CliRuntimeDescriptor, ServerRuntimeContractError> {
    let raw = runtime_record(value)?;
    match raw.get("kind") {
        Some(Value::String(kind)) if kind == "executor-cli" => {
            Ok(CliRuntimeDescriptor::ExecutorCli(CliGatewayDescriptor {
                endpoint: parse_runtime_endpoint(raw)?,
                kind: CliGatewayKind::ExecutorCli,
            }))
        }
        Some(_) => Err(invalid("unsupported runtime kind")),
        None => parse_server_runtime_descriptor(value).map(CliRuntimeDescriptor::Controller),
    }
}

fn parse_runtime_endpoint(raw: &JsonObject) -> Result<RuntimeEndpoint, ServerRuntimeContractError> {
    require_schema(raw)?;
    let pid = raw
        .get("pid")
        .and_then(as_number)
        .filter(|&pid| is_safe_integer(pid) && pid > 0.0)
        .ok_or_else(|| invalid("pid must be a positive integer"))?;
    let started_at = required_string(raw, "startedAt")?;
    if date_parse(started_at).is_none() {
        return Err(invalid("startedAt must be an ISO timestamp"));
    }
    let base_url = required_string(raw, "baseUrl")?;
    let parsed_url =
        Url::parse(base_url).map_err(|_| invalid("baseUrl must be an absolute URL"))?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err(invalid("baseUrl must use HTTP or HTTPS"));
    }
    let local_capability = required_string(raw, "localCapability")?;
    if !is_local_capability_text(local_capability) {
        return Err(invalid("localCapability is invalid"));
    }
    let base_url = parsed_url.as_str();
    Ok(RuntimeEndpoint {
        schema_version: SERVER_RUNTIME_SCHEMA_VERSION,
        instance_id: required_string(raw, "instanceId")?.to_owned(),
        started_at: started_at.to_owned(),
        pid: pid as u64,
        base_url: base_url.strip_suffix('/').unwrap_or(base_url).to_owned(),
        local_capability: local_capability.to_owned(),
    })
}

pub fn is_local_capability(value: &Value) -> bool {
    value.as_str().is_some_and(is_local_capability_text)
}

pub fn is_local_capability_text(text: &str) -> bool {
    text.strip_prefix(LOCAL_CAPABILITY_PREFIX)
        .is_some_and(is_runtime_probe_challenge_text)
}

pub fn is_runtime_probe_challenge(value: &Value) -> bool {
    value.as_str().is_some_and(is_runtime_probe_challenge_text)
}

pub fn is_runtime_probe_challenge_text(text: &str) -> bool {
    text.len() == 43
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub fn runtime_proof_payload(instance_id: &str, challenge: &str) -> String {
    format!("{SERVER_RUNTIME_PROOF_CONTEXT}\0{instance_id}\0{challenge}")
}

fn runtime_record(value: &Value) -> Result<&JsonObject, ServerRuntimeContractError> {
    value
        .as_object()
        .ok_or_else(|| invalid("runtime payload must be an object"))
}

fn require_schema(raw: &JsonObject) -> Result<(), ServerRuntimeContractError> {
    if raw.get("schemaVersion").and_then(as_number)
        != Some(f64::from(SERVER_RUNTIME_SCHEMA_VERSION))
    {
        return Err(invalid("unsupported runtime schema version"));
    }
    Ok(())
}

fn required_string<'a>(
    raw: &'a JsonObject,
    field: &str,
) -> Result<&'a str, ServerRuntimeContractError> {
    raw.get(field)
        .and_then(Value::as_str)
        .map(trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid(format!("{field} must be a non-empty string")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn descriptor() -> Value {
        json!({
            "schemaVersion": 1, "instanceId": " instance-1 ", "workspaceDir": "/workspace-default",
            "startedAt": "2026-07-31T12:00:00.000Z", "pid": 123, "baseUrl": "http://127.0.0.1:8080/",
            "localCapability": format!("{LOCAL_CAPABILITY_PREFIX}{}", "a".repeat(43)),
        })
    }

    #[test]
    fn parses_a_runtime_descriptor_and_normalizes_its_base_url() {
        let raw = descriptor();
        let parsed = parse_server_runtime_descriptor(&raw).unwrap();
        assert_eq!(parsed.endpoint.instance_id, "instance-1");
        assert_eq!(parsed.endpoint.base_url, "http://127.0.0.1:8080");
        assert_eq!(parsed.workspace_dir, "/workspace-default");
        assert_eq!(parsed.endpoint.local_capability, raw["localCapability"]);
    }

    #[test]
    fn validates_schema_endpoint_and_auth_before_workspace_directory() {
        let mut raw = descriptor();
        raw["workspaceDir"] = Value::Null;
        raw["localCapability"] = json!("secret");
        raw["startedAt"] = json!("not a date");
        raw["pid"] = json!(1.25);
        raw["schemaVersion"] = json!(2);
        for (field, expected) in [
            ("schemaVersion", "unsupported runtime schema version"),
            ("pid", "pid must be a positive integer"),
            ("startedAt", "startedAt must be an ISO timestamp"),
            ("localCapability", "localCapability is invalid"),
            ("workspaceDir", "workspaceDir must be a non-empty string"),
        ] {
            assert_eq!(
                parse_server_runtime_descriptor(&raw)
                    .unwrap_err()
                    .to_string(),
                expected
            );
            raw[field] = descriptor()[field].clone();
        }
        raw["startedAt"] = json!("03 Feb 2024 GMT");
        assert!(parse_server_runtime_descriptor(&raw).is_ok());
    }

    #[test]
    fn keeps_the_credential_free_probe_minimal() {
        let proof = "b".repeat(43);
        let raw = json!({"schemaVersion": 1, "instanceId": "a", "proof": proof, "ignored": false});
        assert_eq!(
            serde_json::to_value(parse_server_runtime_probe(&raw).unwrap()).unwrap(),
            json!({
                "schemaVersion": 1, "instanceId": "a", "proof": proof,
            })
        );
        let raw = json!({"schemaVersion": 1, "instanceId": "a", "proof": "short"});
        assert_eq!(
            parse_server_runtime_probe(&raw).unwrap_err().to_string(),
            "proof must be 32-byte base64url data"
        );
    }

    #[test]
    fn treats_only_absent_kind_as_controller() {
        let mut raw = descriptor();
        raw["kind"] = Value::Null;
        assert_eq!(
            parse_cli_runtime_descriptor(&raw).unwrap_err().to_string(),
            "unsupported runtime kind"
        );
        raw["kind"] = json!("executor-cli");
        let runtime = parse_cli_runtime_descriptor(&raw).unwrap();
        let wire = serde_json::to_value(runtime).unwrap();
        assert_eq!(wire["kind"], "executor-cli");
        assert!(wire.get("workspaceDir").is_none());
    }
}
