//! Backend primitives shared by the controller and the worker.
//!
//! Ports `server/common/`, one module per TypeScript file.

pub mod domain_error;
pub mod event_loop_stalls;
pub mod executor_disconnect;
pub mod executor_path;
pub mod json_file_store;
pub mod keyed_lock;
pub mod log;
pub mod path_boundary;
pub mod private_file;
pub mod provider_discovery;
pub mod stored_json;
pub mod unavailable_service;
pub mod user_shell;
pub mod websocket_capacity;
pub mod workspace_lease;

pub use keyed_lock::KeyedLock;
