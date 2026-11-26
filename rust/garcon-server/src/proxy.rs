//! Forwards every request no native unit claims to the original, including
//! WebSocket upgrades for browser sockets and executor links, whose upgraded
//! byte streams are relayed unchanged.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Mutex;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::header::{CONNECTION, HeaderMap, HeaderName, HeaderValue, UPGRADE};
use hyper::{Request, Response, StatusCode, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo};
use std::io::Cursor;

use hyper::upgrade::Upgraded;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpSocket, TcpStream};

pub type ResponseBody = BoxBody<Bytes, hyper::Error>;

const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
];
const X_FORWARDED_FOR: HeaderName = HeaderName::from_static("x-forwarded-for");
const X_REAL_IP: HeaderName = HeaderName::from_static("x-real-ip");

pub fn full_body(bytes: Bytes) -> ResponseBody {
    Full::new(bytes).map_err(|never| match never {}).boxed()
}

fn empty_body() -> ResponseBody {
    Empty::new().map_err(|never| match never {}).boxed()
}

/// Appends one line per request handed to the original, in the format the
/// parity harness reads (`GARCON_RS_FALLBACK_LOG`).
pub struct FallbackLog(Mutex<File>);

impl FallbackLog {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        Ok(Self(Mutex::new(
            OpenOptions::new().create(true).append(true).open(path)?,
        )))
    }

    fn record(&self, method: &hyper::Method, path: &str) {
        let mut file = self.0.lock().expect("fallback log lock");
        let _ = writeln!(file, "{method} {path}");
    }
}

pub struct Proxy {
    client: Client<HttpConnector, Incoming>,
    origin: String,
    authority: String,
    trust_proxy: bool,
    fallback_log: Option<FallbackLog>,
}

fn remove_hop_by_hop(headers: &mut HeaderMap) {
    let listed: Vec<HeaderName> = headers
        .get_all(CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())
        .collect();
    for name in listed {
        headers.remove(name);
    }
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
    headers.remove(UPGRADE);
}

fn is_upgrade(headers: &HeaderMap) -> bool {
    headers.contains_key(UPGRADE)
        && headers
            .get_all(CONNECTION)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
}

fn bad_gateway() -> Response<ResponseBody> {
    let mut response = Response::new(full_body(Bytes::from_static(b"Bad Gateway")));
    *response.status_mut() = StatusCode::BAD_GATEWAY;
    response
}

/// A connector to the original with Nagle's algorithm disabled, so proxying
/// adds no write coalescing delay that a direct connection would not have.
pub fn no_delay_connector() -> HttpConnector {
    let mut connector = HttpConnector::new();
    connector.set_nodelay(true);
    connector
}

/// Relays an upgraded connection until the original ends it.
///
/// Unlike `copy_bidirectional`, which keeps the client-to-original direction
/// open after the original closes, the original ending its side ends the
/// relay. The original drops a slow WebSocket client by closing its
/// connection; with half-close semantics the relay stayed blocked forwarding
/// the client's queued frames to an original that no longer reads them, and
/// the client never saw the drop. A client that ends its side first still
/// receives whatever the original sends until it closes.
///
/// The two directions must not share one lock: when the client stops reading,
/// a write blocked on it must not stop the relay reading the client's
/// requests, or the original never sees the backpressure it drops slow
/// clients on. Upgraded TCP connections are therefore relayed through
/// independent socket halves (`relay_upgraded`).
async fn relay<CR, CW, UR, UW>(client: (CR, CW), upstream: (UR, UW))
where
    CR: AsyncRead + Unpin,
    CW: AsyncWrite + Unpin,
    UR: AsyncRead + Unpin,
    UW: AsyncWrite + Unpin,
{
    let ((mut client_read, mut client_write), (mut upstream_read, mut upstream_write)) =
        (client, upstream);
    let downstream = async {
        let _ = tokio::io::copy(&mut upstream_read, &mut client_write).await;
        let _ = client_write.shutdown().await;
    };
    let upstream_bound = async {
        let _ = tokio::io::copy(&mut client_read, &mut upstream_write).await;
        let _ = upstream_write.shutdown().await;
        std::future::pending::<()>().await;
    };
    tokio::select! {
        () = downstream => {}
        () = upstream_bound => {}
    }
}

/// Recovers the TCP connection and any bytes hyper read past the upgrade.
fn into_tcp(upgraded: Upgraded) -> Result<(TcpStream, Bytes), Upgraded> {
    let parts = upgraded.downcast::<TokioIo<TcpStream>>()?;
    Ok((parts.io.into_inner(), parts.read_buf))
}

/// Relays an upgraded client connection to the original.
async fn relay_upgraded(client: Upgraded, upstream: Upgraded) {
    // Both connections are TCP connections this proxy created, so a failed
    // downcast is a programming error; dropping them closes both sides.
    let (Ok((client, client_buffered)), Ok((upstream, upstream_buffered))) =
        (into_tcp(client), into_tcp(upstream))
    else {
        return;
    };
    let (client_read, client_write) = client.into_split();
    let (upstream_read, upstream_write) = upstream.into_split();
    relay(
        (
            Cursor::new(client_buffered).chain(client_read),
            client_write,
        ),
        (
            Cursor::new(upstream_buffered).chain(upstream_read),
            upstream_write,
        ),
    )
    .await;
}

