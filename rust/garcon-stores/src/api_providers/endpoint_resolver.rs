//! Resolves endpoint metadata. Credential release remains an access-policy operation.

use std::rc::Rc;

use garcon_base::{
    domain_error::{DomainError, as_domain_error},
    errors::{DiagnosticError, ErrorMetadata},
};
use garcon_contract::{
    agent_execution::{
        AgentCredentialReference, AgentCredentialReferenceKind, AgentEndpointSelection,
    },
    agents::AgentModelOption,
    api_providers::{ApiProtocol, ApiProviderTemplateId, ModelDiscoveryKind},
    error_codes::ErrorCode,
    executors::effective_executor_id,
    model_routing::{endpoint_model_option_value, raw_model_from_endpoint_option_value},
};
use serde::Serialize;

use super::Result;
use super::access::ApiProviderAccess;
use super::store::{StoredApiProvider, StoredApiProviderEndpoint};

pub type SupportedEndpointProtocols = Rc<dyn Fn(&str, &str) -> Vec<ApiProtocol>>;

#[derive(Debug, Clone, Copy)]
pub struct ModelSelectionInput<'a> {
    pub executor_id: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    pub model: &'a str,
    pub api_provider_id: Option<&'a str>,
    pub model_endpoint_id: Option<&'a str>,
}

#[derive(Debug, Clone, Copy)]
pub struct PreviousModelSelectionInput<'a> {
    pub model: &'a str,
    pub api_provider_id: Option<&'a str>,
    pub model_endpoint_id: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedModelSelection {
    pub model: String,
    pub api_provider_id: Option<String>,
    pub endpoint_id: Option<String>,
    pub protocol: Option<ApiProtocol>,
    pub is_local: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<AgentEndpointSelection>,
}

impl ResolvedModelSelection {
    fn native(model: &str) -> Self {
        Self {
            model: model.into(),
            api_provider_id: None,
            endpoint_id: None,
            protocol: None,
            is_local: false,
            executor_id: None,
            endpoint: None,
        }
    }
}

pub struct ResolvedEndpointReference {
    pub api_provider: StoredApiProvider,
    pub endpoint: StoredApiProviderEndpoint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelSelectionErrorCode {
    SelectionIncomplete,
    ApiProviderNotFound,
    EndpointNotFound,
    EndpointNotExposed,
    ProtocolIncompatible,
    ModelNotFound,
}

impl ModelSelectionErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SelectionIncomplete => "SELECTION_INCOMPLETE",
            Self::ApiProviderNotFound => "API_PROVIDER_NOT_FOUND",
            Self::EndpointNotFound => "ENDPOINT_NOT_FOUND",
            Self::EndpointNotExposed => "ENDPOINT_NOT_EXPOSED",
            Self::ProtocolIncompatible => "PROTOCOL_INCOMPATIBLE",
            Self::ModelNotFound => "MODEL_NOT_FOUND",
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ModelSelectionError {
    pub message: String,
    pub code: ModelSelectionErrorCode,
}

impl ModelSelectionError {
    pub fn new(message: impl Into<String>, code: ModelSelectionErrorCode) -> Self {
        Self {
            message: message.into(),
            code,
        }
    }
}

impl DiagnosticError for ModelSelectionError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "ModelSelectionError",
            code: Some(self.code.as_str()),
        }
    }
}

pub struct ApiProviderEndpointResolver {
    access: Rc<ApiProviderAccess>,
    supported_protocols: SupportedEndpointProtocols,
}

impl ApiProviderEndpointResolver {
    /// The callback receives the agent ID and the effective executor ID.
    pub fn new(
        access: Rc<ApiProviderAccess>,
        supported_protocols: SupportedEndpointProtocols,
    ) -> Self {
        Self {
            access,
            supported_protocols,
        }
    }

    pub fn get_model_options(
        &self,
        agent: &str,
        executor_id: Option<&str>,
    ) -> Result<Vec<AgentModelOption>> {
        let executor = effective_executor_id(executor_id);
        let providers = match self.access.list(&executor) {
            Ok(providers) => providers,
            Err(error)
                if as_domain_error(error.as_ref()).is_some_and(|error| {
                    error.code == ErrorCode::API_PROVIDER_STORAGE_UNAVAILABLE
                }) =>
            {
                return Ok(Vec::new());
            }
            Err(error) => return Err(error),
        };
        let mut options = Vec::new();
        for profile in &providers {
            for endpoint in &profile.endpoints {
                if !self.endpoint_supports_agent(agent, endpoint, &executor) {
                    continue;
                }
                for model in &endpoint.models {
                    let raw = raw_model(model);
                    options.push(AgentModelOption {
                        value: endpoint_model_option_value(&endpoint.id, raw),
                        label: format!("{}: {}", profile.label, model.label),
                        supports_images: Some(
                            model.supports_images.unwrap_or(endpoint.supports_images),
                        ),
                        is_local: Some(is_local(profile, endpoint, Some(model))),
                        api_provider_id: Some(profile.id.clone()),
                        endpoint_id: Some(endpoint.id.clone()),
                        raw_model: Some(raw.into()),
                        protocol: Some(endpoint.protocol),
                    });
                }
            }
        }
        Ok(options)
    }

