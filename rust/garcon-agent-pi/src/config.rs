//! Ports `server-agents/pi/src/config.ts`.

use std::rc::Rc;

use garcon_agents_common::environment::{
    executable_override::resolve_executable_override, read_environment::read_environment,
};
use garcon_interface::{host::AgentEnvironmentReader, resources::ExecutorResult};
use garcon_js::path::{posix, win32};

pub struct PiConfig {
    environment: Rc<dyn AgentEnvironmentReader>,
}

pub fn create_pi_config(environment: Rc<dyn AgentEnvironmentReader>) -> PiConfig {
    PiConfig { environment }
}

impl PiConfig {
    pub fn binary(&self) -> ExecutorResult<String> {
        let override_path = match self.get("GARCON_PI_BINARY")? {
            Some(value) => Some(value),
            None => self.get("PI_BINARY")?,
        };
        let Some(command) = override_path else {
            return Ok("pi".to_owned());
        };
        let absolute_or_bare = if cfg!(windows) {
            win32::is_absolute(&command) || win32::basename(&command) == command
        } else {
            posix::is_absolute(&command) || posix::basename(&command) == command
        };
        if absolute_or_bare {
            return Ok(command);
        }
        let cwd = std::env::current_dir()?;
        Ok(resolve_executable_override(
            &command,
            None,
            &cwd.to_string_lossy(),
        ))
    }

    pub fn agent_directory_override(&self) -> ExecutorResult<Option<String>> {
        self.get("PI_CODING_AGENT_DIR")
    }

    pub fn session_directory_override(&self) -> ExecutorResult<Option<String>> {
        self.get("PI_CODING_AGENT_SESSION_DIR")
    }

    pub fn home_directory(&self) -> ExecutorResult<String> {
        if !cfg!(windows)
            && let Some(home) = self.get("HOME")?
        {
            return Ok(home);
        }
        std::env::home_dir()
            .map(|home| home.to_string_lossy().into_owned())
            .ok_or_else(|| "Home directory is unavailable".into())
    }

    pub fn is_test_environment(&self) -> ExecutorResult<bool> {
        Ok(self.get("NODE_ENV")?.as_deref() == Some("test"))
    }

    fn get(&self, name: &str) -> ExecutorResult<Option<String>> {
        read_environment(self.environment.as_ref(), name)
    }
}
