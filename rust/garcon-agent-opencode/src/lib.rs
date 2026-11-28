//! The OpenCode integration (ADR-027). Ports `server-agents/opencode/src/`:
//! one module per TypeScript file, under `agents::opencode`.

pub mod agents;
pub mod config;
mod integration;
pub mod js;

pub use integration::OpenCodeAgentIntegration;
