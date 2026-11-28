//! Contracts shared by the server, worker, CLI, and web client (ADR-018).
//!
//! Ports `common/`, one module per TypeScript file with the same name.

pub mod agent_integration;
pub mod agents;
pub mod api_providers;
pub mod attachments;
pub mod chat_id;
pub mod chat_modes;
pub mod error_codes;
pub mod executor_path;
pub mod executors;
pub mod input_format;
pub mod json;
pub mod project_resolution;
