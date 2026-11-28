//! Owns the private, controller-side executor configuration file.

use std::cell::RefCell;
use std::collections::HashSet;
use std::error::Error;
use std::future::Future;
use std::rc::Rc;

use garcon_base::{
    domain_error::DomainError,
    json_file_store::{JsonFileStore, JsonWriteOptions, ReadJsonStateError, WriteFileError},
    keyed_lock::KeyedLock,
    private_file::assert_private_file,
};
use garcon_contract::{
    error_codes::ErrorCode,
    executors::{
        ExecutorConnection, ExecutorConnectionTarget, ExecutorDirection, LOCAL_EXECUTOR_LABEL,
        is_executor_secret, is_remote_executor_id, parse_create_executor_request,
        parse_update_executor_request,
    },
};
use garcon_js::{path::native, trim, utf16};
use garcon_link::connection_url::{
    ExecutorSocketUrlOptions, create_executor_secret, executor_connection_url,
    parse_connection_url, validate_executor_socket_url,
};
use serde::{Serialize, Serializer, ser::SerializeStruct};
use serde_json::Value;
use tokio_util::task::TaskTracker;

use super::public_url::executor_public_url;

type BoxError = Box<dyn Error>;
type Result<T> = std::result::Result<T, BoxError>;
pub type AssertExecutorUpdate =
    Box<dyn FnOnce(&RemoteExecutorConfig, &RemoteExecutorConfig) -> Result<()>>;
const WRITE_LOCK: &str = "executor-config";

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RemoteExecutorConnection {
    ExecutorConnects {
        #[serde(rename = "advertisedUrl")]
        advertised_url: Option<String>,
    },
    ControllerConnects {
        #[serde(rename = "targetUrl")]
        target_url: String,
    },
}

impl RemoteExecutorConnection {
    fn direction(&self) -> ExecutorDirection {
        match self {
            Self::ExecutorConnects { .. } => ExecutorDirection::ExecutorConnects,
            Self::ControllerConnects { .. } => ExecutorDirection::ControllerConnects,
        }
    }

    fn address(&self) -> Option<&str> {
        match self {
            Self::ExecutorConnects { advertised_url } => advertised_url.as_deref(),
            Self::ControllerConnects { target_url } => Some(target_url),
        }
    }
}

#[derive(Clone)]
pub struct RemoteExecutorConfig {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub allow_controller_cli: bool,
    pub allow_executor_management: bool,
    pub secret: String,
    pub connection: RemoteExecutorConnection,
    pub no_tls: bool,
    pub allow_unverified_tls: bool,
    // The original's create and file-read constructors insert the keys in different orders.
    created_here: bool,
}

impl Serialize for RemoteExecutorConfig {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut fields = serializer.serialize_struct("RemoteExecutorConfig", 9)?;
        fields.serialize_field("id", &self.id)?;
        fields.serialize_field("label", &self.label)?;
        fields.serialize_field("enabled", &self.enabled)?;
        if self.created_here {
            fields.serialize_field("noTls", &self.no_tls)?;
        } else {
            fields.serialize_field("secret", &self.secret)?;
            fields.serialize_field("connection", &self.connection)?;
        }
        fields.serialize_field("allowControllerCli", &self.allow_controller_cli)?;
        fields.serialize_field("allowExecutorManagement", &self.allow_executor_management)?;
        if !self.created_here {
            fields.serialize_field("noTls", &self.no_tls)?;
        }
        fields.serialize_field("allowUnverifiedTls", &self.allow_unverified_tls)?;
        if self.created_here {
            fields.serialize_field("secret", &self.secret)?;
            fields.serialize_field("connection", &self.connection)?;
        }
        fields.end()
    }
}

#[derive(Serialize)]
struct StoredConfig<'a> {
    version: u8,
    executors: &'a [RemoteExecutorConfig],
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
struct ExecutorConfigUpgradeError {
    message: String,
    #[source]
    cause: Option<BoxError>,
}

struct WriteFailure {
    renamed: bool,
    source: BoxError,
}

#[async_trait::async_trait(?Send)]
trait ConfigWriter {
    async fn write(
        &self,
        path: &str,
        executors: &[RemoteExecutorConfig],
    ) -> std::result::Result<(), WriteFailure>;
}

