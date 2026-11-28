//! Backend primitives shared by the controller and the worker.
//!
//! Ports `server/common/`, one module per TypeScript file.

pub mod domain_error;
pub mod event_loop_stalls;
pub mod executor_disconnect;
pub mod log;
