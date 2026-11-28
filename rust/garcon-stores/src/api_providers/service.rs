//! Management result shapes and preparation before executor-local discovery.

use std::rc::Rc;

use garcon_base::domain_error::{DomainError, as_domain_error};
use garcon_contract::{
    agents::AgentModelOption,
    api_provider_templates::api_provider_template,
    api_providers::{
        API_PROVIDER_TEMPLATE_IDS, ApiProtocol, ApiProviderAssignmentOutcome,
        ApiProviderAssignmentStatus, ApiProviderCatalogEntry, ApiProviderCreateResult,
        ApiProviderManagement, ApiProviderModelDiscoveryResponse, ApiProviderUpdateResult,
        ModelDiscoveryKind, OpenAiEndpointCapabilities, is_api_provider_template_id,
    },
    error_codes::ErrorCode,
};
use garcon_interface::execution_runtime::ApiProviderDiscoveryRequest;
use garcon_js::trim;
use serde_json::{Map, Value};
use url::Url;

use super::access::{ApiProviderAccess, provider_not_found};
use super::assignments::{
    AssertAssignmentCurrent, RetainExecutorReferences, validate_provider_executor_ids,
};
use super::store::{
    CreateApiProviderInput, StoredApiProvider, UpdateApiProviderEndpointInput,
    UpdateApiProviderInput, bare_model, check_capabilities, configuration_changed, model_discovery,
    models, normalize_base_url, protocol, required_string, unsupported_template,
};
use super::{Result, js_truthy, renamed_write, revision};

pub enum PreparedDiscovery {
    Request(ApiProviderDiscoveryRequest),
    Answer(ApiProviderModelDiscoveryResponse),
}

pub struct ApiProviderService {
    access: Rc<ApiProviderAccess>,
}

impl ApiProviderService {
    pub fn new(access: Rc<ApiProviderAccess>) -> Rc<Self> {
        Rc::new(Self { access })
    }

    pub fn management(&self) -> Result<ApiProviderManagement> {
        Ok(ApiProviderManagement {
            providers: self.access.store.redacted_list()?,
            assignments: self.access.assignments.snapshot()?,
        })
    }

