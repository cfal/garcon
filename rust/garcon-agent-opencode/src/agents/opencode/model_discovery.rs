//! Ports `server-agents/opencode/src/agents/opencode/model-discovery.ts`.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use futures::{
    FutureExt,
    future::{LocalBoxFuture, Shared},
};
use garcon_contract::chat_modes::ThinkingMode;
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use garcon_js::Clock;
use serde_json::{Map, json};
use tokio::{sync::oneshot, task::spawn_local};

use super::{
    endpoint_coordinator::OpenCodeEndpointCoordinator,
    model_catalog::{
        OpenCodeModelOption, configured_providers_from_result,
        connected_providers_from_list_result, models_from_providers,
    },
    request_control::with_abortable_timeout,
    sdk_client::{OpenCodeClient, OpenCodeRequest},
    thinking_variant::resolve_open_code_thinking_variant,
};
use crate::js::log_fields;

const DEFAULT_CACHE_TTL_MS: f64 = 5.0 * 60_000.0;
const DEFAULT_DISCOVERY_TIMEOUT_MS: f64 = 10_000.0;

pub struct OpenCodeModelDiscoveryOptions {
    pub cache_ttl_ms: Option<f64>,
    pub discovery_timeout_ms: Option<f64>,
    pub logger: Rc<dyn AgentLogger>,
    pub endpoint: Rc<OpenCodeEndpointCoordinator>,
    pub is_available: Rc<dyn Fn() -> bool>,
    pub is_temporarily_unavailable: Rc<dyn Fn() -> bool>,
    pub instance_generation: Rc<dyn Fn() -> u64>,
    pub mark_available: Rc<dyn Fn(u64)>,
    pub mark_temporarily_unavailable: Rc<dyn Fn(String, u64) -> bool>,
    pub clock: Rc<dyn Clock>,
}

struct OpenCodeModelCache {
    models: Vec<OpenCodeModelOption>,
    fetched_at: f64,
}

type PendingModels = Shared<LocalBoxFuture<'static, Vec<OpenCodeModelOption>>>;

pub struct OpenCodeModelDiscovery {
    options: OpenCodeModelDiscoveryOptions,
    cache: RefCell<Option<OpenCodeModelCache>>,
    pending: RefCell<Option<PendingModels>>,
}

impl OpenCodeModelDiscovery {
    pub fn new(options: OpenCodeModelDiscoveryOptions) -> Rc<Self> {
        Rc::new(Self {
            options,
            cache: RefCell::default(),
            pending: RefCell::default(),
        })
    }

    pub fn models(&self) -> Vec<OpenCodeModelOption> {
        self.cache
            .borrow()
            .as_ref()
            .map_or_else(Vec::new, |cache| cache.models.clone())
    }

    pub fn invalidate(&self) {
        if let Some(cache) = self.cache.borrow_mut().as_mut() {
            cache.fetched_at = f64::NEG_INFINITY;
        }
    }

    pub async fn get_models(self: &Rc<Self>) -> Vec<OpenCodeModelOption> {
        if !(self.options.is_available)() {
            return Vec::new();
        }
        if (self.options.is_temporarily_unavailable)() || self.cache_is_fresh() {
            return self.models();
        }
        let pending = self.pending.borrow().clone();
        let pending = pending.unwrap_or_else(|| {
            let (send, receive) = oneshot::channel();
            let pending = async move { receive.await.unwrap_or_default() }
                .boxed_local()
                .shared();
            self.pending.replace(Some(pending.clone()));
            spawn_local({
                let discovery = self.clone();
                async move {
                    let models = discovery.load().await;
                    discovery.pending.take();
                    let _ = send.send(models);
                }
            });
            pending
        });
        pending.await
    }

    pub async fn declared_thinking_modes(
        self: &Rc<Self>,
        model: &str,
    ) -> Option<Vec<ThinkingMode>> {
        let cached = self.cached_modes(model);
        if cached.is_some() || self.cache_is_fresh() {
            return cached;
        }
        self.get_models().await;
        self.cached_modes(model)
    }

