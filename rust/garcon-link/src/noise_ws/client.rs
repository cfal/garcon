//! Ports `@cfal/noise-ws/src/client.ts`: the dialing adapter.

use std::rc::Rc;

use tokio::net::TcpStream;
use tokio::task::spawn_local;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_tls_with_config};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::TypeError;
use super::connection::{CloseHandler, ErrorHandler, MessageHandler, NoiseConnection, OpenHandler};
use super::errors::NoiseErrorCode;
use super::options::{NoiseLimits, NoiseOptions};
use super::tls::ClientTls;
use super::websocket::{Side, WebSocketTransport, frame_limit};

/// `Pick<Bun.TLSOptions, 'ca'>`: an authority bundle in place of the bundled roots.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoiseTlsOptions {
    pub ca: Option<Vec<u8>>,
}

pub struct NoiseClientOptions {
    pub psk: Vec<u8>,
    pub context: String,
    pub limits: Option<NoiseLimits>,
    pub on_message: MessageHandler,
    pub on_open: Option<OpenHandler>,
    pub on_error: Option<ErrorHandler>,
    pub on_close: Option<CloseHandler>,
    pub tls: Option<NoiseTlsOptions>,
    /// Opt-in for an unverified outer TLS layer. Noise authentication remains mandatory.
    pub allow_unverified_tls: bool,
    pub signal: Option<CancellationToken>,
}

pub fn connect_noise_web_socket(
    address: &str,
    options: NoiseClientOptions,
) -> Result<Rc<NoiseConnection>, TypeError> {
    let mut url =
        Url::parse(address).map_err(|_| TypeError::new("Invalid encrypted WebSocket URL"))?;
    if !matches!(url.scheme(), "ws" | "wss")
        || url.fragment().is_some_and(|fragment| !fragment.is_empty())
        || !url.username().is_empty()
        || url.password().is_some_and(|password| !password.is_empty())
    {
        return Err(TypeError::new(
            "Expected ws: or wss: without URL credentials or a fragment",
        ));
    }
    url.set_fragment(None);
    let NoiseClientOptions {
        psk,
        context,
        limits,
        on_message,
        on_open,
        on_error,
        on_close,
        tls,
        allow_unverified_tls,
        signal,
    } = options;
    let connection = NoiseConnection::new(
        true,
        NoiseOptions {
            psk,
            context,
            limits,
            on_message,
            on_open,
            on_error,
            on_close,
        },
        None,
    )?;
    if signal.as_ref().is_some_and(CancellationToken::is_cancelled) {
        connection.fail(NoiseErrorCode::Closed);
        return Ok(connection);
    }
    // `addEventListener('abort')`, removed at the connection's finish.
    if let Some(signal) = signal.clone() {
        let listening = Rc::clone(&connection);
        spawn_local(async move {
            tokio::select! {
                _ = listening.closed() => {}
                _ = signal.cancelled() => listening.fail(NoiseErrorCode::Closed),
            }
        });
    }
    let tls = ClientTls::new(
        tls.as_ref().and_then(|tls| tls.ca.as_deref()),
        allow_unverified_tls,
    );
    spawn_local({
        let connection = Rc::clone(&connection);
        async move {
            let stream = tokio::select! {
                // `socket.terminate()` on a socket that is still connecting.
                _ = connection.closed() => return,
                stream = dial(&url, tls) => match stream {
                    Err(()) => {
                        connection.fail(NoiseErrorCode::TransportError);
                        return;
                    }
                    Ok(stream) => stream,
                },
            };
            let transport = WebSocketTransport::start(Rc::clone(&connection), stream, Side::Client);
            connection.attach(transport);
        }
    });
    Ok(connection)
}

type DialStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The `error` event: every failure to open the socket, whatever its reason.
async fn dial(address: &Url, tls: ClientTls) -> Result<DialStream, ()> {
    let connector = if address.scheme() == "wss" {
        Some(tls.connector().map_err(|_| ())?)
    } else {
        None
    };
    // Nagle's algorithm stays off, as it is on the sockets the front door took
    // over from Bun (ADR-009): a small frame must not wait for an acknowledgement.
    connect_async_tls_with_config(address.as_str(), Some(frame_limit()), true, connector)
        .await
        .map(|(stream, _response)| stream)
        .map_err(|_| ())
}