    pub fn get_catalog(&self, executor: &str) -> Result<Vec<ApiProviderCatalogEntry>> {
        match self.access.list(executor) {
            Ok(profiles) => Ok(profiles.iter().map(StoredApiProvider::redacted).collect()),
            Err(error) if is_unavailable(error.as_ref()) => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }

    pub async fn assign(
        self: &Rc<Self>,
        executor: String,
        provider: String,
        retain: RetainExecutorReferences,
        assert_current: Option<AssertAssignmentCurrent>,
    ) -> Result<ApiProviderManagement> {
        self.access
            .assign(executor, provider, retain, assert_current)
            .await?;
        self.management()
    }

    pub async fn unassign(
        self: &Rc<Self>,
        executor: String,
        provider: String,
        retain: RetainExecutorReferences,
        assert_current: Option<AssertAssignmentCurrent>,
    ) -> Result<ApiProviderManagement> {
        self.access
            .unassign(executor, provider, retain, assert_current)
            .await?;
        self.management()
    }

    pub async fn create(
        self: &Rc<Self>,
        input: Value,
        executor: &str,
        retain: RetainExecutorReferences,
    ) -> Result<ApiProviderCreateResult> {
        let root = object(&input, "API provider")?;
        let executors = if let Some(ids) = root.get("executorIds") {
            self.validate_executors(ids)?
        } else {
            self.validate_executors(&Value::Array(vec![Value::String(executor.into())]))?
        };
        let input = flatten_input(&input)?;
        let service = self.clone();
        self.access
            .store
            .run_detached(async move {
                let profile = service.access.store.create_api_provider(input).await?;
                let entry = profile.redacted();
                let assignment = service.save_assignments(profile, executors, retain).await;
                Ok(ApiProviderCreateResult { entry, assignment })
            })
            .await
    }

    pub async fn update(
        self: &Rc<Self>,
        id: String,
        input: Value,
        retain: RetainExecutorReferences,
    ) -> Result<ApiProviderUpdateResult> {
        let root = object(&input, "API provider")?;
        let executors = root
            .get("executorIds")
            .map(|ids| self.validate_executors(ids))
            .transpose()?;
        let patch = flatten_patch(&input)?;
        let service = self.clone();
        self.access
            .store
            .run_detached(async move {
                let profile = if patch.label.is_some() || patch.endpoint.is_some() {
                    service.access.store.update_api_provider(id, patch).await?
                } else {
                    let profile = service
                        .access
                        .store
                        .get_api_provider(&id)?
                        .ok_or_else(provider_not_found)?;
                    if patch
                        .revision
                        .is_some_and(|revision| revision != profile.revision)
                    {
                        return Err(configuration_changed().into());
                    }
                    profile
                };
                let entry = profile.redacted();
                let assignment = if let Some(executors) = executors {
                    Some(service.save_assignments(profile, executors, retain).await)
                } else {
                    None
                };
                Ok(ApiProviderUpdateResult { entry, assignment })
            })
            .await
    }

    pub async fn delete(
        self: &Rc<Self>,
        id: String,
        is_referenced: impl FnOnce(&str) -> Result<bool> + 'static,
    ) -> Result<()> {
        let service = self.clone();
        self.access
            .store
            .run_detached(async move {
                service
                    .access
                    .store
                    .delete_api_provider(id.clone(), is_referenced)
                    .await?;
                service.access.assignments.remove_provider(id).await
            })
            .await
    }

    fn validate_executors(&self, ids: &Value) -> Result<Vec<String>> {
        let ids = validate_provider_executor_ids(ids)?;
        for id in &ids {
            self.access.assert_executor(id)?;
        }
        Ok(ids)
    }

    async fn save_assignments(
        &self,
        profile: StoredApiProvider,
        executor_ids: Vec<String>,
        retain: RetainExecutorReferences,
    ) -> ApiProviderAssignmentOutcome {
        let result = self
            .access
            .set_assignments(profile.id, executor_ids.clone(), profile.revision, retain)
            .await;
        let (status, error) = match result {
            Ok(()) => (ApiProviderAssignmentStatus::Assigned, None),
            Err(error) if renamed_write(error.as_ref()) || is_unavailable(error.as_ref()) => (
                ApiProviderAssignmentStatus::Unknown, Some("Profile saved, but executor access could not be confirmed. Reload after checking controller configuration.".into()),
            ),
            Err(_) => (ApiProviderAssignmentStatus::NotAssigned, Some("Profile saved, but executor access was not saved. Reload the profile or retry Save.".into())),
        };
        ApiProviderAssignmentOutcome {
            executor_ids,
            status,
            error,
        }
    }

    pub fn prepare_test(&self, input: &Value, executor: &str) -> Result<PreparedDiscovery> {
        let flat = flatten_input(input)?;
        self.access.assert_executor(executor)?;
        let mut key = flat.api_key.filter(|key| !key.is_empty());
        if key.is_none() && js_truthy(&input["apiProviderId"]) {
            let stored = self.stored_key(
                executor,
                flat.protocol,
                &flat.base_url,
                input.get("apiProviderId"),
                input.get("endpointId"),
                revision(&input["revision"]),
            )?;
            if stored.different_origin {
                return Ok(needs_key("testing"));
            }
            key = stored.key;
        }
        Ok(PreparedDiscovery::Request(ApiProviderDiscoveryRequest {
            protocol: flat.protocol,
            base_url: flat.base_url,
            api_key: key,
            model_discovery: flat.model_discovery,
        }))
    }

    pub fn prepare_discovery(&self, input: &Value, executor: &str) -> Result<PreparedDiscovery> {
        let root = object(input, "API provider model discovery")?;
        let protocol = require_protocol(&input["protocol"])?;
        let base_url = normalize_base_url(input["baseUrl"].as_str(), "endpoint.baseUrl")?;
        let typed = |field| optional_lookup(root.get(field), field).map(|id| id.map(Value::String));
        let provider = typed("apiProviderId")?;
        let endpoint = typed("endpointId")?;
        let discovery = match model_discovery(protocol, &input["modelDiscovery"]) {
            ModelDiscoveryKind::None if protocol == ApiProtocol::AnthropicMessages => {
                ModelDiscoveryKind::AnthropicModels
            }
            ModelDiscoveryKind::None => ModelDiscoveryKind::OpenAiModels,
            mode => mode,
        };
        self.access.assert_executor(executor)?;
        let uses_credentials = discovery != ModelDiscoveryKind::OllamaTags;
        let mut api_key = input["apiKey"]
            .as_str()
            .filter(|key| !key.is_empty())
            .map(str::to_owned);
        if api_key.is_none() {
            let stored = self.stored_key(
                executor,
                protocol,
                &base_url,
                provider.as_ref(),
                endpoint.as_ref(),
                revision(&input["revision"]),
            )?;
            if uses_credentials && stored.different_origin {
                return Ok(needs_key("fetching models"));
            }
            api_key = stored.key;
        }
        Ok(PreparedDiscovery::Request(ApiProviderDiscoveryRequest {
            protocol,
            base_url,
            api_key: api_key.filter(|_| uses_credentials),
            model_discovery: discovery,
        }))
    }

    fn stored_key(
        &self,
        executor: &str,
        protocol: ApiProtocol,
        base_url: &str,
        provider: Option<&Value>,
        endpoint: Option<&Value>,
        revision: Option<i64>,
    ) -> Result<DiscoveryKey> {
        let provider = provider.filter(|value| js_truthy(value));
        let endpoint = endpoint.filter(|value| js_truthy(value));
        if provider.is_none() && endpoint.is_none() {
            return Ok(DiscoveryKey::default());
        }
        let (Some(provider), Some(endpoint), Some(revision)) = (
            provider,
            endpoint,
            revision.filter(|revision| *revision > 0),
        ) else {
            return Err(DomainError::new_validation(
                "Saved discovery requires provider, endpoint, and revision",
            )
            .into());
        };
        // A truthy non-string ID does not equal a persisted string ID in the original.
        let (_, stored) = self.access.require(
            executor,
            provider.as_str().unwrap_or(""),
            Some(endpoint.as_str().unwrap_or("\0")),
            Some(revision),
        )?;
        if stored.protocol != protocol {
            return Err(DomainError::new(
                ErrorCode::API_PROVIDER_UNAVAILABLE,
                "Endpoint protocol does not match",
                409,
                false,
            )
            .into());
        }
        if Url::parse(&stored.base_url)?.origin() != Url::parse(base_url)?.origin() {
            return Ok(DiscoveryKey {
                key: None,
                different_origin: !stored.api_key.is_empty(),
            });
        }
        Ok(DiscoveryKey {
            key: (!stored.api_key.is_empty()).then_some(stored.api_key),
            different_origin: false,
        })
    }
}

#[derive(Default)]
struct DiscoveryKey {
    key: Option<String>,
    different_origin: bool,
}

fn needs_key(action: &str) -> PreparedDiscovery {
    PreparedDiscovery::Answer(ApiProviderModelDiscoveryResponse {
        success: false,
        models: None,
        error: Some(format!(
            "Enter the API key for this base URL before {action}."
        )),
    })
}

fn is_unavailable(error: &(dyn std::error::Error + 'static)) -> bool {
    as_domain_error(error)
        .is_some_and(|error| error.code == ErrorCode::API_PROVIDER_STORAGE_UNAVAILABLE)
}

fn object<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| format!("{field} must be an object").into())
}

