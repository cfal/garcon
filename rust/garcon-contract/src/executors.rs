//! Ports `common/executors.ts`.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use garcon_js::{trim, utf16};

pub const LOCAL_EXECUTOR_ID: &str = "local";
pub const LOCAL_EXECUTOR_LABEL: &str = "Local";
pub type ExecutorId = String;

/// How a remote executor and the controller meet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutorDirection {
    ExecutorConnects,
    ControllerConnects,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExecutionTarget {
    pub executor_id: ExecutorId,
    pub agent_id: String,
}

/// The ID of the executor a value names, or of the Local executor when it
/// names none.
pub fn effective_executor_id(value: Option<&str>) -> ExecutorId {
    value.unwrap_or(LOCAL_EXECUTOR_ID).to_owned()
}

static REMOTE_EXECUTOR_ID_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        .expect("the remote executor ID pattern compiles")
});
// A canonical 32-byte base64url value ends with two zero padding bits.
static EXECUTOR_SECRET_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$")
        .expect("the executor secret pattern compiles")
});

/// Whether `value` names a remote executor: a version 4 UUID in lower case.
pub fn is_remote_executor_id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| REMOTE_EXECUTOR_ID_PATTERN.is_match(text))
}

/// Whether `value` is an executor secret in canonical base64url form.
pub fn is_executor_secret(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| EXECUTOR_SECRET_PATTERN.is_match(text))
}

/// Whether `value` names an executor: the Local executor or a remote one.
pub fn is_executor_id(value: &Value) -> bool {
    value.as_str() == Some(LOCAL_EXECUTOR_ID) || is_remote_executor_id(value)
}

/// Reads an executor ID. An absent or `null` value names the Local executor;
/// any other value that names no executor reads as `None`.
pub fn parse_executor_id(value: &Value) -> Option<ExecutorId> {
    if value.is_null() {
        return Some(LOCAL_EXECUTOR_ID.to_owned());
    }
    is_executor_id(value).then(|| {
        value
            .as_str()
            .expect("an executor ID is a string")
            .to_owned()
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutorSnapshotAvailability {
    Ready,
    Reconnecting,
    Offline,
}

/// A failure an executor reports, with its code and message.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorBulkStatus {
    pub availability: ExecutorBulkAvailability,
    pub last_error: Option<ExecutorError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutorBulkAvailability {
    Connecting,
    Ready,
    Reconnecting,
    Offline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutorKind {
    Local,
    Remote,
}

/// Which services an executor provides.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorServices {
    pub files: bool,
    pub git: bool,
    pub gh: bool,
    pub terminals: bool,
    /// Whether the executor's file service can create directories.
    pub directory_creation: bool,
}

/// What the clients see of an executor. It holds no credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorSnapshot {
    pub id: ExecutorId,
    pub label: String,
    pub kind: ExecutorKind,
    pub enabled: bool,
    pub allow_controller_cli: bool,
    pub allow_executor_management: bool,
    pub direction: Option<ExecutorDirection>,
    pub availability: ExecutorSnapshotAvailability,
    pub bulk: Option<ExecutorBulkStatus>,
    pub instance_id: Option<String>,
    pub project_base_path: Option<String>,
    pub last_error: Option<ExecutorError>,
    pub executor_services: ExecutorServices,
}

/// How a new executor is reached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "direction", rename_all = "kebab-case")]
pub enum ExecutorConnectionTarget {
    ExecutorConnects {
        #[serde(
            rename = "advertisedUrl",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        advertised_url: Option<String>,
    },
    ControllerConnects {
        #[serde(rename = "connectionUrl")]
        connection_url: String,
    },
}

/// A request to create an executor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateExecutorRequest {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_executor_management: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_controller_cli: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_tls: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_unverified_tls: Option<bool>,
    #[serde(flatten)]
    pub target: ExecutorConnectionTarget,
}

/// A request to change an executor. Every field is optional and an absent
/// field is left as it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateExecutorRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_executor_management: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_controller_cli: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<ExecutorConnectionUpdate>,
}

