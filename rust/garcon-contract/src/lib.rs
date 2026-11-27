//! Contracts shared by the server, worker, CLI, and web client (ADR-018).
//!
//! Ports `common/`, one module per TypeScript file with the same name.

pub mod chat_id;
pub mod error_codes;
pub mod executor_path;
pub mod executors;
pub mod git_error;
pub mod json;
pub mod terminal;
