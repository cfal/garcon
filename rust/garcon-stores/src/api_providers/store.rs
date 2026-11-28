//! Private provider records in the controller's configuration directory.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::future::Future;
use std::io;
use std::rc::Rc;

use garcon_base::{
    domain_error::DomainError, errors::NamedError, json_file_store::JsonFileStore,
    keyed_lock::KeyedLock,
};
use garcon_contract::{
    agents::AgentModelOption,
    api_provider_templates::{ManagedHeaders, api_provider_template},
    api_providers::{
        ApiProtocol, ApiProviderCatalogEntry, ApiProviderEndpointCatalogEntry,
        ApiProviderTemplateId, ModelDiscoveryKind, OpenAiEndpointCapabilities, is_api_provider_id,
        is_api_provider_template_id, label_for_protocol,
    },
    error_codes::ErrorCode,
};
use garcon_js::{Clock, clock::to_iso_string, json, path::native, trim, utf16};
use indexmap::IndexMap;
use serde::{Serialize, Serializer, ser::SerializeStruct};
use serde_json::Value;
use tokio_util::task::TaskTracker;
use url::Url;

use super::reference_writes::ApiProviderReferenceWrites;
use super::{Listener, Listeners, Result, SnapshotWriter, js_truthy, renamed_write, revision};

const WRITE_LOCK: &str = "profiles";
const MAX_REVISION: i64 = (1 << 53) - 1;

#[derive(Clone)]
pub struct StoredApiProvider {
    pub id: String,
    pub revision: i64,
    pub label: String,
    pub template_id: Option<ApiProviderTemplateId>,
    pub endpoints: Vec<StoredApiProviderEndpoint>,
    pub created_at: String,
    pub updated_at: String,
    // The on-disk constructors put endpoints in different positions.
    created_here: bool,
}

impl Serialize for StoredApiProvider {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut fields = serializer.serialize_struct(
            "StoredApiProvider",
            6 + usize::from(self.template_id.is_some()),
        )?;
        fields.serialize_field("id", &self.id)?;
        fields.serialize_field("revision", &self.revision)?;
        fields.serialize_field("label", &self.label)?;
        if let Some(template) = self.template_id {
            fields.serialize_field("templateId", &template)?;
        }
        if !self.created_here {
            fields.serialize_field("endpoints", &self.endpoints)?;
        }
        fields.serialize_field("createdAt", &self.created_at)?;
        fields.serialize_field("updatedAt", &self.updated_at)?;
        if self.created_here {
            fields.serialize_field("endpoints", &self.endpoints)?;
        }
        fields.end()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredApiProviderEndpoint {
    pub id: String,
    pub protocol: ApiProtocol,
    pub base_url: String,
    pub api_key: String,
    pub api_key_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<OpenAiEndpointCapabilities>,
    pub default_model: String,
    pub models: Vec<AgentModelOption>,
    pub supports_images: bool,
    pub model_discovery: ModelDiscoveryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<IndexMap<String, String>>,
}

impl StoredApiProvider {
    pub fn redacted(&self) -> ApiProviderCatalogEntry {
        ApiProviderCatalogEntry {
            id: self.id.clone(),
            revision: self.revision,
            label: self.label.clone(),
            template_id: self.template_id,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            endpoints: self
                .endpoints
                .iter()
                .map(|endpoint| ApiProviderEndpointCatalogEntry {
                    id: endpoint.id.clone(),
                    protocol: endpoint.protocol,
                    base_url: endpoint.base_url.clone(),
                    capabilities: endpoint.capabilities,
                    default_model: endpoint.default_model.clone(),
                    models: endpoint.models.clone(),
                    supports_images: endpoint.supports_images,
                    has_api_key: !endpoint.api_key.is_empty(),
                    api_key_label: Some(endpoint.api_key_label.clone()),
                    model_discovery: Some(endpoint.model_discovery),
                })
                .collect(),
        }
    }
}

pub struct CreateApiProviderInput {
    pub template_id: ApiProviderTemplateId,
    pub label: String,
    pub protocol: ApiProtocol,
    pub base_url: String,
    pub api_key: Option<String>,
    pub capabilities: Option<OpenAiEndpointCapabilities>,
    pub default_model: String,
    pub models: Vec<AgentModelOption>,
    pub supports_images: bool,
    pub model_discovery: ModelDiscoveryKind,
}

#[derive(Default)]
pub struct UpdateApiProviderEndpointInput {
    pub id: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub clear_api_key: Option<bool>,
    pub capabilities: Option<OpenAiEndpointCapabilities>,
    pub default_model: Option<String>,
    pub models: Option<Vec<AgentModelOption>>,
    pub supports_images: Option<bool>,
    pub model_discovery: Option<ModelDiscoveryKind>,
}

#[derive(Default)]
pub struct UpdateApiProviderInput {
    pub revision: Option<i64>,
    pub label: Option<String>,
    pub endpoint: Option<UpdateApiProviderEndpointInput>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    version: u8,
    legacy_provider_ids: Vec<String>,
    api_providers: Vec<StoredApiProvider>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            version: 2,
            legacy_provider_ids: Vec::new(),
            api_providers: Vec::new(),
        }
    }
}

