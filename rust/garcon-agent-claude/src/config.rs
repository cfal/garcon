use std::rc::Rc;

use garcon_agents_common::environment::read_environment::read_environment;
use garcon_interface::{host::AgentEnvironmentReader, resources::ExecutorResult};

#[derive(Clone)]
pub struct ClaudeConfig {
    environment: Rc<dyn AgentEnvironmentReader>,
}

pub fn create_claude_config(environment: Rc<dyn AgentEnvironmentReader>) -> ClaudeConfig {
    ClaudeConfig { environment }
}

impl ClaudeConfig {
    pub fn binary(&self) -> ExecutorResult<String> {
        Ok(
            read_environment(self.environment.as_ref(), "CLAUDE_BINARY")?
                .unwrap_or_else(|| "claude".to_owned()),
        )
    }

    pub fn anthropic_api_key(&self) -> ExecutorResult<Option<String>> {
        read_environment(self.environment.as_ref(), "ANTHROPIC_API_KEY")
    }

    pub fn anthropic_base_url(&self) -> ExecutorResult<Option<String>> {
        read_environment(self.environment.as_ref(), "ANTHROPIC_BASE_URL")
    }

    pub fn config_home_dir(&self) -> ExecutorResult<Option<String>> {
        read_environment(self.environment.as_ref(), "CLAUDE_CONFIG_DIR")
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use indexmap::IndexMap;

    use super::*;

    #[derive(Default)]
    struct Environment {
        calls: RefCell<Vec<String>>,
        values: RefCell<IndexMap<String, String>>,
    }

    impl AgentEnvironmentReader for Environment {
        fn get(&self, name: &str) -> ExecutorResult<Option<String>> {
            self.calls.borrow_mut().push(name.to_owned());
            if name == "ANTHROPIC_API_KEY" {
                return Err("synthetic environment read failure".into());
            }
            Ok(self.values.borrow().get(name).cloned())
        }
    }

    #[test]
    fn reads_config_lazily_and_propagates_host_errors_without_falling_back() {
        let environment = Rc::new(Environment::default());
        let config = create_claude_config(environment.clone());
        assert!(environment.calls.borrow().is_empty());
        assert_eq!(config.binary().unwrap(), "claude");
        assert_eq!(*environment.calls.borrow(), ["CLAUDE_BINARY"]);

        environment.values.replace(IndexMap::from([
            ("CLAUDE_BINARY".into(), "  /synthetic/claude ".into()),
            (
                "ANTHROPIC_BASE_URL".into(),
                "\t https://synthetic.invalid \n".into(),
            ),
            ("CLAUDE_CONFIG_DIR".into(), "   ".into()),
        ]));
        assert_eq!(config.binary().unwrap(), "/synthetic/claude");
        assert_eq!(
            config.anthropic_base_url().unwrap().as_deref(),
            Some("https://synthetic.invalid")
        );
        assert_eq!(config.config_home_dir().unwrap(), None);
        assert_eq!(
            config.anthropic_api_key().unwrap_err().to_string(),
            "synthetic environment read failure"
        );
        assert_eq!(
            *environment.calls.borrow(),
            [
                "CLAUDE_BINARY",
                "CLAUDE_BINARY",
                "ANTHROPIC_BASE_URL",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY"
            ]
        );
    }
}
