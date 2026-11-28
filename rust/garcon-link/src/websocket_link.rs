//! Ports `server/remote/transport/websocket-link.ts`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::convert::Infallible;
use std::fmt::Write;
use std::future::{Future, pending};
use std::rc::{Rc, Weak};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::Bytes;
use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::Shared;
use garcon_js::json::{Opaque, parse, stringify};
use garcon_js::utf16;
use hmac::{Hmac, Mac};
use http_body_util::Full;
use hyper::{
    Request, Response, StatusCode, body::Incoming, server::conn::http1, service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use rand_core::{OsRng, RngCore};
use rustls_pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, spawn_local};
use tokio::time::{Instant, MissedTickBehavior, interval_at, sleep_until, timeout};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::handshake::server::create_response_with_body;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::connection_url::is_executor_secret;
use crate::failure_reason::{Failure, failure_reason};
use crate::link_handshake::{LinkDialTarget, LinkHello, LinkRole, parse_link_hello};
use crate::message_queue_budget::{MessageQueueBudget, MessageQueueSnapshot};
use crate::message_session::{MessageContinuityError, MessageSessionAttachment, SessionError};
use crate::noise_ws::{
    NoiseClientOptions, NoiseConnection, NoiseErrorCode, NoiseLimits, NoiseMessage, NoiseOptions,
    NoiseReadyState, NoiseServer, NoiseServerOptions, PendingNoiseConnection, UpgradeFailure,
    connect_noise_web_socket, create_noise_server,
};
use crate::rpc_lane::{RpcLane, is_session_id};
use crate::rpc_protocol::EXECUTOR_PROTOCOL_REVISION;
use crate::session_socket::{SESSION_SOCKET_BUFFER_BYTES, SessionSocketFrames};
use crate::session_transport::{Listeners, SessionTransport, SessionTransportOptions};
use crate::socket_admission::{ExecutorSocketAdmission, SocketAdmissionLease};

pub const EXECUTOR_NOISE_CONTEXT: &str = "garcon-executor/v1";
pub const REDIAL_DELAYS_MS: &[u64] = &[0, 5000, 5000, 10000, 10000, 10000, 10000, 10000, 30000];
const LISTENER_STOP_SETTLE_MS: u64 = 25;
const LISTENER_HTTP_IDLE: Duration = Duration::from_secs(10);
const STABLE_SESSION_MS: u64 = 10_000;
const MAX_SOCKETS: usize = 4;

static LINK_VERSION: LazyLock<String> = LazyLock::new(|| {
    // INFALLIBLE: the release manifest is part of the build.
    let manifest =
        parse(include_str!("../../../package.json")).expect("the release manifest is JSON");
    // INFALLIBLE: the workspace package always declares its version.
    let version = manifest["version"]
        .as_str()
        .expect("the release manifest has a version");
    format!("{version}+protocol.{EXECUTOR_PROTOCOL_REVISION}")
});

pub struct WebSocketLinkOptions {
    pub role: LinkRole,
    pub executor_id: Option<String>,
    pub secret: String,
    pub runtime_id: Option<String>,
    pub no_tls: bool,
    pub allow_unverified_tls: bool,
    pub max_queued_bytes: Option<usize>,
    pub max_queued_frames: Option<usize>,
    pub redial_delays_ms: Option<Vec<u64>>,
    pub stable_session_ms: Option<u64>,
    pub noise_limits: Option<NoiseLimits>,
    pub socket_admission: Option<Rc<ExecutorSocketAdmission>>,
    pub new_id: Option<Rc<dyn Fn() -> String>>,
}

pub struct ExecutorListenerTls {
    pub cert: Vec<u8>,
    pub key: Vec<u8>,
}

struct Listener {
    stop: CancellationToken,
    noise: Rc<NoiseServer>,
    task: JoinHandle<()>,
}

struct StartingListener<'a>(&'a RefCell<State>);

impl Drop for StartingListener<'_> {
    fn drop(&mut self) {
        self.0.borrow_mut().starting_listener = false;
    }
}

