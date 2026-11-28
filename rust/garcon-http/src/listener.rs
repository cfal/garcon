use std::cell::Cell;
use std::error::Error;
use std::future::{Future, poll_fn};
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http::header::{CONNECTION, HOST, HeaderValue};
use http::{Request, Response, StatusCode, Version};
use http_body_util::{Full, LengthLimitError, Limited};
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;

// Bun counts the entire request head, including the request line and CRLFs.
const MAX_REQUEST_HEAD_BYTES: usize = 16 * 1024;
const MAX_REQUEST_HEADERS: usize = 198;
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(100);

pub type HttpRequest = Request<RequestBody>;
pub type HttpResponse = Response<Full<Bytes>>;

pub struct RequestBody {
    body: Limited<Incoming>,
    exceeded: Rc<Cell<bool>>,
    idle: Arc<ConnectionIdle>,
}

impl RequestBody {
    /// Disables the idle timeout until this request's handler returns.
    pub fn disable_idle_timeout(&self) {
        self.idle.deadline_millis.store(0, Ordering::Relaxed);
    }
}

impl Body for RequestBody {
    type Data = Bytes;
    type Error = Box<dyn Error + Send + Sync>;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let result = Pin::new(&mut self.body).poll_frame(cx);
        if matches!(&result, Poll::Ready(Some(Err(error))) if error.is::<LengthLimitError>()) {
            self.exceeded.set(true);
        }
        result
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

pub struct Listener {
    tcp: TcpListener,
    body_limit: usize,
    idle_timeout: Duration,
}

impl Listener {
    pub async fn bind(
        address: &str,
        port: u16,
        body_limit: usize,
        idle_seconds: u8,
    ) -> io::Result<Self> {
        let address = address
            .strip_prefix('[')
            .and_then(|address| address.strip_suffix(']'))
            .unwrap_or(address);
        Ok(Self {
            tcp: TcpListener::bind((address, port)).await?,
            body_limit,
            idle_timeout: rounded_idle_timeout(idle_seconds),
        })
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.tcp.local_addr()
    }

    pub async fn serve<F, ResponseFuture>(self, handler: F, shutdown: CancellationToken)
    where
        F: Fn(HttpRequest, SocketAddr) -> ResponseFuture + 'static,
        ResponseFuture: Future<Output = HttpResponse> + 'static,
    {
        let handler = Rc::new(handler);
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break,
                _ = connections.join_next(), if !connections.is_empty() => {},
                accepted = self.tcp.accept() => {
                    let Ok((socket, peer)) = accepted else {
                        tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                        continue;
                    };
                    if socket.set_nodelay(true).is_err() {
                        continue;
                    }
                    let handler = Rc::clone(&handler);
                    connections.spawn_local(serve_connection(
                        socket, peer, self.body_limit, self.idle_timeout, handler,
                    ));
                }
            }
        }
        connections.shutdown().await;
    }
}

fn rounded_idle_timeout(seconds: u8) -> Duration {
    // Bun sweeps idle sockets in four-second intervals after dispatch.
    Duration::from_secs(u64::from(seconds).div_ceil(4) * 4)
}

struct ConnectionIdle {
    timeout: Duration,
    start: Instant,
    // Hyper requires the transport of an upgraded connection to be Send.
    // Only this socket timer, not any controller state, crosses that boundary.
    deadline_millis: AtomicU64,
}

impl ConnectionIdle {
    fn reset(&self) {
        if !self.timeout.is_zero() {
            let millis = (self.start.elapsed() + self.timeout).as_millis();
            self.deadline_millis
                .store(u64::try_from(millis).unwrap_or(u64::MAX), Ordering::Relaxed);
        }
    }

    fn deadline(&self) -> Option<Instant> {
        let millis = self.deadline_millis.load(Ordering::Relaxed);
        (millis != 0).then(|| self.start + Duration::from_millis(millis))
    }

    fn activity(&self) {
        if self.deadline_millis.load(Ordering::Relaxed) != 0 {
            self.reset();
        }
    }
}

struct ActivitySocket {
    socket: TcpStream,
    idle: Arc<ConnectionIdle>,
}

impl AsyncRead for ActivitySocket {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let socket = self.get_mut();
        let before = buf.filled().len();
        let result = Pin::new(&mut socket.socket).poll_read(cx, buf);
        if buf.filled().len() > before {
            socket.idle.activity();
        }
        result
    }
}

