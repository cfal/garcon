//! The executor: the only public entry to runtime services and integrations.
//!
//! The controller receives a started executor's `ExecutionRuntimeApi` handle
//! from the binary that composes them and never depends on this crate
//! (ADR-022). Ports `server/remote/worker.ts`, `server/remote/worker-cli.ts`,
//! and `server/remote/server/`.

pub mod cli;
