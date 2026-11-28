//! Role-specific locations of the CLI runtime descriptor.

use garcon_js::path::native;
use serde::{Deserialize, Serialize};

use crate::server_runtime::SERVER_RUNTIME_FILENAME;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Controller,
    Executor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeSelection {
    Auto,
    Controller,
    Executor,
}

pub fn executor_data_directory(config_dir: &str) -> String {
    native::join(&[config_dir, "executor"])
}

pub fn cli_gateway_runtime_file(data_dir: &str) -> String {
    native::join(&[data_dir, SERVER_RUNTIME_FILENAME])
}

pub fn cli_runtime_file(config_dir: &str, runtime: RuntimeKind) -> String {
    match runtime {
        RuntimeKind::Controller => cli_gateway_runtime_file(config_dir),
        RuntimeKind::Executor => cli_gateway_runtime_file(&executor_data_directory(config_dir)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_the_role_directory_before_appending_runtime_file() {
        let path = std::path::Path::new("config");
        assert_eq!(
            executor_data_directory("config"),
            path.join("executor").to_str().unwrap()
        );
        assert_eq!(
            cli_runtime_file("config", RuntimeKind::Controller),
            path.join("runtime.json").to_str().unwrap()
        );
        assert_eq!(
            cli_runtime_file("config", RuntimeKind::Executor),
            path.join("executor").join("runtime.json").to_str().unwrap()
        );
    }
}
