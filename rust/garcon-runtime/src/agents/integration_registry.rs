use std::cell::RefCell;
use std::collections::HashSet;
use std::error::Error;
use std::fmt;
use std::future::Future;
use std::rc::Rc;

use futures::future::{FutureExt, LocalBoxFuture, Shared, join_all};
use garcon_interface::integration::{
    AGENT_INTEGRATION_API_VERSION, AgentIntegration, AgentIntegrationClass,
};
use garcon_interface::resources::ExecutorResult;
use garcon_interface::testing::{AgentIntegrationConformanceOptions, validate_agent_integration};
use indexmap::IndexMap;

use super::integration_host::{IntegrationHostFactory, valid_agent_id};

type LifecycleTask = Shared<LocalBoxFuture<'static, Result<(), Rc<dyn Error>>>>;

#[derive(Default)]
struct Lifecycle {
    start: Option<LifecycleTask>,
    stop: Option<LifecycleTask>,
    started: bool,
}

#[derive(Debug, thiserror::Error)]
#[error("Unsupported agent integration: {0}")]
pub struct UnknownAgentIntegration(pub String);

#[derive(Debug)]
struct SharedLifecycleError(Rc<dyn Error>);

impl fmt::Display for SharedLifecycleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

impl Error for SharedLifecycleError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.0.as_ref())
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct IntegrationLifecycleErrors {
    message: &'static str,
    pub errors: Vec<Box<dyn Error>>,
}

pub struct IntegrationRegistry {
    integrations: IndexMap<String, Rc<AgentIntegration>>,
    lifecycle: Rc<RefCell<Lifecycle>>,
}

impl IntegrationRegistry {
    pub fn from_classes(
        classes: &[&dyn AgentIntegrationClass],
        host: &IntegrationHostFactory,
    ) -> ExecutorResult<Self> {
        let mut integrations = IndexMap::new();
        for class in classes {
            let id = class.integration_id();
            let version = class.api_version();
            if version != AGENT_INTEGRATION_API_VERSION {
                return Err(format!(
                    "Unsupported agent integration API version for {id}: {version}"
                )
                .into());
            }
            if !valid_agent_id(id) {
                return Err(format!("Invalid agent integration ID: {id}").into());
            }
            check_duplicate(&integrations, id)?;
            let integration = class.create(host.for_agent(id)?);
            validate(id, version, &integration)?;
            host.bind_configuration(
                id,
                integration
                    .descriptor
                    .configuration
                    .iter()
                    .map(|entry| entry.key.clone()),
            )?;
            integrations.insert(id.into(), Rc::new(integration));
        }
        Ok(Self {
            integrations,
            lifecycle: Rc::default(),
        })
    }

    pub fn from_instances(
        instances: impl IntoIterator<Item = Rc<AgentIntegration>>,
    ) -> ExecutorResult<Self> {
        let mut integrations = IndexMap::new();
        for integration in instances {
            let id = &integration.descriptor.id;
            check_duplicate(&integrations, id)?;
            validate(id, AGENT_INTEGRATION_API_VERSION, &integration)?;
            integrations.insert(id.clone(), integration);
        }
        Ok(Self {
            integrations,
            lifecycle: Rc::default(),
        })
    }

    pub fn has(&self, id: &str) -> bool {
        self.integrations.contains_key(id)
    }

    pub fn get(&self, id: &str) -> Option<Rc<AgentIntegration>> {
        self.integrations.get(id).cloned()
    }

    pub fn require(&self, id: &str) -> ExecutorResult<Rc<AgentIntegration>> {
        self.get(id)
            .ok_or_else(|| UnknownAgentIntegration(id.into()).into())
    }

    pub fn list(&self) -> Vec<Rc<AgentIntegration>> {
        self.integrations.values().cloned().collect()
    }

    pub async fn start(&self) -> ExecutorResult<()> {
        let task = {
            let mut state = self.lifecycle.borrow_mut();
            if state.started {
                return Ok(());
            }
            if let Some(start) = &state.start {
                start.clone()
            } else {
                if state.stop.is_some() {
                    return Err("Agent integrations are stopping".into());
                }
                let lifecycle = self.lifecycle.clone();
                let integrations = self.list();
                let start = spawn_lifecycle(async move {
                    let result = start_all(integrations).await;
                    let mut state = lifecycle.borrow_mut();
                    state.started = result.is_ok();
                    state.start = None;
                    result
                });
                state.start = Some(start.clone());
                start
            }
        };
        task.await
            .map_err(|error| SharedLifecycleError(error).into())
    }