    fn cached_modes(&self, model: &str) -> Option<Vec<ThinkingMode>> {
        self.cache
            .borrow()
            .as_ref()?
            .models
            .iter()
            .find(|entry| entry.value == model)?
            .thinking_modes
            .clone()
    }

    pub fn resolve_thinking_variant(
        &self,
        model: Option<&str>,
        thinking_mode: Option<ThinkingMode>,
    ) -> Option<String> {
        let declared = model
            .filter(|model| !model.is_empty())
            .and_then(|model| self.cached_modes(model));
        resolve_variant(thinking_mode, declared)
    }

    pub async fn resolve_thinking_variant_for_turn(
        self: &Rc<Self>,
        model: Option<&str>,
        thinking_mode: Option<ThinkingMode>,
    ) -> Option<String> {
        let Some(model) = model.filter(|model| !model.is_empty()) else {
            return self.resolve_thinking_variant(model, thinking_mode);
        };
        if thinking_mode.is_none_or(|mode| mode == ThinkingMode::None) {
            return self.resolve_thinking_variant(Some(model), thinking_mode);
        }
        resolve_variant(thinking_mode, self.declared_thinking_modes(model).await)
    }

    fn cache_is_fresh(&self) -> bool {
        self.cache.borrow().as_ref().is_some_and(|cache| {
            self.options.clock.now_ms() as f64 - cache.fetched_at
                < self.options.cache_ttl_ms.unwrap_or(DEFAULT_CACHE_TTL_MS)
        })
    }

    async fn load(self: &Rc<Self>) -> Vec<OpenCodeModelOption> {
        let generation = Cell::new(None);
        let result = self
            .options
            .endpoint
            .with_client_lease(
                |client| {
                    generation.set(Some((self.options.instance_generation)()));
                    self.discover(client)
                },
                None,
            )
            .await;
        let generation = generation
            .get()
            .unwrap_or_else(|| (self.options.instance_generation)());
        match result {
            Ok(models) => {
                self.cache.replace(Some(OpenCodeModelCache {
                    models: models.clone(),
                    fetched_at: self.options.clock.now_ms() as f64,
                }));
                (self.options.mark_available)(generation);
                models
            }
            Err(failure) => {
                let reason = failure.to_string();
                if (self.options.mark_temporarily_unavailable)(reason.clone(), generation) {
                    self.options.logger.warn(
                        "OpenCode model discovery is unavailable",
                        Some(&log_fields([("reason", json!(reason))])),
                    );
                }
                self.models()
            }
        }
    }

    async fn discover(
        &self,
        client: Rc<dyn OpenCodeClient>,
    ) -> ExecutorResult<Vec<OpenCodeModelOption>> {
        let configured = client.supports_config_providers();
        let (operation, label) = if configured {
            (OpenCodeRequest::ConfigProviders, "OpenCode model discovery")
        } else {
            (OpenCodeRequest::ProviderList, "OpenCode provider list")
        };
        let result = with_abortable_timeout(
            |signal| async move { client.request(operation, Map::new(), &signal).await },
            Some(
                self.options
                    .discovery_timeout_ms
                    .unwrap_or(DEFAULT_DISCOVERY_TIMEOUT_MS),
            ),
            label,
            None,
        )
        .await?;
        let providers: Vec<_> = if configured {
            configured_providers_from_result(&result).iter().collect()
        } else {
            connected_providers_from_list_result(&result)
        };
        Ok(models_from_providers(&providers))
    }
}

fn resolve_variant(
    thinking_mode: Option<ThinkingMode>,
    declared: Option<Vec<ThinkingMode>>,
) -> Option<String> {
    let declared = declared.map(|modes| {
        modes
            .into_iter()
            .map(|mode| mode.as_str().to_owned())
            .collect::<Vec<_>>()
    });
    resolve_open_code_thinking_variant(thinking_mode.map(ThinkingMode::as_str), declared.as_deref())
}

#[cfg(test)]
mod tests;