#[async_trait::async_trait(?Send)]
impl ConfigWriter for JsonFileStore {
    async fn write(
        &self,
        path: &str,
        executors: &[RemoteExecutorConfig],
    ) -> std::result::Result<(), WriteFailure> {
        self.write_json_file_atomic(
            path,
            &StoredConfig {
                version: 1,
                executors,
            },
            JsonWriteOptions {
                mode: Some(0o600),
                ..Default::default()
            },
        )
        .await
        .map_err(|error| WriteFailure {
            renamed: matches!(&error, WriteFileError::Atomic(error) if error.renamed),
            source: error.into(),
        })
    }
}

#[derive(Default)]
struct State {
    executors: Vec<RemoteExecutorConfig>,
    uncertain_executor_id: Option<String>,
}

pub struct ExecutorConfigStore {
    path: String,
    state: RefCell<State>,
    lock: KeyedLock,
    writes: TaskTracker,
    writer: Rc<dyn ConfigWriter>,
    executor_id: fn() -> String,
    executor_secret: fn() -> String,
}

impl ExecutorConfigStore {
    pub async fn open(workspace: &str) -> Result<Rc<Self>> {
        Self::open_with(
            workspace,
            Rc::new(JsonFileStore::default()),
            || uuid::Uuid::new_v4().to_string(),
            create_executor_secret,
        )
        .await
    }

    async fn open_with(
        workspace: &str,
        writer: Rc<dyn ConfigWriter>,
        executor_id: fn() -> String,
        executor_secret: fn() -> String,
    ) -> Result<Rc<Self>> {
        let path = native::join(&[workspace, "executors.json"]);
        assert_private_file(&path).await?;
        let executors = JsonFileStore::default()
            .read_json_state_file(&path, Vec::new, |value| normalize_snapshot(&value))
            .await
            .map_err(|error| describe_open_error(&path, error))?;
        Ok(Rc::new(Self {
            path,
            state: RefCell::new(State {
                executors,
                ..Default::default()
            }),
            lock: KeyedLock::new(),
            writes: TaskTracker::new(),
            writer,
            executor_id,
            executor_secret,
        }))
    }

    pub async fn drain(&self) {
        self.writes.close();
        self.writes.wait().await;
    }

    pub fn list(&self) -> Vec<RemoteExecutorConfig> {
        self.state.borrow().executors.clone()
    }

    pub fn is_durable(&self, id: &str) -> bool {
        self.state.borrow().uncertain_executor_id.as_deref() != Some(id)
    }

    pub fn get(&self, id: &str) -> Option<RemoteExecutorConfig> {
        self.state
            .borrow()
            .executors
            .iter()
            .find(|executor| executor.id == id)
            .cloned()
    }

    pub fn require(&self, id: &str) -> Result<RemoteExecutorConfig> {
        if !self.is_durable(id) {
            return Err(unavailable().into());
        }
        self.get(id).ok_or_else(|| {
            DomainError::new(
                ErrorCode::EXECUTOR_NOT_FOUND,
                "Executor not found",
                404,
                false,
            )
            .into()
        })
    }

    pub fn connection(&self, id: &str, public_base: Option<&str>) -> Result<ExecutorConnection> {
        let executor = self.require(id)?;
        Ok(ExecutorConnection {
            connection_url: resolve_connection_url(&executor, public_base)?,
            no_tls: executor.no_tls,
            allow_unverified_tls: executor.allow_unverified_tls,
        })
    }

    pub async fn create(
        self: &Rc<Self>,
        raw: Value,
        public_base: Option<String>,
    ) -> Result<RemoteExecutorConfig> {
        self.serialized(move |store| async move {
            let request = parse_create_executor_request(&raw)
                .ok_or_else(|| DomainError::new_validation("Invalid executor configuration"))?;
            store.assert_label_available(&request.label, None)?;
            let id = (store.executor_id)();
            let no_tls = request.no_tls.unwrap_or_default();
            let (connection, secret, allow_unverified_tls) = match request.target {
                ExecutorConnectionTarget::ExecutorConnects { advertised_url } => {
                    let address = advertised_url
                        .map(|url| validate_socket(&url.replace("{executorId}", &id), no_tls))
                        .transpose()?;
                    (
                        RemoteExecutorConnection::ExecutorConnects {
                            advertised_url: address,
                        },
                        (store.executor_secret)(),
                        false,
                    )
                }
                ExecutorConnectionTarget::ControllerConnects { connection_url } => {
                    let parsed = parse_connection_url(&connection_url)?;
                    let allow = parsed.socket_url.starts_with("wss:")
                        && request.allow_unverified_tls == Some(true);
                    let target_url = validate_socket(&parsed.socket_url, no_tls)?;
                    (
                        RemoteExecutorConnection::ControllerConnects { target_url },
                        parsed.secret,
                        allow,
                    )
                }
            };
            let executor = RemoteExecutorConfig {
                id,
                label: request.label,
                enabled: true,
                no_tls,
                allow_controller_cli: request.allow_controller_cli.unwrap_or_default(),
                allow_executor_management: request.allow_executor_management.unwrap_or_default(),
                connection,
                secret,
                allow_unverified_tls,
                created_here: true,
            };
            resolve_connection_url(&executor, public_base.as_deref())?;
            let mut candidate = store.list();
            candidate.push(executor.clone());
            store.save(candidate, &executor.id).await?;
            Ok(executor)
        })
        .await
    }

