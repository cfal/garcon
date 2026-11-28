use std::{
    cell::{Cell, RefCell},
    path::Path,
    rc::Rc,
};

use async_trait::async_trait;
use garcon_base::{
    domain_error::DomainError, errors::error_metadata,
    executor_disconnect::ExecutorSessionLostError, log::create_logger,
    unhandled_rejection_policy::install_unhandled_rejection_policy,
};
use garcon_cases::{CaseError, replay, text};
use garcon_contract::{
    agent_integration::{AgentDescriptor, AgentSettingDescriptor, AgentSettingsEnvelope},
    agents::AgentCatalogEntry,
    agents::AgentModelOption,
    api_providers::ApiProviderCatalogEntry,
    error_codes::ErrorCode,
    model_catalog::ModelCatalogResponse,
};
use garcon_execution::{
    catalog_service::{
        AgentCatalogService, AgentModelQuery, CatalogCapabilities, CatalogDirectory,
        CatalogEndpointResolver, CatalogIntegration, CatalogQuerySignal, ModelImageSupport,
    },
    model_catalog_cache::{
        ModelCatalog, ModelCatalogResponseCache, ModelCatalogSnapshot, create_catalog_etag,
    },
    types::ExecutionOperationResult,
};
use garcon_interface::{
    errors::{
        AgentCallError, AgentDeliveryOutcome, AgentIntegrationError, AgentIntegrationErrorCode,
    },
    services::{
        AgentCatalog, AgentCatalogRequest, AgentCatalogSnapshot, AgentGenerationModel,
        AgentSettings, RequireNativeDiscovery,
    },
};
use garcon_js::{Number, clock::ManualClock, json::Opaque};
use indexmap::IndexMap;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::{sync::oneshot, task::LocalSet};
use tokio_util::sync::CancellationToken;

const REMOTE: &str = "22222222-2222-4222-8222-222222222222";

fn typed<T: DeserializeOwned>(input: &Value) -> T {
    garcon_js::json::from_str(&garcon_js::json::stringify(input)).unwrap()
}

fn wire(value: &impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(value).unwrap()).unwrap()
}

fn model(value: &str) -> Value {
    json!({"value":value,"label":value})
}

fn settings() -> Value {
    json!([{"key":"effort","label":"Effort","labelKey":"thinking","type":"enum",
        "options":[{"value":"high","label":"High","labelKey":"enabled",
            "description":"Uses extended thinking for every response.","descriptionKey":"thinkingEnabled"}]}])
}

fn catalog_agent(id: &str, models: Vec<Value>, values: Value) -> Value {
    json!({
        "id":id, "label":"Sample Agent", "kind":"agent", "executionPolicy":"conversation", "selectionLabel":"Model",
        "inputFormatByModel":{}, "supportsCompact":false, "supportsFork":true, "supportsForkAtMessage":true,
        "supportsForkWhileRunning":true, "supportsUpdateProjectPath":true, "supportsSteering":true,
        "supportsImages":true, "fileAttachmentMimeTypes":[], "acceptsApiProviderEndpoints":true,
        "supportedProtocols":["openai-compatible"], "authLoginSupported":true,
        "supportedPermissionModes":["default","manualBypass"], "supportedThinkingModes":["none","ultra"],
        "settings":settings(), "defaultSettings":{"ownerId":id,"schemaVersion":2,"values":values},
        "requiresStrictModelDiscovery":true, "generation":{"priority":10,"model":"sample-model"},
        "defaultModel":"sample-model", "models":models
    })
}

