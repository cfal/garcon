//! Ports `@cfal/noise-ws/src/server.ts`: admission and the sockets of a
//! listener, not the HTTP listener itself. The listener upgrades a connection
//! and hands the upgraded stream to the connection it admitted.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::Role;

use super::TypeError;
use super::connection::{FinishHandler, NoiseConnection, NoiseReadyState};
use super::errors::NoiseErrorCode;
use super::options::{NoiseOptions, is_safe_integer};
use super::websocket::{Side, WebSocketTransport, frame_limit};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NoiseServerOptions {
    pub max_connections: Option<usize>,
    pub max_pending_handshakes: Option<usize>,
}

/// Why `upgrade` did not admit a connection. The first two are the HTTP
/// answer the listener gives.
#[derive(Debug, thiserror::Error)]
pub enum UpgradeFailure {
    #[error("The Noise server is closed or its admission is full")]
    ServiceUnavailable,
    #[error("The WebSocket upgrade did not take the connection")]
    BadRequest,
    #[error(transparent)]
    InvalidOptions(#[from] TypeError),
}

pub struct NoiseServer {
    max_connections: usize,
    max_pending: usize,
    // In insertion order, as the original's `Set`. Each connection removes itself when it finishes.
    connections: Rc<RefCell<Vec<Rc<NoiseConnection>>>>,
    disposed: Cell<bool>,
}

pub fn create_noise_server(options: NoiseServerOptions) -> Result<NoiseServer, TypeError> {
    let max_connections = options.max_connections.unwrap_or(64);
    let max_pending = options.max_pending_handshakes.unwrap_or(16);
    if [max_connections, max_pending]
        .into_iter()
        .any(|limit| limit < 1 || !is_safe_integer(limit as u64))
    {
        return Err(TypeError::new("Invalid Noise server admission limit"));
    }
    Ok(NoiseServer {
        max_connections,
        max_pending,
        connections: Rc::default(),
        disposed: Cell::new(false),
    })
}

impl NoiseServer {
    /// Pending and established connections.
    pub fn size(&self) -> usize {
        self.connections.borrow().len()
    }

    /// Admits a connection for an upgrade request. `server` is the listener's
    /// native upgrade, which receives the connection to open later; a refused
    /// upgrade (`false`) releases the connection.
    pub fn upgrade(
        &self,
        connection_options: NoiseOptions,
        server: impl FnOnce(&Rc<NoiseConnection>) -> bool,
    ) -> Result<PendingNoiseConnection, UpgradeFailure> {
        let pending = self
            .connections
            .borrow()
            .iter()
            .filter(|connection| connection.ready_state() != NoiseReadyState::Open)
            .count();
        if self.disposed.get() || self.size() >= self.max_connections || pending >= self.max_pending
        {
            return Err(UpgradeFailure::ServiceUnavailable);
        }
        let connection = self.admit(connection_options)?;
        if server(&connection) {
            return Ok(PendingNoiseConnection {
                connection: Some(connection),
            });
        }
        // Failed upgrades release their admission and copied credentials.
        connection.fail(NoiseErrorCode::TransportError);
        Err(UpgradeFailure::BadRequest)
    }

    /// Closes its connections and refuses future upgrades.
    pub fn close(&self) {
        self.disposed.set(true);
        let connections = self.connections.borrow().clone();
        for connection in connections {
            connection.close();
        }
    }

    fn admit(&self, options: NoiseOptions) -> Result<Rc<NoiseConnection>, TypeError> {
        let connections = Rc::clone(&self.connections);
        let on_finish: FinishHandler = Rc::new(move |connection| {
            connections
                .borrow_mut()
                .retain(|admitted| !Rc::ptr_eq(admitted, connection));
        });
        let connection = NoiseConnection::new(false, options, Some(on_finish))?;
        self.connections.borrow_mut().push(Rc::clone(&connection));
        Ok(connection)
    }
}

/// A connection `upgrade` admitted, waiting for the stream of its WebSocket.
pub struct PendingNoiseConnection {
    connection: Option<Rc<NoiseConnection>>,
}

impl PendingNoiseConnection {
    /// `websocket.open`: attaches the upgraded stream and starts its driver.
    pub async fn open<S>(mut self, stream: S)
    where
        S: AsyncRead + AsyncWrite + Unpin + 'static,
    {
        let Some(connection) = self.connection.take() else {
            return;
        };
        let stream =
            WebSocketStream::from_raw_socket(stream, Role::Server, Some(frame_limit())).await;
        let transport = WebSocketTransport::start(Rc::clone(&connection), stream, Side::Server);
        connection.attach(transport);
    }
}

impl Drop for PendingNoiseConnection {
    /// An admitted connection whose upgrade does not complete has failed it.
    fn drop(&mut self) {
        if let Some(connection) = self.connection.take() {
            connection.fail(NoiseErrorCode::TransportError);
        }
    }
}