impl AsyncWrite for ActivitySocket {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let socket = self.get_mut();
        let result = Pin::new(&mut socket.socket).poll_write(cx, bytes);
        if matches!(result, Poll::Ready(Ok(written)) if written > 0) {
            socket.idle.activity();
        }
        result
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().socket).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().socket).poll_shutdown(cx)
    }
}

async fn serve_connection<F, ResponseFuture>(
    socket: TcpStream,
    peer: SocketAddr,
    body_limit: usize,
    idle_timeout: Duration,
    handler: Rc<F>,
) where
    F: Fn(HttpRequest, SocketAddr) -> ResponseFuture,
    ResponseFuture: Future<Output = HttpResponse>,
{
    let idle = Arc::new(ConnectionIdle {
        timeout: idle_timeout,
        start: Instant::now(),
        deadline_millis: AtomicU64::new(0),
    });
    let request_idle = Arc::clone(&idle);
    let service = service_fn(move |request: Request<Incoming>| {
        let handler = Rc::clone(&handler);
        let idle = Arc::clone(&request_idle);
        async move {
            idle.reset();
            let response =
                handle_request(request, peer, body_limit, Arc::clone(&idle), &*handler).await;
            idle.reset();
            Ok::<_, std::convert::Infallible>(response)
        }
    });
    let mut connection = std::pin::pin!(
        http1::Builder::new()
            .max_buf_size(MAX_REQUEST_HEAD_BYTES)
            .max_headers(MAX_REQUEST_HEADERS)
            .serve_connection(
                TokioIo::new(ActivitySocket {
                    socket,
                    idle: Arc::clone(&idle)
                }),
                service
            )
            .with_upgrades()
    );
    let mut timer = std::pin::pin!(sleep_until(Instant::now()));
    poll_fn(|cx| {
        if connection.as_mut().poll(cx).is_ready() {
            return Poll::Ready(());
        }
        if let Some(deadline) = idle.deadline() {
            if timer.deadline() != deadline {
                timer.as_mut().reset(deadline);
            }
            if timer.as_mut().poll(cx).is_ready() {
                return Poll::Ready(());
            }
        }
        Poll::Pending
    })
    .await;
}