pub struct ApiProviderStore {
    path: String,
    clock: Rc<dyn Clock>,
    snapshot: RefCell<Snapshot>,
    unavailable: Cell<bool>,
    lock: KeyedLock,
    tasks: TaskTracker,
    references: Rc<ApiProviderReferenceWrites>,
    listeners: Listeners,
    writer: Rc<dyn SnapshotWriter<Snapshot>>,
}

impl ApiProviderStore {
    pub async fn open(config_dir: &str, clock: Rc<dyn Clock>) -> Result<Rc<Self>> {
        Self::open_with_writer(config_dir, clock, Rc::new(JsonFileStore::default())).await
    }

    pub(super) async fn open_with_writer(
        config_dir: &str,
        clock: Rc<dyn Clock>,
        writer: Rc<dyn SnapshotWriter<Snapshot>>,
    ) -> Result<Rc<Self>> {
        let path = native::join(&[config_dir, "api-providers.json"]);
        tokio::fs::create_dir_all(config_dir).await?;
        let snapshot = JsonFileStore::default()
            .read_json_state_file(&path, Snapshot::default, |raw| {
                normalize_snapshot(&raw, &*clock)
            })
            .await?;
        let store = Rc::new(Self {
            path,
            clock,
            snapshot: RefCell::new(Snapshot::default()),
            unavailable: Cell::new(false),
            lock: KeyedLock::new(),
            tasks: TaskTracker::new(),
            references: Rc::new(ApiProviderReferenceWrites::default()),
            listeners: Listeners::default(),
            writer,
        });
        store.write(snapshot).await?;
        Ok(store)
    }

    pub async fn drain(&self) {
        self.tasks.close();
        self.tasks.wait().await;
    }

    pub fn on_changed(&self, listener: Listener) -> impl FnOnce() + use<> {
        self.listeners.subscribe(listener)
    }

    pub fn legacy_provider_ids(&self) -> Result<Vec<String>> {
        self.assert_available()?;
        Ok(self.snapshot.borrow().legacy_provider_ids.clone())
    }

    pub fn list(&self) -> Result<Vec<StoredApiProvider>> {
        self.assert_available()?;
        Ok(self.snapshot.borrow().api_providers.clone())
    }

    pub fn redacted_list(&self) -> Result<Vec<ApiProviderCatalogEntry>> {
        self.assert_available()?;
        Ok(self
            .snapshot
            .borrow()
            .api_providers
            .iter()
            .map(StoredApiProvider::redacted)
            .collect())
    }

    pub fn get_api_provider(&self, id: &str) -> Result<Option<StoredApiProvider>> {
        self.assert_available()?;
        Ok(self
            .snapshot
            .borrow()
            .api_providers
            .iter()
            .find(|provider| provider.id == id)
            .cloned())
    }

    pub fn get_endpoint(
        &self,
        id: &str,
    ) -> Result<Option<(StoredApiProvider, StoredApiProviderEndpoint)>> {
        self.assert_available()?;
        Ok(self
            .snapshot
            .borrow()
            .api_providers
            .iter()
            .find_map(|provider| {
                provider
                    .endpoints
                    .iter()
                    .find(|endpoint| endpoint.id == id)
                    .map(|endpoint| (provider.clone(), endpoint.clone()))
            }))
    }

    pub fn retain_references(
        self: &Rc<Self>,
        next: &[String],
        current: &[String],
    ) -> Result<Box<dyn FnOnce()>> {
        let guard = self
            .references
            .retain(next, current, |id| Ok(self.get_api_provider(id)?.is_some()))?;
        Ok(Box::new(move || drop(guard)))
    }