fn etag_trace(mode: &str) -> String {
    let mut models: Vec<_> = ["z", "Z", "ä", "Å", "12", "2"]
        .into_iter()
        .map(model)
        .collect();
    if mode == "reverse" {
        models.reverse();
    }
    let values = garcon_js::json::from_str(r#"{"10":"ten","2":"two","big":9007199254740992,"number":1.0,"exp":1e21,"__proto__":{"ignored":true},"constructor":3,"\ud83d\udcc1":"astral","\ufffd":"replacement"}"#).unwrap();
    let mut agents = vec![
        catalog_agent("z", models.clone(), values),
        catalog_agent("á", models.clone(), json!({"effort":"high"})),
    ];
    let endpoint = |id: &str| {
        json!({
            "id":id,"protocol":"openai-compatible","baseUrl":"https://example.invalid/v1","defaultModel":"x",
            "models":models,"supportsImages":false,"hasApiKey":false
        })
    };
    let mut endpoints = vec![endpoint("Z"), endpoint("á")];
    if mode == "reverse" {
        endpoints.reverse();
    }
    let provider = |id: &str| json!({"id":id,"revision":1,"label":id,"createdAt":"x","updatedAt":"x","endpoints":endpoints});
    let mut providers = vec![provider("P"), provider("p")];
    if mode == "reverse" {
        agents.reverse();
        providers.reverse();
    }
    let body: ModelCatalogResponse =
        typed(&json!({"catalog":{"agents":agents,"apiProviders":providers}}));
    create_catalog_etag(&body).unwrap()
}

type PendingCatalog = oneshot::Receiver<ExecutionOperationResult<Vec<AgentCatalogEntry>>>;

struct CachePorts {
    pending: RefCell<Option<PendingCatalog>>,
    fail_first: bool,
    next: Cell<usize>,
    calls: RefCell<Vec<Value>>,
}

fn agent(id: &str) -> AgentCatalogEntry {
    typed(&catalog_agent(
        id,
        vec![model("sample-model")],
        json!({"effort":"high"}),
    ))
}

#[async_trait(?Send)]
impl ModelCatalog for CachePorts {
    async fn get_agent_catalog_entries(
        &self,
        executor: &str,
        _: Option<&[String]>,
    ) -> ExecutionOperationResult<Vec<AgentCatalogEntry>> {
        self.calls.borrow_mut().push(json!(["agents", executor]));
        let next = self.next.get() + 1;
        self.next.set(next);
        let pending = self.pending.borrow_mut().take();
        if let Some(pending) = pending {
            return pending.await?;
        }
        if next == 1 && self.fail_first {
            return Err(DomainError::new(
                ErrorCode::EXECUTOR_UNAVAILABLE,
                "Executor unavailable",
                503,
                true,
            )
            .into());
        }
        Ok(vec![agent(&format!("agent-{next}"))])
    }
    fn get_catalog(
        &self,
        executor: &str,
    ) -> ExecutionOperationResult<Vec<ApiProviderCatalogEntry>> {
        self.calls.borrow_mut().push(json!(["providers", executor]));
        Ok(Vec::new())
    }
}

fn inspect(snapshot: &ModelCatalogSnapshot) -> Value {
    json!([snapshot.body.catalog.agents[0].id, snapshot.created_at])
}

async fn cache_trace(mode: &str) -> Value {
    let (resolve, pending) = oneshot::channel();
    let ports = Rc::new(CachePorts {
        pending: RefCell::new(
            matches!(mode, "stale-failure" | "stale-success" | "coalesced").then_some(pending),
        ),
        fail_first: mode == "failure",
        next: Cell::new(0),
        calls: RefCell::default(),
    });
    let clock = Rc::new(ManualClock::new(2_000));
    let cache = Rc::new(ModelCatalogResponseCache::new(
        clock.clone(),
        Rc::new(install_unhandled_rejection_policy(Rc::new(create_logger(
            "test",
        )))),
    ));
    let read = |instance| cache.get_snapshot(ports.clone(), Some(REMOTE), instance);
    let mut values = Vec::new();
    match mode {
        "stale-failure" | "stale-success" | "coalesced" => {
            let mut stale = Box::pin(read(Some("first")));
            assert!(futures::poll!(stale.as_mut()).is_pending());
            let mut concurrent = (mode == "coalesced").then(|| Box::pin(read(Some("first"))));
            if let Some(concurrent) = &mut concurrent {
                assert!(futures::poll!(concurrent.as_mut()).is_pending());
            }
            cache.clear(Some(REMOTE));
            let replacement = read(Some("first")).await.unwrap();
            values.push(inspect(&replacement));
            if mode == "stale-failure" {
                resolve
                    .send(Err(std::io::Error::other("Old executor unavailable").into()))
                    .unwrap();
                values.push(json!(stale.await.unwrap_err().to_string()));
            } else {
                resolve.send(Ok(vec![agent("agent-1")])).unwrap();
                let first = stale.await.unwrap();
                values.push(inspect(&first));
                values.push(if let Some(concurrent) = concurrent {
                    json!(Rc::ptr_eq(&first, &concurrent.await.unwrap()))
                } else {
                    Value::Null
                });
            }
            values.push(json!(Rc::ptr_eq(
                &replacement,
                &read(Some("first")).await.unwrap()
            )));
        }
        "failure" => {
            let error = read(None).await.unwrap_err();
            values.push(json!(error_metadata(error.as_error()).code));
            values.push(inspect(&read(None).await.unwrap()));
        }
        "ttl" | "instance" => {
            let first = read(Some("first")).await.unwrap();
            values.push(inspect(&first));
            clock.advance(59_999);
            values.push(json!(Rc::ptr_eq(
                &first,
                &read(Some("first")).await.unwrap()
            )));
            let replacement = if mode == "instance" {
                read(Some("second")).await.unwrap()
            } else {
                clock.advance(1);
                read(Some("first")).await.unwrap()
            };
            values.push(inspect(&replacement));
        }
        _ => panic!("undeliverable cache scenario {mode}"),
    }
    json!({"values":values,"calls":&*ports.calls.borrow()})
}

struct Integration {
    mode: String,
    descriptor: AgentDescriptor,
    settings: Vec<AgentSettingDescriptor>,
    signal: CancellationToken,
    effects: RefCell<Vec<Value>>,
}

#[async_trait(?Send)]
impl AgentCatalog for Integration {
    async fn snapshot(
        &self,
        request: AgentCatalogRequest,
    ) -> ExecutionOperationResult<AgentCatalogSnapshot> {
        self.effects.borrow_mut().push(json!([
            "snapshot",
            request.strict,
            request.require_native_discovery,
            request.timeout_ms,
            request.dispatch_deadline
        ]));
        match self.mode.as_str() {
            "strict-missing" => {
                return Err(AgentIntegrationError::new(
                    AgentIntegrationErrorCode::BINARY_NOT_FOUND,
                    "Unavailable binary",
                    false,
                    None,
                )
                .into());
            }
            "session-loss" => {
                return Err(ExecutorSessionLostError::new(
                    AgentDeliveryOutcome::NotDispatched,
                    "Call was not sent",
                )
                .into());
            }
            "rejected" => {
                return Err(AgentCallError::new(
                    AgentDeliveryOutcome::Rejected,
                    "Provider rejected",
                )
                .into());
            }
            "cancelled" | "strict-error" | "relaxed-error" => {
                if self.mode == "cancelled" {
                    self.signal.cancel();
                }
                return Err(std::io::Error::other("provider failure").into());
            }
            _ => {}
        }
        Ok(AgentCatalogSnapshot {
            models: vec![typed(
                &json!({"value":"sample-model","label":"Sample Model","supportsImages":true}),
            )],
            default_model: "sample-model".into(),
            requires_strict_model_discovery: true,
            generation: Some(AgentGenerationModel {
                priority: Number(10.0),
                model: "sample-model".into(),
            }),
        })
    }
}

#[async_trait(?Send)]
impl AgentSettings for Integration {
    fn describe(&self) -> &[AgentSettingDescriptor] {
        &self.settings
    }
    fn defaults(&self) -> ExecutionOperationResult<AgentSettingsEnvelope> {
        Ok(typed(
            &json!({"ownerId":"sample-agent","schemaVersion":2,"values":{"effort":"high"}}),
        ))
    }
    fn parse(
        &self,
        input: AgentSettingsEnvelope,
    ) -> ExecutionOperationResult<AgentSettingsEnvelope> {
        Ok(input)
    }
    async fn migrate(
        &self,
        input: AgentSettingsEnvelope,
    ) -> ExecutionOperationResult<AgentSettingsEnvelope> {
        Ok(input)
    }
    fn apply_patch(
        &self,
        _: AgentSettingsEnvelope,
        _: IndexMap<String, Opaque>,
    ) -> ExecutionOperationResult<AgentSettingsEnvelope> {
        unreachable!("catalog reads do not update agent settings")
    }
}

impl CatalogIntegration for Integration {
    fn descriptor(&self) -> &AgentDescriptor {
        &self.descriptor
    }
    fn catalog(&self) -> &dyn AgentCatalog {
        self
    }
    fn settings(&self) -> &dyn AgentSettings {
        self
    }
    fn capabilities(&self) -> CatalogCapabilities<'_> {
        CatalogCapabilities {
            literal_execution: None,
            supports_compact: false,
            supports_steering: true,
            file_attachment_mime_types: None,
            accepts_api_provider_endpoints: true,
            auth_login_supported: true,
        }
    }
}

