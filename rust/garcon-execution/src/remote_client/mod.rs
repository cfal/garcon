//! Controller-side adapters for authenticated executor links.

pub mod cli_dispatcher;
mod executor_client;
mod listeners;
mod remote_agent_integration;
mod remote_files;
mod remote_git;
mod remote_history;
mod remote_producers;
mod remote_terminals;
mod sessions;
mod wire;

pub use executor_client::RemoteExecutorClientFactory;

#[cfg(test)]
#[path = "../../tests/support/remote_client_cleanup_tests.rs"]
mod remote_client_cleanup_tests;
#[cfg(test)]
#[path = "../../tests/support/remote_client_producer_tests.rs"]
mod remote_client_producer_tests;
#[cfg(test)]
#[path = "../../tests/support/remote_client_sessions_tests.rs"]
mod remote_client_sessions_tests;
#[cfg(test)]
#[path = "../../tests/support/remote_client_wire_cases.rs"]
mod remote_client_wire_cases;