fn optional_boolean(value: Option<&Value>, field: &str) -> Result<Option<bool>> {
    value
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| format!("{field} must be a boolean").into())
        })
        .transpose()
}

fn optional_lookup(value: Option<&Value>, field: &str) -> Result<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) if value == "" => Ok(None),
        Some(value) => value
            .as_str()
            .map(trim)
            .filter(|value| !value.is_empty())
            .map(|value| Some(value.into()))
            .ok_or_else(|| format!("{field} must be a string").into()),
    }
}

fn require_protocol(value: &Value) -> Result<ApiProtocol> {
    protocol(value)
        .ok_or_else(|| "endpoint.protocol must be anthropic-messages or openai-compatible".into())
}

fn capabilities(
    protocol: ApiProtocol,
    value: Option<&Value>,
) -> Result<Option<OpenAiEndpointCapabilities>> {
    if protocol != ApiProtocol::OpenAiCompatible {
        return Ok(None);
    }
    let checked = if let Some(value) = value {
        let fields = object(value, "endpoint.capabilities")?;
        Some(OpenAiEndpointCapabilities {
            chat_completions: optional_boolean(
                fields.get("chatCompletions"),
                "endpoint.capabilities.chatCompletions",
            )?
            .unwrap_or(true),
            responses: optional_boolean(
                fields.get("responses"),
                "endpoint.capabilities.responses",
            )?
            .unwrap_or(false),
        })
    } else {
        None
    };
    check_capabilities(protocol, checked)
}

fn manual_models(value: &Value, default: &str) -> Vec<AgentModelOption> {
    let result = models(value, false);
    if result.is_empty() && (!value.is_array() || !default.is_empty()) {
        vec![bare_model(default)]
    } else {
        result
    }
}