struct Directory(Rc<Integration>);

impl CatalogDirectory for Directory {
    fn get(&self, agent: &str, _: Option<&str>) -> Option<Rc<dyn CatalogIntegration>> {
        (agent == self.0.descriptor.id).then(|| self.0.clone() as Rc<dyn CatalogIntegration>)
    }
    fn require(
        &self,
        _: &str,
        _: Option<&str>,
    ) -> ExecutionOperationResult<Rc<dyn CatalogIntegration>> {
        Ok(self.0.clone())
    }
    fn list(&self, _: Option<&str>) -> ExecutionOperationResult<Vec<Rc<dyn CatalogIntegration>>> {
        Ok(vec![self.0.clone()])
    }
}

impl CatalogEndpointResolver for Integration {
    fn model_supports_images(&self, _: ModelImageSupport<'_>) -> bool {
        false
    }
    fn get_model_options(&self, agent: &str, executor: &str) -> Vec<AgentModelOption> {
        self.effects
            .borrow_mut()
            .push(json!(["models", agent, executor]));
        if self.mode == "merge" {
            ["sample-model", "", "endpoint-model"]
                .into_iter()
                .map(|value| typed(&model(value)))
                .collect()
        } else {
            Vec::new()
        }
    }
}

async fn service_trace(mode: &str) -> Value {
    let signal = CancellationToken::new();
    let integration = Rc::new(Integration {
        mode: mode.into(),
        signal: signal.clone(),
        effects: RefCell::default(),
        settings: typed(&settings()),
        descriptor: typed(&json!({
            "id":"sample-agent","label":"Sample Agent","icon":null,"supportedPermissionModes":["default","manualBypass"],
            "supportedThinkingModes":["none","ultra"],"supportsImages":true,"supportsProjectPathUpdate":true,
            "requiresNativePathForProjectPathUpdate":false,"supportedEndpointProtocols":["openai-compatible"],"configuration":[]
        })),
    });
    let catalog =
        AgentCatalogService::new(Rc::new(Directory(integration.clone())), integration.clone());
    let id = if mode == "missing" {
        "missing"
    } else {
        "sample-agent"
    };
    let result = catalog
        .get_agent_catalog_entry(
            id,
            AgentModelQuery {
                executor_id: Some(REMOTE),
                strict: mode == "strict-error",
                require_native_discovery: matches!(mode, "strict-missing" | "session-loss")
                    .then_some(RequireNativeDiscovery),
                signal: Some(CatalogQuerySignal {
                    token: &signal,
                    reason: &|| std::io::Error::other("Stopped").into(),
                }),
                timeout_ms: Some(500.0),
                dispatch_deadline: Some(2500.0),
            },
        )
        .await;
    let entry = match result {
        Ok(entry) => wire(&entry),
        Err(error) => json!({"error":error.to_string(),"code":error_metadata(error.as_ref()).code}),
    };
    json!({
        "entry":entry, "strict":catalog.requires_strict_model_discovery(id, Some(REMOTE)),
        "localStrict":catalog.requires_strict_model_discovery(id,None), "effects":&*integration.effects.borrow(),
    })
}

