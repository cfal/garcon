use std::convert::Infallible;
use std::rc::Rc;
use std::sync::Arc;

use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::spawn_local;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::create_response_with_body;
use tokio_tungstenite::tungstenite::protocol::Role;

use crate::noise_ws::{NoiseOptions, NoiseServer, UpgradeFailure};

pub(super) enum Reply {
    Text(u16, &'static str),
    Echo(&'static str),
    Noise {
        server: Rc<NoiseServer>,
        options: NoiseOptions,
    },
}

pub(super) struct Fixture {
    pub port: u16,
}

impl Fixture {
    pub fn url(&self, scheme: &str, path: &str) -> String {
        format!("{scheme}://127.0.0.1:{}{path}", self.port)
    }
}

type Route = Rc<dyn Fn(&Request<Incoming>) -> Reply>;
type HttpResponse = Response<Full<Bytes>>;

pub(super) async fn serve(
    tls: Option<TlsAcceptor>,
    route: impl Fn(&Request<Incoming>) -> Reply + 'static,
) -> Fixture {
    let listener = TcpListener::bind(("0.0.0.0", 0))
        .await
        .expect("the listener binds");
    let port = listener.local_addr().expect("the listener address").port();
    let route: Route = Rc::new(route);
    spawn_local(async move {
        while let Ok((stream, _)) = listener.accept().await {
            stream.set_nodelay(true).expect("TCP_NODELAY is available");
            let route = Rc::clone(&route);
            let tls = tls.clone();
            spawn_local(async move {
                if let Some(tls) = tls {
                    if let Ok(stream) = tls.accept(stream).await {
                        serve_connection(stream, route).await;
                    }
                } else {
                    serve_connection(stream, route).await;
                }
            });
        }
    });
    Fixture { port }
}

pub(super) fn tls_identity(host: &str) -> (TlsAcceptor, Vec<u8>) {
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(vec![host.to_owned()]).expect("a test identity");
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("the protocol versions are supported")
    .with_no_client_auth()
    .with_single_cert(
        vec![cert.der().clone()],
        signing_key.serialize_der().try_into().unwrap(),
    )
    .expect("the identity is accepted");
    (TlsAcceptor::from(Arc::new(config)), cert.pem().into_bytes())
}

pub(super) struct Answered {
    pub status: u16,
    pub body: String,
}

pub(super) async fn get(url: &str) -> Answered {
    let url = url::Url::parse(url).expect("a valid test URL");
    let authority = url.authority();
    let mut stream = TcpStream::connect(authority)
        .await
        .expect("the probe connects");
    stream
        .write_all(
            format!(
                "GET {} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n",
                url.path()
            )
            .as_bytes(),
        )
        .await
        .expect("the probe sends");
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .await
        .expect("the probe reads");
    let (head, body) = response.split_once("\r\n\r\n").expect("a response head");
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .expect("a status line");
    Answered {
        status,
        body: body.to_owned(),
    }
}

async fn serve_connection(
    stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    route: Route,
) {
    let service = service_fn(move |request| {
        let response = respond(request, &route);
        async move { Ok::<_, Infallible>(response) }
    });
    let _ = http1::Builder::new()
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades()
        .await;
}

fn respond(mut request: Request<Incoming>, route: &Route) -> HttpResponse {
    let reply = route(&request);
    let handshake = || {
        let mut head = Request::builder()
            .method(request.method())
            .uri(request.uri())
            .version(request.version())
            .body(())
            .expect("the parsed request has a valid head");
        *head.headers_mut() = request.headers().clone();
        create_response_with_body(&head, Full::default).ok()
    };
    let (status, body) = match reply {
        Reply::Text(status, body) => (status, body),
        Reply::Echo(greeting) => {
            if let Some(response) = handshake() {
                let upgraded = hyper::upgrade::on(&mut request);
                spawn_local(async move {
                    if let Ok(stream) = upgraded.await {
                        let mut socket = WebSocketStream::from_raw_socket(
                            TokioIo::new(stream),
                            Role::Server,
                            None,
                        )
                        .await;
                        let _ = socket.send(Message::Text(greeting.into())).await;
                        while let Some(Ok(message)) = socket.next().await {
                            if matches!(message, Message::Text(_) | Message::Binary(_)) {
                                let _ = socket.send(message).await;
                            }
                        }
                    }
                });
                return response;
            }
            (400, "")
        }
        Reply::Noise { server, options } => {
            let mut response = None;
            match server.upgrade(options, |_| {
                response = handshake();
                response.is_some()
            }) {
                Ok(pending) => {
                    let upgraded = hyper::upgrade::on(&mut request);
                    spawn_local(async move {
                        if let Ok(stream) = upgraded.await {
                            pending.open(TokioIo::new(stream)).await;
                        }
                    });
                    return response.expect("admission accepted the handshake");
                }
                Err(UpgradeFailure::ServiceUnavailable) => (503, ""),
                Err(UpgradeFailure::BadRequest) => (400, ""),
                Err(UpgradeFailure::InvalidOptions(_)) => (500, "Internal Server Error"),
            }
        }
    };
    let mut response = Response::new(Full::new(Bytes::from_static(body.as_bytes())));
    *response.status_mut() = StatusCode::from_u16(status).expect("a valid response status");
    response
}