async fn handle_request<F, ResponseFuture>(
    request: Request<Incoming>,
    peer: SocketAddr,
    body_limit: usize,
    idle: Arc<ConnectionIdle>,
    handler: &F,
) -> HttpResponse
where
    F: Fn(HttpRequest, SocketAddr) -> ResponseFuture,
    ResponseFuture: Future<Output = HttpResponse>,
{
    if request.version() == Version::HTTP_11 && !request.headers().contains_key(HOST) {
        return empty_and_close(StatusCode::BAD_REQUEST);
    }
    if request
        .body()
        .size_hint()
        .exact()
        .is_some_and(|length| length > body_limit as u64)
    {
        return empty_and_close(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let exceeded = Rc::new(Cell::new(false));
    let request = request.map(|body| RequestBody {
        body: Limited::new(body, body_limit),
        exceeded: Rc::clone(&exceeded),
        idle,
    });
    let response = handler(request, peer).await;
    if exceeded.get() {
        empty_and_close(StatusCode::PAYLOAD_TOO_LARGE)
    } else {
        response
    }
}

fn empty_and_close(status: StatusCode) -> HttpResponse {
    let mut response = Response::new(Full::default());
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONNECTION, HeaderValue::from_static("close"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::task::LocalSet;

    async fn exchange(addr: SocketAddr, request: impl AsRef<[u8]>) -> String {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream.write_all(request.as_ref()).await.unwrap();
        let mut response = String::new();
        tokio::time::timeout(Duration::from_secs(3), stream.read_to_string(&mut response))
            .await
            .expect("the server closes the connection")
            .unwrap();
        response
    }

    async fn server() -> (SocketAddr, Rc<Cell<usize>>, CancellationToken) {
        let listener = Listener::bind("0.0.0.0", 0, 64, 0).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let addr = SocketAddr::from(([127, 0, 0, 1], addr.port()));
        let shutdown = CancellationToken::new();
        let calls = Rc::new(Cell::new(0));
        let calls_for_handler = Rc::clone(&calls);
        tokio::task::spawn_local(listener.serve(
            move |request, _| {
                calls_for_handler.set(calls_for_handler.get() + 1);
                async move {
                    let _ = request.into_body().collect().await;
                    Response::new(Full::new(Bytes::from_static(b"accepted")))
                }
            },
            shutdown.clone(),
        ));
        (addr, calls, shutdown)
    }

    #[tokio::test]
    async fn rejects_missing_host_but_leaves_invalid_host_for_the_route_wrapper() {
        LocalSet::new()
            .run_until(async {
                let (addr, calls, shutdown) = server().await;
                for (version, host, status) in [
                    ("1.1", "", 400),
                    ("1.1", "Host:\r\n", 200),
                    ("1.1", "Host: a b\r\n", 200),
                    ("1.0", "", 200),
                ] {
                    let response = exchange(
                        addr,
                        format!("GET / HTTP/{version}\r\n{host}Connection: close\r\n\r\n"),
                    )
                    .await;
                    assert_eq!(
                        response.split_ascii_whitespace().nth(1),
                        Some(status.to_string().as_str()),
                        "{response}"
                    );
                }
                assert_eq!(calls.get(), 3);
                shutdown.cancel();
            })
            .await;
    }

    #[test]
    fn rounds_the_idle_timeout_like_bun() {
        for (configured, effective) in [(0, 0), (1, 4), (2, 4), (4, 4), (5, 8), (120, 120)] {
            assert_eq!(
                rounded_idle_timeout(configured),
                Duration::from_secs(effective)
            );
        }
    }

    #[tokio::test]
    async fn the_idle_clock_starts_at_dispatch_and_can_be_disabled_by_a_handler() {
        LocalSet::new()
            .run_until(async {
                let mut listener = Listener::bind("0.0.0.0", 0, 64, 1).await.unwrap();
                let addr =
                    SocketAddr::from(([127, 0, 0, 1], listener.local_addr().unwrap().port()));
                listener.idle_timeout = Duration::from_millis(160);
                let shutdown = CancellationToken::new();
                tokio::task::spawn_local(listener.serve(
                    |request, _| async move {
                        let path = request.uri().path();
                        if path == "/disable" {
                            request.body().disable_idle_timeout();
                        }
                        if path == "/wait" || path == "/disable" {
                            tokio::time::sleep(Duration::from_millis(260)).await;
                        }
                        Response::new(Full::new(Bytes::from_static(b"ok")))
                    },
                    shutdown.clone(),
                ));
                let mut stream = TcpStream::connect(addr).await.unwrap();
                stream.write_all(b"GET /").await.unwrap();
                tokio::time::sleep(Duration::from_millis(260)).await;
                stream
                    .write_all(b" HTTP/1.1\r\nHost: localhost\r\n\r\n")
                    .await
                    .unwrap();
                let mut response = String::new();
                tokio::time::timeout(Duration::from_secs(3), stream.read_to_string(&mut response))
                    .await
                    .unwrap()
                    .unwrap();
                assert!(response.starts_with("HTTP/1.1 200 "), "{response}");
                let response =
                    exchange(addr, "GET /wait HTTP/1.1\r\nHost: localhost\r\n\r\n").await;
                assert!(response.is_empty(), "{response}");
                let response =
                    exchange(addr, "GET /disable HTTP/1.1\r\nHost: localhost\r\n\r\n").await;
                assert!(response.starts_with("HTTP/1.1 200 "), "{response}");
                shutdown.cancel();
            })
            .await;
    }

    #[tokio::test]
    async fn uses_buns_wire_framing_for_range_responses() {
        LocalSet::new()
            .run_until(async {
                let listener = Listener::bind("0.0.0.0", 0, 64, 0).await.unwrap();
                let addr = SocketAddr::from(([127, 0, 0, 1], listener.local_addr().unwrap().port()));
                let shutdown = CancellationToken::new();
                tokio::task::spawn_local(listener.serve(
                    |request, _| async move {
                        let response = Response::builder()
                            .header("content-length", "4096")
                            .body(Some(Bytes::from(vec![b'a'; 4096])))
                            .unwrap();
                        crate::compression::finish_native(request.method(), request.headers(), response, true)
                            .await
                            .unwrap()
                            .map(|body| Full::new(body.unwrap_or_default()))
                    },
                    shutdown.clone(),
                ));
                for (method, range, status, length) in [
                    ("GET", "bytes=0-254", "206", Some("255")),
                    ("GET", "bytes=0-255", "206", None),
                    ("GET", "bytes=9-2", "200", None),
                    ("HEAD", "bytes=0-254", "200", None),
                    ("GET", "bytes=4096-", "416", Some("0")),
                ] {
                    let response = exchange(
                        addr,
                        format!("{method} / HTTP/1.1\r\nHost: localhost\r\nRange: {range}\r\nConnection: close\r\n\r\n"),
                    )
                    .await;
                    let head = response.split("\r\n\r\n").next().unwrap();
                    assert_eq!(head.split_ascii_whitespace().nth(1), Some(status), "{head}");
                    assert_eq!(
                        head.split("\r\n").find_map(|line| line.strip_prefix("content-length: ")),
                        length,
                        "{method} {range}: {head}"
                    );
                }
                shutdown.cancel();
            })
            .await;
    }

    #[tokio::test]
    async fn rejects_an_oversized_request_head_before_dispatching() {
        LocalSet::new()
            .run_until(async {
                let (addr, calls, shutdown) = server().await;
                for (prefix, suffix) in [
                    (
                        "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nX-Long: ",
                        "\r\n\r\n",
                    ),
                    (
                        "GET /",
                        " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
                    ),
                ] {
                    for (head_bytes, status) in [(16_384, 200), (16_385, 431), (32_768, 431)] {
                        let request = format!(
                            "{prefix}{}{suffix}",
                            "a".repeat(head_bytes - prefix.len() - suffix.len())
                        );
                        let response = exchange(addr, request).await;
                        assert!(
                            response.starts_with(&format!("HTTP/1.1 {status} ")),
                            "{head_bytes} bytes: {response}"
                        );
                        if status == 431 {
                            assert!(response.ends_with("\r\n\r\n"), "{response}");
                            let headers = response.to_ascii_lowercase();
                            assert!(headers.contains("\r\nconnection: close\r\n"), "{response}");
                            // Hyper's empty parser error uses explicit zero-length framing.
                            assert!(headers.contains("\r\ncontent-length: 0\r\n"), "{response}");
                        }
                    }
                }
                assert_eq!(calls.get(), 2);
                shutdown.cancel();
            })
            .await;
    }

    #[tokio::test]
    async fn counts_header_fields_including_host_and_connection() {
        LocalSet::new()
            .run_until(async {
                let (addr, calls, shutdown) = server().await;
                for (extra_headers, status) in [(196, 200), (197, 431)] {
                    let mut request =
                        "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n".to_owned();
                    for index in 0..extra_headers {
                        request.push_str(&format!("X-Test-{index}: present\r\n"));
                    }
                    request.push_str("\r\n");
                    let response = exchange(addr, request).await;
                    assert!(
                        response.starts_with(&format!("HTTP/1.1 {status} ")),
                        "{response}"
                    );
                    if status == 431 {
                        let headers = response.to_ascii_lowercase();
                        assert!(headers.contains("\r\nconnection: close\r\n"), "{response}");
                        assert!(headers.contains("\r\ncontent-length: 0\r\n"), "{response}");
                    }
                }
                assert_eq!(calls.get(), 1);
                shutdown.cancel();
            })
            .await;
    }

    #[tokio::test]
    async fn limits_fixed_length_and_chunked_request_bodies() {
        LocalSet::new().run_until(async {
            let (addr, calls, shutdown) = server().await;
            for (size, status) in [(64, 200), (65, 413)] {
                let body = "x".repeat(size);
                let request = format!("POST / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {size}\r\n\r\n{body}");
                let response = exchange(addr, request).await;
                assert!(response.starts_with(&format!("HTTP/1.1 {status} ")), "{response}");
            }
            assert_eq!(calls.get(), 1, "the declared oversized body is rejected before dispatch");
            for (size, status) in [(64, 200), (65, 413)] {
                let body = "x".repeat(size);
                let request = format!(
                    "POST / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n40\r\n{}\r\n{}0\r\n\r\n",
                    &body[..64],
                    if size > 64 { "1\r\nx\r\n" } else { "" },
                );
                let response = exchange(addr, request).await;
                assert!(response.starts_with(&format!("HTTP/1.1 {status} ")), "{response}");
            }
            assert_eq!(calls.get(), 3, "the handler encounters the oversized chunked body during its read");
            shutdown.cancel();
        }).await;
    }
}
