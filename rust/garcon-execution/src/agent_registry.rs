//! Controller-facing registry queries. The router owns the live-run projection.
//! Chat processing consumes `get_running_chat_ids_snapshot` without loading
//! provider state or using execution ownership as a proxy for a running turn.
//! The registry mutations and runtime lifecycle methods are ported separately.

mod adoption;

pub use adoption::AdoptionChatRegistry;

use indexmap::IndexMap;

use crate::{
    runtime_router::{AgentRuntimeRouter, AgentRuntimeRouterOptions, RunningSession},
    types::ExecutionOperationResult,
};

pub struct AgentRegistry {
    runtime: AgentRuntimeRouter,
}

impl AgentRegistry {
    pub fn new(runtime: AgentRuntimeRouterOptions) -> Self {
        Self {
            runtime: AgentRuntimeRouter::new(runtime),
        }
    }

    pub fn is_chat_running(&self, chat_id: &str) -> bool {
        self.runtime.is_chat_running(chat_id)
    }

    pub fn is_agent_session_running(
        &self,
        agent_id: &str,
        agent_session_id: Option<&str>,
        executor_id: Option<&str>,
    ) -> bool {
        self.runtime
            .is_agent_session_running(agent_id, agent_session_id, executor_id)
    }

    pub fn get_running_sessions(
        &self,
    ) -> ExecutionOperationResult<IndexMap<String, Vec<RunningSession>>> {
        self.runtime.get_running_sessions()
    }

    pub fn get_running_chat_ids_snapshot(&self) -> Vec<String> {
        self.runtime.get_running_chat_ids_snapshot()
    }

    pub fn get_running_session_count(&self) -> usize {
        self.runtime.get_running_session_count()
    }
}