    pub async fn update(
        self: &Rc<Self>,
        id: String,
        raw: Value,
        assert_allowed: Option<AssertExecutorUpdate>,
    ) -> Result<RemoteExecutorConfig> {
        self.serialized(move |store| async move {
            let request = parse_update_executor_request(&raw).ok_or_else(|| DomainError::new_validation("Invalid executor update"))?;
            let previous = store.require(&id)?;
            let mut executor = previous.clone();
            if let Some(label) = request.label {
                if label != trim(&previous.label) { store.assert_label_available(&label, Some(&id))?; }
                executor.label = label;
            }
            if let Some(enabled) = request.enabled { executor.enabled = enabled; }
            if let Some(allowed) = request.allow_controller_cli { executor.allow_controller_cli = allowed; }
            if let Some(allowed) = request.allow_executor_management { executor.allow_executor_management = allowed; }
            if let Some(change) = request.connection {
                if change.connection_url.is_none() && change.direction != previous.connection.direction() {
                    return Err(DomainError::new_validation("Changing connection direction requires a connection URL").into());
                }
                let parsed = change.connection_url.as_deref().map(parse_connection_url).transpose()?;
                let address = parsed.as_ref().map(|value| value.socket_url.as_str()).or_else(|| previous.connection.address())
                    .map(|value| validate_socket(value, change.no_tls)).transpose()?;
                executor.connection = match change.direction {
                    ExecutorDirection::ExecutorConnects => RemoteExecutorConnection::ExecutorConnects { advertised_url: address },
                    ExecutorDirection::ControllerConnects => RemoteExecutorConnection::ControllerConnects {
                        // A change to this direction requires a URL, and an existing target always has one.
                        target_url: address.ok_or_else(|| DomainError::new_validation("Changing connection direction requires a connection URL"))?,
                    },
                };
                if let Some(parsed) = parsed { executor.secret = parsed.secret; }
                executor.no_tls = change.no_tls;
                executor.allow_unverified_tls = change.allow_unverified_tls == Some(true)
                    && matches!(&executor.connection, RemoteExecutorConnection::ControllerConnects { target_url } if target_url.starts_with("wss:"));
                resolve_connection_url(&executor, None)?;
            }
            if let Some(guard) = assert_allowed { guard(&previous, &executor)?; }
            let candidate = store.list().into_iter().map(|entry| if entry.id == id { executor.clone() } else { entry }).collect();
            store.save(candidate, &id).await?;
            Ok(executor)
        }).await
    }

    pub async fn remove(self: &Rc<Self>, id: String) -> Result<()> {
        self.serialized(move |store| async move {
            store.require(&id)?;
            let candidate = store
                .list()
                .into_iter()
                .filter(|entry| entry.id != id)
                .collect();
            store.save(candidate, &id).await
        })
        .await
    }

    async fn serialized<T, F, Fut>(self: &Rc<Self>, operation: F) -> Result<T>
    where
        T: 'static,
        F: FnOnce(Rc<Self>) -> Fut + 'static,
        Fut: Future<Output = Result<T>> + 'static,
    {
        let store = self.clone();
        // A disconnected caller must not release the write lock before a rename settles.
        self.writes
            .spawn_local(async move {
                store
                    .lock
                    .run_exclusive(
                        WRITE_LOCK,
                        || async {
                            if store.state.borrow().uncertain_executor_id.is_some() {
                                return Err(unavailable().into());
                            }
                            operation(store.clone()).await
                        },
                        None,
                    )
                    .await?
            })
            .await?
    }

