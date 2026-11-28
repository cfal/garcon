//! Ports `server/remote/server/cli-gateway.ts`.

use std::cell::{Cell, RefCell};
use std::convert::Infallible;
use std::error::Error;
use std::io;
use std::net::Ipv4Addr;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use garcon_base::domain_error::{DomainError, as_domain_error};
use garcon_base::executor_disconnect::ExecutorSessionLostError;
use garcon_base::http_body::fetch_header_value;
use garcon_base::http_error::{JsonErrorResponseError, json_error};
use garcon_base::runtime_proof::runtime_proof_response;
use garcon_base::server_runtime::{
    ServerRuntimeState, create_server_runtime_state, publish_runtime_descriptor,
    remove_server_runtime,
};
use garcon_contract::cli_runtime_paths::cli_gateway_runtime_file;
use garcon_contract::error_codes::ErrorCode;
use garcon_contract::server_runtime::{
    CLI_SERVER_INSTANCE_HEADER, CliGatewayDescriptor, CliGatewayKind, CliRuntimeDescriptor,
    RuntimeEndpoint, parse_cli_context,
};
use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{
    SystemClock,
    json::{self, Opaque},
    trim,
};
use garcon_link::cli_admission::{CliAdmission, CliAdmissionLease};
use garcon_link::cli_protocol::{
    CliPool, CliRoute, cli_policy, cli_request_bytes, cli_request_too_large, cli_route,
    parse_cli_http_response, parse_controller_cli_request,
};
use garcon_link::message_session::SessionError;
use garcon_link::rpc::{ExecutorRpc, RpcCallOptions, RpcTimeout};
use garcon_link::rpc_connection::ExecutorRpcConnection;
use garcon_link::rpc_lane::RpcLane;
use http_body_util::BodyExt;
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Serialize;
use subtle::ConstantTimeEq;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{Instant, sleep, sleep_until, timeout, timeout_at};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::executor_rpc_server::{not_dispatched, shared_error};

const SOCKET_LIMIT: usize = 32;
const RESPONSE_LIMIT: usize = 16;
const BULK_RESPONSE_LIMIT: usize = 12;
const HEADER_LIMIT: usize = 32 * 1024;
const CHUNK_BYTES: usize = 64 * 1024;
const HTTP_IDLE: Duration = Duration::from_secs(30);
const REJECTED_IDLE: Duration = Duration::from_secs(1);
const HTTP_TIMEOUTS: HttpTimeouts = HttpTimeouts {
    head: Duration::from_secs(10),
    request: Duration::from_secs(30),
};

struct HttpTimeouts {
    head: Duration,
    request: Duration,
}

type CurrentConnection = dyn Fn() -> Option<Rc<ExecutorRpcConnection>>;
type GatewayResult<T> = Result<T, SessionError>;

pub(crate) struct CliGateway {
    runtime_file: String,
    descriptor: CliGatewayDescriptor,
    stop: CancellationToken,
    task: RefCell<Option<JoinHandle<()>>>,
}

impl CliGateway {
    pub(crate) async fn start(
        data_dir: &str,
        current_connection: Rc<CurrentConnection>,
    ) -> ExecutorResult<Self> {
        let runtime = create_server_runtime_state(data_dir, &SystemClock)?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let runtime_file = cli_gateway_runtime_file(data_dir);
        let descriptor = CliGatewayDescriptor {
            endpoint: RuntimeEndpoint {
                schema_version: runtime.identity.schema_version,
                instance_id: runtime.identity.instance_id.clone(),
                started_at: runtime.identity.started_at.clone(),
                pid: u64::from(std::process::id()),
                base_url: format!("http://{}", listener.local_addr()?),
                local_capability: runtime.local_capability.clone(),
            },
            kind: CliGatewayKind::ExecutorCli,
        };
        let mut dirs = tokio::fs::DirBuilder::new();
        dirs.recursive(true);
        #[cfg(unix)]
        dirs.mode(0o700);
        dirs.create(data_dir).await?;
        if let Err(error) = publish_runtime_descriptor(
            &runtime_file,
            &CliRuntimeDescriptor::ExecutorCli(descriptor.clone()),
        )
        .await
        {
            drop(listener);
            let _ = remove_server_runtime(&runtime_file, &descriptor.endpoint.instance_id).await;
            return Err(error.into());
        }
        let stop = CancellationToken::new();
        let state = Rc::new(Gateway {
            runtime,
            current_connection,
            stop: stop.clone(),
            admission: CliAdmission::default(),
            responses: Rc::default(),
        });
        let task = tokio::task::spawn_local(accept_connections(listener, state));
        Ok(Self {
            runtime_file,
            descriptor,
            stop,
            task: RefCell::new(Some(task)),
        })
    }