    pub async fn stop(&self) -> ExecutorResult<()> {
        let task = {
            let mut state = self.lifecycle.borrow_mut();
            if let Some(stop) = &state.stop {
                stop.clone()
            } else {
                let start = state.start.clone();
                let started = start.is_none() && std::mem::take(&mut state.started);
                let lifecycle = self.lifecycle.clone();
                let integrations = self.list();
                let stop = spawn_lifecycle(async move {
                    let started = if let Some(start) = start {
                        let _ = start.await;
                        std::mem::take(&mut lifecycle.borrow_mut().started)
                    } else {
                        started
                    };
                    let result = if started {
                        stop_all(integrations).await
                    } else {
                        Ok(())
                    };
                    lifecycle.borrow_mut().stop = None;
                    result
                });
                state.stop = Some(stop.clone());
                stop
            }
        };
        task.await
            .map_err(|error| SharedLifecycleError(error).into())
    }
}

fn spawn_lifecycle(work: impl Future<Output = ExecutorResult<()>> + 'static) -> LifecycleTask {
    // Lifecycle work belongs to the registry, not the first waiting caller.
    let task = tokio::task::spawn_local(work);
    async move {
        task.await
            .map_err(|error| Rc::new(error) as Rc<dyn Error>)?
            .map_err(Rc::from)
    }
    .boxed_local()
    .shared()
}

async fn start_all(integrations: Vec<Rc<AgentIntegration>>) -> ExecutorResult<()> {
    let mut started = Vec::new();
    for integration in integrations {
        let result = async {
            integration.lifecycle.migrate_owned_storage().await?;
            integration.lifecycle.start().await
        }
        .await;
        if let Err(cause) = result {
            let mut rollback = stop_in_reverse(&started).await;
            if rollback.is_empty() {
                return Err(cause);
            }
            rollback.insert(0, cause);
            return Err(IntegrationLifecycleErrors {
                message: "Agent integration startup failed and lifecycle rollback was incomplete",
                errors: rollback,
            }
            .into());
        }
        started.push(integration);
    }
    Ok(())
}

async fn stop_in_reverse(integrations: &[Rc<AgentIntegration>]) -> Vec<Box<dyn Error>> {
    join_all(
        integrations
            .iter()
            .rev()
            .map(|integration| integration.lifecycle.stop()),
    )
    .await
    .into_iter()
    .filter_map(Result::err)
    .collect()
}

async fn stop_all(integrations: Vec<Rc<AgentIntegration>>) -> ExecutorResult<()> {
    let errors = stop_in_reverse(&integrations).await;
    if !errors.is_empty() {
        return Err(IntegrationLifecycleErrors {
            message: "Agent integration shutdown failed",
            errors,
        }
        .into());
    }
    Ok(())
}

fn check_duplicate(
    integrations: &IndexMap<String, Rc<AgentIntegration>>,
    id: &str,
) -> ExecutorResult<()> {
    if integrations.contains_key(id) {
        return Err(format!("Duplicate agent integration ID: {id}").into());
    }
    Ok(())
}

fn validate(id: &str, version: u64, integration: &AgentIntegration) -> ExecutorResult<()> {
    validate_agent_integration(AgentIntegrationConformanceOptions {
        integration_id: id,
        api_version: version,
        integration,
    })?;
    let descriptor = &integration.descriptor;
    if garcon_js::trim(&descriptor.label).is_empty() {
        return Err(format!("Agent integration {id} has an empty label").into());
    }
    let mut keys = HashSet::new();
    for entry in &descriptor.configuration {
        if garcon_js::trim(&entry.key).is_empty() {
            return Err(
                format!("Agent integration {id} has an invalid configuration descriptor").into(),
            );
        }
        if !keys.insert(&entry.key) {
            return Err(format!(
                "Agent integration {id} declares configuration {} twice",
                entry.key
            )
            .into());
        }
    }
    let defaults = integration.settings.defaults()?;
    if defaults.owner_id != *id || defaults.schema_version < 1 {
        return Err(format!("Agent integration {id} returned invalid default settings").into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