/// The new connection settings of an executor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorConnectionUpdate {
    pub direction: ExecutorDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_url: Option<String>,
    pub no_tls: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_unverified_tls: Option<bool>,
}

/// The stored connection settings of an executor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorConnection {
    pub connection_url: String,
    pub no_tls: bool,
    pub allow_unverified_tls: bool,
}

fn has_only_keys(value: &Map<String, Value>, allowed: &[&str]) -> bool {
    value.keys().all(|key| allowed.contains(&key.as_str()))
}

fn is_label(value: &Value) -> bool {
    value.as_str().is_some_and(is_label_text)
}

fn is_label_text(text: &str) -> bool {
    !trim(text).is_empty() && utf16::len(text) <= 100
}

fn is_connection_url(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| !text.is_empty() && utf16::len(text) <= 4096)
}

/// Whether a property is absent or a boolean.
fn absent_or_boolean(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Bool(_)))
}

fn optional_boolean(object: &Map<String, Value>, key: &str) -> Option<bool> {
    object.get(key).and_then(Value::as_bool)
}

fn optional_text(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Whether `value` is the error an executor reports: `null`, or an object of
/// a code and a message and nothing else.
fn parse_executor_error(value: &Value) -> Option<Option<ExecutorError>> {
    if value.is_null() {
        return Some(None);
    }
    let object = value.as_object()?;
    if !has_only_keys(object, &["code", "message"]) {
        return None;
    }
    Some(Some(ExecutorError {
        code: object.get("code")?.as_str()?.to_owned(),
        message: object.get("message")?.as_str()?.to_owned(),
    }))
}

/// Reads a request to create an executor. It rejects a request that is
/// incomplete or holds a field the request has no place for.
pub fn parse_create_executor_request(value: &Value) -> Option<CreateExecutorRequest> {
    let object = value.as_object()?;
    let label = object
        .get("label")
        .and_then(Value::as_str)
        .filter(|label| is_label_text(label))?;
    if ![
        "allowExecutorManagement",
        "allowControllerCli",
        "noTls",
        "allowUnverifiedTls",
    ]
    .iter()
    .all(|key| absent_or_boolean(object.get(*key)))
    {
        return None;
    }
    let allow_unverified_tls = object.get("allowUnverifiedTls");
    let direction = object.get("direction");
    let is = |name: &str| direction.and_then(Value::as_str) == Some(name);
    let target = if is("executor-connects")
        && allow_unverified_tls != Some(&Value::Bool(true))
        && object.get("advertisedUrl").is_none_or(is_connection_url)
        && has_only_keys(
            object,
            &[
                "label",
                "direction",
                "advertisedUrl",
                "noTls",
                "allowUnverifiedTls",
                "allowControllerCli",
                "allowExecutorManagement",
            ],
        ) {
        ExecutorConnectionTarget::ExecutorConnects {
            advertised_url: optional_text(object, "advertisedUrl"),
        }
    } else if is("controller-connects")
        && object.get("connectionUrl").is_some_and(is_connection_url)
        && has_only_keys(
            object,
            &[
                "label",
                "direction",
                "connectionUrl",
                "noTls",
                "allowUnverifiedTls",
                "allowControllerCli",
                "allowExecutorManagement",
            ],
        )
    {
        // INFALLIBLE: `is_connection_url` accepted the property, a string.
        let connection_url = object
            .get("connectionUrl")?
            .as_str()
            .expect("a connection URL is a string");
        ExecutorConnectionTarget::ControllerConnects {
            connection_url: connection_url.to_owned(),
        }
    } else {
        return None;
    };
    Some(CreateExecutorRequest {
        label: trim(label).to_owned(),
        allow_executor_management: optional_boolean(object, "allowExecutorManagement"),
        allow_controller_cli: optional_boolean(object, "allowControllerCli"),
        no_tls: optional_boolean(object, "noTls"),
        allow_unverified_tls: optional_boolean(object, "allowUnverifiedTls"),
        target,
    })
}

/// Reads a request to change an executor. An empty request, or one with an
/// unknown field, is rejected.
pub fn parse_update_executor_request(value: &Value) -> Option<UpdateExecutorRequest> {
    let object = value.as_object()?;
    if object.is_empty()
        || !has_only_keys(
            object,
            &[
                "label",
                "enabled",
                "connection",
                "allowControllerCli",
                "allowExecutorManagement",
            ],
        )
        || !absent_or_boolean(object.get("allowExecutorManagement"))
        || !absent_or_boolean(object.get("allowControllerCli"))
        || !absent_or_boolean(object.get("enabled"))
        || !object.get("label").is_none_or(is_label)
    {
        return None;
    }
    let connection = match object.get("connection") {
        None => None,
        Some(Value::Null) => return None,
        Some(value) => Some(parse_executor_connection_update(value)?),
    };
    Some(UpdateExecutorRequest {
        allow_executor_management: optional_boolean(object, "allowExecutorManagement"),
        label: optional_text(object, "label").map(|label| trim(&label).to_owned()),
        enabled: optional_boolean(object, "enabled"),
        allow_controller_cli: optional_boolean(object, "allowControllerCli"),
        connection,
    })
}

fn parse_executor_connection_update(value: &Value) -> Option<ExecutorConnectionUpdate> {
    let object = value.as_object()?;
    let direction = match object.get("direction")?.as_str()? {
        "executor-connects" => ExecutorDirection::ExecutorConnects,
        "controller-connects" => ExecutorDirection::ControllerConnects,
        _ => return None,
    };
    // Certificate verification cannot be switched off for an executor that
    // listens; only the dialing controller may skip it.
    if !has_only_keys(
        object,
        &["direction", "connectionUrl", "noTls", "allowUnverifiedTls"],
    ) || !absent_or_boolean(object.get("allowUnverifiedTls"))
        || direction == ExecutorDirection::ExecutorConnects
            && object.get("allowUnverifiedTls") == Some(&Value::Bool(true))
        || !object.get("connectionUrl").is_none_or(is_connection_url)
    {
        return None;
    }
    Some(ExecutorConnectionUpdate {
        direction,
        connection_url: optional_text(object, "connectionUrl"),
        no_tls: object.get("noTls")?.as_bool()?,
        allow_unverified_tls: optional_boolean(object, "allowUnverifiedTls"),
    })
}

/// Reads what the clients see of an executor.
pub fn parse_executor_snapshot(value: &Value) -> Option<ExecutorSnapshot> {
    let object = value.as_object()?;
    if !has_only_keys(
        object,
        &[
            "id",
            "label",
            "kind",
            "enabled",
            "direction",
            "availability",
            "bulk",
            "instanceId",
            "projectBasePath",
            "lastError",
            "executorServices",
            "allowControllerCli",
            "allowExecutorManagement",
        ],
    ) {
        return None;
    }
    let allow_executor_management = object.get("allowExecutorManagement")?.as_bool()?;
    let allow_controller_cli = object.get("allowControllerCli")?.as_bool()?;
    if !is_executor_id(object.get("id")?) {
        return None;
    }
    // INFALLIBLE: `is_executor_id` accepted the property, a string.
    let id = object
        .get("id")?
        .as_str()
        .expect("an executor ID is a string")
        .to_owned();
    let label = object
        .get("label")
        .and_then(Value::as_str)
        .filter(|label| is_label_text(label))?;
    let enabled = object.get("enabled")?.as_bool()?;
    let availability = match object.get("availability")?.as_str()? {
        "ready" => ExecutorSnapshotAvailability::Ready,
        "reconnecting" => ExecutorSnapshotAvailability::Reconnecting,
        "offline" => ExecutorSnapshotAvailability::Offline,
        _ => return None,
    };
    let instance_id = match object.get("instanceId")? {
        Value::Null => None,
        Value::String(instance_id) if !instance_id.is_empty() && utf16::len(instance_id) <= 128 => {
            Some(instance_id.clone())
        }
        _ => return None,
    };
    let project_base_path = match object.get("projectBasePath")? {
        Value::Null => None,
        Value::String(path) => Some(path.clone()),
        _ => return None,
    };
    let kind = if id == LOCAL_EXECUTOR_ID {
        if object.get("kind")?.as_str()? != "local"
            || !object.get("direction")?.is_null()
            || !enabled
        {
            return None;
        }
        ExecutorKind::Local
    } else {
        if object.get("kind")?.as_str()? != "remote" {
            return None;
        }
        ExecutorKind::Remote
    };
    let direction = match object.get("direction")? {
        Value::Null if kind == ExecutorKind::Local => None,
        Value::String(direction) if kind == ExecutorKind::Remote => {
            Some(match direction.as_str() {
                "executor-connects" => ExecutorDirection::ExecutorConnects,
                "controller-connects" => ExecutorDirection::ControllerConnects,
                _ => return None,
            })
        }
        _ => return None,
    };
    let services = object.get("executorServices")?.as_object()?;
    if !has_only_keys(
        services,
        &["files", "git", "gh", "terminals", "directoryCreation"],
    ) {
        return None;
    }
    let executor_services = ExecutorServices {
        files: services.get("files")?.as_bool()?,
        git: services.get("git")?.as_bool()?,
        gh: services.get("gh")?.as_bool()?,
        terminals: services.get("terminals")?.as_bool()?,
        directory_creation: services.get("directoryCreation")?.as_bool()?,
    };
    let last_error = parse_executor_error(object.get("lastError")?)?;
    let bulk = match (kind, object.get("bulk")?) {
        (ExecutorKind::Local, Value::Null) => None,
        (ExecutorKind::Remote, bulk) => {
            let bulk = bulk.as_object()?;
            if !has_only_keys(bulk, &["availability", "lastError"]) {
                return None;
            }
            let availability = match bulk.get("availability")?.as_str()? {
                "connecting" => ExecutorBulkAvailability::Connecting,
                "ready" => ExecutorBulkAvailability::Ready,
                "reconnecting" => ExecutorBulkAvailability::Reconnecting,
                "offline" => ExecutorBulkAvailability::Offline,
                _ => return None,
            };
            Some(ExecutorBulkStatus {
                availability,
                last_error: parse_executor_error(bulk.get("lastError")?)?,
            })
        }
        _ => return None,
    };
    Some(ExecutorSnapshot {
        id,
        label: label.to_owned(),
        kind,
        enabled,
        allow_controller_cli,
        allow_executor_management,
        direction,
        availability,
        bulk,
        instance_id,
        project_base_path,
        last_error,
        executor_services,
    })
}

/// Reads a list of executors. Two entries with the same ID reject the list.
pub fn parse_executors(value: &Value) -> Option<Vec<ExecutorSnapshot>> {
    let candidates = value.as_array()?;
    let mut executors: Vec<ExecutorSnapshot> = Vec::with_capacity(candidates.len());
    let mut ids: Vec<String> = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let executor = parse_executor_snapshot(candidate)?;
        if ids.contains(&executor.id) {
            return None;
        }
        ids.push(executor.id.clone());
        executors.push(executor);
    }
    Some(executors)
}