    pub(crate) async fn dispose(&self) -> ExecutorResult<()> {
        if self.stop.is_cancelled() {
            return Ok(());
        }
        self.stop.cancel();
        let task = self.task.take();
        let stopped = match task {
            Some(task) => task.await.map_err(Box::<dyn Error>::from),
            None => Ok(()),
        };
        let removed =
            remove_server_runtime(&self.runtime_file, &self.descriptor.endpoint.instance_id).await;
        stopped?;
        removed?;
        Ok(())
    }
}

impl Drop for CliGateway {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

struct Gateway {
    runtime: ServerRuntimeState,
    current_connection: Rc<CurrentConnection>,
    stop: CancellationToken,
    admission: CliAdmission,
    responses: Rc<HttpAdmission>,
}

impl Gateway {
    async fn dispatch(
        &self,
        request: Request<Incoming>,
        socket: &Exchange,
        abort: &CancellationToken,
    ) -> GatewayResult<Response<Bytes>> {
        let url = Url::parse("http://127.0.0.1")
            .and_then(|base| base.join(&request.uri().to_string()))
            .map_err(shared_error)?;
        let method = request.method();
        if method == Method::GET && url.path() == "/api/v1/runtime" {
            socket.reserve(&self.responses, RpcLane::Primary)?;
            return runtime_proof_response(&self.runtime, &url).map_err(shared_error);
        }
        let authorization =
            first_header(request.headers(), header::AUTHORIZATION).unwrap_or_default();
        let token = authorization.strip_prefix("Bearer ").unwrap_or_default();
        let capability = self.runtime.local_capability.as_bytes();
        if token.len() != capability.len()
            || !bool::from(token.as_bytes().ct_eq(capability))
            || request.headers().contains_key(header::ORIGIN)
        {
            return Err(reject(
                ErrorCode::CLI_ACCESS_DENIED,
                "A local CLI gateway capability is required",
                403,
                false,
            ));
        }
        let connection = self
            .live_connection()
            .ok_or_else(|| not_dispatched("Controller is disconnected"))?;
        let instance_header =
            HeaderName::from_bytes(CLI_SERVER_INSTANCE_HEADER.as_bytes()).map_err(shared_error)?;
        let expected = fetch_header_value(request.headers(), &instance_header);
        if method == Method::GET && url.path() == "/api/v1/cli/context" {
            socket.reserve(&self.responses, RpcLane::Primary)?;
            let _lease = self.admit(CliPool::Short, RpcLane::Primary)?;
            let context = connection
                .primary
                .call(
                    "",
                    "controllerCli.describe",
                    Opaque::from_value(serde_json::Value::Null),
                    rpc_options(abort, Some(5_000)),
                )
                .await?;
            let context = context.ok_or_else(unconfirmed)?;
            let context = parse_cli_context(&context).map_err(shared_error)?;
            if context.default_executor_id != connection.primary.transport.executor_id {
                return Err(unconfirmed());
            }
            if expected.is_some_and(|expected| context.server_instance_id != expected) {
                return Err(reject(
                    ErrorCode::CLI_CONTROLLER_CHANGED,
                    "Garcon restarted; start a new CLI invocation",
                    409,
                    false,
                ));
            }
            return json_response(StatusCode::OK, &context);
        }
        let route = cli_route(method.as_str(), url.path()).map_err(shared_error)?;
        let lane = route.operation.policy().lane;
        socket.reserve(&self.responses, lane)?;
        let expected = expected.ok_or_else(|| {
            reject(
                ErrorCode::VALIDATION_FAILED,
                "Expected controller instance is required",
                400,
                false,
            )
        })?;
        let body = match timeout_at(socket.request_deadline, read_body(request, lane)).await {
            Ok(result) => result?,
            Err(_) => {
                let mut response = Response::new(Bytes::new());
                *response.status_mut() = StatusCode::REQUEST_TIMEOUT;
                return Ok(response);
            }
        };
        let envelope = request_envelope(&expected, route, &url, body)?;
        let call = parse_controller_cli_request(&envelope).map_err(shared_error)?;
        let policy = cli_policy(call.http.operation, &call.http.body);
        let _lease = self.admit(policy.pool, lane)?;
        // The captured RPC deadlines, not the HTTP idle clock, govern controller work.
        socket.set_idle(None);
        let (rpc, timeout) = connection
            .acquire(lane, abort.clone(), policy.timeout_ms)
            .await?;
        if !self.owns(&connection, &rpc) {
            return Err(not_dispatched(
                "The captured executor connection is unavailable",
            ));
        }
        let result = rpc
            .call(
                "",
                "controllerCli.request",
                envelope,
                rpc_options(abort, timeout),
            )
            .await?;
        let result = result.ok_or_else(unconfirmed)?;
        let result = parse_cli_http_response(&result).map_err(shared_error)?;
        let status = StatusCode::from_u16(result.status).map_err(shared_error)?;
        let mut response = json_response(status, &result.body)?;
        if let Some(retry_after) = result.retry_after {
            response.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from_str(&retry_after).map_err(shared_error)?,
            );
        }
        Ok(response)
    }