impl WebSocketLinkOptions {
    pub fn new(role: LinkRole, secret: String) -> Self {
        Self {
            role,
            secret,
            executor_id: None,
            runtime_id: None,
            no_tls: false,
            allow_unverified_tls: false,
            max_queued_bytes: None,
            max_queued_frames: None,
            redial_delays_ms: None,
            stable_session_ms: None,
            noise_limits: None,
            socket_admission: None,
            new_id: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkClosureCause {
    LivenessTimeout,
    SocketClosed,
    SocketError,
    ProtocolError,
    RecordLimit,
    SessionRetired,
    LocalClose,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkClosure {
    pub lane: RpcLane,
    pub session_id: String,
    pub primary_session_id: String,
    pub cause: LinkClosureCause,
    pub queues: Option<MessageQueueSnapshot>,
    pub primary_redials: usize,
    pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkFailure {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane: Option<RpcLane>,
    pub message: String,
    pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub fn should_log_link_failure(failure: &LinkFailure) -> bool {
    failure.count.is_power_of_two()
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct LinkError(pub &'static str);

struct Hello {
    parsed: LinkHello,
    raw: Opaque,
}

struct Connection {
    socket: Rc<NoiseConnection>,
    state: RefCell<ConnectionState>,
}

struct ConnectionState {
    hello: Option<Hello>,
    peer: Option<Hello>,
    timeout: Option<JoinHandle<()>>,
    session: Option<Rc<SessionTransport>>,
    hooks: Option<Rc<MessageSessionAttachment>>,
    heartbeat: Option<JoinHandle<()>>,
    last_received_at: Instant,
    closed: bool,
    authenticated: bool,
    frames: Option<Rc<SessionSocketFrames>>,
    close_cause: Option<LinkClosureCause>,
    close_reason: Option<String>,
    session_started_at: Option<Instant>,
}

struct Socket {
    socket: Rc<NoiseConnection>,
    lease: Option<SocketAdmissionLease>,
}

struct BulkGrant {
    primary: Rc<SessionTransport>,
    id: String,
}

#[derive(Default)]
struct State {
    sockets: Vec<Socket>,
    connections: Vec<Rc<Connection>>,
    current: Option<Rc<SessionTransport>>,
    bulk: Option<Rc<SessionTransport>>,
    bulk_grant: Option<BulkGrant>,
    bulk_dial: Option<Rc<NoiseConnection>>,
    dial_url: Option<String>,
    disposed: bool,
    quiescing: bool,
    dial_timer: Option<JoinHandle<()>>,
    starting_listener: bool,
    listener: Option<Listener>,
    dialing: bool,
    redials: usize,
    failures: HashMap<(Option<RpcLane>, &'static str), LinkFailure>,
    closure_counts: HashMap<(RpcLane, LinkClosureCause), usize>,
}

type SessionListener = dyn Fn(Rc<SessionTransport>) -> Result<(), SessionError>;
type FailureListener = dyn Fn(&LinkFailure);
type ClosureListener = dyn Fn(&LinkClosure);
type QuiesceListener = dyn Fn();
type Ready = Result<Rc<SessionTransport>, SessionError>;

pub struct WebSocketLink {
    pub runtime_id: String,
    options: WebSocketLinkOptions,
    new_id: Rc<dyn Fn() -> String>,
    ready: Shared<oneshot::Receiver<Ready>>,
    ready_sender: RefCell<Option<oneshot::Sender<Ready>>>,
    sessions: Rc<Listeners<SessionListener>>,
    bulk_sessions: Rc<Listeners<SessionListener>>,
    quiesce_listeners: Rc<Listeners<QuiesceListener>>,
    errors: Rc<Listeners<FailureListener>>,
    closures: Rc<Listeners<ClosureListener>>,
    queue_budget: Rc<MessageQueueBudget>,
    state: RefCell<State>,
}

impl WebSocketLink {
    pub fn new(options: WebSocketLinkOptions) -> Result<Rc<Self>, LinkError> {
        if !is_executor_secret(&Value::String(options.secret.clone())) {
            return Err(LinkError(
                "Executor shared secret must be a canonical base64url 32-byte key",
            ));
        }
        if options.role == LinkRole::Controller
            && options.executor_id.as_ref().is_none_or(String::is_empty)
        {
            return Err(LinkError("Controller executor ID is required"));
        }
        if options.redial_delays_ms.as_ref().is_some_and(|delays| {
            delays.is_empty() || delays.iter().any(|delay| *delay > (1 << 53) - 1)
        }) {
            return Err(LinkError(
                "Executor redial delays must be non-negative integers",
            ));
        }
        let new_id = options
            .new_id
            .clone()
            .unwrap_or_else(|| Rc::new(|| uuid::Uuid::new_v4().to_string()));
        let runtime_id = options.runtime_id.clone().unwrap_or_else(|| new_id());
        let (sender, receiver) = oneshot::channel();
        Ok(Rc::new(Self {
            runtime_id,
            options,
            new_id,
            ready: receiver.shared(),
            ready_sender: RefCell::new(Some(sender)),
            sessions: Listeners::new(),
            bulk_sessions: Listeners::new(),
            quiesce_listeners: Listeners::new(),
            errors: Listeners::new(),
            closures: Listeners::new(),
            queue_budget: Rc::default(),
            state: RefCell::default(),
        }))
    }

    pub fn ready(&self) -> impl Future<Output = Ready> + use<> {
        let ready = self.ready.clone();
        async move {
            match ready.await {
                Ok(result) => result,
                Err(_) => pending().await,
            }
        }
    }

    pub fn role(&self) -> LinkRole {
        self.options.role
    }

    pub fn current(&self) -> Option<Rc<SessionTransport>> {
        self.state.borrow().current.clone()
    }

    pub fn bulk(&self) -> Option<Rc<SessionTransport>> {
        self.state.borrow().bulk.clone()
    }

    pub fn is_dialer(&self) -> bool {
        self.state.borrow().dialing
    }

    pub fn quiescing(&self) -> bool {
        let state = self.state.borrow();
        state.quiescing || state.disposed
    }

    pub fn executor_id(&self) -> Option<String> {
        match self.role() {
            LinkRole::Controller => self.options.executor_id.clone(),
            LinkRole::Worker => self.current().map(|session| session.executor_id.clone()),
        }
    }

    pub fn accepts_socket(&self) -> bool {
        let state = self.state.borrow();
        !state.disposed
            && !state.quiescing
            && (state.sockets.len() < MAX_SOCKETS || displaceable_socket(&state).is_some())
    }

    pub fn on_error(&self, listener: Rc<FailureListener>) -> impl Fn() + use<> {
        self.errors.subscribe(listener)
    }

    pub fn on_closure(&self, listener: Rc<ClosureListener>) -> impl Fn() + use<> {
        self.closures.subscribe(listener)
    }

    pub fn on_session(
        &self,
        listener: Rc<SessionListener>,
    ) -> Result<impl Fn() + use<>, SessionError> {
        let unsubscribe = self.sessions.subscribe(Rc::clone(&listener));
        if let Some(session) = self.current() {
            listener(session)?;
        }
        Ok(unsubscribe)
    }

    pub fn on_bulk_session(
        &self,
        listener: Rc<SessionListener>,
    ) -> Result<impl Fn() + use<>, SessionError> {
        let unsubscribe = self.bulk_sessions.subscribe(Rc::clone(&listener));
        if let Some(session) = self.bulk() {
            listener(session)?;
        }
        Ok(unsubscribe)
    }

    pub fn on_quiesce(&self, listener: Rc<QuiesceListener>) -> impl Fn() + use<> {
        self.quiesce_listeners.subscribe(listener)
    }

    pub fn upgrade(
        self: &Rc<Self>,
        noise: &NoiseServer,
        is_websocket_upgrade: bool,
        accept: impl FnOnce(&Rc<NoiseConnection>) -> bool,
    ) -> Result<PendingNoiseConnection, UpgradeFailure> {
        if !self.accepts_socket() {
            return Err(UpgradeFailure::ServiceUnavailable);
        }
        let mut lease = self
            .options
            .socket_admission
            .as_ref()
            .and_then(|admission| admission.acquire());
        if self.options.socket_admission.is_some() && lease.is_none() {
            return Err(UpgradeFailure::ServiceUnavailable);
        }
        let full = self.state.borrow().sockets.len() >= MAX_SOCKETS;
        if full {
            if !is_websocket_upgrade {
                if let Some(lease) = lease {
                    lease.release();
                }
                return Err(UpgradeFailure::BadRequest);
            }
            let displaced = displaceable_socket(&self.state.borrow());
            if let Some(displaced) = displaced {
                displaced.close();
            }
        }
        let admitted = noise.upgrade(self.noise_options(None), |socket| {
            self.track_socket(Rc::clone(socket), lease.take());
            let accepted = accept(socket);
            if !accepted {
                self.forget_socket(socket);
            }
            accepted
        });
        if let Some(lease) = lease {
            lease.release();
        }
        admitted
    }

    fn track_socket(&self, socket: Rc<NoiseConnection>, lease: Option<SocketAdmissionLease>) {
        self.state
            .borrow_mut()
            .sockets
            .push(Socket { socket, lease });
    }

    fn forget_socket(&self, socket: &Rc<NoiseConnection>) {
        let mut state = self.state.borrow_mut();
        if let Some(index) = state
            .sockets
            .iter()
            .position(|tracked| Rc::ptr_eq(&tracked.socket, socket))
            && let Some(lease) = state.sockets.remove(index).lease
        {
            lease.release();
        }
        if state
            .bulk_dial
            .as_ref()
            .is_some_and(|dial| Rc::ptr_eq(dial, socket))
        {
            state.bulk_dial = None;
        }
    }

    pub fn prepare_bulk(
        &self,
        primary: &Rc<SessionTransport>,
        id: String,
    ) -> Result<(), LinkError> {
        if self.quiescing()
            || !self.is_primary(primary)
            || !primary.connected()
            || !is_session_id(&Value::String(id.clone()))
        {
            return Err(LinkError("Bulk parent is unavailable"));
        }
        self.fence_bulk();
        self.state.borrow_mut().bulk_grant = Some(BulkGrant {
            primary: Rc::clone(primary),
            id,
        });
        Ok(())
    }

    fn is_primary(&self, primary: &Rc<SessionTransport>) -> bool {
        self.state
            .borrow()
            .current
            .as_ref()
            .is_some_and(|current| Rc::ptr_eq(current, primary))
    }

    pub fn fence_bulk(&self) {
        let (socket, bulk, connections) = {
            let mut state = self.state.borrow_mut();
            state.bulk_grant = None;
            (
                state.bulk_dial.take(),
                state.bulk.take(),
                state.connections.clone(),
            )
        };
        if let Some(bulk) = bulk {
            bulk.close(None);
        }
        if let Some(socket) = socket {
            socket.close();
        }
        for connection in connections {
            if connection.lane() == Some(RpcLane::Bulk) {
                self.close(&connection, LinkClosureCause::LocalClose, None);
            }
        }
    }

    pub fn dial_bulk(
        self: &Rc<Self>,
        primary: &Rc<SessionTransport>,
        id: &str,
    ) -> Result<(), SessionError> {
        let invalid = || link_error("Bulk dial is not authorized");
        let url = {
            let state = self.state.borrow();
            if state.disposed
                || state.quiescing
                || state.bulk_dial.is_some()
                || state.bulk.is_some()
                || !state
                    .bulk_grant
                    .as_ref()
                    .is_some_and(|grant| Rc::ptr_eq(&grant.primary, primary) && grant.id == id)
            {
                return Err(invalid());
            }
            state.dial_url.clone().ok_or_else(invalid)?
        };
        let socket = self.connect_noise(
            &url,
            LinkDialTarget {
                lane: RpcLane::Bulk,
                session_id: Some(id.to_owned()),
                primary_session_id: Some(primary.id.clone()),
            },
        )?;
        if socket.ready_state() != NoiseReadyState::Closed {
            self.state.borrow_mut().bulk_dial = Some(Rc::clone(&socket));
            self.track_socket(socket, None);
        }
        Ok(())
    }

    pub fn dial(self: &Rc<Self>, address: &str) -> Result<(), SessionError> {
        if self.is_dialer() || self.quiescing() {
            return Err(link_error("Executor dial loop cannot start"));
        }
        let target = Url::parse(address).map_err(|_| link_error("Invalid URL"))?;
        if !(target.scheme() == "wss" || target.scheme() == "ws" && self.options.no_tls) {
            return Err(link_error(
                "Executor connections require TLS unless no-TLS mode is explicit",
            ));
        }
        if target
            .fragment()
            .is_some_and(|fragment| !fragment.is_empty())
            || !target.username().is_empty()
            || target
                .password()
                .is_some_and(|password| !password.is_empty())
        {
            return Err(link_error(
                "Executor network URL must not contain userinfo or a fragment",
            ));
        }
        {
            let mut state = self.state.borrow_mut();
            state.dialing = true;
            state.dial_url = Some(address.to_owned());
        }
        self.connect_primary(address)
    }

    fn connect_primary(self: &Rc<Self>, url: &str) -> Result<(), SessionError> {
        if self.quiescing() {
            return Ok(());
        }
        let socket = self.connect_noise(
            url,
            LinkDialTarget {
                lane: RpcLane::Primary,
                session_id: None,
                primary_session_id: None,
            },
        )?;
        if socket.ready_state() != NoiseReadyState::Closed {
            self.track_socket(Rc::clone(&socket), None);
        }
        let weak = Rc::downgrade(self);
        spawn_local(async move {
            socket.closed().await;
            if let Some(link) = weak.upgrade() {
                link.schedule_redial();
            }
        });
        Ok(())
    }

    fn schedule_redial(self: &Rc<Self>) {
        if self.quiescing() {
            return;
        }
        let delays = self
            .options
            .redial_delays_ms
            .as_deref()
            .unwrap_or(REDIAL_DELAYS_MS);
        let mut state = self.state.borrow_mut();
        let delay = delays[state.redials.min(delays.len() - 1)];
        state.redials += 1;
        let deadline = Instant::now() + Duration::from_millis(delay);
        let weak = Rc::downgrade(self);
        state.dial_timer = Some(spawn_local(async move {
            sleep_until(deadline).await;
            if let Some(link) = weak.upgrade() {
                let url = {
                    let mut state = link.state.borrow_mut();
                    state.dial_timer = None;
                    state.dial_url.clone()
                };
                if let Some(url) = url {
                    let _ = link.connect_primary(&url);
                }
            }
        }));
    }

    fn connect_noise(
        self: &Rc<Self>,
        url: &str,
        target: LinkDialTarget,
    ) -> Result<Rc<NoiseConnection>, SessionError> {
        let options = self.noise_options(Some(target));
        connect_noise_web_socket(
            url,
            NoiseClientOptions {
                psk: options.psk,
                context: options.context,
                limits: options.limits,
                on_message: options.on_message,
                on_open: options.on_open,
                on_error: options.on_error,
                on_close: options.on_close,
                tls: None,
                allow_unverified_tls: self.options.allow_unverified_tls,
                signal: None,
            },
        )
        .map_err(|error| Rc::new(error) as SessionError)
    }

    pub async fn listen(
        self: &Rc<Self>,
        port: u16,
        hostname: &str,
        tls: Option<ExecutorListenerTls>,
    ) -> Result<String, SessionError> {
        if tls.is_some() && self.options.no_tls {
            return Err(link_error(
                "TLS credentials and no-TLS mode are mutually exclusive",
            ));
        }
        if tls.is_none() && !self.options.no_tls {
            return Err(link_error(
                "A listener requires TLS credentials or explicit no-TLS mode",
            ));
        }
        {
            let mut state = self.state.borrow_mut();
            if state.starting_listener || state.listener.is_some() || state.disposed {
                return Err(link_error("Executor listener cannot start"));
            }
            state.starting_listener = true;
        }
        let _starting = StartingListener(&self.state);
        self.start_listener(port, hostname, tls).await
    }

    async fn start_listener(
        self: &Rc<Self>,
        port: u16,
        hostname: &str,
        tls: Option<ExecutorListenerTls>,
    ) -> Result<String, SessionError> {
        let tls = tls.map(listener_tls).transpose()?;
        let listener = TcpListener::bind((hostname, port))
            .await
            .map_err(|error| Rc::new(error) as SessionError)?;
        if self.state.borrow().disposed {
            return Err(link_error("Executor listener cannot start"));
        }
        let mut address = listener
            .local_addr()
            .map_err(|error| Rc::new(error) as SessionError)?;
        if address.ip() == std::net::Ipv4Addr::UNSPECIFIED {
            address.set_ip(std::net::Ipv4Addr::LOCALHOST.into());
        }
        let scheme = if tls.is_some() { "wss" } else { "ws" };
        let noise = Rc::new(
            create_noise_server(NoiseServerOptions {
                max_connections: Some(MAX_SOCKETS),
                max_pending_handshakes: Some(MAX_SOCKETS),
            })
            .map_err(|error| Rc::new(error) as SessionError)?,
        );
        let stop = CancellationToken::new();
        let task = spawn_local(accept_connections(
            listener,
            tls,
            Rc::downgrade(self),
            Rc::clone(&noise),
            stop.clone(),
        ));
        self.state.borrow_mut().listener = Some(Listener { stop, noise, task });
        Ok(format!("{scheme}://{address}/executor"))
    }

    pub async fn dispose(&self) {
        if !self.dispose_connections() {
            return;
        }
        let listener = self.state.borrow_mut().listener.take();
        if let Some(listener) = listener {
            listener.noise.close();
            listener.stop.cancel();
            let _ = timeout(
                Duration::from_millis(LISTENER_STOP_SETTLE_MS),
                listener.task,
            )
            .await;
        }
    }

    pub fn disconnect(&self) {
        let (connections, sockets) = {
            let state = self.state.borrow();
            (
                state.connections.clone(),
                state
                    .sockets
                    .iter()
                    .map(|tracked| Rc::clone(&tracked.socket))
                    .collect::<Vec<_>>(),
            )
        };
        for connection in connections {
            connection
                .state
                .borrow_mut()
                .close_cause
                .get_or_insert(LinkClosureCause::LocalClose);
        }
        for socket in sockets {
            socket.close();
        }
    }

    pub fn quiesce(&self) {
        {
            let mut state = self.state.borrow_mut();
            state.quiescing = true;
            if let Some(timer) = state.dial_timer.take() {
                timer.abort();
            }
        }
        let _: Result<_, Infallible> = self.quiesce_listeners.notify(|listener| {
            listener();
            Ok(())
        });
        let (sockets, connections) = {
            let state = self.state.borrow();
            (
                state
                    .sockets
                    .iter()
                    .map(|tracked| Rc::clone(&tracked.socket))
                    .collect::<Vec<_>>(),
                state.connections.clone(),
            )
        };
        for socket in sockets {
            if socket.ready_state() != NoiseReadyState::Open {
                socket.close();
            }
        }
        for connection in connections {
            let unauthenticated = connection.state.borrow().hooks.is_none();
            if unauthenticated {
                self.close(&connection, LinkClosureCause::LocalClose, None);
            }
        }
    }

    fn dispose_connections(&self) -> bool {
        {
            let mut state = self.state.borrow_mut();
            if state.disposed {
                return false;
            }
            state.disposed = true;
            if let Some(timer) = state.dial_timer.take() {
                timer.abort();
            }
        }
        self.settle_ready(Err(link_error("Executor connector disposed")));
        if let Some(session) = self.current() {
            session.close(None);
        }
        self.fence_bulk();
        self.disconnect();
        self.sessions.clear();
        self.bulk_sessions.clear();
        self.quiesce_listeners.clear();
        self.errors.clear();
        self.closures.clear();
        true
    }

    fn settle_ready(&self, result: Ready) {
        if let Some(sender) = self.ready_sender.borrow_mut().take() {
            let _ = sender.send(result);
        }
    }

    fn noise_options(self: &Rc<Self>, target: Option<LinkDialTarget>) -> NoiseOptions {
        let connection: Rc<RefCell<Weak<Connection>>> = Rc::default();
        let weak = Rc::downgrade(self);
        let target_lane = target.as_ref().map(|target| target.lane);
        NoiseOptions {
            // INFALLIBLE: construction validates the key's canonical base64url encoding.
            psk: URL_SAFE_NO_PAD
                .decode(&self.options.secret)
                .expect("the validated shared key decodes"),
            context: EXECUTOR_NOISE_CONTEXT.to_owned(),
            limits: self.options.noise_limits,
            on_open: Some(Rc::new({
                let slot = Rc::clone(&connection);
                let weak = Weak::clone(&weak);
                move |socket, ()| {
                    if let Some(link) = weak.upgrade().filter(|link| !link.quiescing()) {
                        let connection = link.open(Rc::clone(socket), target.as_ref());
                        *slot.borrow_mut() = Rc::downgrade(&connection);
                    } else {
                        socket.close();
                    }
                    Ok(())
                }
            })),
            on_message: Rc::new({
                let slot = Rc::clone(&connection);
                let weak = Weak::clone(&weak);
                move |socket, message| {
                    let connection = slot.borrow().upgrade();
                    if let Some((link, connection)) = weak.upgrade().zip(connection) {
                        link.receive(&connection, message);
                    } else {
                        socket.close();
                    }
                    Ok(())
                }
            }),
            on_error: Some(Rc::new({
                let slot = Rc::clone(&connection);
                let weak = Weak::clone(&weak);
                move |_, error| {
                    let connection = slot.borrow().upgrade();
                    if let Some(connection) = &connection {
                        let mut state = connection.state.borrow_mut();
                        state
                            .close_cause
                            .get_or_insert(noise_closure_cause(error.code));
                        state.close_reason.get_or_insert_with(|| {
                            format!("Encrypted connection failed ({})", error.code)
                        });
                    }
                    if error.code != NoiseErrorCode::Closed
                        && let Some(link) = weak.upgrade()
                    {
                        let lane = connection
                            .as_ref()
                            .and_then(|connection| connection.hello_lane())
                            .or(target_lane);
                        link.report_failure(
                            error.code.as_str(),
                            format!("Executor encrypted connection failed ({})", error.code),
                            None,
                            lane,
                        );
                    }
                    Ok(())
                }
            })),
            on_close: Some(Rc::new(move |socket, _| {
                if let Some(link) = weak.upgrade() {
                    link.forget_socket(socket);
                    let connection = connection.borrow().upgrade();
                    if let Some(connection) = connection {
                        link.closed(&connection);
                    }
                }
                Ok(())
            })),
        }
    }

    fn open(
        self: &Rc<Self>,
        socket: Rc<NoiseConnection>,
        target: Option<&LinkDialTarget>,
    ) -> Rc<Connection> {
        let hello = target.map(|target| self.hello(target, None));
        let wire = hello.as_ref().map(|hello| stringify(hello.raw.as_value()));
        let connection = Rc::new(Connection {
            socket,
            state: RefCell::new(ConnectionState {
                hello,
                peer: None,
                timeout: None,
                session: None,
                hooks: None,
                heartbeat: None,
                last_received_at: Instant::now(),
                closed: false,
                authenticated: false,
                frames: None,
                close_cause: None,
                close_reason: None,
                session_started_at: None,
            }),
        });
        let weak_link = Rc::downgrade(self);
        let weak_connection = Rc::downgrade(&connection);
        let deadline = Instant::now() + Duration::from_secs(5);
        connection.state.borrow_mut().timeout = Some(spawn_local(async move {
            sleep_until(deadline).await;
            if let Some((link, connection)) = weak_link.upgrade().zip(weak_connection.upgrade()) {
                link.report_failure(
                    "authentication-timeout",
                    "Executor authentication timed out".to_owned(),
                    None,
                    connection.hello_lane(),
                );
                link.close(&connection, LinkClosureCause::ProtocolError, None);
            }
        }));
        self.state
            .borrow_mut()
            .connections
            .push(Rc::clone(&connection));
        if let Some(wire) = wire
            && let Err(error) = connection.socket.send(NoiseMessage::Text(wire))
        {
            self.close(&connection, LinkClosureCause::SocketError, Some(&error));
        }
        connection
    }

    fn hello(&self, target: &LinkDialTarget, peer: Option<&LinkHello>) -> Hello {
        let session_id = if target.lane == RpcLane::Primary && self.role() == LinkRole::Controller {
            Some((self.new_id)())
        } else {
            target.session_id.clone()
        };
        let executor_id = self
            .options
            .executor_id
            .clone()
            .or_else(|| self.current().map(|current| current.executor_id.clone()))
            .or_else(|| peer.and_then(|peer| peer.executor_id.clone()));
        let mut nonce = [0; 32];
        OsRng.fill_bytes(&mut nonce);
        let parsed = LinkHello {
            version: LINK_VERSION.clone(),
            role: self.role(),
            executor_id,
            runtime_id: self.runtime_id.clone(),
            nonce: hex(&nonce),
            lane: target.lane,
            session_id,
            primary_session_id: target.primary_session_id.clone(),
        };
        // INFALLIBLE: LinkHello consists only of JSON scalars and a fixed type tag.
        let raw = serde_json::to_string(&parsed).expect("the local hello serializes");
        // INFALLIBLE: the encoder produced JSON.
        let raw = Opaque::parse(&raw).expect("the local hello parses");
        Hello { parsed, raw }
    }

    fn receive(self: &Rc<Self>, connection: &Rc<Connection>, message: NoiseMessage) {
        {
            let mut state = connection.state.borrow_mut();
            if state.closed || self.state.borrow().disposed {
                return;
            }
            state.last_received_at = Instant::now();
        }
        if let Err(error) = self.receive_inner(connection, message) {
            let reason = failure_reason(Failure::Error(error.as_ref()));
            let (authenticated, session) = {
                let mut state = connection.state.borrow_mut();
                state
                    .close_cause
                    .get_or_insert(LinkClosureCause::ProtocolError);
                state.close_reason.get_or_insert_with(|| reason.clone());
                (state.authenticated, state.session.clone())
            };
            let (kind, message) = if authenticated {
                ("connection-lost", "Executor connection lost")
            } else {
                ("authentication-failed", "Executor authentication failed")
            };
            self.report_failure(
                kind,
                message.to_owned(),
                Some(reason),
                connection.hello_lane(),
            );
            if error.is::<MessageContinuityError>()
                && let Some(session) = session
            {
                session.close(Some(error));
            }
            self.close(connection, LinkClosureCause::ProtocolError, None);
        }
    }

    fn receive_inner(
        self: &Rc<Self>,
        connection: &Rc<Connection>,
        message: NoiseMessage,
    ) -> Result<(), SessionError> {
        let text = matches!(&message, NoiseMessage::Text(_));
        let encoded = match message {
            NoiseMessage::Text(text) => text,
            NoiseMessage::Binary(fragment) => {
                let frames = connection
                    .state
                    .borrow()
                    .frames
                    .clone()
                    .ok_or_else(|| link_error("Unauthenticated session fragment"))?;
                let complete = frames
                    .receive(&fragment)
                    .map_err(|error| Rc::new(error) as SessionError)?;
                let Some(encoded) = complete else {
                    return Ok(());
                };
                encoded
            }
        };
        let hooks = connection.state.borrow().hooks.clone();
        if let Some(hooks) = hooks {
            return match encoded.as_str() {
                r#"{"type":"ping"}"# => heartbeat(connection, "pong"),
                r#"{"type":"pong"}"# => Ok(()),
                _ if text => Err(Rc::new(MessageContinuityError(
                    "Session packets require binary framing",
                ))),
                _ => {
                    hooks.receive(encoded);
                    Ok(())
                }
            };
        }
        if encoded.len() > 8192 {
            return Err(link_error("Handshake exceeds budget"));
        }
        let frame = Opaque::parse(&encoded)
            .map_err(|_| link_error("Malformed executor handshake frame"))?;
        let awaiting_hello = connection.state.borrow().peer.is_none();
        if awaiting_hello && let Some(peer) = parse_link_hello(&frame) {
            return self.accept_hello(connection, peer, frame);
        }
        let signature = frame
            .as_object()
            .filter(|frame| frame.get("type").and_then(Value::as_str) == Some("proof"))
            .and_then(|frame| frame.get("signature"))
            .and_then(Value::as_str)
            .and_then(decode_signature);
        let peer_role = connection
            .state
            .borrow()
            .peer
            .as_ref()
            .map(|peer| peer.parsed.role);
        let valid = if let Some((signature, role)) = signature.zip(peer_role) {
            self.proof_mac(connection, role)?
                .verify_slice(&signature)
                .is_ok()
        } else {
            false
        };
        if !valid {
            return Err(link_error("Executor proof is missing or invalid"));
        }
        connection.state.borrow_mut().authenticated = true;
        self.accept(connection)
    }

    fn accept_hello(
        self: &Rc<Self>,
        connection: &Rc<Connection>,
        peer: LinkHello,
        raw: Opaque,
    ) -> Result<(), SessionError> {
        if peer.version != *LINK_VERSION {
            let version = stringify(&Value::String(
                utf16::truncate(&peer.version, 80).to_owned(),
            ));
            self.report_failure(
                "version-mismatch",
                format!(
                    "Executor version mismatch: local {}, peer {version}. Use matching builds.",
                    *LINK_VERSION
                ),
                None,
                Some(peer.lane),
            );
            self.close(connection, LinkClosureCause::ProtocolError, None);
            return Ok(());
        }
        if peer.role == self.role() {
            return Err(link_error("Executor handshake mismatch"));
        }
        let awaiting_local = connection.state.borrow().hello.is_none();
        let local = awaiting_local.then(|| {
            self.hello(
                &LinkDialTarget {
                    lane: peer.lane,
                    session_id: peer.session_id.clone(),
                    primary_session_id: peer.primary_session_id.clone(),
                },
                Some(&peer),
            )
        });
        let wire = local.as_ref().map(|hello| stringify(hello.raw.as_value()));
        {
            let mut state = connection.state.borrow_mut();
            state.peer = Some(Hello { parsed: peer, raw });
            if let Some(local) = local {
                state.hello = Some(local);
            }
        }
        if let Some(wire) = wire {
            send_text(connection, wire)?;
        }
        self.validate_identity(connection)?;
        let proof = self
            .proof_mac(connection, self.role())?
            .finalize()
            .into_bytes();
        send_text(
            connection,
            json!({"type": "proof", "signature": hex(&proof)}).to_string(),
        )
    }

    fn validate_identity(&self, connection: &Connection) -> Result<(), SessionError> {
        let state = connection.state.borrow();
        let (hello, peer) = hellos(&state)?;
        let (controller, worker) = if hello.role == LinkRole::Controller {
            (hello, peer)
        } else {
            (peer, hello)
        };
        if hello.lane != peer.lane
            || !controller
                .session_id
                .as_ref()
                .is_some_and(|id| is_session_id(&Value::String(id.clone())))
            || worker.session_id.is_some() && worker.session_id != controller.session_id
            || worker.executor_id.is_some() && worker.executor_id != controller.executor_id
            || hello.primary_session_id != peer.primary_session_id
        {
            return Err(link_error("Executor lane identity mismatch"));
        }
        if hello.lane == RpcLane::Primary {
            return Ok(());
        }
        let link = self.state.borrow();
        let authorized = link.bulk_grant.as_ref().is_some_and(|grant| {
            link.current
                .as_ref()
                .is_some_and(|parent| Rc::ptr_eq(parent, &grant.primary))
                && grant.primary.connected()
                && controller.session_id.as_deref() == Some(grant.id.as_str())
                && hello.primary_session_id.as_deref() == Some(grant.primary.id.as_str())
                && controller.executor_id.as_deref() == Some(grant.primary.executor_id.as_str())
                && peer.runtime_id == grant.primary.peer_runtime_id
        });
        if authorized {
            Ok(())
        } else {
            Err(link_error(
                "Bulk connection is not authorized by the current primary",
            ))
        }
    }

    fn proof_mac(
        &self,
        connection: &Connection,
        purpose: LinkRole,
    ) -> Result<Hmac<Sha256>, SessionError> {
        let state = connection.state.borrow();
        let invalid = || link_error("Executor proof is missing or invalid");
        let hello = state.hello.as_ref().ok_or_else(invalid)?;
        let peer = state.peer.as_ref().ok_or_else(invalid)?;
        let ordered = if self.role() == LinkRole::Controller {
            [hello.raw.as_value(), peer.raw.as_value()]
        } else {
            [peer.raw.as_value(), hello.raw.as_value()]
        };
        let value = json!(["garcon-executor", purpose.as_str(), ordered]);
        // INFALLIBLE: HMAC accepts a key of any length.
        let mut mac =
            Hmac::new_from_slice(self.options.secret.as_bytes()).expect("HMAC accepts the key");
        mac.update(stringify(&value).as_bytes());
        Ok(mac)
    }

    fn accept(self: &Rc<Self>, connection: &Rc<Connection>) -> Result<(), SessionError> {
        if let Some(timeout) = connection.state.borrow_mut().timeout.take() {
            timeout.abort();
        }
        self.validate_identity(connection)?;
        let (lane, executor, id, parent, runtime) = {
            let state = connection.state.borrow();
            let (hello, peer) = hellos(&state)?;
            let controller = if self.role() == LinkRole::Controller {
                hello
            } else {
                peer
            };
            (
                hello.lane,
                controller
                    .executor_id
                    .clone()
                    .ok_or_else(|| link_error("Executor lane identity mismatch"))?,
                controller
                    .session_id
                    .clone()
                    .ok_or_else(|| link_error("Executor lane identity mismatch"))?,
                hello.primary_session_id.clone(),
                peer.runtime_id.clone(),
            )
        };
        {
            let state = self.state.borrow();
            match lane {
                RpcLane::Primary if state.current.is_some() => {
                    return Err(link_error("Executor session already attached"));
                }
                RpcLane::Bulk if state.bulk.is_some() => {
                    return Err(link_error("Executor session already attached"));
                }
                _ => {}
            }
            let lease = state
                .sockets
                .iter()
                .find(|tracked| Rc::ptr_eq(&tracked.socket, &connection.socket))
                .and_then(|tracked| tracked.lease.as_ref());
            if lease.is_some_and(|lease| !lease.promote(lane)) {
                return Err(link_error("Executor socket role capacity exhausted"));
            }
        }
        let session = self.create_session(connection, lane, executor, id, parent, runtime)?;
        let listeners = match lane {
            RpcLane::Primary => &self.sessions,
            RpcLane::Bulk => &self.bulk_sessions,
        };
        let attach = || {
            listeners.notify(|listener| listener(Rc::clone(&session)))?;
            let weak_link = Rc::downgrade(self);
            let weak_connection = Rc::downgrade(connection);
            let weak_session = Rc::downgrade(&session);
            let frames = Rc::new(SessionSocketFrames::new(
                Rc::clone(&connection.socket),
                Rc::new({
                    let link = Weak::clone(&weak_link);
                    let connection = Weak::clone(&weak_connection);
                    move || {
                        if let Some((link, connection)) = link.upgrade().zip(connection.upgrade()) {
                            let error = weak_session
                                .upgrade()
                                .and_then(|session| session.channel.failure());
                            link.retire(&connection, error.as_deref());
                        }
                    }
                }),
                Some(Rc::new(move |error| {
                    if let Some((link, connection)) =
                        weak_link.upgrade().zip(weak_connection.upgrade())
                    {
                        link.close(
                            &connection,
                            LinkClosureCause::SocketError,
                            Some(error.as_ref()),
                        );
                    }
                })),
            ));
            connection.state.borrow_mut().frames = Some(Rc::clone(&frames));
            session.attach(frames).map(Rc::new)
        };
        let hooks = match attach() {
            Ok(hooks) => hooks,
            Err(error) => {
                session.close(Some(Rc::clone(&error)));
                return Err(error);
            }
        };
        {
            let mut state = connection.state.borrow_mut();
            state.hooks = Some(Rc::clone(&hooks));
            if state.closed {
                drop(state);
                hooks.disconnected();
                return Ok(());
            }
            state.session_started_at = Some(Instant::now());
        }
        self.state
            .borrow_mut()
            .failures
            .retain(|(failed_lane, _), _| {
                *failed_lane != Some(lane) && !(lane == RpcLane::Primary && failed_lane.is_none())
            });
        if lane == RpcLane::Primary {
            self.settle_ready(Ok(session));
        }
        self.start_heartbeat(connection);
        Ok(())
    }

    fn create_session(
        self: &Rc<Self>,
        connection: &Rc<Connection>,
        lane: RpcLane,
        executor_id: String,
        id: String,
        primary_session_id: Option<String>,
        runtime: String,
    ) -> Result<Rc<SessionTransport>, SessionError> {
        let weak_link = Rc::downgrade(self);
        let weak_connection = Rc::downgrade(connection);
        let session = SessionTransport::new(
            id,
            runtime,
            Rc::new(move |error| {
                if let Some((link, connection)) = weak_link.upgrade().zip(weak_connection.upgrade())
                {
                    let session = connection.state.borrow().session.clone();
                    if let Some(session) = session {
                        let mut state = link.state.borrow_mut();
                        clear_if_current(&mut state.current, &session);
                        clear_if_current(&mut state.bulk, &session);
                    }
                    link.retire(&connection, Some(error.as_ref()));
                }
            }),
            SessionTransportOptions {
                max_queued_bytes: self.options.max_queued_bytes,
                max_queued_frames: self.options.max_queued_frames,
                budget: Some(Rc::clone(&self.queue_budget)),
                executor_id,
                lane,
                primary_session_id,
            },
        )
        .map_err(|error| Rc::new(error) as SessionError)?;
        match lane {
            RpcLane::Primary => {
                self.state.borrow_mut().current = Some(Rc::clone(&session));
                let (link, this) = (Rc::downgrade(self), Rc::downgrade(&session));
                let _unsubscribe = session.on_availability(Rc::new(move |connected| {
                    if !connected && let Some((link, this)) = link.upgrade().zip(this.upgrade()) {
                        let detached =
                            clear_if_current(&mut link.state.borrow_mut().current, &this);
                        if detached {
                            link.fence_bulk();
                        }
                    }
                }));
            }
            RpcLane::Bulk => self.state.borrow_mut().bulk = Some(Rc::clone(&session)),
        }
        connection.state.borrow_mut().session = Some(Rc::clone(&session));
        Ok(session)
    }

    fn start_heartbeat(self: &Rc<Self>, connection: &Rc<Connection>) {
        let (link, weak) = (Rc::downgrade(self), Rc::downgrade(connection));
        let every = Duration::from_secs(5);
        let mut interval = interval_at(Instant::now() + every, every);
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        connection.state.borrow_mut().heartbeat = Some(spawn_local(async move {
            loop {
                interval.tick().await;
                let Some((link, connection)) = link.upgrade().zip(weak.upgrade()) else {
                    break;
                };
                if connection.state.borrow().last_received_at.elapsed() > Duration::from_secs(15) {
                    link.close(&connection, LinkClosureCause::LivenessTimeout, None);
                    break;
                }
                if let Err(error) = heartbeat(&connection, "ping") {
                    link.close(
                        &connection,
                        LinkClosureCause::SocketError,
                        Some(error.as_ref()),
                    );
                    break;
                }
            }
        }));
    }

    fn report_failure(
        &self,
        kind: &'static str,
        message: String,
        reason: Option<String>,
        lane: Option<RpcLane>,
    ) {
        let failure = {
            let mut state = self.state.borrow_mut();
            if state.disposed {
                return;
            }
            let key = (lane, kind);
            let count = state
                .failures
                .get(&key)
                .filter(|previous| previous.message == message && previous.reason == reason)
                .map_or(1, |previous| previous.count + 1);
            let failure = LinkFailure {
                lane,
                message,
                count,
                reason,
            };
            state.failures.insert(key, failure.clone());
            failure
        };
        let _: Result<_, Infallible> = self.errors.notify(|listener| {
            listener(&failure);
            Ok(())
        });
    }

    fn close(
        &self,
        connection: &Connection,
        cause: LinkClosureCause,
        failure: Option<&(dyn std::error::Error + 'static)>,
    ) {
        {
            let mut state = connection.state.borrow_mut();
            state.close_cause.get_or_insert(cause);
            if let Some(failure) = failure {
                state
                    .close_reason
                    .get_or_insert_with(|| failure_reason(Failure::Error(failure)));
            }
        }
        self.closed(connection);
        connection.socket.close();
    }

    fn retire(&self, connection: &Connection, failure: Option<&(dyn std::error::Error + 'static)>) {
        let disposed = self.state.borrow().disposed;
        if disposed {
            self.close(connection, LinkClosureCause::LocalClose, None);
        } else {
            self.close(connection, LinkClosureCause::SessionRetired, failure);
        }
    }

    fn closed(&self, connection: &Connection) {
        let (hooks, session, cause, reason, stable) = {
            let mut state = connection.state.borrow_mut();
            if state.closed {
                return;
            }
            state.closed = true;
            for task in [state.timeout.take(), state.heartbeat.take()]
                .into_iter()
                .flatten()
            {
                task.abort();
            }
            if let Some(frames) = &state.frames {
                frames.dispose();
            }
            let stable = state
                .hello
                .as_ref()
                .is_some_and(|hello| hello.parsed.lane == RpcLane::Primary)
                && state.session_started_at.is_some_and(|started| {
                    started.elapsed()
                        >= Duration::from_millis(
                            self.options.stable_session_ms.unwrap_or(STABLE_SESSION_MS),
                        )
                });
            (
                state.hooks.clone(),
                state.session.clone(),
                state.close_cause.unwrap_or(LinkClosureCause::SocketClosed),
                state.close_reason.clone(),
                stable,
            )
        };
        {
            let mut state = self.state.borrow_mut();
            state
                .connections
                .retain(|current| !std::ptr::eq(current.as_ref(), connection));
            if stable {
                state.redials = 0;
            }
        }
        if let Some(hooks) = hooks {
            if let Some(session) = session {
                self.report_closure(&session, cause, reason);
            }
            hooks.disconnected();
        }
    }

    fn report_closure(
        &self,
        session: &SessionTransport,
        cause: LinkClosureCause,
        reason: Option<String>,
    ) {
        let closure = {
            let mut state = self.state.borrow_mut();
            let count = state
                .closure_counts
                .entry((session.lane, cause))
                .or_default();
            *count += 1;
            LinkClosure {
                lane: session.lane,
                session_id: session.id.clone(),
                primary_session_id: session.primary_session_id.clone(),
                cause,
                queues: session.channel.queue_snapshot(),
                count: *count,
                primary_redials: state.redials,
                reason,
            }
        };
        let _: Result<_, Infallible> = self.closures.notify(|listener| {
            listener(&closure);
            Ok(())
        });
    }
}

impl Connection {
    fn hello_lane(&self) -> Option<RpcLane> {
        self.state
            .borrow()
            .hello
            .as_ref()
            .map(|hello| hello.parsed.lane)
    }

    fn lane(&self) -> Option<RpcLane> {
        let state = self.state.borrow();
        state
            .hello
            .as_ref()
            .or(state.peer.as_ref())
            .map(|hello| hello.parsed.lane)
    }
}

fn hellos(state: &ConnectionState) -> Result<(&LinkHello, &LinkHello), SessionError> {
    state
        .hello
        .as_ref()
        .zip(state.peer.as_ref())
        .map(|(local, peer)| (&local.parsed, &peer.parsed))
        .ok_or_else(|| link_error("Executor handshake mismatch"))
}

fn clear_if_current(
    slot: &mut Option<Rc<SessionTransport>>,
    session: &Rc<SessionTransport>,
) -> bool {
    if slot
        .as_ref()
        .is_some_and(|current| Rc::ptr_eq(current, session))
    {
        *slot = None;
        true
    } else {
        false
    }
}

fn send_text(connection: &Connection, text: String) -> Result<(), SessionError> {
    connection
        .socket
        .send(NoiseMessage::Text(text))
        .map_err(|error| Rc::new(error) as SessionError)
}

fn heartbeat(connection: &Connection, kind: &str) -> Result<(), SessionError> {
    if connection.socket.buffered_amount() < SESSION_SOCKET_BUFFER_BYTES {
        send_text(connection, json!({"type": kind}).to_string())?;
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        // INFALLIBLE: formatting into String cannot fail.
        write!(hex, "{byte:02x}").expect("writing to a String is infallible");
    }
    hex
}

fn decode_signature(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 {
        return None;
    }
    let digit = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    };
    let mut output = [0; 32];
    let (pairs, _) = text.as_bytes().as_chunks::<2>();
    for (slot, [first, second]) in output.iter_mut().zip(pairs) {
        *slot = digit(*first)? * 16 + digit(*second)?;
    }
    Some(output)
}

fn noise_closure_cause(code: NoiseErrorCode) -> LinkClosureCause {
    match code {
        NoiseErrorCode::TransportClosed => LinkClosureCause::SocketClosed,
        NoiseErrorCode::RecordLimit => LinkClosureCause::RecordLimit,
        NoiseErrorCode::TransportError | NoiseErrorCode::Backpressure => {
            LinkClosureCause::SocketError
        }
        NoiseErrorCode::HandshakeTimeout | NoiseErrorCode::MessageTimeout => {
            LinkClosureCause::LivenessTimeout
        }
        _ => LinkClosureCause::ProtocolError,
    }
}

fn listener_tls(tls: ExecutorListenerTls) -> Result<TlsAcceptor, SessionError> {
    let cert = CertificateDer::pem_slice_iter(&tls.cert)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| Rc::new(error) as SessionError)?;
    let key =
        PrivateKeyDer::from_pem_slice(&tls.key).map_err(|error| Rc::new(error) as SessionError)?;
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|error| Rc::new(error) as SessionError)?
    .with_no_client_auth()
    .with_single_cert(cert, key)
    .map_err(|error| Rc::new(error) as SessionError)?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

async fn accept_connections(
    listener: TcpListener,
    tls: Option<TlsAcceptor>,
    link: Weak<WebSocketLink>,
    noise: Rc<NoiseServer>,
    stop: CancellationToken,
) {
    loop {
        let stream = tokio::select! {
            _ = stop.cancelled() => return,
            stream = listener.accept() => match stream {
                Ok((stream, _)) => stream,
                Err(_) => return,
            },
        };
        let _ = stream.set_nodelay(true);
        let (tls, link, noise, stop) = (tls.clone(), link.clone(), Rc::clone(&noise), stop.clone());
        spawn_local(async move {
            let serve = async move {
                if let Some(tls) = tls {
                    if let Ok(Ok(stream)) = timeout(LISTENER_HTTP_IDLE, tls.accept(stream)).await {
                        listener_connection(stream, link, noise).await;
                    }
                } else {
                    listener_connection(stream, link, noise).await;
                }
            };
            tokio::select! {
                _ = stop.cancelled() => {}
                () = serve => {}
            }
        });
    }
}

type HttpResponse = Response<Full<Bytes>>;

async fn listener_connection(
    stream: impl AsyncRead + AsyncWrite + Send + Unpin + 'static,
    link: Weak<WebSocketLink>,
    noise: Rc<NoiseServer>,
) {
    let service = service_fn(move |request| {
        let response = respond_to_upgrade(request, &link, &noise);
        async move { Ok::<_, Infallible>(response) }
    });
    let _ = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(LISTENER_HTTP_IDLE)
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades()
        .await;
}

fn respond_to_upgrade(
    mut request: Request<Incoming>,
    link: &Weak<WebSocketLink>,
    noise: &NoiseServer,
) -> HttpResponse {
    if request.uri().path() != "/executor" {
        return empty_response(StatusCode::NOT_FOUND);
    }
    let Some(link) = link.upgrade() else {
        return empty_response(StatusCode::SERVICE_UNAVAILABLE);
    };
    let is_upgrade = is_web_socket_upgrade(&request);
    let mut response = None;
    let mut native_upgrade_called = false;
    let pending = link.upgrade(noise, is_upgrade, |_| {
        native_upgrade_called = true;
        let mut head = Request::new(());
        *head.method_mut() = request.method().clone();
        *head.uri_mut() = request.uri().clone();
        *head.version_mut() = request.version();
        *head.headers_mut() = request.headers().clone();
        response = create_response_with_body(&head, Full::default).ok();
        response.is_some()
    });
    match pending {
        Ok(pending) => {
            let upgraded = hyper::upgrade::on(&mut request);
            spawn_local(async move {
                if let Ok(socket) = upgraded.await {
                    pending.open(TokioIo::new(socket)).await;
                }
            });
            // INFALLIBLE: admission succeeded only when the WebSocket response was built.
            response.expect("an admitted upgrade has an HTTP response")
        }
        Err(UpgradeFailure::ServiceUnavailable) => empty_response(StatusCode::SERVICE_UNAVAILABLE),
        Err(UpgradeFailure::BadRequest)
            if native_upgrade_called
                && upgrade_headers(&request)
                && header(&request, "sec-websocket-version") != Some("13") =>
        {
            let mut required = empty_response(StatusCode::UPGRADE_REQUIRED);
            required.headers_mut().insert(
                "sec-websocket-version",
                hyper::header::HeaderValue::from_static("13"),
            );
            required
        }
        Err(UpgradeFailure::BadRequest) => empty_response(StatusCode::BAD_REQUEST),
        Err(UpgradeFailure::InvalidOptions(_)) => empty_response(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

pub fn is_web_socket_upgrade<T>(request: &Request<T>) -> bool {
    upgrade_headers(request)
        && header(request, "sec-websocket-version") == Some("13")
        && header(request, "sec-websocket-key").is_some_and(|key| {
            key.as_bytes().strip_suffix(b"==").is_some_and(|digits| {
                digits.len() == 22
                    && digits
                        .iter()
                        .all(|digit| digit.is_ascii_alphanumeric() || matches!(digit, b'+' | b'/'))
            })
        })
}

fn upgrade_headers<T>(request: &Request<T>) -> bool {
    request.method() == hyper::Method::GET
        && header(request, "upgrade").is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
        && header(request, "connection").is_some_and(|value| {
            value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
        })
}

fn header<'a, T>(request: &'a Request<T>, name: &str) -> Option<&'a str> {
    request.headers().get(name)?.to_str().ok()
}

fn empty_response(status: StatusCode) -> HttpResponse {
    let mut response = Response::new(Full::default());
    *response.status_mut() = status;
    response
}

fn link_error(message: &'static str) -> SessionError {
    Rc::new(LinkError(message))
}

fn displaceable_socket(state: &State) -> Option<Rc<NoiseConnection>> {
    let mut confirming = None;
    for tracked in &state.sockets {
        match tracked.socket.ready_state() {
            NoiseReadyState::Connecting | NoiseReadyState::Handshaking => {
                return Some(Rc::clone(&tracked.socket));
            }
            NoiseReadyState::Confirming => {
                confirming.get_or_insert_with(|| Rc::clone(&tracked.socket));
            }
            _ => {}
        }
    }
    confirming
}
