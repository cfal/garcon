//! The agent integration and execution runtime contracts (ADR-024).
//!
//! Ports `server-agents/interface/src/`, one module per TypeScript file.

pub mod cli_updates;
pub mod errors;
pub mod execution;
pub mod execution_runtime;
pub mod execution_v5;
pub mod files;
pub mod git;
pub mod host;
pub mod integration;
pub mod native_fork;
pub mod native_history;
pub mod native_message_source;
pub mod producer;
pub mod resources;
pub mod services;
pub mod terminals;
pub mod testing;
pub mod transcript;
pub mod usage_history;
