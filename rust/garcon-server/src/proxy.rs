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
use tokio::net::TcpStream;

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

/// Opens a dedicated connection to the original for a protocol upgrade.
async fn connect_upstream(authority: &str) -> std::io::Result<TcpStream> {
    let stream = TcpStream::connect(authority).await?;
    stream.set_nodelay(true)?;
    Ok(stream)
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
                let _ = tokio::io::copy_bidirectional(
                    &mut TokioIo::new(client),
                    &mut TokioIo::new(upstream),
                )
                .await;
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
