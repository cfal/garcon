//! Controller lookup of executor-qualified agent integrations.

use std::rc::Rc;

use garcon_base::domain_error::DomainError;
use garcon_contract::{
    error_codes::ErrorCode,
    executors::{AgentExecutionTarget, effective_executor_id},
};
use garcon_interface::integration::AgentIntegration;

use crate::types::ExecutionOperationResult;

pub trait ExecutionIntegrationDirectory {
    fn require_integration(
        &self,
        target: &AgentExecutionTarget,
    ) -> ExecutionOperationResult<Rc<AgentIntegration>>;
    fn known_integration(&self, target: &AgentExecutionTarget) -> Option<Rc<AgentIntegration>>;
    fn integrations_for(
        &self,
        executor_id: &str,
    ) -> ExecutionOperationResult<Vec<Rc<AgentIntegration>>>;
    fn is_ready(&self, executor_id: &str) -> bool;
}

pub struct AgentDirectory {
    executors: Rc<dyn ExecutionIntegrationDirectory>,
}

impl AgentDirectory {
    pub fn new(executors: Rc<dyn ExecutionIntegrationDirectory>) -> Self {
        Self { executors }
    }

    pub fn has(&self, agent_id: &str, executor_id: Option<&str>) -> bool {
        self.get(agent_id, executor_id).is_some()
    }

    pub fn get(&self, agent_id: &str, executor_id: Option<&str>) -> Option<Rc<AgentIntegration>> {
        self.executors
            .known_integration(&target(agent_id, executor_id))
    }

    pub fn require(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<Rc<AgentIntegration>> {
        self.executors
            .require_integration(&target(agent_id, executor_id))
    }

    pub fn list(
        &self,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<Vec<Rc<AgentIntegration>>> {
        self.executors
            .integrations_for(&effective_executor_id(executor_id))
    }

    pub fn is_ready(&self, executor_id: Option<&str>) -> bool {
        self.executors.is_ready(&effective_executor_id(executor_id))
    }

    pub fn require_ready(&self, executor_id: Option<&str>) -> Result<(), DomainError> {
        if self.is_ready(executor_id) {
            Ok(())
        } else {
            Err(DomainError::new(
                ErrorCode::EXECUTOR_UNAVAILABLE,
                "Executor is unavailable",
                503,
                true,
            ))
        }
    }
}

fn target(agent_id: &str, executor_id: Option<&str>) -> AgentExecutionTarget {
    AgentExecutionTarget {
        agent_id: agent_id.into(),
        executor_id: effective_executor_id(executor_id),
    }
}
