//! Projects executor-scoped integration capabilities and model discovery.

use std::{cell::RefCell, collections::HashSet, error::Error, rc::Rc};

use futures::future::try_join_all;
use garcon_base::{
    errors::{ErrorInput, error_metadata},
    executor_disconnect::as_agent_call_error,
    keyed_lock::LockAborted,
    log::{Logger, ScopedLogger, create_logger},
};
use garcon_contract::{
    agent_integration::AgentDescriptor,
    agents::{
        AgentCatalogEntry, AgentCatalogEntryKind, AgentExecutionPolicy, AgentGeneration,
        AgentModelOption,
    },
    attachments::FileAttachmentMimeTypes,
    error_codes::ErrorCode,
    executors::effective_executor_id,
};
use garcon_interface::{
    errors::{AgentDeliveryOutcome, AgentIntegrationError, AgentIntegrationErrorCode},
    integration::AgentIntegration,
    services::{
        AgentCatalog, AgentCatalogRequest, AgentCatalogSnapshot, AgentLiteralExecution,
        AgentSettings, RequireNativeDiscovery,
    },
};
use garcon_js::json::Opaque;
use tokio_util::sync::CancellationToken;

use crate::{
    directory::AgentDirectory,
    execution_errors::execution_domain_error,
    types::{ExecutionOperationResult, execution_error_input},
};

pub struct CatalogQuerySignal<'a> {
    pub token: &'a CancellationToken,
    pub reason: &'a dyn Fn() -> Box<dyn Error>,
}

#[derive(Default)]
pub struct AgentModelQuery<'a> {
    pub executor_id: Option<&'a str>,
    pub strict: bool,
    pub require_native_discovery: Option<RequireNativeDiscovery>,
    pub signal: Option<CatalogQuerySignal<'a>>,
    pub timeout_ms: Option<f64>,
    pub dispatch_deadline: Option<f64>,
}

pub struct ModelImageSupport<'a> {
    pub executor_id: Option<&'a str>,
    pub agent_id: &'a str,
    pub model: &'a str,
    pub api_provider_id: Option<&'a str>,
    pub model_endpoint_id: Option<&'a str>,
}

pub trait CatalogEndpointResolver {
    fn model_supports_images(&self, input: ModelImageSupport<'_>) -> bool;
    fn get_model_options(&self, agent_id: &str, executor_id: &str) -> Vec<AgentModelOption>;
}

pub struct CatalogCapabilities<'a> {
    pub literal_execution: Option<&'a AgentLiteralExecution>,
    pub supports_compact: bool,
    pub supports_steering: bool,
    pub file_attachment_mime_types: Option<&'a FileAttachmentMimeTypes>,
    pub accepts_api_provider_endpoints: bool,
    pub auth_login_supported: bool,
}

pub trait CatalogIntegration {
    fn descriptor(&self) -> &AgentDescriptor;
    fn catalog(&self) -> &dyn AgentCatalog;
    fn settings(&self) -> &dyn AgentSettings;
    fn capabilities(&self) -> CatalogCapabilities<'_>;
}

impl CatalogIntegration for AgentIntegration {
    fn descriptor(&self) -> &AgentDescriptor {
        &self.descriptor
    }
    fn catalog(&self) -> &dyn AgentCatalog {
        self.catalog.as_ref()
    }
    fn settings(&self) -> &dyn AgentSettings {
        self.settings.as_ref()
    }
    fn capabilities(&self) -> CatalogCapabilities<'_> {
        CatalogCapabilities {
            literal_execution: self.literal_execution.as_ref(),
            supports_compact: self.compaction.is_some(),
            supports_steering: self.steering.is_some(),
            file_attachment_mime_types: self
                .attachments
                .as_ref()
                .map(|facet| &facet.file_mime_types),
            accepts_api_provider_endpoints: self.endpoints.is_some(),
            auth_login_supported: self
                .auth
                .as_ref()
                .is_some_and(|auth| auth.login_capabilities().launch_login.is_some()),
        }
    }
}

