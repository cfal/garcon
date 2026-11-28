//! Git command contracts from `server/runtime/git/types.ts`.

use std::collections::BTreeMap;
use std::ffi::OsString;

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::ChildEnvironment;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitCommandResult {
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Default)]
pub struct GitCommandOptions {
    pub truncate_stdout: Option<bool>,
    pub signal: Option<CancellationToken>,
    pub timeout_ms: Option<f64>,
    pub disable_optional_locks: bool,
    pub max_stdout_bytes: Option<usize>,
    pub max_stderr_bytes: Option<usize>,
    pub base_environment: Option<ChildEnvironment>,
    pub env: Option<BTreeMap<OsString, Option<OsString>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandTrace {
    pub args: Vec<String>,
    pub duration_ms: u64,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aborted: Option<bool>,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct GitProcessError {
    pub message: String,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: Option<bool>,
    pub aborted: Option<bool>,
}
