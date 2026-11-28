//! Contracts shared by the server, worker, CLI, and web client (ADR-018).
//!
//! Ports `common/`, one module per TypeScript file with the same name.

pub mod chat_id;
pub mod error_codes;
pub mod executor_path;
pub mod executors;
pub mod file_contracts;
pub mod gh;
pub mod gh_identity;
pub mod git;
pub mod git_diagnostics;
pub mod git_error;
pub mod git_execution;
pub mod git_refs;
pub mod git_request_validation;
pub mod json;
pub mod slash_commands;
pub mod terminal;
pub mod terminal_error;
pub mod transcript_projection;