    pub fn resolve_selection(
        &self,
        input: ModelSelectionInput<'_>,
    ) -> Result<ResolvedModelSelection> {
        let agent = nonempty(input.agent_id).ok_or_else(|| {
            ModelSelectionError::new(
                "agentId is required for model selection",
                ModelSelectionErrorCode::SelectionIncomplete,
            )
        })?;
        let provider_id = nonempty(input.api_provider_id);
        let endpoint_id = nonempty(input.model_endpoint_id);
        if provider_id.is_none() && endpoint_id.is_none() {
            return Ok(ResolvedModelSelection::native(input.model));
        }
        let (Some(provider_id), Some(endpoint_id)) = (provider_id, endpoint_id) else {
            return Err(ModelSelectionError::new(
                "API provider selections require apiProviderId and modelEndpointId.",
                ModelSelectionErrorCode::SelectionIncomplete,
            )
            .into());
        };
        let executor = effective_executor_id(input.executor_id);
        let ResolvedEndpointReference {
            api_provider: profile,
            endpoint,
        } = self.require_endpoint(provider_id, endpoint_id, &executor)?;
        self.assert_compatible(agent, &endpoint, &executor)?;
        let model = selected_model(&endpoint, input.model).ok_or_else(|| {
            ModelSelectionError::new(
                format!(
                    "Model is not exposed by endpoint {}: {}",
                    endpoint.id, input.model
                ),
                ModelSelectionErrorCode::ModelNotFound,
            )
        })?;
        let model_id = raw_model(model);
        let local = is_local(&profile, &endpoint, Some(model));
        let selection = build_endpoint_selection(&profile, &endpoint, model_id, local);
        Ok(ResolvedModelSelection {
            model: model_id.into(),
            api_provider_id: Some(profile.id),
            endpoint_id: Some(endpoint.id),
            protocol: Some(endpoint.protocol),
            is_local: local,
            executor_id: Some(executor),
            endpoint: Some(selection),
        })
    }

    pub fn model_supports_images(&self, input: ModelSelectionInput<'_>) -> Result<bool> {
        let (Some(agent), Some(provider), Some(endpoint)) = (
            nonempty(input.agent_id),
            nonempty(input.api_provider_id),
            nonempty(input.model_endpoint_id),
        ) else {
            return Ok(false);
        };
        let executor = effective_executor_id(input.executor_id);
        let reference = self.require_endpoint(provider, endpoint, &executor)?;
        self.assert_compatible(agent, &reference.endpoint, &executor)?;
        Ok(selected_model(&reference.endpoint, input.model)
            .and_then(|model| model.supports_images)
            .unwrap_or(reference.endpoint.supports_images))
    }

    pub fn resolve_endpoint_reference(
        &self,
        selection: &ResolvedModelSelection,
    ) -> Result<Option<ResolvedEndpointReference>> {
        let (Some(provider), Some(endpoint)) = (
            nonempty(selection.api_provider_id.as_deref()),
            nonempty(selection.endpoint_id.as_deref()),
        ) else {
            return Ok(None);
        };
        let reference = self.require_endpoint(
            provider,
            endpoint,
            &effective_executor_id(selection.executor_id.as_deref()),
        )?;
        if let Some(endpoint) = &selection.endpoint
            && endpoint
                .credential
                .as_ref()
                .map(|credential| credential.revision)
                != Some(reference.api_provider.revision)
        {
            return Err(DomainError::new(
                ErrorCode::API_PROVIDER_CONFIGURATION_CHANGED,
                "Provider configuration changed. Refresh and try again.",
                409,
                false,
            )
            .into());
        }
        Ok(Some(reference))
    }