    pub async fn create_api_provider(
        self: &Rc<Self>,
        input: CreateApiProviderInput,
    ) -> Result<StoredApiProvider> {
        let label = required_string(Some(&input.label), "label")?;
        let base_url = normalize_base_url(Some(&input.base_url), "baseUrl")?;
        let capabilities = check_capabilities(input.protocol, input.capabilities)?;
        let default_model = required_string(Some(&input.default_model), "defaultModel")?;
        let models = ensure_default_model(input.models, &default_model);
        let template = api_provider_template(input.protocol, input.template_id)
            .ok_or_else(|| unsupported_template(input.protocol, input.template_id))?;
        self.with_lock(move |store| async move {
            let mut snapshot = store.snapshot.borrow().clone();
            let now = to_iso_string(store.clock.now_ms())?;
            let id = create_api_provider_id(&label)?;
            let suffix = match input.protocol {
                ApiProtocol::AnthropicMessages => "anthropic",
                ApiProtocol::OpenAiCompatible => "openai",
            };
            let api_key = input.api_key.unwrap_or_default();
            let api_provider = StoredApiProvider {
                revision: 1,
                label,
                template_id: Some(input.template_id),
                created_at: now.clone(),
                updated_at: now,
                endpoints: vec![StoredApiProviderEndpoint {
                    id: format!("{id}_{suffix}"),
                    protocol: input.protocol,
                    base_url,
                    api_key_label: label_api_key(&api_key),
                    api_key,
                    capabilities,
                    default_model,
                    models,
                    supports_images: input.supports_images,
                    model_discovery: input.model_discovery,
                    headers: (template.managed_headers == Some(ManagedHeaders::Openrouter)).then(
                        || {
                            IndexMap::from([
                                (
                                    "HTTP-Referer".into(),
                                    "https://github.com/cfal/garcon".into(),
                                ),
                                ("X-OpenRouter-Title".into(), "Garcon".into()),
                            ])
                        },
                    ),
                }],
                id,
                created_here: true,
            };
            snapshot.api_providers.push(api_provider.clone());
            store.write(snapshot).await?;
            Ok(api_provider)
        })
        .await
    }

    pub async fn update_api_provider(
        self: &Rc<Self>,
        id: String,
        patch: UpdateApiProviderInput,
    ) -> Result<StoredApiProvider> {
        self.with_lock(move |store| async move {
            let mut snapshot = store.snapshot.borrow().clone();
            let provider = snapshot
                .api_providers
                .iter_mut()
                .find(|entry| entry.id == id)
                .ok_or_else(|| format!("Unknown API provider: {id}"))?;
            if patch
                .revision
                .is_some_and(|revision| revision != provider.revision)
            {
                return Err(configuration_changed().into());
            }
            if provider.revision >= MAX_REVISION {
                return Err("API provider revision exhausted".into());
            }
            provider.revision += 1;
            if let Some(label) = patch.label {
                provider.label = required_string(Some(&label), "label")?;
            }
            provider.updated_at = to_iso_string(store.clock.now_ms())?;
            if let Some(patch) = patch.endpoint {
                let id = patch.id.as_deref().or_else(|| {
                    provider
                        .endpoints
                        .first()
                        .map(|endpoint| endpoint.id.as_str())
                });
                let id = id.ok_or("Unknown endpoint: undefined")?.to_owned();
                let endpoint = provider
                    .endpoints
                    .iter_mut()
                    .find(|entry| entry.id == id)
                    .ok_or_else(|| format!("Unknown endpoint: {id}"))?;
                apply_endpoint_patch(endpoint, patch)?;
            }
            let stored = provider.clone();
            store.write(snapshot).await?;
            Ok(stored)
        })
        .await
    }

    pub async fn delete_api_provider(
        self: &Rc<Self>,
        id: String,
        is_referenced: impl FnOnce(&str) -> Result<bool> + 'static,
    ) -> Result<()> {
        self.with_lock(move |store| async move {
            let mut snapshot = store.snapshot.borrow().clone();
            let Some(index) = snapshot
                .api_providers
                .iter()
                .position(|entry| entry.id == id)
            else {
                return Ok(());
            };
            let _deleting = store.references.deleting(&id, || is_referenced(&id))?;
            snapshot.api_providers.remove(index);
            store.write(snapshot).await
        })
        .await
    }

