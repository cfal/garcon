use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;
use std::rc::Rc;

use async_trait::async_trait;
use futures::future::LocalBoxFuture;
use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_base::path_boundary::realpath;
use garcon_contract::agent_execution::AgentCredentialReference;
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::host::{
    AgentApiProviderReader, AgentEnvironmentReader, AgentHost, AgentLegacyDirectoryClaim,
    AgentLogger, AgentResolveCredentialRequest, AgentResolvedCredential, AgentScopedStorage,
};
use garcon_interface::resources::{AgentResourceScope, ExecutorResult};
use garcon_js::json::Opaque;
use garcon_js::path::native;
use indexmap::IndexMap;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::integration_migration_store::FileAgentMigrationStore;

pub struct ResolveIntegrationCredentialRequest {
    pub executor_id: String,
    pub agent_id: String,
    pub reference: AgentCredentialReference,
    pub signal: CancellationToken,
}

pub type ResolveIntegrationCredential =
    dyn Fn(
        ResolveIntegrationCredentialRequest,
    ) -> LocalBoxFuture<'static, ExecutorResult<Option<AgentResolvedCredential>>>;
pub type ReadIntegrationEnvironment = dyn Fn(&str) -> Option<String>;
pub type IntegrationLoggerFactory = dyn Fn(&str) -> Rc<dyn AgentLogger>;

pub struct IntegrationHostFactoryOptions {
    pub workspace_dir: String,
    pub executor_id: Option<String>,
    pub instance_id: Option<String>,
    pub resolve_credential: Rc<ResolveIntegrationCredential>,
    pub read_environment: Option<Rc<ReadIntegrationEnvironment>>,
    pub logger_factory: Option<Rc<IntegrationLoggerFactory>>,
}

struct BoundEnvironmentReader {
    read: Rc<ReadIntegrationEnvironment>,
    names: RefCell<Option<HashSet<String>>>,
}

impl BoundEnvironmentReader {
    fn bind(&self, names: impl IntoIterator<Item = String>) -> ExecutorResult<()> {
        let mut bound = self.names.borrow_mut();
        if bound.is_some() {
            return Err("Agent environment is already bound".into());
        }
        *bound = Some(names.into_iter().collect());
        Ok(())
    }
}

impl AgentEnvironmentReader for BoundEnvironmentReader {
    fn get(&self, name: &str) -> ExecutorResult<Option<String>> {
        if !self
            .names
            .borrow()
            .as_ref()
            .is_some_and(|names| names.contains(name))
        {
            return Err(invalid_settings(format!(
                "Agent attempted to read undeclared environment variable: {name}"
            )));
        }
        Ok((self.read)(name))
    }
}

struct BoundApiProviders {
    resolve: Rc<ResolveIntegrationCredential>,
    scope: AgentResourceScope,
}

#[async_trait(?Send)]
impl AgentApiProviderReader for BoundApiProviders {
    async fn resolve_credential(
        &self,
        request: AgentResolveCredentialRequest,
    ) -> ExecutorResult<Option<AgentResolvedCredential>> {
        (self.resolve)(ResolveIntegrationCredentialRequest {
            executor_id: self.scope.executor_id.clone(),
            agent_id: self.scope.integration_id.clone(),
            reference: request.reference,
            signal: request.signal,
        })
        .await
    }
}

struct HostRecord {
    host: AgentHost,
    environment: Rc<BoundEnvironmentReader>,
}

pub struct IntegrationHostFactory {
    options: IntegrationHostFactoryOptions,
    instance_id: String,
    hosts: RefCell<HashMap<String, Rc<HostRecord>>>,
}

impl IntegrationHostFactory {
    pub fn new(options: IntegrationHostFactoryOptions) -> Self {
        let instance_id = options
            .instance_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        Self {
            options,
            instance_id,
            hosts: RefCell::default(),
        }
    }

