//! The executor: the only public entry to runtime services and integrations.
//!
//! The controller receives a started executor's service handle from the
//! binary that composes them and never depends on this crate
//! (ADR-022). Ports `server/remote/worker.ts`, `server/remote/worker-cli.ts`,
//! and `server/remote/server/`.

pub mod cli;
mod cli_gateway;
mod default_agent_integrations;
mod executor_rpc_server;
mod history_rpc_server;
mod listener_secret;
mod producer_relay;
mod terminal_rpc_server;
mod worker;

pub use worker::{
    Executor, ExecutorIntegrationOptions, ExecutorOptions, ExecutorWorkerOptions, WorkerConnection,
};
