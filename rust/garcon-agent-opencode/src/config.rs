//! Ports `server-agents/opencode/src/config.ts`.

use std::rc::Rc;

use garcon_agents_common::environment::read_environment::read_environment;
use garcon_interface::host::AgentEnvironmentReader;

#[derive(Clone)]
pub struct OpenCodeConfig {
    pub is_test_environment: Rc<dyn Fn() -> bool>,
}

impl OpenCodeConfig {
    pub fn from_environment(environment: Rc<dyn AgentEnvironmentReader>) -> Self {
        Self {
            is_test_environment: Rc::new(move || {
                read_environment(environment.as_ref(), "NODE_ENV")
                    .is_ok_and(|value| value.as_deref() == Some("test"))
            }),
        }
    }
}

impl Default for OpenCodeConfig {
    fn default() -> Self {
        Self {
            is_test_environment: Rc::new(|| false),
        }
    }
}