    fn live_connection(&self) -> Option<Rc<ExecutorRpcConnection>> {
        if self.stop.is_cancelled() {
            return None;
        }
        (self.current_connection)().filter(|connection| connection.primary.transport.connected())
    }

    fn owns(&self, connection: &Rc<ExecutorRpcConnection>, rpc: &Rc<ExecutorRpc>) -> bool {
        connection.owns(rpc)
            && rpc.active()
            && self
                .live_connection()
                .is_some_and(|current| Rc::ptr_eq(&current, connection))
    }

    fn admit(&self, pool: CliPool, lane: RpcLane) -> GatewayResult<CallLease> {
        self.admission
            .acquire("gateway", pool, lane)
            .map(CallLease)
            .map_err(shared_error)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<'a> {
    expected_server_instance_id: &'a str,
    http: HttpCall,
}

#[derive(Serialize)]
struct HttpCall {
    #[serde(flatten)]
    route: CliRoute,
    query: Vec<[String; 2]>,
    body: Opaque,
}

fn request_envelope(
    expected: &str,
    route: CliRoute,
    url: &Url,
    body: Opaque,
) -> GatewayResult<Opaque> {
    let value = Envelope {
        expected_server_instance_id: expected,
        http: HttpCall {
            route,
            query: url
                .query_pairs()
                .map(|(key, value)| [key.into_owned(), value.into_owned()])
                .collect(),
            body,
        },
    };
    let bytes = serde_json::to_vec(&value).map_err(shared_error)?;
    json::from_slice(&bytes).map_err(shared_error)
}

fn rpc_options(abort: &CancellationToken, timeout: Option<u64>) -> RpcCallOptions {
    RpcCallOptions {
        signal: Some(abort.clone()),
        timeout: timeout.map_or(RpcTimeout::None, RpcTimeout::Milliseconds),
        ..Default::default()
    }
}

// Node's IncomingMessage keeps the first value of singleton headers.
fn first_header(headers: &HeaderMap, name: HeaderName) -> Option<String> {
    Some(
        headers
            .get(name)?
            .as_bytes()
            .trim_ascii()
            .iter()
            .copied()
            .map(char::from)
            .collect(),
    )
}

async fn read_body(request: Request<Incoming>, lane: RpcLane) -> GatewayResult<Opaque> {
    let limit = cli_request_bytes(lane);
    let length = fetch_header_value(request.headers(), &header::CONTENT_LENGTH);
    if length
        .as_deref()
        .and_then(|size| size.parse::<u64>().ok())
        .is_some_and(|size| size > limit as u64)
    {
        return Err(shared_error(cli_request_too_large(lane)));
    }
    if !request.headers().contains_key(header::TRANSFER_ENCODING)
        && length.as_deref().is_none_or(|length| length == "0")
    {
        return Ok(Opaque::from_value(serde_json::Value::Null));
    }
    let content_type = first_header(request.headers(), header::CONTENT_TYPE);
    let mut incoming = request.into_body();
    let mut bytes = Vec::new();
    while let Some(frame) = incoming.frame().await {
        let frame = frame.map_err(|error| {
            if error.is_incomplete_message() {
                reject(
                    ErrorCode::CLI_CONTROLLER_UNAVAILABLE,
                    "CLI upload aborted before dispatch",
                    503,
                    true,
                )
            } else {
                shared_error(error)
            }
        })?;
        if let Ok(chunk) = frame.into_data() {
            if chunk.len() > limit - bytes.len() {
                return Err(shared_error(cli_request_too_large(lane)));
            }
            bytes.extend_from_slice(&chunk);
        }
    }
    if bytes.is_empty() {
        return Ok(Opaque::from_value(serde_json::Value::Null));
    }
    if !content_type
        .as_deref()
        .and_then(|kind| kind.split(';').next())
        .is_some_and(|kind| trim(kind).eq_ignore_ascii_case("application/json"))
    {
        return Err(reject(
            ErrorCode::VALIDATION_FAILED,
            "CLI requests require application/json",
            415,
            false,
        ));
    }
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    json::from_slice(bytes)
        .map_err(|_| reject(ErrorCode::VALIDATION_FAILED, "Malformed JSON", 400, false))
}

fn reject(code: ErrorCode, message: &'static str, status: u16, retryable: bool) -> SessionError {
    shared_error(DomainError::new(code, message, status, retryable))
}

fn unconfirmed() -> SessionError {
    reject(
        ErrorCode::CLI_OUTCOME_UNKNOWN,
        "The CLI request may have reached Garcon; its outcome could not be confirmed",
        503,
        false,
    )
}

fn gateway_error(error: &(dyn Error + 'static)) -> Result<Response<Bytes>, JsonErrorResponseError> {
    if let Some(error) = as_domain_error(error) {
        let mut response = domain_response(error)?;
        if error.code == ErrorCode::CLI_SERVICE_BUSY {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
        }
        return Ok(response);
    }
    let outcome = error
        .downcast_ref::<AgentCallError>()
        .map(|error| error.outcome)
        .or_else(|| {
            error
                .downcast_ref::<ExecutorSessionLostError>()
                .map(|error| error.outcome)
        });
    let error = if outcome == Some(AgentDeliveryOutcome::NotDispatched) {
        DomainError::new(
            ErrorCode::CLI_CONTROLLER_UNAVAILABLE,
            "The executor controller is unavailable",
            503,
            true,
        )
    } else {
        DomainError::new(
            ErrorCode::CLI_OUTCOME_UNKNOWN,
            "The CLI request may have reached Garcon; its outcome could not be confirmed",
            503,
            false,
        )
    };
    domain_response(&error)
}

fn domain_response(error: &DomainError) -> Result<Response<Bytes>, JsonErrorResponseError> {
    json_error(
        &error.message,
        f64::from(error.status),
        Some(error.code.as_str()),
        Some(error.retryable),
        None,
    )
}

fn json_response(status: StatusCode, value: &impl Serialize) -> GatewayResult<Response<Bytes>> {
    let mut response = Response::new(Bytes::from(
        serde_json::to_vec(value).map_err(shared_error)?,
    ));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json;charset=utf-8"),
    );
    Ok(response)
}

struct CallLease(CliAdmissionLease);

impl Drop for CallLease {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[derive(Default)]
struct HttpAdmission {
    total: Cell<usize>,
    bulk: Cell<usize>,
}

struct HttpLease {
    admission: Rc<HttpAdmission>,
    lane: RpcLane,
}

impl Drop for HttpLease {
    fn drop(&mut self) {
        self.admission.total.update(|count| count - 1);
        if self.lane == RpcLane::Bulk {
            self.admission.bulk.update(|count| count - 1);
        }
    }
}

struct Exchange {
    lease: RefCell<Option<HttpLease>>,
    request_deadline: Instant,
    idle: Cell<Option<Duration>>,
    deadline: Cell<Option<Instant>>,
    changed: Notify,
}

impl Exchange {
    fn new(request_timeout: Duration) -> Self {
        Self {
            lease: RefCell::default(),
            request_deadline: Instant::now() + request_timeout,
            idle: Cell::new(Some(HTTP_IDLE)),
            deadline: Cell::new(Some(Instant::now() + HTTP_IDLE)),
            changed: Notify::new(),
        }
    }

