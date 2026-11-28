//! Ports `server-agents/common/src/catalog/model-catalog.ts`.

use std::collections::HashSet;
use std::rc::Rc;

use async_trait::async_trait;
use futures::future::LocalBoxFuture;
use garcon_base::{errors::NamedError, keyed_lock::LockAborted};
use garcon_contract::agents::AgentModelOption;
use garcon_interface::host::AgentLogger;
use garcon_interface::resources::ExecutorResult;
use garcon_interface::services::{
    AgentCatalog, AgentCatalogRequest, AgentCatalogSnapshot, AgentGenerationModel,
};
use indexmap::IndexMap;

use crate::execution::admission::check_signal;

pub type DiscoverModels = Box<
    dyn Fn(AgentCatalogRequest) -> LocalBoxFuture<'static, ExecutorResult<Vec<AgentModelOption>>>,
>;

pub struct ModelCatalog {
    pub logger: Rc<dyn AgentLogger>,
    pub default_model: String,
    pub fallback_models: Vec<AgentModelOption>,
    pub requires_strict_model_discovery: bool,
    pub generation: Option<AgentGenerationModel>,
    pub discover: Option<DiscoverModels>,
}

#[async_trait(?Send)]
impl AgentCatalog for ModelCatalog {
    async fn snapshot(&self, request: AgentCatalogRequest) -> ExecutorResult<AgentCatalogSnapshot> {
        check_signal(Some(&request.signal))?;
        let mut models = if let Some(discover) = &self.discover {
            let signal = request.signal.clone();
            let strict = request.strict || request.require_native_discovery.is_some();
            match discover(request).await {
                Ok(models) => models,
                Err(error) => {
                    check_signal(Some(&signal))?;
                    if strict
                        || error.is::<LockAborted>()
                        || error
                            .downcast_ref::<NamedError>()
                            .is_some_and(|error| error.name == "AbortError")
                    {
                        return Err(error);
                    }
                    self.logger.warn(
                        "Dynamic model discovery failed; using static models.",
                        Some(&IndexMap::from([(
                            "code".into(),
                            serde_json::Value::from("MODEL_DISCOVERY_FAILED").into(),
                        )])),
                    );
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        models.extend(self.fallback_models.iter().cloned());
        let mut seen = HashSet::new();
        models.retain(|model| seen.insert(model.value.clone()));
        Ok(AgentCatalogSnapshot {
            models,
            default_model: self.default_model.clone(),
            requires_strict_model_discovery: self.requires_strict_model_discovery,
            generation: self.generation.clone(),
        })
    }
}

#[cfg(test)]
mod tests;