fn flatten_input(input: &Value) -> Result<CreateApiProviderInput> {
    object(input, "API provider")?;
    let endpoint = object(&input["endpoint"], "endpoint")?;
    let endpoint_value = &input["endpoint"];
    let protocol = require_protocol(&endpoint_value["protocol"])?;
    let template_id = is_api_provider_template_id(&input["templateId"]).ok_or_else(|| {
        format!(
            "templateId must be {}",
            API_PROVIDER_TEMPLATE_IDS
                .iter()
                .map(|id| id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;
    if api_provider_template(protocol, template_id).is_none() {
        return Err(unsupported_template(protocol, template_id).into());
    }
    let default_model = required_string(
        endpoint_value["defaultModel"].as_str(),
        "endpoint.defaultModel",
    )?;
    let label = required_string(input["label"].as_str(), "label")?;
    let base_url = normalize_base_url(endpoint_value["baseUrl"].as_str(), "endpoint.baseUrl")?;
    let api_key = endpoint_value["apiKey"].as_str().map(str::to_owned);
    let capabilities = capabilities(protocol, endpoint.get("capabilities"))?;
    let models = manual_models(&endpoint_value["models"], &default_model);
    let supports_images =
        optional_boolean(endpoint.get("supportsImages"), "endpoint.supportsImages")?
            .unwrap_or(false);
    Ok(CreateApiProviderInput {
        template_id,
        label,
        protocol,
        base_url,
        api_key,
        capabilities,
        default_model,
        models,
        supports_images,
        model_discovery: model_discovery(protocol, &endpoint_value["modelDiscovery"]),
    })
}

fn flatten_patch(input: &Value) -> Result<UpdateApiProviderInput> {
    let root = object(input, "API provider")?;
    let revision = root
        .get("revision")
        .map(|value| {
            revision(value)
                .filter(|revision| *revision > 0)
                .ok_or_else(|| DomainError::new_validation("Invalid provider revision"))
        })
        .transpose()?;
    let label = root
        .get("label")
        .map(|label| required_string(label.as_str(), "label"))
        .transpose()?;
    let endpoint = if let Some(value) = root.get("endpoint") {
        let fields = object(value, "endpoint")?;
        let protocol = fields.get("protocol").map(require_protocol).transpose()?;
        let id = fields
            .get("id")
            .map(|id| required_string(id.as_str(), "endpoint.id"))
            .transpose()?;
        let url = fields
            .get("baseUrl")
            .map(|url| normalize_base_url(url.as_str(), "endpoint.baseUrl"))
            .transpose()?;
        let key = fields
            .get("apiKey")
            .map(|key| {
                key.as_str()
                    .map(str::to_owned)
                    .ok_or("endpoint.apiKey must be a string")
            })
            .transpose()?;
        let clear_api_key = optional_boolean(fields.get("clearApiKey"), "endpoint.clearApiKey")?;
        let caps = if let Some(value) = fields.get("capabilities") {
            let protocol = protocol
                .ok_or("endpoint.protocol is required when endpoint.capabilities is patched")?;
            capabilities(protocol, Some(value))?
        } else {
            None
        };
        let default = fields
            .get("defaultModel")
            .map(|value| required_string(value.as_str(), "endpoint.defaultModel"))
            .transpose()?;
        let models = fields
            .get("models")
            .map(|value| manual_models(value, default.as_deref().unwrap_or_default()));
        let supports_images =
            optional_boolean(fields.get("supportsImages"), "endpoint.supportsImages")?;
        let discovery = if let Some(value) = fields.get("modelDiscovery") {
            let protocol = protocol
                .ok_or("endpoint.protocol is required when endpoint.modelDiscovery is patched")?;
            Some(model_discovery(protocol, value))
        } else {
            None
        };
        let changed = id.is_some()
            || url.is_some()
            || key.is_some()
            || clear_api_key.is_some()
            || fields.contains_key("capabilities")
            || default.is_some()
            || models.is_some()
            || supports_images.is_some()
            || discovery.is_some();
        changed.then_some(UpdateApiProviderEndpointInput {
            id,
            base_url: url,
            api_key: key,
            clear_api_key,
            capabilities: caps,
            default_model: default,
            models,
            supports_images,
            model_discovery: discovery,
        })
    } else {
        None
    };
    Ok(UpdateApiProviderInput {
        revision,
        label,
        endpoint,
    })
}