    pub fn for_agent(&self, agent_id: &str) -> ExecutorResult<AgentHost> {
        if !valid_agent_id(agent_id) {
            return Err(format!("Invalid agent integration ID: {agent_id}").into());
        }
        if let Some(record) = self.hosts.borrow().get(agent_id) {
            return Ok(clone_host(&record.host));
        }
        let options = &self.options;
        let scope = AgentResourceScope {
            executor_id: options.executor_id.as_deref().unwrap_or("local").into(),
            instance_id: self.instance_id.clone(),
            integration_id: agent_id.into(),
        };
        let workspace_dir = native::resolve(
            &std::env::current_dir()?.to_string_lossy(),
            &[&options.workspace_dir],
        );
        let environment = Rc::new(BoundEnvironmentReader {
            read: options
                .read_environment
                .clone()
                .unwrap_or_else(|| Rc::new(|name| std::env::var(name).ok())),
            names: RefCell::default(),
        });
        let host = AgentHost {
            agent_id: agent_id.into(),
            migrations: Rc::new(FileAgentMigrationStore::new(
                &options.workspace_dir,
                agent_id,
            )),
            storage: Rc::new(ScopedStorage::new(workspace_dir, agent_id)),
            logger: options.logger_factory.as_ref().map_or_else(
                || {
                    Rc::new(IntegrationLogger(create_logger(&format!(
                        "agent-integration:{agent_id}"
                    )))) as Rc<dyn AgentLogger>
                },
                |logger_factory| logger_factory(agent_id),
            ),
            api_providers: Rc::new(BoundApiProviders {
                scope: scope.clone(),
                resolve: options.resolve_credential.clone(),
            }),
            scope,
            environment: environment.clone(),
        };
        let result = clone_host(&host);
        self.hosts
            .borrow_mut()
            .insert(agent_id.into(), Rc::new(HostRecord { host, environment }));
        Ok(result)
    }

    pub fn bind_configuration(
        &self,
        agent_id: &str,
        names: impl IntoIterator<Item = String>,
    ) -> ExecutorResult<()> {
        let record = self
            .hosts
            .borrow()
            .get(agent_id)
            .cloned()
            .ok_or_else(|| format!("Agent host has not been constructed: {agent_id}"))?;
        record.environment.bind(names)
    }
}

fn clone_host(host: &AgentHost) -> AgentHost {
    AgentHost {
        agent_id: host.agent_id.clone(),
        scope: host.scope.clone(),
        migrations: host.migrations.clone(),
        logger: host.logger.clone(),
        storage: host.storage.clone(),
        environment: host.environment.clone(),
        api_providers: host.api_providers.clone(),
    }
}

struct IntegrationLogger(ScopedLogger);

fn log_message(message: &str, fields: Option<&IndexMap<String, Opaque>>) -> String {
    match fields.and_then(|fields| serde_json::to_string(fields).ok()) {
        Some(fields) => format!("{message} {fields}"),
        None => message.to_owned(),
    }
}

impl AgentLogger for IntegrationLogger {
    fn debug(&self, message: &str, fields: Option<&IndexMap<String, Opaque>>) {
        self.0.debug(&log_message(message, fields));
    }
    fn info(&self, message: &str, fields: Option<&IndexMap<String, Opaque>>) {
        self.0.info(&log_message(message, fields));
    }
    fn warn(&self, message: &str, fields: Option<&IndexMap<String, Opaque>>) {
        self.0.warn(&log_message(message, fields));
    }
    fn error(&self, message: &str, fields: Option<&IndexMap<String, Opaque>>) {
        self.0.error(&log_message(message, fields));
    }
}

struct ScopedStorage {
    root_directory: String,
    workspace_dir: String,
}

impl ScopedStorage {
    fn new(workspace_dir: String, agent_id: &str) -> Self {
        Self {
            root_directory: native::join(&[&workspace_dir, "agent-data", agent_id]),
            workspace_dir,
        }
    }
}

#[async_trait(?Send)]
impl AgentScopedStorage for ScopedStorage {
    fn root_directory(&self) -> &str {
        &self.root_directory
    }

    async fn directory(&self, namespace: &str) -> ExecutorResult<String> {
        assert_namespace(namespace)?;
        fs::create_dir_all(native::dirname(&self.root_directory)).await?;
        ensure_directory_without_symlink(self.root_directory.as_ref()).await?;

        let root = realpath(&self.root_directory).await?;
        let candidate = root.join(namespace);
        ensure_directory_without_symlink(&candidate).await?;
        let resolved = realpath(candidate).await?;
        let relative = native::relative(
            native::SEP,
            &root.to_string_lossy(),
            &resolved.to_string_lossy(),
        );
        if relative.is_empty()
            || relative == ".."
            || relative
                .strip_prefix("..")
                .is_some_and(|tail| tail.starts_with(native::SEP))
            || native::is_absolute(&relative)
        {
            return Err(invalid_settings(format!(
                "Agent storage namespace escapes its scope: {namespace}"
            )));
        }
        Ok(resolved.to_string_lossy().into_owned())
    }