/// Receive buffer for upgraded connections to the original. The relay adds a
/// hop between the original and the client; with autotuned buffers that hop
/// absorbs megabytes, so the original would detect a slow WebSocket client, and
/// drop it at its send budget, far later than without the front door. The hop
/// is loopback, where a small window costs no throughput.
const UPGRADED_UPSTREAM_RECEIVE_BUFFER: u32 = 32 * 1024;

/// Opens a dedicated connection to the original for a protocol upgrade.
async fn connect_upstream(authority: &str) -> std::io::Result<TcpStream> {
    let address: std::net::SocketAddr = authority.parse().map_err(|_| {
        std::io::Error::other(format!(
            "the original's address is not a socket address: {authority}"
        ))
    })?;
    let socket = if address.is_ipv4() {
        TcpSocket::new_v4()?
    } else {
        TcpSocket::new_v6()?
    };
    socket.set_recv_buffer_size(UPGRADED_UPSTREAM_RECEIVE_BUFFER)?;
    socket.set_nodelay(true)?;
    socket.connect(address).await
}

impl Proxy {
    pub fn new(origin: String, trust_proxy: bool, fallback_log: Option<FallbackLog>) -> Self {
        let authority = origin.trim_start_matches("http://").to_string();
        let client = Client::builder(TokioExecutor::new()).build(no_delay_connector());
        Self {
            client,
            origin,
            authority,
            trust_proxy,
            fallback_log,
        }
    }

    /// Replaces client-supplied forwarding headers with the connection's
    /// address. When the front door itself runs behind a trusted proxy
    /// (`GARCON_TRUST_PROXY`), that proxy's headers pass through instead.
    fn set_forwarded_for(&self, headers: &mut HeaderMap, peer: SocketAddr) {
        let peer = HeaderValue::from_str(&peer.ip().to_string())
            .expect("an IP address is a valid header value");
        if self.trust_proxy {
            if !headers.contains_key(&X_FORWARDED_FOR) && !headers.contains_key(&X_REAL_IP) {
                headers.insert(X_FORWARDED_FOR, peer);
            }
            return;
        }
        headers.remove(X_REAL_IP);
        headers.insert(X_FORWARDED_FOR, peer);
    }

    fn target_uri(&self, uri: &Uri) -> Uri {
        let path = uri
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or("/");
        format!("{}{path}", self.origin)
            .parse()
            .expect("origin and request path form a valid URI")
    }

    pub async fn forward(
        &self,
        mut request: Request<Incoming>,
        peer: SocketAddr,
    ) -> Response<ResponseBody> {
        if let Some(log) = &self.fallback_log {
            log.record(request.method(), request.uri().path());
        }
        self.set_forwarded_for(request.headers_mut(), peer);
        if is_upgrade(request.headers()) {
            return self.forward_upgrade(request).await;
        }
        *request.uri_mut() = self.target_uri(request.uri());
        remove_hop_by_hop(request.headers_mut());
        match self.client.request(request).await {
            Ok(response) => {
                let (mut parts, body) = response.into_parts();
                remove_hop_by_hop(&mut parts.headers);
                Response::from_parts(parts, body.boxed())
            }
            Err(_) => bad_gateway(),
        }
    }