    fn reserve(&self, admission: &Rc<HttpAdmission>, lane: RpcLane) -> GatewayResult<()> {
        if admission.total.get() >= RESPONSE_LIMIT
            || lane == RpcLane::Bulk && admission.bulk.get() >= BULK_RESPONSE_LIMIT
        {
            return Err(reject(
                ErrorCode::CLI_SERVICE_BUSY,
                "CLI HTTP response budget exhausted",
                503,
                true,
            ));
        }
        admission.total.update(|count| count + 1);
        if lane == RpcLane::Bulk {
            admission.bulk.update(|count| count + 1);
        }
        self.lease.replace(Some(HttpLease {
            admission: Rc::clone(admission),
            lane,
        }));
        Ok(())
    }

    fn set_idle(&self, timeout: Option<Duration>) {
        self.idle.set(timeout);
        self.deadline
            .set(timeout.map(|timeout| Instant::now() + timeout));
        self.changed.notify_one();
    }

    fn progress(&self) {
        if let Some(idle) = self.idle.get() {
            self.set_idle(Some(idle));
        }
    }

    async fn idle_expired(&self) {
        loop {
            if let Some(deadline) = self.deadline.get() {
                tokio::select! {
                    biased;
                    () = self.changed.notified() => {},
                    () = sleep_until(deadline) => return,
                }
            } else {
                self.changed.notified().await;
            }
        }
    }
}

struct IdleIo<I> {
    stream: I,
    socket: Rc<Exchange>,
}

impl<I: AsyncRead + Unpin> AsyncRead for IdleIo<I> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let old = buffer.filled().len();
        let result = Pin::new(&mut self.stream).poll_read(cx, buffer);
        if matches!(result, Poll::Ready(Ok(()))) && buffer.filled().len() > old {
            self.socket.progress();
        }
        result
    }
}

