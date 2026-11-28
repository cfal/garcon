//! Caches model responses per executor instance without retaining stale in-flight work.

use std::{
    cell::RefCell,
    collections::HashMap,
    error::Error,
    fmt,
    future::Future,
    rc::Rc,
    task::{Context, Poll, Waker},
};

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use garcon_base::unhandled_rejection_policy::UnhandledRejectionPolicy;
use garcon_contract::{
    agents::{AgentCatalog, AgentCatalogEntry},
    api_providers::ApiProviderCatalogEntry,
    executors::effective_executor_id,
    model_catalog::ModelCatalogResponse,
};
use garcon_js::{clock::Clock, collation::Collation};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use crate::types::{ExecutionOperationResult, execution_error_input};

const MODEL_CATALOG_RESPONSE_CACHE_TTL_MS: i64 = 60_000;

#[async_trait(?Send)]
pub trait ModelCatalog {
    async fn get_agent_catalog_entries(
        &self,
        executor_id: &str,
        confirming_agents: Option<&[String]>,
    ) -> ExecutionOperationResult<Vec<AgentCatalogEntry>>;
    fn get_catalog(
        &self,
        executor_id: &str,
    ) -> ExecutionOperationResult<Vec<ApiProviderCatalogEntry>>;
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogSnapshot {
    pub body: ModelCatalogResponse,
    pub etag: String,
    pub created_at: i64,
}

pub fn create_catalog_etag(body: &ModelCatalogResponse) -> ExecutionOperationResult<String> {
    let collation = Collation::english();
    let mut body = body.clone();
    body.catalog
        .agents
        .sort_by(|left, right| collation.compare(&left.id, &right.id));
    for agent in &mut body.catalog.agents {
        agent
            .models
            .sort_by(|left, right| collation.compare(&left.value, &right.value));
    }
    body.catalog
        .api_providers
        .sort_by(|left, right| collation.compare(&left.id, &right.id));
    for provider in &mut body.catalog.api_providers {
        provider
            .endpoints
            .sort_by(|left, right| collation.compare(&left.id, &right.id));
        for endpoint in &mut provider.endpoints {
            endpoint
                .models
                .sort_by(|left, right| collation.compare(&left.value, &right.value));
        }
    }
    let value = garcon_js::json::from_str(&serde_json::to_string(&body)?)?;
    let canonical = garcon_js::json::stringify(&stable_object(value));
    let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.as_bytes()));
    Ok(format!(r#"W/"model-catalog:{digest}""#))
}

fn stable_object(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(stable_object).collect()),
        Value::Object(values) => {
            let mut entries: Vec<_> = values.into_iter().collect();
            entries.sort_unstable_by(|(left, _), (right, _)| {
                left.encode_utf16().cmp(right.encode_utf16())
            });
            // Assignment on the original's plain object does not create an own __proto__ key.
            Value::Object(
                entries
                    .into_iter()
                    .filter(|(key, _)| key != "__proto__")
                    .map(|(key, value)| (key, stable_object(value)))
                    .collect(),
            )
        }
        value => value,
    }
}

pub async fn build_catalog_response(
    catalog: &dyn ModelCatalog,
    executor_id: &str,
    confirming_agents: Option<&[String]>,
    clock: &dyn Clock,
) -> ExecutionOperationResult<ModelCatalogSnapshot> {
    let body = ModelCatalogResponse {
        catalog: AgentCatalog {
            agents: catalog
                .get_agent_catalog_entries(executor_id, confirming_agents)
                .await?,
            api_providers: catalog.get_catalog(executor_id)?,
        },
    };
    Ok(ModelCatalogSnapshot {
        etag: create_catalog_etag(&body)?,
        created_at: clock.now_ms(),
        body,
    })
}

/// Concurrent callers see the same concrete failure, rather than separate
/// errors reconstructed from its message.
#[derive(Debug, Clone)]
pub struct CatalogSnapshotError(Rc<Box<dyn Error>>);

impl CatalogSnapshotError {
    pub fn as_error(&self) -> &(dyn Error + 'static) {
        self.0.as_ref().as_ref()
    }
}

impl fmt::Display for CatalogSnapshotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self.as_error(), formatter)
    }
}

impl Error for CatalogSnapshotError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.as_error())
    }
}

type SnapshotResult = Result<Rc<ModelCatalogSnapshot>, CatalogSnapshotError>;
type SnapshotReceiver = watch::Receiver<Option<SnapshotResult>>;

