//! Ports `server-agents/opencode/src/config.ts`.

use std::rc::Rc;

#[derive(Clone)]
pub struct OpenCodeConfig {
    pub is_test_environment: Rc<dyn Fn() -> bool>,
}

impl Default for OpenCodeConfig {
    fn default() -> Self {
        Self {
            is_test_environment: Rc::new(|| false),
        }
    }
}
