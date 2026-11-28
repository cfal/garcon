//! The encrypted executor link.
//!
//! Ports `@cfal/noise-ws` and `server/remote/transport/`, one module per
//! TypeScript file.

pub mod bulk_connection;
pub mod cli_admission;
pub mod cli_protocol;
pub mod connection_url;
pub mod failure_reason;
pub mod file_protocol;
pub mod git_protocol;
pub mod history_pages;
pub mod limits;
pub mod link_handshake;
pub mod message_queue_budget;
pub mod message_session;
pub mod noise_ws;
pub mod rpc;
pub mod rpc_admission;
pub mod rpc_connection;
pub mod rpc_journal;
pub mod rpc_lane;
pub mod rpc_protocol;
pub mod rpc_routing;
pub mod session_socket;
pub mod session_transport;
pub mod socket_admission;
pub mod terminal_protocol;
pub mod websocket_link;