impl<I: AsyncWrite + Unpin> AsyncWrite for IdleIo<I> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.stream).poll_write(cx, bytes);
        if matches!(result, Poll::Ready(Ok(written)) if written > 0) {
            self.socket.progress();
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

struct DrainBody(Bytes);

impl Body for DrainBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        let size = self.0.len().min(CHUNK_BYTES);
        Poll::Ready((size > 0).then(|| Ok(Frame::data(self.0.split_to(size)))))
    }

    fn is_end_stream(&self) -> bool {
        self.0.is_empty()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.0.len() as u64)
    }
}

async fn accept_connections(listener: TcpListener, gateway: Rc<Gateway>) {
    let mut sockets = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            () = gateway.stop.cancelled() => break,
            _ = sockets.join_next(), if !sockets.is_empty() => {},
            incoming = listener.accept() => match incoming {
                Ok((stream, _)) if sockets.len() < SOCKET_LIMIT => {
                    sockets.spawn_local(serve_socket(stream, Rc::clone(&gateway)));
                }
                Ok(_) => {},
                Err(_) => sleep(Duration::from_millis(100)).await,
            },
        }
    }
    sockets.shutdown().await;
}

async fn serve_socket(stream: TcpStream, gateway: Rc<Gateway>) {
    let _ = stream.set_nodelay(true);
    serve_http(stream, gateway, HTTP_TIMEOUTS).await;
}

async fn serve_http(
    stream: impl AsyncRead + AsyncWrite + Unpin,
    gateway: Rc<Gateway>,
    deadlines: HttpTimeouts,
) {
    let socket = Rc::new(Exchange::new(deadlines.request));
    let abort = CancellationToken::new();
    let _abort_on_close = abort.clone().drop_guard();
    let mut io = IdleIo {
        stream,
        socket: Rc::clone(&socket),
    };
    let service = service_fn({
        let socket = Rc::clone(&socket);
        move |request| {
            let (abort, gateway, socket) = (abort.clone(), Rc::clone(&gateway), Rc::clone(&socket));
            async move {
                let mut response = match gateway.dispatch(request, &socket, &abort).await {
                    Ok(response) => response,
                    Err(error) => gateway_error(error.as_ref())?,
                };
                response
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                response
                    .headers_mut()
                    .insert(header::CONNECTION, HeaderValue::from_static("close"));
                socket.set_idle(Some(if socket.lease.borrow().is_some() {
                    HTTP_IDLE
                } else {
                    REJECTED_IDLE
                }));
                Ok::<_, JsonErrorResponseError>(response.map(DrainBody))
            }
        }
    });
    // One response per socket keeps its admission until Hyper has drained it or the socket closes.
    let connection = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(deadlines.head)
        .max_buf_size(HEADER_LIMIT)
        .max_header_size(HEADER_LIMIT)
        .max_headers(HEADER_LIMIT / 4)
        .keep_alive(false)
        .serve_connection(TokioIo::new(&mut io), service);
    let result = tokio::select! {
        biased;
        result = connection => result,
        () = socket.idle_expired() => return,
    };
    if result.is_err_and(|error| error.is_timeout()) {
        // Hyper closes on a header timeout without writing Node's response.
        let _ = timeout(
            REJECTED_IDLE,
            io.write_all(b"HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n"),
        )
        .await;
    }
}

#[cfg(test)]
mod tests;
