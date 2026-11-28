//! Ports common/start-selection.ts.

use garcon_js::{OptionalNullable, json::Opaque};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent_integration::{AgentSettingsEnvelope, parse_agent_settings_envelope};
use crate::agent_settings::normalize_agent_settings;
use crate::agents::has_agent_execution_metadata;
use crate::api_providers::ApiProtocol;
use crate::chat_modes::{PermissionMode, ThinkingMode, is_permission_mode, is_thinking_mode};
use crate::execution_defaults::{
    execution_defaults_for_agent, is_permission_mode_supported, is_thinking_mode_supported,
    normalize_supported_permission_mode, normalize_supported_thinking_mode,
};
use crate::settings::RemoteExecutionDefaults;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StartSelectionErrorCode {
    UnknownAgent,
    InvalidCatalog,
    ProviderNotSupported,
    UnknownProvider,
    AmbiguousProvider,
    UnknownEndpoint,
    IncompatibleEndpoint,
    AmbiguousModel,
    UnknownModel,
    UnsupportedPermissionMode,
    UnsupportedReasoningEffort,
    PermissionOverrideRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct StartSelectionError {
    pub code: StartSelectionErrorCode,
    pub message: String,
}

impl StartSelectionError {
    pub fn new(code: StartSelectionErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

use StartSelectionErrorCode::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestedModelSelection {
    #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
    pub provider_id: OptionalNullable<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_id: Option<String>,
    pub model: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplicitModes {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestedStartSelection {
    pub agent_id: String,
    #[serde(flatten)]
    pub model_selection: RequestedModelSelection,
    #[serde(flatten)]
    pub modes: ExplicitModes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedModelSelection {
    pub model: String,
    pub api_provider_id: Option<String>,
    pub model_endpoint_id: Option<String>,
    pub model_protocol: Option<ApiProtocol>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedStartSelection {
    #[serde(flatten)]
    pub model_selection: ResolvedModelSelection,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub agent_settings: AgentSettingsEnvelope,
}

fn catalog_entries<'a>(catalog: &'a Value, key: &str) -> &'a [Value] {
    catalog["catalog"][key]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

fn available_values(label: &str, values: &[Value]) -> String {
    if values.is_empty() {
        format!("{label}: none")
    } else {
        format!(
            "{label}: {}",
            values
                .iter()
                .map(|value| field(value, "id").unwrap_or(""))
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}

fn api_protocol(value: &Value) -> Option<ApiProtocol> {
    match value.as_str()? {
        "anthropic-messages" => Some(ApiProtocol::AnthropicMessages),
        "openai-compatible" => Some(ApiProtocol::OpenAiCompatible),
        _ => None,
    }
}

fn validated_list<T>(value: &Value, parse: fn(&Value) -> Option<T>) -> Option<Vec<T>> {
    value.as_array()?.iter().map(parse).collect()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct CatalogAgent {
    wire: Opaque,
    #[serde(skip)]
    default_settings: AgentSettingsEnvelope,
    #[serde(skip)]
    permission_modes: Vec<PermissionMode>,
    #[serde(skip)]
    thinking_modes: Vec<ThinkingMode>,
    #[serde(skip)]
    protocols: Vec<ApiProtocol>,
}

impl CatalogAgent {
    pub fn as_value(&self) -> &Value {
        self.wire.as_value()
    }
}

pub fn require_catalog_agent(
    catalog: &Value,
    agent_id: &str,
) -> Result<CatalogAgent, StartSelectionError> {
    let agents = catalog_entries(catalog, "agents");
    let raw = agents
        .iter()
        .find(|entry| field(entry, "id") == Some(agent_id))
        .ok_or_else(|| {
            StartSelectionError::new(
                UnknownAgent,
                format!(
                    "unknown agent: {agent_id}; {}",
                    available_values("available agents", agents)
                ),
            )
        })?;
    let invalid = || {
        StartSelectionError::new(
            InvalidCatalog,
            format!("catalog entry for {agent_id} is invalid"),
        )
    };
    let default_settings = parse_agent_settings_envelope(&raw["defaultSettings"]);
    if !has_agent_execution_metadata(raw) || !raw["models"].is_array() {
        return Err(invalid());
    }
    let permission_modes =
        validated_list(&raw["supportedPermissionModes"], is_permission_mode).ok_or_else(invalid)?;
    let thinking_modes =
        validated_list(&raw["supportedThinkingModes"], is_thinking_mode).ok_or_else(invalid)?;
    let protocols = validated_list(&raw["supportedProtocols"], api_protocol).ok_or_else(invalid)?;
    if !raw["defaultModel"].is_string()
        || !raw["acceptsApiProviderEndpoints"].is_boolean()
        || !raw["requiresStrictModelDiscovery"].is_boolean()
    {
        return Err(invalid());
    }
    let default_settings = default_settings
        .filter(|settings| settings.owner_id == agent_id)
        .ok_or_else(invalid)?;
    let mut wire = raw.clone();
    wire["defaultSettings"] = serde_json::json!({
        "ownerId": default_settings.owner_id,
        "schemaVersion": default_settings.schema_version,
        "values": default_settings.values.as_value(),
    });
    Ok(CatalogAgent {
        wire: Opaque::from_value(wire),
        default_settings,
        permission_modes,
        thinking_modes,
        protocols,
    })
}

pub fn require_catalog_models(agent: &Value) -> Result<&[Value], StartSelectionError> {
    let invalid = || {
        StartSelectionError::new(
            InvalidCatalog,
            format!(
                "model catalog for {} is invalid",
                field(agent, "id").unwrap_or("undefined")
            ),
        )
    };
    let models = agent["models"].as_array().ok_or_else(invalid)?;
    let valid = models.iter().all(|model| {
        field(model, "value").is_some_and(|value| !value.is_empty())
            && field(model, "label").is_some()
            && ["apiProviderId", "endpointId", "rawModel"]
                .iter()
                .all(|key| model.get(key).is_none_or(Value::is_string))
            && model
                .get("protocol")
                .is_none_or(|value| api_protocol(value).is_some())
    });
    if !valid {
        return Err(invalid());
    }
    Ok(models)
}

pub fn require_catalog_provider<'a>(
    providers: &'a [Value],
    selector: &str,
) -> Result<&'a Value, StartSelectionError> {
    if let Some(provider) = providers
        .iter()
        .find(|provider| field(provider, "id") == Some(selector))
    {
        return Ok(provider);
    }
    let mut by_name = providers
        .iter()
        .filter(|provider| field(provider, "label") == Some(selector));
    if let Some(provider) = by_name.next() {
        if let Some(second) = by_name.next() {
            let ids = [provider, second]
                .into_iter()
                .chain(by_name)
                .map(|provider| field(provider, "id").unwrap_or(""))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(StartSelectionError::new(
                AmbiguousProvider,
                format!("API provider name {selector} is ambiguous; specify a provider ID: {ids}"),
            ));
        }
        return Ok(provider);
    }
    Err(StartSelectionError::new(
        UnknownProvider,
        format!(
            "unknown API provider: {selector}; {}",
            available_values("available providers", providers)
        ),
    ))
}

fn native_model(model: &str) -> ResolvedModelSelection {
    ResolvedModelSelection {
        model: model.to_owned(),
        api_provider_id: None,
        model_endpoint_id: None,
        model_protocol: None,
    }
}

pub fn resolve_catalog_model_selection(
    catalog: &Value,
    agent: &Value,
    model: &Value,
) -> Result<ResolvedModelSelection, StartSelectionError> {
    let value = field(model, "value").unwrap_or("undefined");
    let raw_model = field(model, "rawModel").unwrap_or(value);
    let provider_id = field(model, "apiProviderId").filter(|id| !id.is_empty());
    let endpoint_id = field(model, "endpointId").filter(|id| !id.is_empty());
    let incomplete = || {
        StartSelectionError::new(
            InvalidCatalog,
            format!("model routing for {value} is incomplete"),
        )
    };
    let Some(provider_id) = provider_id else {
        if endpoint_id.is_some()
            || field(model, "protocol").is_some_and(|protocol| !protocol.is_empty())
        {
            return Err(incomplete());
        }
        return Ok(native_model(raw_model));
    };
    let endpoint_id = endpoint_id.ok_or_else(incomplete)?;
    let protocol = field(model, "protocol")
        .filter(|protocol| !protocol.is_empty())
        .ok_or_else(incomplete)?;
    let endpoint = catalog_entries(catalog, "apiProviders")
        .iter()
        .find(|provider| field(provider, "id") == Some(provider_id))
        .and_then(|provider| provider["endpoints"].as_array())
        .and_then(|endpoints| {
            endpoints
                .iter()
                .find(|endpoint| field(endpoint, "id") == Some(endpoint_id))
        })
        .ok_or_else(|| {
            StartSelectionError::new(
                InvalidCatalog,
                format!("model routing for {value} is invalid"),
            )
        })?;
    let protocol = api_protocol(&endpoint["protocol"])
        .filter(|endpoint_protocol| {
            endpoint_protocol.as_str() == protocol
                && protocols_include(agent, endpoint_protocol.as_str())
        })
        .ok_or_else(|| {
            StartSelectionError::new(
                InvalidCatalog,
                format!("model routing for {value} is incompatible"),
            )
        })?;
    Ok(ResolvedModelSelection {
        model: raw_model.to_owned(),
        api_provider_id: Some(provider_id.to_owned()),
        model_endpoint_id: Some(endpoint_id.to_owned()),
        model_protocol: Some(protocol),
    })
}

fn protocols_include(agent: &Value, protocol: &str) -> bool {
    agent["supportedProtocols"]
        .as_array()
        .is_some_and(|protocols| {
            protocols
                .iter()
                .any(|value| value.as_str() == Some(protocol))
        })
}

fn resolve_provider_and_endpoint(
    catalog: &Value,
    agent: &CatalogAgent,
    agent_id: &str,
    requested: &RequestedModelSelection,
) -> Result<RequestedModelSelection, StartSelectionError> {
    if requested.provider_id.is_absent() {
        return Ok(requested.clone());
    }
    let Some(selector) = requested.provider_id.as_deref() else {
        if requested.endpoint_id.is_some() {
            return Err(StartSelectionError::new(
                IncompatibleEndpoint,
                "native model selection cannot specify an API endpoint",
            ));
        }
        return Ok(requested.clone());
    };
    let provider = require_catalog_provider(catalog_entries(catalog, "apiProviders"), selector)?;
    if agent.as_value()["acceptsApiProviderEndpoints"] == false {
        return Err(StartSelectionError::new(
            ProviderNotSupported,
            format!("agent {agent_id} does not accept API provider endpoints"),
        ));
    }
    let provider_id = field(provider, "id").unwrap_or("undefined");
    let endpoints = provider["endpoints"].as_array().ok_or_else(|| {
        StartSelectionError::new(
            InvalidCatalog,
            format!("endpoint catalog for provider {provider_id} is invalid"),
        )
    })?;
    let mut resolved = requested.clone();
    resolved.provider_id = OptionalNullable::some(provider_id.to_owned());
    let Some(endpoint_id) = requested.endpoint_id.as_deref().filter(|id| !id.is_empty()) else {
        return Ok(resolved);
    };
    let endpoint = endpoints
        .iter()
        .find(|endpoint| field(endpoint, "id") == Some(endpoint_id))
        .ok_or_else(|| {
            StartSelectionError::new(
                UnknownEndpoint,
                format!(
                    "unknown endpoint {endpoint_id} in provider {provider_id}; {}",
                    available_values("available endpoints", endpoints)
                ),
            )
        })?;
    if !api_protocol(&endpoint["protocol"])
        .is_some_and(|protocol| agent.protocols.contains(&protocol))
    {
        return Err(StartSelectionError::new(
            IncompatibleEndpoint,
            format!("endpoint {endpoint_id} is not compatible with agent {agent_id}"),
        ));
    }
    Ok(resolved)
}

fn matching_models<'a>(models: &'a [Value], requested: &RequestedModelSelection) -> Vec<&'a Value> {
    let routed = models.iter().filter(|model| {
        (requested.provider_id.is_absent()
            || field(model, "apiProviderId") == requested.provider_id.as_deref())
            && requested
                .endpoint_id
                .as_deref()
                .is_none_or(|endpoint_id| field(model, "endpointId") == Some(endpoint_id))
    });
    let exact: Vec<_> = routed
        .clone()
        .filter(|model| field(model, "value") == Some(requested.model.as_str()))
        .collect();
    if !exact.is_empty() {
        return exact;
    }
    routed
        .filter(|model| field(model, "rawModel") == Some(requested.model.as_str()))
        .collect()
}

fn describe_routing(model: &Value) -> String {
    let route = ["apiProviderId", "endpointId"]
        .into_iter()
        .filter_map(|key| field(model, key).filter(|value| !value.is_empty()))
        .collect::<Vec<_>>()
        .join("/");
    if route.is_empty() {
        "native".to_owned()
    } else {
        route
    }
}

pub fn resolve_model_selection(
    catalog: &Value,
    agent_id: &str,
    requested: &RequestedModelSelection,
) -> Result<ResolvedModelSelection, StartSelectionError> {
    let agent = require_catalog_agent(catalog, agent_id)?;
    resolve_model_selection_for_agent(catalog, &agent, agent_id, requested)
}

fn resolve_model_selection_for_agent(
    catalog: &Value,
    agent: &CatalogAgent,
    agent_id: &str,
    requested: &RequestedModelSelection,
) -> Result<ResolvedModelSelection, StartSelectionError> {
    let resolved = resolve_provider_and_endpoint(catalog, agent, agent_id, requested)?;
    let matches = matching_models(require_catalog_models(agent.as_value())?, &resolved);
    if matches.len() > 1 {
        let routes = matches
            .iter()
            .map(|model| describe_routing(model))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(StartSelectionError::new(
            AmbiguousModel,
            format!(
                "model {} is ambiguous across: {routes}; specify --provider and --endpoint",
                requested.model
            ),
        ));
    }
    let Some(selected) = matches.first() else {
        if !requested.provider_id.is_absent()
            || requested
                .endpoint_id
                .as_ref()
                .is_some_and(|id| !id.is_empty())
            || agent.as_value()["requiresStrictModelDiscovery"] == true
        {
            return Err(StartSelectionError::new(
                UnknownModel,
                format!(
                    "model {} is not available for agent {agent_id}",
                    requested.model
                ),
            ));
        }
        return Ok(native_model(&requested.model));
    };
    resolve_catalog_model_selection(catalog, agent.as_value(), selected)
}

fn strict_permission_mode(
    requested: Option<PermissionMode>,
    agent: &CatalogAgent,
    agent_id: &str,
    fallback: PermissionMode,
) -> Result<PermissionMode, StartSelectionError> {
    let Some(requested) = requested else {
        return Ok(normalize_supported_permission_mode(
            &Value::String(fallback.as_str().to_owned()),
            &agent.permission_modes,
        ));
    };
    if !is_permission_mode_supported(requested, &agent.permission_modes) {
        return Err(StartSelectionError::new(
            UnsupportedPermissionMode,
            format!(
                "permission mode {} is not supported by agent {agent_id}",
                requested.as_str()
            ),
        ));
    }
    Ok(requested)
}

fn strict_thinking_mode(
    requested: Option<&str>,
    agent: &CatalogAgent,
    agent_id: &str,
    fallback: ThinkingMode,
) -> Result<ThinkingMode, StartSelectionError> {
    let Some(requested) = requested else {
        return Ok(normalize_supported_thinking_mode(
            &Value::String(fallback.as_str().to_owned()),
            &agent.thinking_modes,
        ));
    };
    is_thinking_mode(&Value::String(requested.to_owned()))
        .filter(|mode| is_thinking_mode_supported(*mode, &agent.thinking_modes))
        .ok_or_else(|| {
            StartSelectionError::new(
                UnsupportedReasoningEffort,
                format!("reasoning effort {requested} is not supported by agent {agent_id}"),
            )
        })
}

pub fn validate_explicit_modes(
    catalog: &Value,
    agent_id: &str,
    requested: &ExplicitModes,
) -> Result<(), StartSelectionError> {
    let agent = require_catalog_agent(catalog, agent_id)?;
    if requested.permission_mode.is_some() {
        strict_permission_mode(
            requested.permission_mode,
            &agent,
            agent_id,
            PermissionMode::Default,
        )?;
    }
    if requested.thinking_mode.is_some() {
        strict_thinking_mode(
            requested.thinking_mode.as_deref(),
            &agent,
            agent_id,
            ThinkingMode::None,
        )?;
    }
    Ok(())
}

pub fn resolve_start_selection(
    catalog: &Value,
    defaults: Option<&RemoteExecutionDefaults>,
    requested: &RequestedStartSelection,
) -> Result<ResolvedStartSelection, StartSelectionError> {
    let agent_id = &requested.agent_id;
    let agent = require_catalog_agent(catalog, agent_id)?;
    let defaults = execution_defaults_for_agent(defaults, agent_id);
    let permission_mode = strict_permission_mode(
        requested.modes.permission_mode,
        &agent,
        agent_id,
        defaults.permission_mode,
    )?;
    if requested.modes.permission_mode.is_none()
        && matches!(
            permission_mode,
            PermissionMode::ManualBypass | PermissionMode::BypassPermissions
        )
    {
        let mode = permission_mode.as_str();
        return Err(StartSelectionError::new(
            PermissionOverrideRequired,
            format!("configured permission mode {mode} requires explicit --permissions {mode}"),
        ));
    }
    let thinking_mode = strict_thinking_mode(
        requested.modes.thinking_mode.as_deref(),
        &agent,
        agent_id,
        defaults.thinking_mode,
    )?;
    let agent_settings = normalize_agent_settings(
        agent_id,
        defaults.agent_settings_by_id.get(agent_id),
        &agent.default_settings,
    );
    Ok(ResolvedStartSelection {
        model_selection: resolve_model_selection_for_agent(
            catalog,
            &agent,
            agent_id,
            &requested.model_selection,
        )?,
        permission_mode,
        thinking_mode,
        agent_settings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn catalog() -> Value {
        json!({"catalog":{
            "agents":[{
                "id":"codex","executionPolicy":"conversation","selectionLabel":"Model","inputFormatByModel":{},
                "models":[
                    {"value":"native","label":"Native model","rawModel":"shared"},
                    {"value":"east:shared","label":"East","rawModel":"shared","apiProviderId":"acme","endpointId":"east","protocol":"openai-compatible"},
                    {"value":"west:shared","label":"West","rawModel":"shared","apiProviderId":"acme","endpointId":"west","protocol":"openai-compatible"}],
                "defaultModel":"native","supportedPermissionModes":["default","acceptEdits","bypassPermissions","plan"],
                "supportedThinkingModes":["none","high"],"supportedProtocols":["openai-compatible"],"acceptsApiProviderEndpoints":true,
                "requiresStrictModelDiscovery":true,"defaultSettings":{"ownerId":"codex","schemaVersion":1,"values":{"source":"default"}}
            }],
            "apiProviders":[{"id":"acme","label":"Acme","endpoints":[
                {"id":"east","protocol":"openai-compatible"},{"id":"west","protocol":"openai-compatible"}]}]
        }})
    }

    fn request(model: &str) -> RequestedModelSelection {
        RequestedModelSelection {
            model: model.to_owned(),
            provider_id: OptionalNullable::ABSENT,
            endpoint_id: None,
        }
    }

    fn start_request() -> RequestedStartSelection {
        RequestedStartSelection {
            agent_id: "codex".to_owned(),
            model_selection: request("native"),
            modes: ExplicitModes::default(),
        }
    }

    fn defaults(permission_mode: PermissionMode) -> RemoteExecutionDefaults {
        let mut global = crate::settings::default_execution_defaults();
        global.permission_mode = permission_mode;
        global.thinking_mode = ThinkingMode::High;
        global.agent_settings_by_id.insert(
            "codex".to_owned(),
            AgentSettingsEnvelope {
                owner_id: "codex".to_owned(),
                schema_version: 1,
                values: Opaque::from_value(json!({"source":"saved"})),
            },
        );
        RemoteExecutionDefaults {
            global,
            by_agent: Default::default(),
        }
    }

    #[test]
    fn rejects_incomplete_execution_metadata() {
        for (key, invalid) in [
            ("executionPolicy", Value::Null),
            ("executionPolicy", json!("unknown")),
            ("selectionLabel", Value::Null),
            ("selectionLabel", json!("")),
        ] {
            let mut catalog = catalog();
            catalog["catalog"]["agents"][0][key] = invalid;
            assert_eq!(
                resolve_model_selection(&catalog, "codex", &request("native"))
                    .unwrap_err()
                    .code,
                InvalidCatalog
            );
        }
    }

    #[test]
    fn resolves_exact_provider_names_to_canonical_routes_without_mutating_the_request() {
        let mut catalog = catalog();
        catalog["catalog"]["apiProviders"][0]["label"] = json!("Example Proxy & Co");
        for model in ["shared", "west:shared"] {
            let request = RequestedStartSelection {
                model_selection: RequestedModelSelection {
                    provider_id: OptionalNullable::some("Example Proxy & Co".to_owned()),
                    endpoint_id: Some("west".to_owned()),
                    ..request(model)
                },
                ..start_request()
            };
            let result = resolve_start_selection(
                &catalog,
                Some(&defaults(PermissionMode::AcceptEdits)),
                &request,
            )
            .unwrap();
            assert_eq!(result.model_selection.model, "shared");
            assert_eq!(
                result.model_selection.api_provider_id.as_deref(),
                Some("acme")
            );
            assert_eq!(
                result.model_selection.model_endpoint_id.as_deref(),
                Some("west")
            );
            assert_eq!(
                result.model_selection.model_protocol,
                Some(ApiProtocol::OpenAiCompatible)
            );
            assert_eq!(result.permission_mode, PermissionMode::AcceptEdits);
            assert_eq!(result.thinking_mode, ThinkingMode::High);
            assert_eq!(result.agent_settings.values["source"], "saved");
            assert_eq!(
                request.model_selection.provider_id.as_deref(),
                Some("Example Proxy & Co")
            );
        }
    }

    #[test]
    fn prefers_an_exact_provider_id_and_rejects_duplicate_names_before_filtering() {
        let mut catalog = catalog();
        let providers = catalog["catalog"]["apiProviders"].as_array_mut().unwrap();
        providers.insert(0, json!({"id":"first","label":"acme","endpoints":[]}));
        providers.push(json!({"id":"other","label":"Acme","endpoints":[]}));
        let mut request = RequestedModelSelection {
            provider_id: OptionalNullable::some("acme".to_owned()),
            endpoint_id: Some("west".to_owned()),
            ..request("west:shared")
        };
        assert_eq!(
            resolve_model_selection(&catalog, "codex", &request)
                .unwrap()
                .api_provider_id
                .as_deref(),
            Some("acme")
        );
        request.provider_id = OptionalNullable::some("Acme".to_owned());
        assert_eq!(
            resolve_model_selection(&catalog, "codex", &request)
                .unwrap_err()
                .code,
            AmbiguousProvider
        );
    }

    #[test]
    fn validates_provider_identity_before_agent_endpoint_support() {
        let mut catalog = catalog();
        catalog["catalog"]["agents"][0]["acceptsApiProviderEndpoints"] = json!(false);
        catalog["catalog"]["apiProviders"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"other","label":"Acme","endpoints":[]}));
        for (selector, expected) in [
            ("Acme", AmbiguousProvider),
            ("ACME", UnknownProvider),
            (" Acme ", UnknownProvider),
            ("acme", ProviderNotSupported),
        ] {
            let request = RequestedModelSelection {
                provider_id: OptionalNullable::some(selector.to_owned()),
                ..request("native")
            };
            assert_eq!(
                resolve_model_selection(&catalog, "codex", &request)
                    .unwrap_err()
                    .code,
                expected
            );
        }
    }

    #[test]
    fn pins_native_routing_without_silently_admitting_undiscovered_models() {
        let mut catalog = catalog();
        let mut request = request("shared");
        assert_eq!(
            resolve_model_selection(&catalog, "codex", &request)
                .unwrap_err()
                .code,
            AmbiguousModel
        );
        request.provider_id = OptionalNullable::NULL;
        assert_eq!(
            resolve_model_selection(&catalog, "codex", &request),
            Ok(native_model("shared"))
        );
        request.endpoint_id = Some("east".to_owned());
        assert_eq!(
            resolve_model_selection(&catalog, "codex", &request)
                .unwrap_err()
                .code,
            IncompatibleEndpoint
        );
        request.endpoint_id = None;
        request.model = "future".to_owned();
        catalog["catalog"]["agents"][0]["requiresStrictModelDiscovery"] = json!(false);
        assert_eq!(
            resolve_model_selection(&catalog, "codex", &request)
                .unwrap_err()
                .code,
            UnknownModel
        );
        request.provider_id = OptionalNullable::ABSENT;
        assert_eq!(
            resolve_model_selection(&catalog, "codex", &request),
            Ok(native_model("future"))
        );
        catalog["catalog"]["agents"][0]["requiresStrictModelDiscovery"] = json!(true);
        assert_eq!(
            resolve_model_selection(&catalog, "codex", &request)
                .unwrap_err()
                .code,
            UnknownModel
        );
    }

    #[test]
    fn classifies_missing_endpoints_and_malformed_routes() {
        let mut catalog = catalog();
        let mut request = RequestedModelSelection {
            provider_id: OptionalNullable::some("acme".to_owned()),
            endpoint_id: Some("missing".to_owned()),
            ..request("shared")
        };
        assert_eq!(
            resolve_model_selection(&catalog, "codex", &request)
                .unwrap_err()
                .code,
            UnknownEndpoint
        );
        assert_eq!(
            resolve_model_selection(&catalog, "missing", &request)
                .unwrap_err()
                .code,
            UnknownAgent
        );
        request.endpoint_id = None;
        request.provider_id = OptionalNullable::NULL;
        catalog["catalog"]["agents"][0]["models"][0]["endpointId"] = json!("west");
        assert_eq!(
            resolve_model_selection(&catalog, "codex", &request)
                .unwrap_err()
                .code,
            InvalidCatalog
        );
        catalog["catalog"]["agents"][0]["models"][0]["protocol"] = json!("bad");
        assert_eq!(
            resolve_model_selection(&catalog, "codex", &request)
                .unwrap_err()
                .code,
            InvalidCatalog
        );
    }

    #[test]
    fn uses_only_neutral_explicit_reasoning_for_agents_without_reasoning_support() {
        let mut catalog = catalog();
        catalog["catalog"]["agents"][0]["supportedThinkingModes"] = json!([]);
        let mut request = start_request();
        request.modes.thinking_mode = Some("none".to_owned());
        assert_eq!(
            resolve_start_selection(&catalog, None, &request)
                .unwrap()
                .thinking_mode,
            ThinkingMode::None
        );
        for mode in ["high", "ultra"] {
            request.modes.thinking_mode = Some(mode.to_owned());
            assert_eq!(
                resolve_start_selection(&catalog, None, &request)
                    .unwrap_err()
                    .code,
                UnsupportedReasoningEffort
            );
        }
    }

    #[test]
    fn requires_inherited_bypass_permission_to_be_explicit() {
        let catalog = catalog();
        let defaults = defaults(PermissionMode::BypassPermissions);
        let mut request = start_request();
        assert_eq!(
            resolve_start_selection(&catalog, Some(&defaults), &request)
                .unwrap_err()
                .code,
            PermissionOverrideRequired
        );
        request.modes.permission_mode = Some(PermissionMode::BypassPermissions);
        assert_eq!(
            resolve_start_selection(&catalog, Some(&defaults), &request)
                .unwrap()
                .permission_mode,
            PermissionMode::BypassPermissions
        );
    }
}
