//! Controller-facing registry queries. The router owns the live-run projection.
//! Chat processing consumes `get_running_chat_ids_snapshot` without loading
//! provider state or using execution ownership as a proxy for a running turn.
//! The registry mutations and runtime lifecycle methods are ported separately.

mod adoption;
mod transcript_commits;
mod transcript_source;

pub use adoption::AdoptionChatRegistry;
pub use transcript_commits::RegistryTranscriptListener;

use std::{cell::RefCell, rc::Rc};

use garcon_base::log::Logger;
use garcon_chats::registry_contracts::ChatRegistryEntry;
use indexmap::IndexMap;

use crate::{
    directory::AgentDirectory,
    event_bus::AgentEventBus,
    runtime_router::{AgentRuntimeRouter, AgentRuntimeRouterOptions, RunningSession},
    types::ExecutionOperationResult,
};

pub type RegistryCarryOverRevision = dyn Fn(&ChatRegistryEntry) -> String;

pub struct AgentRegistryOptions {
    pub runtime: AgentRuntimeRouterOptions,
    pub directory: Rc<AgentDirectory>,
    pub get_carry_over_revision: Rc<RegistryCarryOverRevision>,
    pub logger: Rc<dyn Logger>,
}

pub struct AgentRegistry {
    runtime: AgentRuntimeRouter,
    directory: Rc<AgentDirectory>,
    get_carry_over_revision: Rc<RegistryCarryOverRevision>,
    logger: Rc<dyn Logger>,
    events: AgentEventBus,
    transcript_listeners: RefCell<Vec<Rc<RegistryTranscriptListener>>>,
}

impl AgentRegistry {
    pub fn new(options: AgentRegistryOptions) -> Self {
        Self {
            runtime: AgentRuntimeRouter::new(options.runtime),
            directory: options.directory,
            get_carry_over_revision: options.get_carry_over_revision,
            logger: options.logger,
            events: AgentEventBus::new(),
            transcript_listeners: RefCell::default(),
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
