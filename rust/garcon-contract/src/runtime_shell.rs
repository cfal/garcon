//! Ports `common/runtime-shell.ts`.

use crate::base_path::{InvalidBasePath, parse_base_path};

pub const RUNTIME_BASE_PATH_TOKEN: &str = "__GARCON_RUNTIME_BASE_PATH__";

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RuntimeShellError {
    #[error("Web shell is not runtime-mountable; run bun run build")]
    NotMountable,
    #[error(transparent)]
    InvalidBasePath(#[from] InvalidBasePath),
}

pub fn render_runtime_shell(template: &str, base_path: &str) -> Result<String, RuntimeShellError> {
    if !template.contains(RUNTIME_BASE_PATH_TOKEN) {
        return Err(RuntimeShellError::NotMountable);
    }
    Ok(template.replace(RUNTIME_BASE_PATH_TOKEN, parse_base_path(base_path)?))
}
