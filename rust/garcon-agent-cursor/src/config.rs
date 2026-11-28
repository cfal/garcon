//! Ports `server-agents/cursor/src/config.ts`.

use std::rc::Rc;

use garcon_agents_common::environment::read_environment::read_environment;
use garcon_interface::{host::AgentEnvironmentReader, resources::ExecutorResult};

#[derive(Clone)]
pub struct CursorConfig(Rc<dyn AgentEnvironmentReader>);

impl CursorConfig {
    pub fn new(environment: Rc<dyn AgentEnvironmentReader>) -> Self {
        Self(environment)
    }

    pub fn binary(&self) -> ExecutorResult<String> {
        for name in ["GARCON_CURSOR_BINARY", "CURSOR_BINARY"] {
            if let Some(value) = read_environment(&*self.0, name)? {
                return Ok(value);
            }
        }
        Ok("cursor-agent".into())
    }

    pub fn api_key(&self) -> ExecutorResult<Option<String>> {
        read_environment(&*self.0, "CURSOR_API_KEY")
    }
}
