//! Executor-local GitHub CLI types.

use std::collections::BTreeMap;
use std::ffi::OsString;

use garcon_base::errors::{DiagnosticError, ErrorMetadata};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::ChildEnvironment;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct GhDomainError {
    pub code: &'static str,
    pub message: String,
}

impl GhDomainError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl DiagnosticError for GhDomainError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "GhDomainError",
            code: Some(self.code),
        }
    }
}

#[derive(Default)]
pub struct GhCommandOptions {
    pub timeout_ms: Option<f64>,
    pub signal: Option<CancellationToken>,
    pub max_stdout_bytes: Option<usize>,
    pub max_stderr_bytes: Option<usize>,
    pub base_environment: Option<ChildEnvironment>,
    pub env: Option<BTreeMap<OsString, Option<OsString>>>,
    pub stdin: Option<String>,
}

impl GhCommandOptions {
    pub(super) fn for_signal(signal: Option<&CancellationToken>) -> Self {
        Self {
            signal: signal.cloned(),
            ..Default::default()
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct GhCommandResult {
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct GhProcessError {
    pub message: String,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub aborted: bool,
}

impl DiagnosticError for GhProcessError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "Error",
            code: None,
        }
    }
}