    fn assert_label_available(&self, label: &str, id: Option<&str>) -> Result<()> {
        let normalized = trim(label).to_lowercase();
        if normalized == LOCAL_EXECUTOR_LABEL.to_lowercase() {
            return Err(DomainError::new_validation(
                "The label \"Local\" is reserved for the local executor",
            )
            .into());
        }
        if self.state.borrow().executors.iter().any(|executor| {
            id != Some(executor.id.as_str()) && trim(&executor.label).to_lowercase() == normalized
        }) {
            return Err(DomainError::new_validation(
                "An executor with this label already exists (case-insensitive)",
            )
            .into());
        }
        Ok(())
    }

    async fn save(&self, candidate: Vec<RemoteExecutorConfig>, id: &str) -> Result<()> {
        assert_unique_executors(&candidate)?;
        if let Err(failure) = self.writer.write(&self.path, &candidate).await {
            if failure.renamed {
                self.state.replace(State {
                    executors: candidate,
                    uncertain_executor_id: Some(id.into()),
                });
            }
            return Err(failure.source);
        }
        self.state.borrow_mut().executors = candidate;
        Ok(())
    }
}

fn unavailable() -> DomainError {
    DomainError::new(
        ErrorCode::EXECUTOR_UNAVAILABLE,
        "Executor configuration durability is unknown. Restart the controller before changing executors.",
        503,
        false,
    )
}

fn validate_socket(url: &str, no_tls: bool) -> std::result::Result<String, DomainError> {
    validate_executor_socket_url(
        url,
        ExecutorSocketUrlOptions {
            no_tls,
            allow_placeholder: false,
        },
    )
}

fn resolve_connection_url(
    executor: &RemoteExecutorConfig,
    public_base: Option<&str>,
) -> Result<String> {
    let advertised;
    let address = match (
        executor.connection.address(),
        public_base.filter(|base| !base.is_empty()),
    ) {
        (Some(address), _) => address,
        (None, None) => return Ok(String::new()),
        (None, Some(base)) => {
            advertised = executor_public_url(base, &executor.id)?;
            advertised.as_str()
        }
    };
    let url = executor_connection_url(address, &executor.secret)?;
    if utf16::len(&url) > 4096 {
        return Err(DomainError::new_validation(
            "Executor connection URL exceeds 4096 characters after address expansion",
        )
        .into());
    }
    Ok(url)
}

fn normalize_snapshot(value: &Value) -> Result<Vec<RemoteExecutorConfig>> {
    let entries = value["executors"]
        .as_array()
        .filter(|_| value["version"].as_f64() == Some(1.0))
        .ok_or("Invalid executor configuration")?;
    let executors: Vec<_> = entries
        .iter()
        .map(parse_stored_executor)
        .collect::<Result<_>>()?;
    assert_unique_executors(&executors)?;
    Ok(executors)
}

fn parse_stored_executor(value: &Value) -> Result<RemoteExecutorConfig> {
    if value.get("allowInsecureDevelopment").is_some() {
        return Err(Box::new(ExecutorConfigUpgradeError { message: "Executor configuration uses retired allowInsecureDevelopment; rename it to noTls, preserving its boolean value.".into(), cause: None }));
    }
    let invalid = "Invalid executor configuration";
    let id = value["id"]
        .as_str()
        .filter(|_| is_remote_executor_id(&value["id"]))
        .ok_or(invalid)?;
    let label = value["label"]
        .as_str()
        .filter(|label| !trim(label).is_empty() && utf16::len(label) <= 100)
        .ok_or(invalid)?;
    let enabled = value["enabled"].as_bool().ok_or(invalid)?;
    let secret = value["secret"]
        .as_str()
        .filter(|_| is_executor_secret(&value["secret"]))
        .ok_or(invalid)?;
    let no_tls = value["noTls"].as_bool().ok_or(invalid)?;
    let boolean = |field| -> Result<bool> {
        value.get(field).map_or(Ok(false), |value| {
            value.as_bool().ok_or_else(|| invalid.into())
        })
    };
    let allow_controller_cli = boolean("allowControllerCli")?;
    let allow_executor_management = boolean("allowExecutorManagement")?;
    let allow_unverified_tls = boolean("allowUnverifiedTls")?;
    let stored = value["connection"].as_object().ok_or(invalid)?;
    let invalid_connection = || -> BoxError { "Invalid executor connection configuration".into() };
    let connection = match stored.get("kind").and_then(Value::as_str) {
        Some("executor-connects") => {
            let address = match stored.get("advertisedUrl") {
                Some(Value::Null) => None,
                Some(Value::String(address)) => Some(validate_socket(address, no_tls)?),
                _ => return Err(invalid_connection()),
            };
            if allow_unverified_tls {
                return Err(invalid_connection());
            }
            RemoteExecutorConnection::ExecutorConnects {
                advertised_url: address,
            }
        }
        Some("controller-connects") => RemoteExecutorConnection::ControllerConnects {
            target_url: validate_socket(
                stored
                    .get("targetUrl")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid_connection)?,
                no_tls,
            )?,
        },
        _ => return Err(invalid_connection()),
    };
    let allow_unverified_tls = allow_unverified_tls
        && matches!(&connection, RemoteExecutorConnection::ControllerConnects { target_url } if target_url.starts_with("wss:"));
    Ok(RemoteExecutorConfig {
        id: id.into(),
        label: label.into(),
        enabled,
        secret: secret.into(),
        connection,
        allow_controller_cli,
        allow_executor_management,
        no_tls,
        allow_unverified_tls,
        created_here: false,
    })
}