struct ExecutorCatalog {
    instance_id: Option<String>,
    cached: RefCell<Option<Rc<ModelCatalogSnapshot>>>,
    inflight: RefCell<Option<SnapshotReceiver>>,
}

pub struct ModelCatalogResponseCache {
    executors: RefCell<HashMap<String, Rc<ExecutorCatalog>>>,
    clock: Rc<dyn Clock>,
    unhandled_rejections: Rc<UnhandledRejectionPolicy>,
}

impl ModelCatalogResponseCache {
    pub fn new(clock: Rc<dyn Clock>, unhandled_rejections: Rc<UnhandledRejectionPolicy>) -> Self {
        Self {
            executors: RefCell::default(),
            clock,
            unhandled_rejections,
        }
    }

    pub async fn get_snapshot(
        self: &Rc<Self>,
        catalog: Rc<dyn ModelCatalog>,
        executor_id: Option<&str>,
        instance_id: Option<&str>,
    ) -> SnapshotResult {
        let executor_id = effective_executor_id(executor_id);
        let entry = self.entry(&executor_id, instance_id);
        if let Some(snapshot) = entry.cached.borrow().as_ref().filter(|snapshot| {
            self.clock.now_ms().saturating_sub(snapshot.created_at)
                < MODEL_CATALOG_RESPONSE_CACHE_TTL_MS
        }) {
            return Ok(snapshot.clone());
        }

        let inflight = entry.inflight.borrow().clone();
        let mut receiver = inflight.unwrap_or_else(|| self.start(catalog, executor_id, entry));
        let value = receiver
            .wait_for(Option::is_some)
            .await
            .map_err(|closed| CatalogSnapshotError(Rc::new(Box::new(closed))))?;
        // INFALLIBLE: wait_for returns only after the snapshot result is set.
        value.as_ref().expect("catalog load finished").clone()
    }

    pub fn clear(&self, executor_id: Option<&str>) {
        if let Some(executor_id) = executor_id {
            self.executors.borrow_mut().remove(executor_id);
        } else {
            self.executors.borrow_mut().clear();
        }
    }

    fn entry(&self, executor_id: &str, instance_id: Option<&str>) -> Rc<ExecutorCatalog> {
        let mut executors = self.executors.borrow_mut();
        if let Some(entry) = executors.get(executor_id)
            && entry.instance_id.as_deref() == instance_id
        {
            return entry.clone();
        }
        let entry = Rc::new(ExecutorCatalog {
            instance_id: instance_id.map(str::to_owned),
            cached: RefCell::default(),
            inflight: RefCell::default(),
        });
        executors.insert(executor_id.into(), entry.clone());
        entry
    }

    fn start(
        self: &Rc<Self>,
        catalog: Rc<dyn ModelCatalog>,
        executor_id: String,
        entry: Rc<ExecutorCatalog>,
    ) -> SnapshotReceiver {
        let (resolved, receiver) = watch::channel(None);
        *entry.inflight.borrow_mut() = Some(receiver.clone());
        let mut load = Box::pin({
            let clock = self.clock.clone();
            let executor_id = executor_id.clone();
            async move {
                build_catalog_response(catalog.as_ref(), &executor_id, None, clock.as_ref()).await
            }
        });
        // A shared catalog load survives the last caller dropping its wait.
        let first = load.as_mut().poll(&mut Context::from_waker(Waker::noop()));
        let owner = self.clone();
        tokio::task::spawn_local(async move {
            let result = match first {
                Poll::Ready(result) => result,
                Poll::Pending => load.await,
            }
            .map(Rc::new)
            .map_err(|error| CatalogSnapshotError(Rc::new(error)));
            let mut executors = owner.executors.borrow_mut();
            if executors
                .get(&executor_id)
                .is_some_and(|current| Rc::ptr_eq(current, &entry))
            {
                match &result {
                    Ok(snapshot) => *entry.cached.borrow_mut() = Some(snapshot.clone()),
                    Err(_) => {
                        executors.remove(&executor_id);
                    }
                }
            }
            drop(executors);
            *entry.inflight.borrow_mut() = None;
            if let Err(error) = &result
                && resolved.receiver_count() == 0
            {
                owner
                    .unhandled_rejections
                    .report(execution_error_input(error.as_error()));
            }
            resolved.send_replace(Some(result));
        });
        receiver
    }
}
