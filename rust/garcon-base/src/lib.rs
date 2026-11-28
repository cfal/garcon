//! Backend primitives shared by the controller and the worker.
//!
//! Ports `server/common/`, one module per TypeScript file.

pub mod abortable_wait;
pub mod bounded_text_stream;
pub mod concurrency;
pub mod domain_error;
pub mod errors;
pub mod event_loop;
pub mod event_loop_stalls;
pub mod executor_disconnect;
pub mod executor_path;
pub mod file_stat;
pub mod http_body;
pub mod http_error;
pub mod interactive_deadline;
pub mod json_file_store;
pub mod keyed_lock;
pub mod log;
pub mod path_boundary;
pub mod portable_path;
pub mod private_file;
pub mod promise_timeout;
pub mod provider_discovery;
pub mod runtime_proof;
pub mod server_runtime;
pub mod stored_json;
pub mod terminal_framing;
pub mod ticket_error;
pub mod tls_roots;
pub mod unavailable_service;
pub mod unhandled_rejection_policy;
pub mod user_shell;
pub mod websocket_capacity;
pub mod workspace_lease;

pub use keyed_lock::KeyedLock;
