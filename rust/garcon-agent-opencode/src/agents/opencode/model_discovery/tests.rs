use std::collections::VecDeque;

use async_trait::async_trait;
use garcon_js::{ManualClock, json::Opaque};
use indexmap::IndexMap;
use serde_json::Value;
use tokio::task::LocalSet;

use super::*;
use crate::{
    agents::opencode::{
        endpoint_coordinator::OpenCodeEndpointCoordinatorOptions,
        instance_lifecycle::OpenCodeInstance, sdk_client::OpenCodeEnvelopes,
        sdk_result::OpenCodeSdkResult,
    },
    js::{AbortSignal, error},
};

struct CatalogClient {
    configured: bool,
    requests: RefCell<Vec<OpenCodeRequest>>,
    replies: RefCell<VecDeque<Option<Value>>>,
}

#[async_trait(?Send)]
impl OpenCodeClient for CatalogClient {
    async fn request(
        &self,
        request: OpenCodeRequest,
        _: Map<String, Value>,
        signal: &AbortSignal,
    ) -> ExecutorResult<OpenCodeSdkResult> {
        self.requests.borrow_mut().push(request);
        let reply = self
            .replies
            .borrow_mut()
            .pop_front()
            .expect("fixture reply");
        if let Some(payload) = reply {
            return Ok(OpenCodeSdkResult::success(payload, 200));
        }
        signal.token().cancelled().await;
        Err(signal.abort_reason().into())
    }

    async fn global_events(&self, _: &AbortSignal) -> ExecutorResult<OpenCodeEnvelopes> {
        Err(error("Error", "Unexpected global stream"))
    }

    fn supports_config_providers(&self) -> bool {
        self.configured
    }
    fn supports_move_session(&self) -> bool {
        false
    }
}

struct Logger;

impl AgentLogger for Logger {
    fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn warn(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
}

struct Fixture {
    discovery: Rc<OpenCodeModelDiscovery>,
    client: Rc<CatalogClient>,
    clock: Rc<ManualClock>,
    cooldown: Rc<RefCell<Vec<(String, u64)>>>,
}

fn fixture(configured: bool, replies: impl IntoIterator<Item = Option<Value>>) -> Fixture {
    let client = Rc::new(CatalogClient {
        configured,
        requests: RefCell::default(),
        replies: RefCell::new(replies.into_iter().collect()),
    });
    let instance = Rc::new(OpenCodeInstance {
        client: client.clone(),
        base_url: None,
        server: None,
        close: None,
    });
    let endpoint = OpenCodeEndpointCoordinator::new(OpenCodeEndpointCoordinatorOptions {
        assert_available: Rc::new(|| Ok(())),
        ensure_unlocked: Rc::new(move || {
            let instance = instance.clone();
            async { Ok(instance) }.boxed_local()
        }),
        logger: Rc::new(Logger),
        on_activity: Rc::new(|| {}),
    });
    let clock = Rc::new(ManualClock::new(500));
    let cooldown = Rc::new(RefCell::new(Vec::new()));
    let discovery = OpenCodeModelDiscovery::new(OpenCodeModelDiscoveryOptions {
        cache_ttl_ms: Some(20.0),
        discovery_timeout_ms: Some(10.0),
        logger: Rc::new(Logger),
        endpoint,
        is_available: Rc::new(|| true),
        is_temporarily_unavailable: Rc::new({
            let cooldown = cooldown.clone();
            move || !cooldown.borrow().is_empty()
        }),
        instance_generation: Rc::new(|| 17),
        mark_available: Rc::new(|_| {}),
        mark_temporarily_unavailable: Rc::new({
            let cooldown = cooldown.clone();
            move |reason, generation| {
                cooldown.borrow_mut().push((reason, generation));
                true
            }
        }),
        clock: clock.clone(),
    });
    Fixture {
        discovery,
        client,
        clock,
        cooldown,
    }
}

fn catalog() -> Value {
    json!({"providers":[{"id":"fixture","models":{"a":{"variants":{"high":{}}}}}]})
}

#[tokio::test(start_paused = true)]
async fn deduplicates_hanging_model_discovery_and_suppresses_retries_during_cooldown() {
    LocalSet::new()
        .run_until(async {
            let Fixture {
                discovery,
                client,
                cooldown,
                ..
            } = fixture(true, [None]);
            let (one, two) = futures::join!(discovery.get_models(), discovery.get_models());
            assert!(one.is_empty() && two.is_empty());
            assert_eq!(
                *cooldown.borrow(),
                [(
                    "OpenCode model discovery timed out after 10ms".to_owned(),
                    17
                )]
            );
            assert!(discovery.get_models().await.is_empty());
            assert_eq!(
                *client.requests.borrow(),
                [OpenCodeRequest::ConfigProviders]
            );
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn returns_cached_models_when_a_stale_refresh_times_out() {
    LocalSet::new()
        .run_until(async {
            let Fixture {
                discovery,
                client,
                clock,
                cooldown,
            } = fixture(true, [Some(catalog()), None, Some(catalog())]);
            let expected = discovery.get_models().await;
            assert_eq!(expected[0].value, "fixture/a");
            clock.advance(21);
            assert_eq!(discovery.get_models().await, expected);
            assert!(!cooldown.borrow().is_empty());
            assert_eq!(discovery.get_models().await, expected);
            assert_eq!(client.requests.borrow().len(), 2);
            cooldown.borrow_mut().clear();
            assert_eq!(discovery.get_models().await, expected);
            assert_eq!(client.requests.borrow().len(), 3);
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn discovers_the_declared_ceiling_once_and_does_not_refresh_a_fresh_missing_model() {
    LocalSet::new()
        .run_until(async {
            let Fixture {
                discovery, client, ..
            } = fixture(true, [Some(catalog())]);
            assert_eq!(
                discovery
                    .resolve_thinking_variant_for_turn(Some("fixture/a"), Some(ThinkingMode::Max))
                    .await
                    .as_deref(),
                Some("high")
            );
            assert_eq!(
                discovery
                    .resolve_thinking_variant_for_turn(
                        Some("fixture/missing"),
                        Some(ThinkingMode::Xhigh)
                    )
                    .await
                    .as_deref(),
                Some("xhigh")
            );
            assert_eq!(client.requests.borrow().len(), 1);
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn falls_back_to_connected_providers_only_without_the_config_endpoint() {
    LocalSet::new().run_until(async {
        let payload = json!({"all":[{"id":"fixture","models":{"a":{}}},{"id":"disabled","models":{"b":{}}}],"connected":["fixture"]});
        let Fixture { discovery, client, .. } = fixture(false, [Some(payload)]);
        let models = discovery.get_models().await;
        assert_eq!(models.iter().map(|model| model.value.as_str()).collect::<Vec<_>>(), ["fixture/a"]);
        assert_eq!(*client.requests.borrow(), [OpenCodeRequest::ProviderList]);
    }).await;
}