    pub async fn with_lock<T: 'static, F, Fut>(self: &Rc<Self>, operation: F) -> Result<T>
    where
        F: FnOnce(Rc<Self>) -> Fut + 'static,
        Fut: Future<Output = Result<T>> + 'static,
    {
        let store = self.clone();
        self.run_detached(async move {
            store
                .lock
                .run_exclusive(
                    WRITE_LOCK,
                    || async {
                        store.assert_available()?;
                        operation(store.clone()).await
                    },
                    None,
                )
                .await?
        })
        .await
    }

    pub(super) async fn run_detached<T: 'static>(
        &self,
        operation: impl Future<Output = Result<T>> + 'static,
    ) -> Result<T> {
        self.tasks.spawn_local(operation).await?
    }

    async fn write(&self, snapshot: Snapshot) -> Result<()> {
        if let Err(error) = self.writer.write(&self.path, &snapshot).await {
            if renamed_write(error.as_ref()) {
                self.unavailable.set(true);
            }
            self.listeners.publish()?;
            return Err(error);
        }
        self.snapshot.replace(snapshot);
        self.listeners.publish()
    }

    fn assert_available(&self) -> Result<()> {
        if self.unavailable.get() {
            return Err(DomainError::new(
                ErrorCode::API_PROVIDER_STORAGE_UNAVAILABLE,
                "Provider write durability is unknown. Restart after checking configuration.",
                503,
                false,
            )
            .into());
        }
        Ok(())
    }
}

fn apply_endpoint_patch(
    endpoint: &mut StoredApiProviderEndpoint,
    patch: UpdateApiProviderEndpointInput,
) -> Result<()> {
    if let Some(url) = patch.base_url {
        endpoint.base_url = normalize_base_url(Some(&url), "baseUrl")?;
    }
    if let Some(capabilities) = patch.capabilities {
        endpoint.capabilities = check_capabilities(endpoint.protocol, Some(capabilities))?;
    }
    if let Some(default) = patch.default_model {
        endpoint.default_model = required_string(Some(&default), "defaultModel")?;
    }
    if let Some(models) = patch.models {
        endpoint.models = ensure_default_model(models, &endpoint.default_model);
    }
    if let Some(supports_images) = patch.supports_images {
        endpoint.supports_images = supports_images;
    }
    if let Some(discovery) = patch.model_discovery {
        endpoint.model_discovery = discovery;
    }
    if patch.clear_api_key == Some(true) {
        endpoint.api_key.clear();
        endpoint.api_key_label.clear();
    } else if let Some(key) = patch.api_key.filter(|key| !key.is_empty()) {
        endpoint.api_key_label = label_api_key(&key);
        endpoint.api_key = key;
    }
    Ok(())
}

fn normalize_snapshot(raw: &Value, clock: &dyn Clock) -> Result<Snapshot> {
    if !raw.is_object() && !raw.is_array() {
        return Err(type_error("API provider state must be a JSON object"));
    }
    let version = json::as_number(&raw["version"]);
    let Some(providers) = raw["apiProviders"]
        .as_array()
        .filter(|_| matches!(version, Some(1.0 | 2.0)))
    else {
        return Err(type_error("Invalid API provider state"));
    };
    let normalized = providers
        .iter()
        .map(|raw| normalize_stored_provider(raw, clock))
        .collect::<Result<Vec<_>>>()?;
    let mut ids = HashSet::new();
    let mut endpoint_ids = HashSet::new();
    if normalized.iter().any(|entry| {
        !ids.insert(&entry.id)
            || entry
                .endpoints
                .iter()
                .any(|endpoint| !endpoint_ids.insert(&endpoint.id))
    }) {
        return Err(type_error("Duplicate API provider or endpoint IDs"));
    }
    let legacy_provider_ids = if version == Some(1.0) {
        normalized.iter().map(|entry| entry.id.clone()).collect()
    } else {
        let legacy = raw["legacyProviderIds"]
            .as_array()
            .filter(|entries| entries.iter().all(is_api_provider_id))
            .filter(|_| {
                providers
                    .iter()
                    .all(|entry| revision(&entry["revision"]).is_some_and(|revision| revision > 0))
            })
            .ok_or_else(|| type_error("Invalid API provider revision or migration seed"))?;
        legacy
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    };
    Ok(Snapshot {
        version: 2,
        legacy_provider_ids,
        api_providers: normalized,
    })
}

