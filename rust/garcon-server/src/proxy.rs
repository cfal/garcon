//! Forwards every request no native unit claims to the original, including
//! WebSocket upgrades for browser sockets and executor links, whose upgraded
//! byte streams are relayed by `relay.rs`.

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::header::{
    CONNECTION, HeaderMap, HeaderName, HeaderValue, PROXY_AUTHENTICATE, PROXY_AUTHORIZATION, TE,
    TRAILER, TRANSFER_ENCODING, UPGRADE,
};
use hyper::http::uri::{Authority, Scheme};
use hyper::{Request, Response, StatusCode, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo};

use crate::line_log::LineLog;
use crate::relay::{self, SlowClient};

pub type ResponseBody = BoxBody<Bytes, hyper::Error>;

const HOP_BY_HOP: [HeaderName; 9] = [
    CONNECTION,
    HeaderName::from_static("keep-alive"),
    PROXY_AUTHENTICATE,
    PROXY_AUTHORIZATION,
    HeaderName::from_static("proxy-connection"),
    TE,
    TRAILER,
    TRANSFER_ENCODING,
    UPGRADE,
];
const X_FORWARDED_FOR: HeaderName = HeaderName::from_static("x-forwarded-for");
const X_REAL_IP: HeaderName = HeaderName::from_static("x-real-ip");

pub fn full_body(bytes: Bytes) -> ResponseBody {
    Full::new(bytes).map_err(|never| match never {}).boxed()
}

fn empty_body() -> ResponseBody {
    Empty::new().map_err(|never| match never {}).boxed()
}

/// The browser WebSocket and the slow-client budget the original applies to
/// it (`GARCON_WS_BACKPRESSURE_LIMIT`), enforced by the relay (ADR-010).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserSocket {
    pub path: String,
    pub budget: usize,
}

pub struct Proxy {
    client: Client<HttpConnector, Incoming>,
    authority: Authority,
    trust_proxy: bool,
    fallback_log: Option<LineLog>,
    browser_socket: BrowserSocket,
}