    async fn claim_legacy_workspace_directory(
        &self,
        name: &str,
    ) -> ExecutorResult<AgentLegacyDirectoryClaim> {
        assert_namespace(name)?;
        let source = Path::new(&self.workspace_dir).join(name);
        let mut claim = AgentLegacyDirectoryClaim {
            moved: 0,
            skipped: 0,
        };
        let Some(metadata) = metadata_or_none(&source).await? else {
            return Ok(claim);
        };
        assert_directory_without_symlink(&source, &metadata)?;
        let destination = self.directory(name).await?;
        move_directory_contents(&source, Path::new(&destination), &mut claim).await?;
        Ok(claim)
    }
}

pub(crate) fn valid_agent_id(id: &str) -> bool {
    valid_storage_name(id, b"-")
}

fn valid_storage_name(name: &str, punctuation: &[u8]) -> bool {
    let alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    let mut bytes = name.bytes();
    bytes.next().is_some_and(alphanumeric)
        && bytes.all(|byte| alphanumeric(byte) || punctuation.contains(&byte))
}

fn assert_namespace(name: &str) -> ExecutorResult<()> {
    if !valid_storage_name(name, b"._-") {
        return Err(invalid_settings(format!(
            "Invalid agent storage namespace: {name}"
        )));
    }
    Ok(())
}

fn invalid_settings(message: String) -> Box<dyn std::error::Error> {
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::INVALID_SETTINGS,
        message,
        false,
        None,
    )
    .into()
}

async fn metadata_or_none(path: &Path) -> io::Result<Option<std::fs::Metadata>> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn assert_directory_without_symlink(
    path: &Path,
    metadata: &std::fs::Metadata,
) -> ExecutorResult<()> {
    if metadata.is_symlink() {
        return Err(invalid_settings(format!(
            "Agent storage path must not be a symbolic link: {}",
            path.display()
        )));
    }
    if !metadata.is_dir() {
        return Err(invalid_settings(format!(
            "Agent storage path is not a directory: {}",
            path.display()
        )));
    }
    Ok(())
}

async fn ensure_directory_without_symlink(path: &Path) -> ExecutorResult<()> {
    if let Some(metadata) = metadata_or_none(path).await? {
        return assert_directory_without_symlink(path, &metadata);
    }
    Ok(fs::create_dir(path).await?)
}

async fn move_directory_contents(
    source: &Path,
    destination: &Path,
    claim: &mut AgentLegacyDirectoryClaim,
) -> ExecutorResult<()> {
    let mut entries = fs::read_dir(source).await?;
    while let Some(entry) = entries.next_entry().await? {
        let source = entry.path();
        let destination = destination.join(entry.file_name());
        let Some(metadata) = metadata_or_none(&source).await? else {
            continue;
        };
        if metadata.is_symlink() {
            claim.skipped += 1;
        } else if metadata.is_dir() {
            ensure_directory_without_symlink(&destination).await?;
            Box::pin(move_directory_contents(&source, &destination, claim)).await?;
        } else if !metadata.is_file() || metadata_or_none(&destination).await?.is_some() {
            claim.skipped += 1;
        } else {
            move_file(&source, &destination, claim).await?;
        }
    }
    match fs::remove_dir(source).await {
        Err(error)
            if !matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Err(error.into())
        }
        _ => Ok(()),
    }
}

async fn move_file(
    source: &Path,
    destination: &Path,
    claim: &mut AgentLegacyDirectoryClaim,
) -> io::Result<()> {
    if let Err(error) = fs::rename(source, destination).await {
        if error.kind() != io::ErrorKind::CrossesDevices {
            return Err(error);
        }
        let mut source_file = fs::File::open(source).await?;
        let mut destination_file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .await
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                claim.skipped += 1;
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        let result = async {
            tokio::io::copy(&mut source_file, &mut destination_file).await?;
            destination_file.flush().await?;
            fs::set_permissions(destination, source_file.metadata().await?.permissions()).await
        }
        .await;
        drop(destination_file);
        if let Err(error) = result {
            let _ = fs::remove_file(destination).await;
            return Err(error);
        }
        drop(source_file);
        fs::remove_file(source).await?;
    }
    claim.moved += 1;
    Ok(())
}

#[cfg(test)]
mod tests;
