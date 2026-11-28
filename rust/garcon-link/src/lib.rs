//! The encrypted executor link.
//!
//! Ports `@cfal/noise-ws` and `server/remote/transport/`, one module per
//! TypeScript file.

pub mod connection_url;
pub mod failure_reason;
pub mod limits;
pub mod link_handshake;
pub mod message_queue_budget;
pub mod message_session;
pub mod noise_ws;
pub mod rpc_admission;
pub mod rpc_lane;
pub mod session_socket;
pub mod session_transport;
pub mod socket_admission;