pub trait CatalogDirectory {
    fn get(&self, agent_id: &str, executor_id: Option<&str>) -> Option<Rc<dyn CatalogIntegration>>;
    fn require(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<Rc<dyn CatalogIntegration>>;
    fn list(
        &self,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<Vec<Rc<dyn CatalogIntegration>>>;
}

impl CatalogDirectory for AgentDirectory {
    fn get(&self, agent_id: &str, executor_id: Option<&str>) -> Option<Rc<dyn CatalogIntegration>> {
        AgentDirectory::get(self, agent_id, executor_id)
            .map(|integration| integration as Rc<dyn CatalogIntegration>)
    }

    fn require(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<Rc<dyn CatalogIntegration>> {
        Ok(AgentDirectory::require(self, agent_id, executor_id)?)
    }

    fn list(
        &self,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<Vec<Rc<dyn CatalogIntegration>>> {
        Ok(AgentDirectory::list(self, executor_id)?
            .into_iter()
            .map(|integration| integration as Rc<dyn CatalogIntegration>)
            .collect())
    }
}

pub fn is_catalog_executor_failure(error: &(dyn Error + 'static)) -> bool {
    as_agent_call_error(error).is_some_and(|error| error.outcome != AgentDeliveryOutcome::Rejected)
        || execution_domain_error(error)
            .is_some_and(|error| error.code == ErrorCode::EXECUTOR_UNAVAILABLE)
}

#[derive(Debug, thiserror::Error)]
#[error("Duplicate generation priority: {0}")]
struct DuplicateGenerationPriority(garcon_js::Number);

pub struct AgentCatalogService {
    directory: Rc<dyn CatalogDirectory>,
    endpoint_resolver: Rc<dyn CatalogEndpointResolver>,
    requires_strict_by_agent: RefCell<HashSet<(String, String)>>,
    logger: ScopedLogger,
}

impl AgentCatalogService {
    pub fn new(
        directory: Rc<dyn CatalogDirectory>,
        endpoint_resolver: Rc<dyn CatalogEndpointResolver>,
    ) -> Self {
        Self {
            directory,
            endpoint_resolver,
            requires_strict_by_agent: RefCell::default(),
            logger: create_logger("agents:catalog-service"),
        }
    }

    pub async fn get_models(
        &self,
        agent_id: &str,
        query: AgentModelQuery<'_>,
    ) -> ExecutionOperationResult<Vec<AgentModelOption>> {
        if self.directory.get(agent_id, query.executor_id).is_none() {
            return Ok(Vec::new());
        }
        Ok(self.snapshot(agent_id, &query).await?.models)
    }

    pub fn model_supports_images(&self, input: ModelImageSupport<'_>) -> bool {
        let Some(integration) = self.directory.get(input.agent_id, input.executor_id) else {
            return false;
        };
        if input.api_provider_id.is_none_or(str::is_empty)
            || input.model_endpoint_id.is_none_or(str::is_empty)
        {
            return integration.descriptor().supports_images;
        }
        self.endpoint_resolver.model_supports_images(input)
    }

    pub fn has_endpoint_models(&self, agent_id: &str, executor_id: Option<&str>) -> bool {
        !self
            .endpoint_resolver
            .get_model_options(agent_id, &effective_executor_id(executor_id))
            .is_empty()
    }

    pub fn requires_strict_model_discovery(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> bool {
        self.requires_strict_by_agent
            .borrow()
            .contains(&(effective_executor_id(executor_id), agent_id.into()))
    }

    pub async fn get_agent_catalog_entry(
        &self,
        agent_id: &str,
        query: AgentModelQuery<'_>,
    ) -> ExecutionOperationResult<Option<AgentCatalogEntry>> {
        let Some(integration) = self.directory.get(agent_id, query.executor_id) else {
            return Ok(None);
        };
        let snapshot = self.snapshot(agent_id, &query).await?;
        let descriptor = integration.descriptor();
        let capabilities = integration.capabilities();
        let mut models = snapshot.models;
        if capabilities.accepts_api_provider_endpoints {
            models.extend(
                self.endpoint_resolver
                    .get_model_options(agent_id, &effective_executor_id(query.executor_id)),
            );
        }
        let mut seen = HashSet::new();
        models.retain(|model| !model.value.is_empty() && seen.insert(model.value.clone()));
        let default_model = if snapshot.default_model.is_empty() {
            models
                .first()
                .map(|model| model.value.clone())
                .unwrap_or_default()
        } else {
            snapshot.default_model
        };
        Ok(Some(AgentCatalogEntry {
            id: descriptor.id.clone(),
            label: descriptor.label.clone(),
            description: None,
            kind: AgentCatalogEntryKind::Agent,
            execution_policy: if capabilities.literal_execution.is_some() {
                AgentExecutionPolicy::Literal
            } else {
                AgentExecutionPolicy::Conversation
            },
            selection_label: capabilities
                .literal_execution
                .map_or_else(|| "Model".into(), |facet| facet.selection_label.clone()),
            input_format_by_model: capabilities.literal_execution.map_or_else(
                || Opaque::from_value(serde_json::Value::Object(serde_json::Map::new())),
                |facet| facet.input_format_by_model.clone(),
            ),
            supports_compact: capabilities.supports_compact,
            supports_fork: true,
            supports_fork_at_message: true,
            supports_fork_while_running: true,
            supports_update_project_path: descriptor.supports_project_path_update,
            supports_steering: capabilities.supports_steering,
            supports_images: descriptor.supports_images,
            file_attachment_mime_types: Some(
                capabilities
                    .file_attachment_mime_types
                    .cloned()
                    .unwrap_or_else(|| FileAttachmentMimeTypes::Listed(Vec::new())),
            ),
            accepts_api_provider_endpoints: capabilities.accepts_api_provider_endpoints,
            supported_protocols: descriptor.supported_endpoint_protocols.clone(),
            auth_login_supported: capabilities.auth_login_supported,
            supported_permission_modes: descriptor.supported_permission_modes.clone(),
            supported_thinking_modes: descriptor.supported_thinking_modes.clone(),
            settings: integration.settings().describe().to_vec(),
            default_settings: integration.settings().defaults()?,
            requires_strict_model_discovery: snapshot.requires_strict_model_discovery,
            generation: snapshot.generation.map(|generation| AgentGeneration {
                priority: generation.priority,
                model: generation.model,
            }),
            default_model,
            models,
        }))
    }

    pub async fn get_agent_catalog_entries(
        self: &Rc<Self>,
        executor_id: Option<&str>,
        confirming_agents: &[String],
    ) -> ExecutionOperationResult<Vec<AgentCatalogEntry>> {
        let integrations = self.directory.list(executor_id)?;
        let operations = integrations.iter().map(|integration| {
            let agent_id = integration.descriptor().id.clone();
            let owner = self.clone();
            let executor_id = executor_id.map(str::to_owned);
            let require_native_discovery = confirming_agents
                .contains(&agent_id)
                .then_some(RequireNativeDiscovery);
            // Like Promise.all, an early failure does not cancel the other catalog reads.
            let task = tokio::task::spawn_local(async move {
                owner
                    .get_agent_catalog_entry(
                        &agent_id,
                        AgentModelQuery {
                            executor_id: executor_id.as_deref(),
                            require_native_discovery,
                            ..AgentModelQuery::default()
                        },
                    )
                    .await
            });
            async move { task.await? }
        });
        let entries: Vec<_> = try_join_all(operations)
            .await?
            .into_iter()
            .flatten()
            .collect();
        let mut priorities = HashSet::new();
        for entry in &entries {
            if let Some(generation) = &entry.generation {
                let value = generation.priority.0;
                let priority = if value == 0.0 {
                    0
                } else if value.is_nan() {
                    f64::NAN.to_bits()
                } else {
                    value.to_bits()
                };
                if !priorities.insert(priority) {
                    return Err(Box::new(DuplicateGenerationPriority(generation.priority)));
                }
            }
        }
        Ok(entries)
    }

    async fn snapshot(
        &self,
        agent_id: &str,
        query: &AgentModelQuery<'_>,
    ) -> ExecutionOperationResult<AgentCatalogSnapshot> {
        let integration = self.directory.require(agent_id, query.executor_id)?;
        let signal = query
            .signal
            .as_ref()
            .map(|signal| signal.token.clone())
            .unwrap_or_default();
        let strict = query.strict || query.require_native_discovery.is_some();
        match integration
            .catalog()
            .snapshot(AgentCatalogRequest {
                strict,
                require_native_discovery: query.require_native_discovery,
                signal: signal.clone(),
                timeout_ms: query.timeout_ms,
                dispatch_deadline: query.dispatch_deadline,
            })
            .await
        {
            Ok(snapshot) => {
                let key = (effective_executor_id(query.executor_id), agent_id.into());
                if snapshot.requires_strict_model_discovery {
                    self.requires_strict_by_agent.borrow_mut().insert(key);
                } else {
                    self.requires_strict_by_agent.borrow_mut().remove(&key);
                }
                Ok(snapshot)
            }
            Err(error) => {
                if signal.is_cancelled() {
                    return Err(query.signal.as_ref().map_or_else(
                        || Box::new(LockAborted) as Box<dyn Error>,
                        |signal| (signal.reason)(),
                    ));
                }
                let name = match execution_error_input(error.as_ref()) {
                    ErrorInput::Diagnostic(error) => error.diagnostic_metadata().name,
                    _ => error_metadata(error.as_ref()).name,
                };
                if name == "AbortError"
                    || is_catalog_executor_failure(error.as_ref())
                    || strict
                        && !(query.require_native_discovery.is_some()
                            && is_unavailable_provider(error.as_ref()))
                {
                    return Err(error);
                }
                self.logger.warn(&format!(
                    "Agent catalog snapshot failed. (CATALOG_SNAPSHOT_FAILED, {agent_id})"
                ));
                Ok(AgentCatalogSnapshot {
                    models: Vec::new(),
                    default_model: String::new(),
                    requires_strict_model_discovery: false,
                    generation: None,
                })
            }
        }
    }
}

fn is_unavailable_provider(error: &(dyn Error + 'static)) -> bool {
    error
        .downcast_ref::<AgentIntegrationError>()
        .or_else(|| as_agent_call_error(error).map(|error| &**error))
        .is_some_and(|error| {
            !error.retryable
                && matches!(
                    error.code,
                    AgentIntegrationErrorCode::BINARY_NOT_FOUND
                        | AgentIntegrationErrorCode::INVALID_SETTINGS
                        | AgentIntegrationErrorCode::INVALID_ENDPOINT
                )
        })
}