    /// Sends the upgrade request on a dedicated connection and, when the
    /// original switches protocols, relays bytes in both directions until
    /// either side closes.
    async fn forward_upgrade(&self, mut request: Request<Incoming>) -> Response<ResponseBody> {
        let client_upgrade = hyper::upgrade::on(&mut request);
        let mut upstream_request = Request::builder()
            .method(request.method())
            .uri(
                request
                    .uri()
                    .path_and_query()
                    .map(|value| value.as_str())
                    .unwrap_or("/"),
            )
            .version(request.version())
            .body(Empty::<Bytes>::new())
            .expect("an upgrade request copies a valid request line");
        *upstream_request.headers_mut() = request.headers().clone();

        let Ok(stream) = connect_upstream(&self.authority).await else {
            return bad_gateway();
        };
        let Ok((mut sender, connection)) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await
        else {
            return bad_gateway();
        };
        tokio::spawn(connection.with_upgrades());
        let Ok(mut response) = sender.send_request(upstream_request).await else {
            return bad_gateway();
        };
        if response.status() != StatusCode::SWITCHING_PROTOCOLS {
            let (parts, body) = response.into_parts();
            return Response::from_parts(parts, body.boxed());
        }
        let upstream_upgrade = hyper::upgrade::on(&mut response);
        tokio::spawn(async move {
            if let (Ok(client), Ok(upstream)) = tokio::join!(client_upgrade, upstream_upgrade) {
                relay_upgraded(client, upstream).await;
            }
        });
        let (parts, _) = response.into_parts();
        Response::from_parts(parts, empty_body())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tower_service::Service;

    #[tokio::test]
    async fn the_original_closing_ends_the_relay_while_the_client_is_still_sending() {
        use tokio::io::AsyncReadExt;
        let (client, mut browser) = tokio::io::duplex(1024);
        let (upstream, mut original) = tokio::io::duplex(1024);
        let relay = tokio::spawn(relay(tokio::io::split(client), tokio::io::split(upstream)));
        // The browser queues more than the relay can deliver, and the original
        // stops reading and ends its side, as it does when it drops a client.
        let sending = tokio::spawn(async move {
            let chunk = vec![0u8; 64 * 1024];
            while browser.write_all(&chunk).await.is_ok() {}
            browser
        });
        original.shutdown().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), relay)
            .await
            .expect("the relay ends when the original does")
            .unwrap();
        let mut browser = tokio::time::timeout(std::time::Duration::from_secs(2), sending)
            .await
            .expect("the browser sees its connection end")
            .unwrap();
        let mut rest = Vec::new();
        assert_eq!(browser.read_to_end(&mut rest).await.unwrap(), 0);
        drop(original);
    }

    #[tokio::test]
    async fn a_client_that_closes_first_still_receives_the_original_reply() {
        use tokio::io::AsyncReadExt;
        let (client, mut browser) = tokio::io::duplex(1024);
        let (upstream, mut original) = tokio::io::duplex(1024);
        let relay = tokio::spawn(relay(tokio::io::split(client), tokio::io::split(upstream)));
        browser.write_all(b"request").await.unwrap();
        browser.shutdown().await.unwrap();
        let mut received = Vec::new();
        original.read_to_end(&mut received).await.unwrap();
        assert_eq!(received, b"request");
        original.write_all(b"reply").await.unwrap();
        original.shutdown().await.unwrap();
        let mut reply = Vec::new();
        browser.read_to_end(&mut reply).await.unwrap();
        assert_eq!(reply, b"reply");
        relay.await.unwrap();
    }

    #[tokio::test]
    async fn upgraded_upstream_connections_bound_their_receive_buffer() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stream = connect_upstream(&listener.local_addr().unwrap().to_string())
            .await
            .unwrap();
        // Linux reports twice the requested size to account for bookkeeping.
        let size = socket2::SockRef::from(&stream).recv_buffer_size().unwrap();
        assert!(
            size <= 2 * UPGRADED_UPSTREAM_RECEIVE_BUFFER as usize,
            "receive buffer is {size} bytes"
        );
    }

    #[tokio::test]
    async fn upstream_connections_disable_nagle() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let pooled = no_delay_connector()
            .call(format!("http://{address}").parse().unwrap())
            .await
            .unwrap();
        assert!(pooled.inner().nodelay().unwrap());
        assert!(
            connect_upstream(&address.to_string())
                .await
                .unwrap()
                .nodelay()
                .unwrap()
        );
    }

    #[test]
    fn removes_hop_by_hop_and_connection_listed_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(
            CONNECTION,
            HeaderValue::from_static("keep-alive, x-private"),
        );
        headers.insert("x-private", HeaderValue::from_static("1"));
        headers.insert("transfer-encoding", HeaderValue::from_static("chunked"));
        headers.insert("content-type", HeaderValue::from_static("text/plain"));
        remove_hop_by_hop(&mut headers);
        assert_eq!(
            headers.keys().map(|name| name.as_str()).collect::<Vec<_>>(),
            ["content-type"]
        );
    }

    #[test]
    fn detects_upgrades_from_connection_tokens() {
        let mut headers = HeaderMap::new();
        headers.insert(UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert(CONNECTION, HeaderValue::from_static("keep-alive, Upgrade"));
        assert!(is_upgrade(&headers));
        headers.insert(CONNECTION, HeaderValue::from_static("keep-alive"));
        assert!(!is_upgrade(&headers));
    }

    #[test]
    fn replaces_untrusted_forwarding_headers() {
        let peer: SocketAddr = "203.0.113.7:5000".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(X_FORWARDED_FOR, HeaderValue::from_static("198.51.100.1"));
        headers.insert(X_REAL_IP, HeaderValue::from_static("198.51.100.1"));
        Proxy::new("http://127.0.0.1:1".to_string(), false, None)
            .set_forwarded_for(&mut headers, peer);
        assert_eq!(headers.get(X_FORWARDED_FOR).unwrap(), "203.0.113.7");
        assert!(!headers.contains_key(X_REAL_IP));

        let mut trusted = HeaderMap::new();
        trusted.insert(X_FORWARDED_FOR, HeaderValue::from_static("198.51.100.1"));
        Proxy::new("http://127.0.0.1:1".to_string(), true, None)
            .set_forwarded_for(&mut trusted, peer);
        assert_eq!(trusted.get(X_FORWARDED_FOR).unwrap(), "198.51.100.1");
    }
}