fn normalize_stored_provider(raw: &Value, clock: &dyn Clock) -> Result<StoredApiProvider> {
    let invalid = || type_error("Invalid API provider profile");
    let id = raw["id"]
        .as_str()
        .filter(|_| is_api_provider_id(&raw["id"]))
        .ok_or_else(invalid)?;
    let label = raw["label"].as_str().ok_or_else(invalid)?;
    let endpoints = raw["endpoints"]
        .as_array()
        .filter(|entries| !entries.is_empty())
        .ok_or_else(invalid)?;
    let endpoints = endpoints
        .iter()
        .map(normalize_stored_endpoint)
        .collect::<Result<Vec<_>>>()
        .map_err(|_| invalid())?;
    let now = to_iso_string(clock.now_ms())?;
    Ok(StoredApiProvider {
        id: id.into(),
        revision: revision(&raw["revision"])
            .filter(|value| *value > 0)
            .unwrap_or(1),
        label: label.into(),
        template_id: is_api_provider_template_id(&raw["templateId"]),
        endpoints,
        created_at: raw["createdAt"].as_str().unwrap_or(&now).into(),
        updated_at: raw["updatedAt"].as_str().unwrap_or(&now).into(),
        created_here: false,
    })
}

fn normalize_stored_endpoint(raw: &Value) -> Result<StoredApiProviderEndpoint> {
    let id = raw["id"]
        .as_str()
        .filter(|_| is_api_provider_id(&raw["id"]))
        .ok_or("Invalid endpoint ID")?;
    let protocol = protocol(&raw["protocol"]).ok_or("Invalid endpoint protocol")?;
    let base_url = normalize_base_url(raw["baseUrl"].as_str(), "baseUrl")?;
    let default_model = required_string(raw["defaultModel"].as_str(), "defaultModel")?;
    let api_key = raw["apiKey"].as_str().unwrap_or_default();
    let capabilities = &raw["capabilities"];
    let caps = check_capabilities(
        protocol,
        Some(OpenAiEndpointCapabilities {
            chat_completions: capabilities["chatCompletions"].as_bool() != Some(false),
            responses: capabilities["responses"].as_bool() == Some(true),
        }),
    )?;
    let headers: Option<IndexMap<_, _>> = raw["headers"]
        .as_object()
        .map(|headers| {
            headers
                .iter()
                .filter_map(|(name, value)| {
                    value.as_str().map(|value| (name.clone(), value.to_owned()))
                })
                .collect()
        })
        .filter(|headers: &IndexMap<String, String>| !headers.is_empty());
    Ok(StoredApiProviderEndpoint {
        id: id.into(),
        protocol,
        base_url,
        api_key: api_key.into(),
        api_key_label: raw["apiKeyLabel"]
            .as_str()
            .map_or_else(|| label_api_key(api_key), str::to_owned),
        capabilities: caps,
        models: ensure_default_model(models(&raw["models"], true), &default_model),
        default_model,
        supports_images: js_truthy(&raw["supportsImages"]),
        model_discovery: model_discovery(protocol, &raw["modelDiscovery"]),
        headers,
    })
}

pub(super) fn models(value: &Value, with_metadata: bool) -> Vec<AgentModelOption> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|raw| {
            let value = nonempty(raw["value"].as_str())?;
            let label = nonempty(raw["label"].as_str())?;
            let text = |key| {
                with_metadata
                    .then(|| raw[key].as_str().map(str::to_owned))
                    .flatten()
            };
            Some(AgentModelOption {
                value: value.into(),
                label: label.into(),
                supports_images: raw["supportsImages"].as_bool(),
                thinking_modes: None,
                is_local: raw["isLocal"].as_bool(),
                api_provider_id: text("apiProviderId"),
                endpoint_id: text("endpointId"),
                raw_model: text("rawModel"),
                protocol: with_metadata.then(|| protocol(&raw["protocol"])).flatten(),
            })
        })
        .collect()
}

pub(super) fn bare_model(default: &str) -> AgentModelOption {
    AgentModelOption {
        value: default.into(),
        label: default.into(),
        supports_images: None,
        thinking_modes: None,
        is_local: None,
        api_provider_id: None,
        endpoint_id: None,
        raw_model: None,
        protocol: None,
    }
}

fn ensure_default_model(mut models: Vec<AgentModelOption>, default: &str) -> Vec<AgentModelOption> {
    models.retain_mut(|model| {
        model.value = trim(&model.value).to_owned();
        model.label = trim(&model.label).to_owned();
        !model.value.is_empty() && !model.label.is_empty()
    });
    if !models.iter().any(|model| model.value == default) {
        models.insert(0, bare_model(default));
    }
    models
}

