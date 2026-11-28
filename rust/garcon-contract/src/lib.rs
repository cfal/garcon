//! Contracts shared by the server, worker, CLI, and web client (ADR-018).
//!
//! Ports `common/`, one module per TypeScript file with the same name.

pub mod agent_integration;
pub mod agents;
pub mod api_providers;
pub mod attachments;
pub mod chat_execution_control;
pub mod chat_id;
pub mod chat_modes;
pub mod chat_plan;
pub mod chat_stop;
pub mod cli_presentation;
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
pub mod input_format;
pub mod json;
pub mod project_resolution;
pub mod queue_state;
pub mod slash_commands;
pub mod terminal;
pub mod terminal_error;
pub mod tool_schedule;
pub mod transcript_projection;
pub mod ws_auth;
pub mod ws_value_parsing;
