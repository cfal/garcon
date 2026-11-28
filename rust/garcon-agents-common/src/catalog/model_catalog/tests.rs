use std::cell::RefCell;

use garcon_interface::services::RequireNativeDiscovery;
use garcon_js::json::Opaque;
use tokio_util::sync::CancellationToken;

use super::*;

type Warning = (String, IndexMap<String, Opaque>);

#[derive(Default)]
struct Warnings(RefCell<Vec<Warning>>);

impl AgentLogger for Warnings {
    fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn warn(&self, message: &str, fields: Option<&IndexMap<String, Opaque>>) {
        self.0
            .borrow_mut()
            .push((message.into(), fields.cloned().unwrap_or_default()));
    }
    fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
}

fn model(value: &str, label: &str) -> AgentModelOption {
    AgentModelOption {
        value: value.into(),
        label: label.into(),
        supports_images: None,
        is_local: None,
        api_provider_id: None,
        endpoint_id: None,
        raw_model: None,
        protocol: None,
    }
}

fn request(strict: bool) -> AgentCatalogRequest {
    AgentCatalogRequest {
        strict,
        require_native_discovery: None,
        signal: CancellationToken::new(),
        timeout_ms: None,
        dispatch_deadline: None,
    }
}

fn catalog(warnings: Rc<Warnings>, discover: DiscoverModels) -> ModelCatalog {
    ModelCatalog {
        logger: warnings,
        default_model: "static".into(),
        fallback_models: vec![model("static", "Fallback"), model("other", "Other")],
        requires_strict_model_discovery: false,
        generation: None,
        discover: Some(discover),
    }
}

#[tokio::test]
async fn discovery_failure_is_visible_to_strict_and_native_callers_only() {
    let warnings = Rc::new(Warnings::default());
    let catalog = catalog(
        warnings.clone(),
        Box::new(|_| Box::pin(async { Err("synthetic provider payload".into()) })),
    );
    assert_eq!(
        catalog.snapshot(request(false)).await.unwrap().models,
        catalog.fallback_models
    );
    assert_eq!(
        *warnings.0.borrow(),
        [(
            "Dynamic model discovery failed; using static models.".into(),
            IndexMap::from([(
                "code".into(),
                serde_json::Value::from("MODEL_DISCOVERY_FAILED").into()
            )])
        )]
    );
    let mut native = request(false);
    native.require_native_discovery = Some(RequireNativeDiscovery);
    for request in [request(true), native] {
        assert_eq!(
            catalog.snapshot(request).await.unwrap_err().to_string(),
            "synthetic provider payload"
        );
    }
    assert_eq!(warnings.0.borrow().len(), 1);
}

#[tokio::test]
async fn discovered_models_win_without_reordering_and_cancellation_never_falls_back() {
    let warnings = Rc::new(Warnings::default());
    let mut catalog = catalog(
        warnings.clone(),
        Box::new(|_| {
            Box::pin(async {
                Ok(vec![
                    model("dynamic", "Dynamic"),
                    model("static", "Discovered"),
                    model("dynamic", "Duplicate"),
                ])
            })
        }),
    );
    let snapshot = catalog.snapshot(request(false)).await.unwrap();
    assert_eq!(
        snapshot.models,
        [
            model("dynamic", "Dynamic"),
            model("static", "Discovered"),
            model("other", "Other")
        ]
    );
    catalog.discover = Some(Box::new(|request| {
        Box::pin(async move {
            request.signal.cancel();
            Err("provider failure after cancellation".into())
        })
    }));
    let error = catalog.snapshot(request(false)).await.unwrap_err();
    assert_eq!(
        error.downcast_ref::<NamedError>().unwrap().name,
        "AbortError"
    );
    assert!(warnings.0.borrow().is_empty());
}