fn assert_unique_executors(executors: &[RemoteExecutorConfig]) -> Result<()> {
    let mut ids = HashSet::new();
    let mut secrets = HashSet::new();
    if executors
        .iter()
        .any(|executor| !ids.insert(&executor.id) || !secrets.insert(&executor.secret))
    {
        return Err(DomainError::new_validation(
            "Executors must have unique IDs and shared secrets",
        )
        .into());
    }
    Ok(())
}

fn describe_open_error(path: &str, error: ReadJsonStateError) -> BoxError {
    if let ReadJsonStateError::Corrupt(corrupt) = &error
        && let Some(upgrade) = corrupt
            .source()
            .and_then(|cause| cause.downcast_ref::<ExecutorConfigUpgradeError>())
    {
        let quarantine = corrupt.quarantine_path.as_deref().unwrap_or(path);
        let message = format!(
            "{upgrade} Update a copy of {quarantine} and restore it to {path} before restarting; keep the original backup."
        );
        let ReadJsonStateError::Corrupt(corrupt) = error else {
            // INFALLIBLE: this is the error borrowed by the enclosing branch.
            unreachable!();
        };
        return Box::new(ExecutorConfigUpgradeError {
            message,
            cause: Some(Box::new(corrupt)),
        });
    }
    error.into()
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use garcon_base::domain_error::as_domain_error;
    use serde_json::json;
    use tokio::{sync::Notify, task::LocalSet};

    use super::*;

    #[derive(Default)]
    struct FaultWriter {
        disk: JsonFileStore,
        fail: Cell<Option<bool>>,
    }

    #[async_trait::async_trait(?Send)]
    impl ConfigWriter for FaultWriter {
        async fn write(
            &self,
            path: &str,
            executors: &[RemoteExecutorConfig],
        ) -> std::result::Result<(), WriteFailure> {
            if let Some(renamed) = self.fail.take() {
                if renamed {
                    ConfigWriter::write(&self.disk, path, executors).await?;
                }
                return Err(WriteFailure {
                    renamed,
                    source: "synthetic disk failure".into(),
                });
            }
            ConfigWriter::write(&self.disk, path, executors).await
        }
    }

    fn create(label: &str) -> Value {
        json!({"direction":"executor-connects","label":label})
    }

    #[tokio::test]
    async fn uncertain_config_fences_only_the_affected_credential_and_every_later_write() {
        LocalSet::new().run_until(async {
            for operation in ["grant", "revoke", "enable", "connector", "remove", "create"] {
                let root = tempfile::tempdir().unwrap();
                let workspace = root.path().to_str().unwrap();
                let writer = Rc::new(FaultWriter::default());
                let store = ExecutorConfigStore::open_with(workspace, writer.clone(), || uuid::Uuid::new_v4().to_string(), create_executor_secret).await.unwrap();
                let affected = store.create(create("Affected"), None).await.unwrap();
                let healthy = store.create(create("Healthy"), None).await.unwrap();
                if operation == "enable" { store.update(affected.id.clone(), json!({"enabled":false}), None).await.unwrap(); }
                if operation == "revoke" { store.update(affected.id.clone(), json!({"allowControllerCli":true}), None).await.unwrap(); }
                let path = root.path().join("executors.json");
                let before = tokio::fs::read(&path).await.unwrap();
                writer.fail.set(Some(false));
                assert!(store.update(affected.id.clone(), json!({"label":"Definite failure"}), None).await.is_err());
                assert!(store.is_durable(&affected.id));
                assert_eq!(tokio::fs::read(&path).await.unwrap(), before);
                writer.fail.set(Some(true));
                let result = match operation {
                    "create" => store.create(json!({"direction":"executor-connects","label":"Candidate","allowControllerCli":true}), None).await.map(|_| ()),
                    "remove" => store.remove(affected.id.clone()).await,
                    "grant" => store.update(affected.id.clone(), json!({"allowControllerCli":true,"allowExecutorManagement":true}), None).await.map(|_| ()),
                    "revoke" => store.update(affected.id.clone(), json!({"allowControllerCli":false}), None).await.map(|_| ()),
                    "enable" => store.update(affected.id.clone(), json!({"enabled":true}), None).await.map(|_| ()),
                    _ => store.update(affected.id.clone(), json!({"connection":{"direction":"executor-connects","noTls":true}}), None).await.map(|_| ()),
                };
                assert!(result.is_err());
                let fenced = if operation == "create" { store.list().last().unwrap().id.clone() } else { affected.id };
                assert!(!store.is_durable(&fenced));
                let error = store.connection(&fenced, Some("https://synthetic.test")).unwrap_err();
                assert_eq!(as_domain_error(error.as_ref()).unwrap().code, ErrorCode::EXECUTOR_UNAVAILABLE);
                assert_eq!(store.require(&healthy.id).unwrap().label, "Healthy");
                let persisted = tokio::fs::read(&path).await.unwrap();
                for error in [
                    store.update(healthy.id.clone(), json!({"label":"Changed"}), None).await.err().unwrap(),
                    store.create(create("New"), None).await.err().unwrap(),
                    store.remove(healthy.id.clone()).await.err().unwrap(),
                ] { assert_eq!(as_domain_error(error.as_ref()).unwrap().code, ErrorCode::EXECUTOR_UNAVAILABLE); }
                assert_eq!(tokio::fs::read(&path).await.unwrap(), persisted);
                let reopened = ExecutorConfigStore::open(workspace).await.unwrap();
                assert!(reopened.is_durable(&fenced));
                assert_eq!(serde_json::to_value(reopened.list()).unwrap(), serde_json::to_value(store.list()).unwrap());
            }
        }).await;
    }

    #[derive(Default)]
    struct StagedWriter {
        disk: JsonFileStore,
        started: Notify,
        release: Notify,
        held: Cell<bool>,
    }

    #[async_trait::async_trait(?Send)]
    impl ConfigWriter for StagedWriter {
        async fn write(
            &self,
            path: &str,
            executors: &[RemoteExecutorConfig],
        ) -> std::result::Result<(), WriteFailure> {
            if !self.held.replace(true) {
                self.started.notify_one();
                self.release.notified().await;
            }
            ConfigWriter::write(&self.disk, path, executors).await
        }
    }

    #[tokio::test]
    async fn cancelling_a_caller_does_not_release_the_config_write_lock() {
        LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let writer = Rc::new(StagedWriter::default());
                let store = ExecutorConfigStore::open_with(
                    root.path().to_str().unwrap(),
                    writer.clone(),
                    || uuid::Uuid::new_v4().to_string(),
                    create_executor_secret,
                )
                .await
                .unwrap();
                let caller = tokio::task::spawn_local({
                    let store = store.clone();
                    async move { store.create(create("Cancelled caller"), None).await }
                });
                writer.started.notified().await;
                caller.abort();
                assert!(caller.await.is_err());
                let next = tokio::task::spawn_local({
                    let store = store.clone();
                    async move { store.create(create("Second caller"), None).await }
                });
                tokio::task::yield_now().await;
                assert!(store.list().is_empty());
                writer.release.notify_one();
                next.await.unwrap().unwrap();
                store.drain().await;
                assert_eq!(
                    store
                        .list()
                        .into_iter()
                        .map(|entry| entry.label)
                        .collect::<Vec<_>>(),
                    ["Cancelled caller", "Second caller"]
                );
            })
            .await;
    }
}