#[test]
fn agent_model_catalog_recordings() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let local = LocalSet::new();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/cases/agent-model-catalog");
    replay(dir, |name, args| {
        let mode = text(name, args.first())?
            .ok_or_else(|| CaseError::undeliverable("expected catalog scenario"))?;
        Ok(match name {
            "catalogEtagTrace" => json!(etag_trace(mode)),
            "catalogCacheTrace" => local.block_on(&runtime, async {
                tokio::time::timeout(std::time::Duration::from_secs(2), cache_trace(mode))
                    .await
                    .map_err(|_| CaseError::undeliverable("catalog cache trace did not finish"))
            })?,
            "catalogServiceTrace" => local.block_on(&runtime, service_trace(mode)),
            _ => return Err(CaseError::unhandled(name)),
        })
    });
}

#[tokio::test]
async fn an_old_catalog_failure_cannot_evict_a_replacement() {
    let trace = LocalSet::new()
        .run_until(cache_trace("stale-failure"))
        .await;
    assert_eq!(
        trace["values"],
        json!([["agent-2", 2000], "Old executor unavailable", true])
    );
}

#[test]
fn reordering_nested_models_and_providers_does_not_change_the_etag() {
    assert_eq!(etag_trace("normal"), etag_trace("reverse"));
}

#[tokio::test]
async fn catalog_distinguishes_a_missing_binary_from_a_lost_executor_session() {
    let missing = service_trace("strict-missing").await;
    assert_eq!(missing["entry"]["models"], json!([]));
    assert_eq!(missing["strict"], false);
    let lost = service_trace("session-loss").await;
    assert_eq!(
        lost["entry"],
        json!({"error":"Call was not sent","code":"UNAVAILABLE"})
    );
}