/// Reads the stored connection settings of an executor.
pub fn parse_executor_connection(value: &Value) -> Option<ExecutorConnection> {
    let object = value.as_object()?;
    if !object.get("connectionUrl").is_some_and(is_connection_url) {
        return None;
    }
    Some(ExecutorConnection {
        // INFALLIBLE: `is_connection_url` accepted the property, a string.
        connection_url: object
            .get("connectionUrl")?
            .as_str()
            .expect("a connection URL is a string")
            .to_owned(),
        no_tls: object.get("noTls")?.as_bool()?,
        allow_unverified_tls: object.get("allowUnverifiedTls")?.as_bool()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const REMOTE_ID: &str = "22222222-2222-4222-8222-222222222222";
    const BASE64URL_ALPHABET: &str =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    fn base64url(bytes: &[u8]) -> String {
        let alphabet = BASE64URL_ALPHABET.as_bytes();
        let mut text = String::new();
        for group in bytes.chunks(3) {
            let first = u32::from(group[0]);
            let second = u32::from(*group.get(1).unwrap_or(&0));
            let third = u32::from(*group.get(2).unwrap_or(&0));
            // INFALLIBLE: a 6-bit index is within the 64-character alphabet.
            text.push(alphabet[(first >> 2) as usize] as char);
            text.push(alphabet[((first & 3) << 4 | second >> 4) as usize] as char);
            if group.len() > 1 {
                text.push(alphabet[((second & 15) << 2 | third >> 6) as usize] as char);
            }
            if group.len() > 2 {
                text.push(alphabet[(third & 63) as usize] as char);
            }
        }
        text
    }

    fn remote() -> serde_json::Value {
        json!({
            "id": REMOTE_ID, "label": "Worker", "enabled": true, "kind": "remote", "direction": "executor-connects",
            "availability": "offline", "instanceId": null, "projectBasePath": null, "lastError": null,
            "bulk": { "availability": "offline", "lastError": null },
            "executorServices": { "files": false, "git": false, "gh": false, "terminals": false, "directoryCreation": false },
            "allowControllerCli": false, "allowExecutorManagement": false,
        })
    }

    #[test]
    fn executor_secrets_match_canonical_32_byte_base64url_encoding_in_browser_and_worker() {
        for suffix in BASE64URL_ALPHABET.chars() {
            let secret = format!("{}{suffix}", "A".repeat(42));
            // Decoding gives 32 bytes; encoding them again gives the same text
            // when the last character carries two zero padding bits.
            let canonical = BASE64URL_ALPHABET.find(suffix).unwrap() % 4 == 0;
            assert_eq!(is_executor_secret(&json!(secret)), canonical, "{secret}");
        }
        for byte in 0..=255_u8 {
            let secret = base64url(&[byte; 32]);
            assert!(is_executor_secret(&json!(secret)), "{secret}");
        }
        for value in [
            Value::Null,
            json!(3),
            json!(""),
            json!("A".repeat(42)),
            json!("A".repeat(44)),
            json!("+".repeat(43)),
            json!("/".repeat(43)),
            json!(format!("{}=", "A".repeat(43))),
        ] {
            assert!(!is_executor_secret(&value));
        }
        assert!(!is_executor_secret(&json!(undefined_marker())));
    }

    fn undefined_marker() -> serde_json::Value {
        json!({ "$": "undefined" })
    }

    #[test]
    fn only_absent_or_null_executor_identity_defaults_to_local() {
        for value in [Value::Null, json!(LOCAL_EXECUTOR_ID)] {
            assert_eq!(parse_executor_id(&value).as_deref(), Some("local"));
        }
        assert_eq!(effective_executor_id(Some(REMOTE_ID)), REMOTE_ID);
        assert_eq!(
            parse_executor_id(&json!(REMOTE_ID)).as_deref(),
            Some(REMOTE_ID)
        );
        assert_eq!(effective_executor_id(None), "local");
        assert_eq!(effective_executor_id(Some("")), "");
        for value in [
            json!(""),
            json!("unknown"),
            json!("LOCAL"),
            json!(3),
            json!({}),
            json!([]),
        ] {
            assert_eq!(parse_executor_id(&value), None, "{value}");
        }
        // A UUID in upper case, of another version, or with another variant is
        // not an executor ID.
        assert!(is_remote_executor_id(&json!(
            "22222222-2222-4222-8222-22222222222a"
        )));
        assert!(!is_remote_executor_id(&json!(
            "22222222-2222-4222-8222-22222222222A"
        )));
        assert!(!is_remote_executor_id(&json!(
            "22222222-2222-5222-8222-222222222222"
        )));
        assert!(!is_remote_executor_id(&json!(
            "22222222-2222-4222-c222-222222222222"
        )));
    }

    #[test]
    fn executor_mutation_contracts_reject_incomplete_and_extraneous_fields() {
        assert_eq!(
            parse_create_executor_request(
                &json!({ "label": " Worker ", "direction": "executor-connects" })
            ),
            Some(CreateExecutorRequest {
                label: "Worker".to_owned(),
                allow_executor_management: None,
                allow_controller_cli: None,
                no_tls: None,
                allow_unverified_tls: None,
                target: ExecutorConnectionTarget::ExecutorConnects {
                    advertised_url: None
                },
            })
        );
        assert_eq!(
            parse_create_executor_request(
                &json!({ "label": "Worker", "direction": "controller-connects" })
            ),
            None
        );
        assert_eq!(
            parse_create_executor_request(
                &json!({ "label": "Worker", "direction": "executor-connects", "secret": "hidden" })
            ),
            None
        );
        assert_eq!(parse_update_executor_request(&json!({})), None);
        assert_eq!(
            parse_update_executor_request(&json!({ "enabled": false })),
            Some(UpdateExecutorRequest {
                allow_executor_management: None,
                label: None,
                enabled: Some(false),
                allow_controller_cli: None,
                connection: None,
            })
        );
        assert_eq!(
            parse_update_executor_request(&json!({ "label": " " })),
            None
        );
        assert_eq!(
            parse_update_executor_request(
                &json!({ "connection": { "direction": "executor-connects", "connectionUrl": "url" } })
            ),
            None
        );
        assert_eq!(parse_update_executor_request(&Value::Null), None);
    }

    #[test]
    fn certificate_verification_opt_out_is_explicit_and_only_applies_to_the_dialing_controller() {
        let request = json!({
            "label": "Worker",
            "direction": "controller-connects",
            "connectionUrl": "wss://worker.test/executor#secret=synthetic",
        });
        let mut opted_out = request.clone();
        opted_out["allowUnverifiedTls"] = json!(true);
        assert_eq!(
            parse_create_executor_request(&opted_out)
                .and_then(|request| request.allow_unverified_tls),
            Some(true)
        );
        let mut as_text = request.clone();
        as_text["allowUnverifiedTls"] = json!("true");
        assert_eq!(parse_create_executor_request(&as_text), None);
        assert_eq!(
            parse_create_executor_request(
                &json!({ "label": "Worker", "direction": "executor-connects", "allowUnverifiedTls": true })
            ),
            None
        );
        let connection = json!({
            "direction": "controller-connects",
            "connectionUrl": "wss://worker.test/executor#secret=synthetic",
            "noTls": false,
            "allowUnverifiedTls": true,
        });
        let expected = UpdateExecutorRequest {
            allow_executor_management: None,
            label: None,
            enabled: None,
            allow_controller_cli: None,
            connection: Some(ExecutorConnectionUpdate {
                direction: ExecutorDirection::ControllerConnects,
                connection_url: Some("wss://worker.test/executor#secret=synthetic".to_owned()),
                no_tls: false,
                allow_unverified_tls: Some(true),
            }),
        };
        assert_eq!(
            parse_update_executor_request(&json!({ "connection": connection })),
            Some(expected.clone())
        );
        let mut listening = connection.clone();
        listening["direction"] = json!("executor-connects");
        assert_eq!(
            parse_update_executor_request(&json!({ "connection": listening })),
            None
        );
        let mut as_number = connection.clone();
        as_number["allowUnverifiedTls"] = json!(1);
        assert_eq!(
            parse_update_executor_request(&json!({ "connection": as_number })),
            None
        );
    }

    #[test]
    fn management_grants_are_explicit_booleans_independent_of_workspace_cli_access() {
        let request = json!({ "label": "Worker", "direction": "executor-connects" });
        for granted in [true, false] {
            let mut with_grant = request.clone();
            with_grant["allowExecutorManagement"] = json!(granted);
            assert_eq!(
                parse_create_executor_request(&with_grant)
                    .and_then(|request| request.allow_executor_management),
                Some(granted)
            );
            assert_eq!(
                parse_update_executor_request(&json!({ "allowExecutorManagement": granted })),
                Some(UpdateExecutorRequest {
                    allow_executor_management: Some(granted),
                    label: None,
                    enabled: None,
                    allow_controller_cli: None,
                    connection: None,
                })
            );
        }
        for granted in [Value::Null, json!("true"), json!(1), json!({})] {
            let mut with_grant = request.clone();
            with_grant["allowExecutorManagement"] = granted.clone();
            assert_eq!(
                parse_create_executor_request(&with_grant),
                None,
                "{granted}"
            );
            assert_eq!(
                parse_update_executor_request(&json!({ "allowExecutorManagement": granted })),
                None
            );
        }
    }

    #[test]
    fn connection_updates_permit_an_omitted_url_but_reject_empty_or_malformed_url_fields() {
        for direction in ["executor-connects", "controller-connects"] {
            let connection = json!({ "direction": direction, "noTls": true });
            assert_eq!(
                parse_update_executor_request(&json!({ "connection": connection.clone() })),
                Some(UpdateExecutorRequest {
                    allow_executor_management: None,
                    label: None,
                    enabled: None,
                    allow_controller_cli: None,
                    connection: Some(ExecutorConnectionUpdate {
                        direction: if direction == "executor-connects" {
                            ExecutorDirection::ExecutorConnects
                        } else {
                            ExecutorDirection::ControllerConnects
                        },
                        connection_url: None,
                        no_tls: true,
                        allow_unverified_tls: None,
                    }),
                })
            );
            for connection_url in [json!(""), Value::Null, json!(3)] {
                let mut with_url = connection.clone();
                with_url["connectionUrl"] = connection_url;
                assert_eq!(
                    parse_update_executor_request(&json!({ "connection": with_url })),
                    None
                );
            }
        }
    }

    #[test]
    fn public_snapshots_exclude_credentials_and_preserve_unavailable_remote_targets() {
        let remote = remote();
        assert_eq!(
            parse_executors(&json!([remote.clone()])),
            Some(vec![parse_executor_snapshot(&remote).unwrap()])
        );
        assert_eq!(
            serde_json::to_value(parse_executor_snapshot(&remote).unwrap()).unwrap(),
            remote
        );
        let ready = json!({
            "id": REMOTE_ID, "label": "Worker", "enabled": true, "kind": "remote", "direction": "executor-connects",
            "availability": "ready", "instanceId": "synthetic-instance", "projectBasePath": "/", "lastError": null,
            "bulk": { "availability": "offline", "lastError": null },
            "executorServices": { "files": false, "git": false, "gh": false, "terminals": false, "directoryCreation": false },
            "allowControllerCli": false, "allowExecutorManagement": false,
        });
        let mut reconnecting = ready.clone();
        reconnecting["availability"] = json!("reconnecting");
        assert_eq!(
            parse_executors(&json!([reconnecting.clone()])),
            Some(vec![parse_executor_snapshot(&reconnecting).unwrap()])
        );
        let mut resuming = ready.clone();
        resuming["availability"] = json!("resuming");
        assert_eq!(parse_executors(&json!([resuming])), None);
        for instance_id in [
            undefined_marker(),
            json!(""),
            json!(3),
            json!({}),
            json!("x".repeat(129)),
        ] {
            let mut snapshot = remote.clone();
            if instance_id == undefined_marker() {
                snapshot.as_object_mut().unwrap().shift_remove("instanceId");
            } else {
                snapshot["instanceId"] = instance_id.clone();
            }
            assert_eq!(parse_executors(&json!([snapshot])), None, "{instance_id}");
        }
        let mut without_directory_creation = remote.clone();
        without_directory_creation["executorServices"]
            .as_object_mut()
            .unwrap()
            .shift_remove("directoryCreation");
        let mut directory_creation_as_text = remote.clone();
        directory_creation_as_text["executorServices"]["directoryCreation"] = json!("yes");
        for executor_services in [
            without_directory_creation["executorServices"].clone(),
            directory_creation_as_text["executorServices"].clone(),
        ] {
            let mut snapshot = remote.clone();
            snapshot["executorServices"] = executor_services;
            assert_eq!(parse_executors(&json!([snapshot])), None);
        }
        for extra in [
            json!({ "secret": "hidden" }),
            json!({ "connectionUrl": "hidden" }),
        ] {
            let mut snapshot = remote.clone();
            snapshot
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert_eq!(parse_executors(&json!([snapshot])), None);
        }
        assert_eq!(
            parse_executors(&json!([remote.clone(), remote.clone()])),
            None
        );
        let mut local_id = ready.clone();
        local_id["id"] = json!("local");
        assert_eq!(parse_executors(&json!([local_id])), None);
        for availability in ["connecting", "ready", "reconnecting", "offline"] {
            let mut partial = ready.clone();
            partial["bulk"] = json!({
                "availability": availability,
                "lastError": { "code": "EXECUTOR_BULK_UNAVAILABLE", "message": "Synthetic failure" },
            });
            assert_eq!(
                serde_json::to_value(parse_executors(&json!([partial.clone()])).unwrap()).unwrap(),
                json!([partial])
            );
        }
        for bulk in [
            Value::Null,
            undefined_marker(),
            json!({}),
            json!({ "availability": "waiting", "lastError": null }),
            json!({ "availability": "ready", "lastError": { "code": 1, "message": "Invalid" } }),
            json!({ "availability": "ready", "lastError": null, "secret": "hidden" }),
        ] {
            let mut snapshot = remote.clone();
            if bulk == undefined_marker() {
                snapshot.as_object_mut().unwrap().shift_remove("bulk");
            } else {
                snapshot["bulk"] = bulk.clone();
            }
            assert_eq!(parse_executors(&json!([snapshot])), None, "{bulk}");
        }
        let mut local = ready.clone();
        local["id"] = json!("local");
        local["kind"] = json!("local");
        local["direction"] = Value::Null;
        local["bulk"] = Value::Null;
        assert_eq!(
            serde_json::to_value(parse_executors(&json!([local.clone()])).unwrap()).unwrap(),
            json!([local])
        );
        let mut local_with_bulk = local.clone();
        local_with_bulk["bulk"] = ready["bulk"].clone();
        assert_eq!(parse_executors(&json!([local_with_bulk])), None);
        assert_eq!(parse_executors(&json!(remote)), None);
        assert_eq!(parse_executor_snapshot(&json!([])), None);
        assert_eq!(
            parse_executor_connection(
                &json!({ "connectionUrl": "wss://worker.test", "noTls": true, "allowUnverifiedTls": false })
            ),
            Some(ExecutorConnection {
                connection_url: "wss://worker.test".to_owned(),
                no_tls: true,
                allow_unverified_tls: false,
            })
        );
        assert_eq!(
            parse_executor_connection(
                &json!({ "connectionUrl": "wss://worker.test", "noTls": true })
            ),
            None
        );
    }
}
