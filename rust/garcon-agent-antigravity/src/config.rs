//! Ports `server-agents/antigravity/src/config.ts`.

use std::{collections::BTreeMap, error::Error, ffi::OsStr, io, rc::Rc};

use garcon_agents_common::{
    acp::policy::AcpChildEnv, environment::read_environment::read_environment, which::which,
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    host::AgentEnvironmentReader,
    resources::ExecutorResult,
};

pub const ANTIGRAVITY_AUTH_METHODS: [&str; 4] = [
    "oauth-personal",
    "oauth-business",
    "gemini-api-key",
    "agent-platform",
];

#[derive(Clone)]
pub struct AntigravityConfig(Rc<dyn AgentEnvironmentReader>);

impl AntigravityConfig {
    pub fn new(environment: Rc<dyn AgentEnvironmentReader>) -> Self {
        Self(environment)
    }

    pub fn binary(&self) -> ExecutorResult<String> {
        let command = read_environment(self.0.as_ref(), "GARCON_ANTIGRAVITY_BINARY")?;
        which(OsStr::new(command.as_deref().unwrap_or("agy")))
            .map(|path| path.to_string_lossy().into_owned())
            .ok_or_else(|| {
                integration_error(Code::BINARY_NOT_FOUND,
                    "Antigravity CLI not found on this executor. Install agy or set GARCON_ANTIGRAVITY_BINARY.")
            })
    }

    pub fn api_key(&self) -> ExecutorResult<Option<String>> {
        read_environment(self.0.as_ref(), "GEMINI_API_KEY")
    }

    pub fn auth_method(&self) -> ExecutorResult<&'static str> {
        let configured = read_environment(self.0.as_ref(), "GARCON_ANTIGRAVITY_AUTH_METHOD")?;
        resolve_auth_method(configured.as_deref(), self.api_key()?.is_some())
    }
}

pub fn resolve_auth_method(
    configured: Option<&str>,
    has_api_key: bool,
) -> ExecutorResult<&'static str> {
    match configured {
        Some(method) => ANTIGRAVITY_AUTH_METHODS
            .into_iter()
            .find(|value| *value == method)
            .ok_or_else(|| {
                integration_error(
                    Code::INVALID_SETTINGS,
                    format!(
                        "GARCON_ANTIGRAVITY_AUTH_METHOD must be one of {}; received {method}.",
                        ANTIGRAVITY_AUTH_METHODS.join(", ")
                    ),
                )
            }),
        None if has_api_key => Ok("gemini-api-key"),
        None => Ok("oauth-personal"),
    }
}

pub fn child_environment(
    config: &AntigravityConfig,
    overrides: &BTreeMap<String, String>,
) -> ExecutorResult<AcpChildEnv> {
    let mut env: AcpChildEnv = std::env::vars_os()
        .filter_map(|(name, value)| {
            Some((name.into_string().ok()?, Some(value.into_string().ok()?)))
        })
        .collect();
    env.remove("GEMINI_API_KEY");
    env.insert("AGY_CLI_DISABLE_AUTO_UPDATE".into(), Some("true".into()));
    if config.auth_method().ok() == Some("gemini-api-key")
        && let Some(key) = config.api_key()?
    {
        env.insert("GEMINI_API_KEY".into(), Some(key));
    }
    env.extend(
        overrides
            .iter()
            .map(|(name, value)| (name.clone(), Some(value.clone()))),
    );
    Ok(env)
}

pub(crate) fn integration_error(code: Code, message: impl Into<String>) -> Box<dyn Error> {
    AgentIntegrationError::new(code, message, false, None).into()
}

pub(crate) fn classify_launch_error(error: Box<dyn Error>, binary: Option<&str>) -> Box<dyn Error> {
    let Some(error_io) = error.downcast_ref::<io::Error>() else {
        return error;
    };
    let Some(binary) = binary else {
        return error;
    };
    let Some(detail) = unlaunchable_binary_detail(error_io) else {
        return error;
    };
    integration_error(
        Code::BINARY_NOT_FOUND,
        format!("Cannot launch Antigravity CLI on this executor: {detail}, posix_spawn '{binary}'"),
    )
}

#[cfg(unix)]
fn unlaunchable_binary_detail(error: &io::Error) -> Option<&'static str> {
    Some(match error.raw_os_error()? {
        libc::ENOENT => "ENOENT: no such file or directory",
        libc::ENOTDIR => "ENOTDIR: not a directory",
        libc::EISDIR => "EISDIR: illegal operation on a directory",
        libc::ELOOP => "ELOOP: too many symbolic links encountered",
        libc::ENAMETOOLONG => "ENAMETOOLONG: name too long",
        libc::EACCES => "EACCES: permission denied",
        libc::EPERM => "EPERM: operation not permitted",
        libc::ENOEXEC => "ENOEXEC: exec format error",
        #[cfg(target_os = "linux")]
        libc::ELIBBAD => "ELIBBAD: accessing a corrupted shared library",
        #[cfg(target_os = "macos")]
        libc::EBADARCH => "EBADARCH: bad CPU type in executable",
        #[cfg(target_os = "macos")]
        libc::EBADEXEC => "EBADEXEC: bad executable",
        #[cfg(target_os = "macos")]
        libc::EBADMACHO => "EBADMACHO: malformed Mach-O file",
        _ => return None,
    })
}

#[cfg(not(unix))]
fn unlaunchable_binary_detail(_: &io::Error) -> Option<&'static str> {
    None
}
