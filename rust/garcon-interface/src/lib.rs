//! The agent integration and execution runtime contracts (ADR-024).
//!
//! Ports `server-agents/interface/src/`, one module per TypeScript file.

pub mod errors;
pub mod execution_runtime;
pub mod files;
pub mod git;
pub mod native_message_source;
pub mod resources;
pub mod terminals;
