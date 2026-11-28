//! Ports `server-agents/common/src/lifecycle/integration-lifecycle.ts`.

use std::cell::Cell;

use async_trait::async_trait;
use futures::future::LocalBoxFuture;
use garcon_interface::resources::ExecutorResult;
use garcon_interface::services::AgentLifecycle;

pub type LifecycleOperation = Box<dyn Fn() -> LocalBoxFuture<'static, ExecutorResult<()>>>;

#[derive(Default)]
pub struct IntegrationLifecycleOptions {
    pub start: Option<LifecycleOperation>,
    pub stop: Option<LifecycleOperation>,
    pub migrate_owned_storage: Option<LifecycleOperation>,
}

pub struct IntegrationLifecycle {
    active: Cell<bool>,
    start_attempted: Cell<bool>,
    options: IntegrationLifecycleOptions,
}

impl IntegrationLifecycle {
    pub fn new(options: IntegrationLifecycleOptions) -> Self {
        Self {
            active: Cell::new(false),
            start_attempted: Cell::new(false),
            options,
        }
    }
}

async fn run(operation: Option<&LifecycleOperation>) -> ExecutorResult<()> {
    if let Some(operation) = operation {
        operation().await?;
    }
    Ok(())
}

#[async_trait(?Send)]
impl AgentLifecycle for IntegrationLifecycle {
    async fn start(&self) -> ExecutorResult<()> {
        if self.active.get() || self.start_attempted.replace(true) {
            return Ok(());
        }
        if let Err(error) = run(self.options.start.as_ref()).await {
            let cleanup = run(self.options.stop.as_ref()).await;
            self.start_attempted.set(false);
            self.active.set(false);
            cleanup?;
            return Err(error);
        }
        self.active.set(true);
        Ok(())
    }

    async fn stop(&self) -> ExecutorResult<()> {
        if !self.active.get() && !self.start_attempted.get() {
            return Ok(());
        }
        self.active.set(false);
        self.start_attempted.set(false);
        run(self.options.stop.as_ref()).await
    }

    async fn migrate_owned_storage(&self) -> ExecutorResult<()> {
        run(self.options.migrate_owned_storage.as_ref()).await
    }
}

#[cfg(test)]
mod tests;