pub(super) fn protocol(value: &Value) -> Option<ApiProtocol> {
    match value.as_str()? {
        "anthropic-messages" => Some(ApiProtocol::AnthropicMessages),
        "openai-compatible" => Some(ApiProtocol::OpenAiCompatible),
        _ => None,
    }
}

pub(super) fn model_discovery(protocol: ApiProtocol, value: &Value) -> ModelDiscoveryKind {
    match value.as_str() {
        Some("none") => ModelDiscoveryKind::None,
        Some("anthropic-models") => ModelDiscoveryKind::AnthropicModels,
        Some("openai-models") => ModelDiscoveryKind::OpenAiModels,
        Some("ollama-tags") => ModelDiscoveryKind::OllamaTags,
        Some("openrouter-models") => ModelDiscoveryKind::OpenRouterModels,
        _ if protocol == ApiProtocol::OpenAiCompatible => ModelDiscoveryKind::OpenAiModels,
        _ => ModelDiscoveryKind::None,
    }
}

pub(super) fn check_capabilities(
    protocol: ApiProtocol,
    value: Option<OpenAiEndpointCapabilities>,
) -> Result<Option<OpenAiEndpointCapabilities>> {
    if protocol != ApiProtocol::OpenAiCompatible {
        return Ok(None);
    }
    let caps = value.unwrap_or(OpenAiEndpointCapabilities {
        chat_completions: true,
        responses: false,
    });
    if !caps.chat_completions && !caps.responses {
        return Err(
            "OpenAI-compatible endpoints must support Chat Completions or Responses.".into(),
        );
    }
    Ok(Some(caps))
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(trim).filter(|text| !text.is_empty())
}

pub(super) fn required_string(value: Option<&str>, field: &str) -> Result<String> {
    nonempty(value)
        .map(str::to_owned)
        .ok_or_else(|| format!("{field} is required").into())
}

pub(super) fn normalize_base_url(value: Option<&str>, field: &str) -> Result<String> {
    let mut text = required_string(value, field)?;
    if !text.starts_with("http://") && !text.starts_with("https://") {
        text.insert_str(0, "https://");
    }
    let url = Url::parse(&text).map_err(|_| type_error("Invalid URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("{field} must use http or https").into());
    }
    if url.query().is_some_and(|q| !q.is_empty()) || url.fragment().is_some_and(|f| !f.is_empty()) {
        return Err(format!("{field} must not include query or fragment components").into());
    }
    text.truncate(text.trim_end_matches('/').len());
    Ok(text)
}

pub(super) fn unsupported_template(
    protocol: ApiProtocol,
    template: ApiProviderTemplateId,
) -> String {
    format!(
        "Unsupported template for {} providers: {}",
        label_for_protocol(protocol.as_str()),
        template.as_str()
    )
}

pub(super) fn configuration_changed() -> DomainError {
    DomainError::new(
        ErrorCode::API_PROVIDER_CONFIGURATION_CHANGED,
        "Provider configuration changed. Reload before saving.",
        409,
        false,
    )
}

fn label_api_key(key: &str) -> String {
    let length = utf16::len(key);
    if length == 0 {
        return String::new();
    }
    if length <= 8 {
        return "****".into();
    }
    let head: Vec<_> = key.encode_utf16().take(4).collect();
    let tail: Vec<_> = key.encode_utf16().skip(length - 4).collect();
    format!(
        "{}...{}",
        String::from_utf16_lossy(&head),
        String::from_utf16_lossy(&tail)
    )
}

fn create_api_provider_id(label: &str) -> Result<String> {
    let mut bytes = [0; 3];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    let [a, b, c] = bytes;
    let suffix = format!("{a:02x}{b:02x}{c:02x}");
    let lower = label.to_lowercase();
    let base = lower
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|chunk| !chunk.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    let base = utf16::truncate(&base, 64 - "_anthropic".len() - suffix.len() - 1);
    let id = format!("{base}_{suffix}");
    Ok(if is_api_provider_id(&Value::String(id.clone())) {
        id
    } else {
        format!("custom_{suffix}")
    })
}

fn type_error(message: &str) -> super::BoxError {
    NamedError {
        name: "TypeError".into(),
        message: message.into(),
        code: None,
    }
    .into()
}