    pub fn describe_previous(
        &self,
        input: PreviousModelSelectionInput<'_>,
    ) -> Result<ResolvedModelSelection> {
        if nonempty(input.api_provider_id).is_none() && nonempty(input.model_endpoint_id).is_none()
        {
            return Ok(ResolvedModelSelection::native(input.model));
        }
        let profile = self
            .access
            .store
            .list()?
            .into_iter()
            .find(|profile| Some(profile.id.as_str()) == input.api_provider_id);
        let resolved = profile.as_ref().and_then(|profile| {
            profile
                .endpoints
                .iter()
                .find(|endpoint| Some(endpoint.id.as_str()) == input.model_endpoint_id)
        });
        let (Some(profile), Some(endpoint)) = (profile.as_ref(), resolved) else {
            return Err(DomainError::new(ErrorCode::API_PROVIDER_UNAVAILABLE, "The previous provider is missing. Start a new chat to change its execution configuration.", 409, false).into());
        };
        let model_id = raw_model_from_endpoint_option_value(&endpoint.id, input.model);
        let model = endpoint
            .models
            .iter()
            .find(|model| raw_model(model) == model_id);
        let local = is_local(profile, endpoint, model);
        if model.is_none() && !local {
            return Err(DomainError::new(ErrorCode::API_PROVIDER_UNAVAILABLE, "The previous model classification is unknown. Start a new chat to change its execution configuration.", 409, false).into());
        }
        Ok(ResolvedModelSelection {
            model: input.model.into(),
            api_provider_id: Some(profile.id.clone()),
            endpoint_id: Some(endpoint.id.clone()),
            protocol: Some(endpoint.protocol),
            is_local: local,
            executor_id: None,
            endpoint: Some(build_endpoint_selection(profile, endpoint, model_id, local)),
        })
    }

    fn require_endpoint(
        &self,
        provider: &str,
        endpoint: &str,
        executor: &str,
    ) -> Result<ResolvedEndpointReference> {
        let api_provider = self
            .access
            .list(executor)?
            .into_iter()
            .find(|entry| entry.id == provider)
            .ok_or_else(|| {
                DomainError::new(
                    ErrorCode::API_PROVIDER_UNAVAILABLE,
                    "This provider is unavailable on the selected executor.",
                    409,
                    false,
                )
            })?;
        let endpoint = api_provider
            .endpoints
            .iter()
            .find(|entry| entry.id == endpoint)
            .cloned()
            .ok_or_else(|| {
                ModelSelectionError::new(
                    format!("Unknown API provider endpoint: {endpoint}"),
                    ModelSelectionErrorCode::EndpointNotFound,
                )
            })?;
        Ok(ResolvedEndpointReference {
            api_provider,
            endpoint,
        })
    }

    fn assert_compatible(
        &self,
        agent: &str,
        endpoint: &StoredApiProviderEndpoint,
        executor: &str,
    ) -> Result<()> {
        if !self.endpoint_supports_agent(agent, endpoint, executor) {
            return Err(ModelSelectionError::new(
                format!(
                    "{} endpoint cannot be used with {agent}.",
                    endpoint.protocol.as_str()
                ),
                ModelSelectionErrorCode::EndpointNotExposed,
            )
            .into());
        }
        Ok(())
    }

    fn endpoint_supports_agent(
        &self,
        agent: &str,
        endpoint: &StoredApiProviderEndpoint,
        executor: &str,
    ) -> bool {
        (self.supported_protocols)(agent, executor).contains(&endpoint.protocol)
    }
}

fn build_endpoint_selection(
    profile: &StoredApiProvider,
    endpoint: &StoredApiProviderEndpoint,
    model: &str,
    is_local: bool,
) -> AgentEndpointSelection {
    AgentEndpointSelection {
        api_provider_id: profile.id.clone(),
        endpoint_id: endpoint.id.clone(),
        provider_label: profile.label.clone(),
        protocol: endpoint.protocol,
        base_url: endpoint.base_url.clone(),
        model: model.into(),
        is_local,
        capabilities: endpoint.capabilities,
        headers: endpoint.headers.clone().unwrap_or_default(),
        credential: Some(AgentCredentialReference {
            kind: AgentCredentialReferenceKind::ApiProviderEndpoint,
            api_provider_id: profile.id.clone(),
            endpoint_id: endpoint.id.clone(),
            revision: profile.revision,
        }),
    }
}

fn selected_model<'a>(
    endpoint: &'a StoredApiProviderEndpoint,
    selected: &str,
) -> Option<&'a AgentModelOption> {
    let raw = raw_model_from_endpoint_option_value(&endpoint.id, selected);
    endpoint
        .models
        .iter()
        .find(|model| model.value == selected || raw_model(model) == raw)
}

fn raw_model(model: &AgentModelOption) -> &str {
    nonempty(model.raw_model.as_deref()).unwrap_or(&model.value)
}

fn is_local(
    profile: &StoredApiProvider,
    endpoint: &StoredApiProviderEndpoint,
    model: Option<&AgentModelOption>,
) -> bool {
    model.is_some_and(|model| model.is_local == Some(true))
        || endpoint.model_discovery == ModelDiscoveryKind::OllamaTags
        || profile.template_id == Some(ApiProviderTemplateId::Ollama)
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

pub fn assert_same_api_provider_boundary(
    previous: &ResolvedModelSelection,
    next: &ResolvedModelSelection,
) -> Result<()> {
    if previous.is_local != next.is_local {
        let direction = if previous.is_local {
            "local to cloud"
        } else {
            "cloud to local"
        };
        return Err(format!(
            "Cannot switch from {direction} model mid-session. Start a new chat to use this model."
        )
        .into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "endpoint_resolver_tests.rs"]
mod tests;
