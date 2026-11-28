//! Ports `@cfal/noise-ws`: authenticated, encrypted WebSockets over a fixed
//! Noise protocol, on either side of a controller and executor link.
//!
//! Both endpoints must share a randomly generated 32-byte key. The key is never
//! sent. Application messages are encrypted over both `ws:` and `wss:`,
//! independently of TLS. The dialer is always the Noise initiator.
//!
//! Sockets are driven by tasks local to the single-threaded runtime (ADR-017):
//! call [`connect_noise_web_socket`] and [`PendingNoiseConnection::open`], and
//! construct a connection, inside a `tokio::task::LocalSet`.

mod cipher;
mod client;
mod connection;
mod crypto;
mod errors;
mod handshake;
mod options;
mod records;
mod server;
mod tls;
mod websocket;

#[cfg(test)]
mod tests;

pub use client::{NoiseClientOptions, NoiseTlsOptions, connect_noise_web_socket};
pub use connection::{
    CloseHandler, ErrorHandler, FinishHandler, HandlerResult, MessageHandler, NoiseConnection,
    NoiseFrame, NoiseReadyState, NoiseTransport, NoiseWebSocket, OpenHandler, RejectedWrite,
    async_handler,
};
pub use errors::{NoiseError, NoiseErrorCode, TypeError};
pub use options::{
    MAX_FRAME_BYTES, MAX_MESSAGE_BYTES, MAX_RECORDS_PER_DIRECTION, NOISE_PROTOCOL, NoiseCloseInfo,
    NoiseLimits, NoiseMessage, NoiseOptions, ResolvedNoiseLimits, connection_prologue,
    resolve_limits,
};
pub use server::{
    NoiseServer, NoiseServerOptions, PendingNoiseConnection, UpgradeFailure, create_noise_server,
};