/// The tokens of the `Connection` header, which name hop-by-hop headers and
/// signal upgrades.
fn connection_tokens(headers: &HeaderMap) -> impl Iterator<Item = &str> {
    headers
        .get_all(CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
}

/// Removes the headers that describe one connection rather than the message.
pub fn remove_hop_by_hop(headers: &mut HeaderMap) {
    let listed: Vec<HeaderName> = connection_tokens(headers)
        .filter_map(|name| HeaderName::from_bytes(name.as_bytes()).ok())
        .collect();
    for name in listed.into_iter().chain(HOP_BY_HOP) {
        headers.remove(name);
    }
}

fn is_upgrade(headers: &HeaderMap) -> bool {
    headers.contains_key(UPGRADE)
        && connection_tokens(headers).any(|token| token.eq_ignore_ascii_case("upgrade"))
}

/// The request's path and query on the original. Returns `None` for targets
/// that are not paths, such as the asterisk form of `OPTIONS *`.
pub fn target_uri(authority: &Authority, uri: &Uri) -> Option<Uri> {
    let path_and_query = uri
        .path_and_query()
        .filter(|value| value.as_str().starts_with('/'))?;
    Uri::builder()
        .scheme(Scheme::HTTP)
        .authority(authority.clone())
        .path_and_query(path_and_query.clone())
        .build()
        .ok()
}

/// The original's authority from its origin, such as `http://127.0.0.1:4100`.
pub fn origin_authority(origin: &str) -> std::io::Result<Authority> {
    origin.trim_start_matches("http://").parse().map_err(|_| {
        std::io::Error::other(format!(
            "the original announced an invalid origin: {origin}"
        ))
    })
}

fn plain(status: StatusCode, text: &'static str) -> Response<ResponseBody> {
    let mut response = Response::new(full_body(Bytes::from_static(text.as_bytes())));
    *response.status_mut() = status;
    response
}

/// A connector to the original with Nagle's algorithm disabled, so proxying
/// adds no write coalescing delay that a direct connection would not have.
pub fn no_delay_connector() -> HttpConnector {
    let mut connector = HttpConnector::new();
    connector.set_nodelay(true);
    connector
}

/// The value for `X-Forwarded-For` that names a client connection.
pub fn forwarded_for(peer: std::net::SocketAddr) -> HeaderValue {
    HeaderValue::from_str(&peer.ip().to_string()).expect("an IP address is a valid header value")
}

impl Proxy {
    pub fn new(
        authority: Authority,
        trust_proxy: bool,
        fallback_log: Option<LineLog>,
        browser_socket: BrowserSocket,
    ) -> Self {
        Self {
            client: Client::builder(TokioExecutor::new()).build(no_delay_connector()),
            authority,
            trust_proxy,
            fallback_log,
            browser_socket,
        }
    }

    /// Replaces client-supplied forwarding headers with the connection's
    /// address. When the front door itself runs behind a trusted proxy
    /// (`--trust-proxy`), that proxy's headers pass through instead.
    fn set_forwarded_for(&self, headers: &mut HeaderMap, peer: &HeaderValue) {
        if self.trust_proxy {
            if !headers.contains_key(&X_FORWARDED_FOR) && !headers.contains_key(&X_REAL_IP) {
                headers.insert(X_FORWARDED_FOR, peer.clone());
            }
            return;
        }
        headers.remove(X_REAL_IP);
        headers.insert(X_FORWARDED_FOR, peer.clone());
    }

    /// `peer` is the client connection's `X-Forwarded-For` value.
    pub async fn forward(
        &self,
        mut request: Request<Incoming>,
        peer: &HeaderValue,
    ) -> Response<ResponseBody> {
        if let Some(log) = &self.fallback_log {
            log.record(&format!("{} {}", request.method(), request.uri().path()));
        }
        self.set_forwarded_for(request.headers_mut(), peer);
        if is_upgrade(request.headers()) {
            return self.forward_upgrade(request).await;
        }
        let Some(target) = target_uri(&self.authority, request.uri()) else {
            return plain(StatusCode::BAD_REQUEST, "Bad Request");
        };
        *request.uri_mut() = target;
        remove_hop_by_hop(request.headers_mut());
        match self.client.request(request).await {
            Ok(response) => {
                let (mut parts, body) = response.into_parts();
                remove_hop_by_hop(&mut parts.headers);
                Response::from_parts(parts, body.boxed())
            }
            Err(_) => plain(StatusCode::BAD_GATEWAY, "Bad Gateway"),
        }
    }

    /// Sends the upgrade request on a dedicated connection and, when the
    /// original switches protocols, relays bytes in both directions until
    /// either side closes.
    async fn forward_upgrade(&self, mut request: Request<Incoming>) -> Response<ResponseBody> {
        let bad_gateway = || plain(StatusCode::BAD_GATEWAY, "Bad Gateway");
        let client_upgrade = hyper::upgrade::on(&mut request);
        let slow_client = if request.uri().path() == self.browser_socket.path {
            SlowClient::Drop {
                budget: self.browser_socket.budget,
            }
        } else {
            SlowClient::Backpressure
        };
        let path = request
            .uri()
            .path_and_query()
            .map_or("/", |value| value.as_str());
        let mut upstream_request = Request::builder()
            .method(request.method())
            .uri(path)
            .version(request.version())
            .body(Empty::<Bytes>::new())
            .expect("an upgrade request copies a valid request line");
        *upstream_request.headers_mut() = std::mem::take(request.headers_mut());

        let Ok(stream) = relay::connect_upstream(self.authority.as_str()).await else {
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
                relay::relay_upgraded(client, upstream, slow_client).await;
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

    fn proxy(trust_proxy: bool) -> Proxy {
        let browser_socket = BrowserSocket {
            path: "/ws".to_string(),
            budget: 1 << 20,
        };
        Proxy::new(
            origin_authority("http://127.0.0.1:1").unwrap(),
            trust_proxy,
            None,
            browser_socket,
        )
    }

    #[tokio::test]
    async fn pooled_connections_disable_nagle() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let pooled = no_delay_connector()
            .call(format!("http://{address}").parse().unwrap())
            .await
            .unwrap();
        assert!(pooled.inner().nodelay().unwrap());
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
    fn targets_only_path_requests() {
        let authority = origin_authority("http://127.0.0.1:1").unwrap();
        assert_eq!(
            target_uri(&authority, &Uri::from_static("/api?x=1")).unwrap(),
            "http://127.0.0.1:1/api?x=1"
        );
        assert!(target_uri(&authority, &Uri::from_static("*")).is_none());
    }

    #[test]
    fn replaces_untrusted_forwarding_headers() {
        let peer = forwarded_for("203.0.113.7:5000".parse().unwrap());
        let mut headers = HeaderMap::new();
        headers.insert(X_FORWARDED_FOR, HeaderValue::from_static("198.51.100.1"));
        headers.insert(X_REAL_IP, HeaderValue::from_static("198.51.100.1"));
        proxy(false).set_forwarded_for(&mut headers, &peer);
        assert_eq!(headers.get(X_FORWARDED_FOR).unwrap(), "203.0.113.7");
        assert!(!headers.contains_key(X_REAL_IP));

        let mut trusted = HeaderMap::new();
        trusted.insert(X_FORWARDED_FOR, HeaderValue::from_static("198.51.100.1"));
        proxy(true).set_forwarded_for(&mut trusted, &peer);
        assert_eq!(trusted.get(X_FORWARDED_FOR).unwrap(), "198.51.100.1");
    }
}
