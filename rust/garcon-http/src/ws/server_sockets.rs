//! Browser socket admission, auth publication fences, and the session loop.

use std::cell::{Cell, RefCell};
use std::error::Error;
use std::future::poll_fn;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use bytes::Bytes;
use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_js::{Clock, Number};
use garcon_stores::auth::service::AuthService;
use hyper::upgrade::OnUpgrade;
use hyper_util::rt::TokioIo;
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use yawc::OpCode;

use crate::websocket_auth::{BrowserAuth, BrowserClose, BrowserPrincipal};
use crate::websocket_capacity::{Reservation, WebSocketAdmissionController};

use super::primary::PrimaryHandler;
use super::primary_delivery::{PrimaryPeer, PrimarySocketDelivery};
use super::transport::{BrowserTransport, PrimaryTransport};

// Bun applies the shared listener's Noise ceiling first, then the browser limit.
const SHARED_MESSAGE_FLOOR: usize = 65_535;
const SHARED_WRITE_BUDGET_FLOOR: usize = 32 * 1024 * 1024;
const MESSAGE_TOO_LARGE: BrowserClose = BrowserClose {
    code: 1009,
    reason: "Message exceeds the configured size limit",
};

pub struct BrowserSocketOptions {
    pub max_clients: usize,
    pub limits: BrowserSocketLimits,
    pub auth_disabled: bool,
    pub shutting_down: Rc<Cell<bool>>,
}

pub struct BrowserSocketLimits {
    idle_seconds: u16,
    max_message_bytes: usize,
    shared_message_bytes: usize,
    backpressure_bytes: usize,
    shared_backpressure_bytes: usize,
}

impl BrowserSocketLimits {
    pub fn from_config(
        max_message: Number,
        idle: Number,
        backpressure: Number,
    ) -> Result<Self, &'static str> {
        // Bun.serve takes JSC's signed 52-bit integers, then narrows the
        // shared listener options to u32, u16 and u32, respectively.
        fn bun_integer(value: f64) -> bool {
            value.fract() == 0.0 && (0.0..(1_u64 << 51) as f64).contains(&value)
        }
        let max_message = max_message.0;
        let idle = idle.0;
        let backpressure = backpressure.0;
        if !bun_integer(max_message) {
            return Err("websocket expects maxPayloadLength to be an integer");
        }
        if !bun_integer(idle) {
            return Err("websocket expects idleTimeout to be an integer");
        }
        let idle_seconds = idle as u64 as u16;
        if idle_seconds > 960 {
            return Err("websocket expects idleTimeout to be 960 or less");
        }
        if !bun_integer(backpressure) {
            return Err("websocket expects backpressureLimit to be an integer");
        }
        Ok(Self {
            idle_seconds,
            max_message_bytes: max_message as usize,
            shared_message_bytes: (max_message as u64).max(SHARED_MESSAGE_FLOOR as u64) as u32
                as usize,
            backpressure_bytes: backpressure as usize,
            shared_backpressure_bytes: (backpressure as u64).max(SHARED_WRITE_BUDGET_FLOOR as u64)
                as u32 as usize,
        })
    }
}

#[async_trait::async_trait(?Send)]
pub(crate) trait PrimaryRequests {
    async fn message(&self, peer: &PrimaryPeer, bytes: Bytes);
}

pub struct BrowserSockets {
    pub(super) options: BrowserSocketOptions,
    pub(super) auth: BrowserAuth,
    pub(super) admission: Rc<WebSocketAdmissionController>,
    delivery: PrimarySocketDelivery,
    primary: Rc<dyn PrimaryRequests>,
    pending_upgrades: CancellationToken,
    tasks: TaskTracker,
    unsubscribe: RefCell<Option<Box<dyn FnOnce()>>>,
    logger: ScopedLogger,
}

impl BrowserSockets {
    pub fn new(
        options: BrowserSocketOptions,
        auth: Rc<AuthService>,
        instance_id: String,
        clock: Rc<dyn Clock>,
        unported_log: Option<PathBuf>,
    ) -> Result<Rc<Self>, Box<dyn Error>> {
        Self::with_handler(
            options,
            auth,
            Rc::new(PrimaryHandler::new(instance_id, clock, unported_log)),
        )
    }

    pub(crate) fn with_handler(
        options: BrowserSocketOptions,
        auth: Rc<AuthService>,
        primary: Rc<dyn PrimaryRequests>,
    ) -> Result<Rc<Self>, Box<dyn Error>> {
        let admission = WebSocketAdmissionController::new(options.max_clients)?;
        let sockets = Rc::new(Self {
            auth: BrowserAuth {
                service: auth,
                disabled: options.auth_disabled,
            },
            delivery: PrimarySocketDelivery::new(options.limits.backpressure_bytes),
            options,
            admission,
            primary,
            pending_upgrades: CancellationToken::new(),
            tasks: TaskTracker::new(),
            unsubscribe: RefCell::new(None),
            logger: create_logger("ws:primary"),
        });
        let weak = Rc::downgrade(&sockets);
        let stop = sockets.auth.service.store.on_change(Rc::new(move |_| {
            if let Some(sockets) = weak.upgrade() {
                sockets
                    .delivery
                    .retire_where(|principal| sockets.auth.rejection(principal));
            }
            Ok(())
        }));
        *sockets.unsubscribe.borrow_mut() = Some(Box::new(stop));
        Ok(sockets)
    }

    pub(super) fn begin_upgrade(
        self: &Rc<Self>,
        upgrade: OnUpgrade,
        extension: Option<&'static str>,
        reservation: Reservation,
        principal: BrowserPrincipal,
    ) {
        let sockets = Rc::clone(self);
        self.tasks.spawn_local(async move {
            sockets
                .accept(upgrade, extension, reservation, principal)
                .await;
        });
    }

    async fn accept(
        &self,
        upgrade: OnUpgrade,
        extension: Option<&'static str>,
        reservation: Reservation,
        principal: BrowserPrincipal,
    ) {
        let socket = tokio::select! {
            biased;
            result = upgrade => match result {
                Ok(socket) => socket,
                Err(_) => return,
            },
            () = self.pending_upgrades.cancelled() => return,
        };
        let transport = match BrowserTransport::new(
            TokioIo::new(socket),
            extension,
            self.options.limits.shared_message_bytes,
            self.options.limits.shared_backpressure_bytes,
        ) {
            Ok(transport) => transport,
            Err(error) => {
                self.logger
                    .error(&format!("Browser WebSocket transport failed: {error}"));
                return;
            }
        };
        self.open_transport(transport, reservation, principal).await;
    }

    async fn open_transport<S>(
        &self,
        transport: Rc<BrowserTransport<S>>,
        reservation: Reservation,
        principal: BrowserPrincipal,
    ) where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + 'static,
    {
        if let Some(rejection) = self.auth.rejection(&principal) {
            drop(reservation);
            transport.close(rejection);
            transport.finish().await;
            return;
        }
        if let Err(error) = reservation.confirm() {
            drop(reservation);
            transport.close(BrowserClose {
                code: 1013,
                reason: error.reason(),
            });
            transport.finish().await;
            return;
        }
        let id = reservation.id();
        let peer = self.delivery.add(reservation, principal, transport.clone());
        if peer.is_open() {
            peer.subscribe("chat");
            self.drive(&peer, &transport).await;
        }
        self.delivery.remove(id);
        transport.finish().await;
    }

    async fn drive<S>(&self, peer: &PrimaryPeer, transport: &BrowserTransport<S>)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let mut idle = IdleTimer::new(self.options.limits.idle_seconds, transport.last_input());
        while peer.is_open() {
            idle.observe(transport.last_input());
            let frame = tokio::select! {
                () = idle.wait() => {
                    idle.observe(transport.last_input());
                    match idle.tick(Instant::now()) {
                        IdleAction::Wait => {}
                        IdleAction::Ping if transport.ping().is_ok() => {}
                        IdleAction::Ping | IdleAction::Terminate => {
                            transport.terminate();
                            break;
                        }
                    }
                    continue;
                }
                frame = poll_fn(|cx| transport.poll_frame(cx)) => frame,
            };
            let Ok(Some(frame)) = frame else {
                break;
            };
            match frame.opcode() {
                OpCode::Close => break,
                OpCode::Text | OpCode::Binary => {
                    if let Some(rejection) = self.auth.rejection(&peer.principal) {
                        peer.close(rejection);
                        break;
                    }
                    if frame.payload().len() > self.options.limits.max_message_bytes {
                        peer.close(MESSAGE_TOO_LARGE);
                        break;
                    }
                    self.primary.message(peer, frame.into_payload()).await;
                }
                _ => {}
            }
            tokio::task::yield_now().await;
        }
    }

    pub async fn shutdown(&self) {
        self.options.shutting_down.set(true);
        self.delivery.close();
        self.pending_upgrades.cancel();
        self.tasks.close();
        self.tasks.wait().await;
    }

    pub fn publish(&self, topic: &str, payload: &Bytes) -> isize {
        self.delivery.publish(topic, payload)
    }
}

impl Drop for BrowserSockets {
    fn drop(&mut self) {
        if let Some(stop) = self.unsubscribe.get_mut().take() {
            stop();
        }
    }
}

struct IdleTimer {
    input: Instant,
    deadline: Option<Instant>,
    until_ping: Duration,
    ping_grace: Duration,
    pinged: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IdleAction {
    Wait,
    Ping,
    Terminate,
}

impl IdleTimer {
    fn new(seconds: u16, input: Instant) -> Self {
        let enabled = seconds != 0;
        let seconds = seconds.max(8);
        let margin = if seconds >= 32 {
            16
        } else if seconds >= 16 {
            8
        } else {
            4
        };
        let until_ping =
            Duration::from_secs(u64::from(seconds.saturating_sub(margin)).div_ceil(4) * 4);
        let ping_grace = Duration::from_secs(u64::from(margin));
        Self {
            input,
            deadline: enabled.then(|| input + until_ping),
            until_ping,
            ping_grace,
            pinged: false,
        }
    }

    fn observe(&mut self, input: Instant) {
        if input > self.input {
            self.input = input;
            self.deadline = self.deadline.map(|_| input + self.until_ping);
            self.pinged = false;
        }
    }

    async fn wait(&self) {
        if let Some(deadline) = self.deadline {
            sleep_until(deadline).await;
        } else {
            std::future::pending().await
        }
    }

    fn tick(&mut self, now: Instant) -> IdleAction {
        if self.deadline.is_none_or(|deadline| deadline > now) {
            return IdleAction::Wait;
        }
        if self.pinged {
            return IdleAction::Terminate;
        }
        self.pinged = true;
        self.deadline = Some(now + self.ping_grace);
        IdleAction::Ping
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compose_routes::RouteMap;
    use crate::http_request::HttpAuthentication;
    use crate::http_route::{HttpRouteOptions, HttpRouter};
    use crate::listener::Listener;
    use garcon_base::json_file_store::JsonFileStore;
    use garcon_js::{Clock, SystemClock};
    use garcon_stores::auth::passwords::BunPasswords;
    use garcon_stores::auth::store::{AuthAccountStore, AuthWriteFailure, AuthWriter};
    use garcon_stores::auth::token::{AuthTokens, VerifiedAuthClaims};
    use serde_json::Value;
    use std::net::SocketAddr;
    use tokio::task::{JoinHandle, LocalSet};
    use uuid::Uuid;

    #[derive(Default)]
    struct Echo {
        burst_finished: Cell<bool>,
    }

    #[async_trait::async_trait(?Send)]
    impl PrimaryRequests for Echo {
        async fn message(&self, peer: &PrimaryPeer, bytes: Bytes) {
            use super::super::transport::SendResult;

            match bytes.as_ref() {
                b"fixture-close" => peer.close(BrowserClose {
                    code: 4001,
                    reason: "AUTH_REVOKED",
                }),
                b"fixture-burst" => {
                    let payload = Bytes::from(vec![b'x'; 256 * 1024]);
                    for _ in 0..64 {
                        if peer.send(payload.clone()) == SendResult::Dropped {
                            break;
                        }
                    }
                    self.burst_finished.set(true);
                }
                b"fixture-burst-state" => {
                    let state: &[u8] = if self.burst_finished.get() {
                        b"finished"
                    } else {
                        b"waiting"
                    };
                    peer.send(Bytes::from_static(state));
                }
                _ => {
                    peer.send(bytes);
                }
            }
        }
    }

    struct Fixture {
        address: SocketAddr,
        sockets: Rc<BrowserSockets>,
        auth: Rc<AuthService>,
        shutdown: CancellationToken,
        listener: JoinHandle<()>,
        _root: tempfile::TempDir,
    }

    impl Fixture {
        async fn start(auth_disabled: bool, base_path: &str, max_clients: usize) -> Self {
            Self::with_writer(
                auth_disabled,
                base_path,
                max_clients,
                Rc::new(JsonFileStore::default()),
            )
            .await
        }

        async fn with_writer(
            auth_disabled: bool,
            base_path: &str,
            max_clients: usize,
            writer: Rc<dyn AuthWriter>,
        ) -> Self {
            let root = tempfile::tempdir().unwrap();
            let clock: Rc<dyn Clock> = Rc::new(SystemClock);
            let store = AuthAccountStore::open_with_writer(
                root.path().join("auth.json").to_string_lossy().into_owned(),
                clock.clone(),
                writer,
            )
            .await
            .unwrap();
            let auth = Rc::new(AuthService::new(
                store,
                AuthTokens::new("30d".into(), clock.clone()),
                Rc::new(BunPasswords),
                clock,
            ));
            let closing = Rc::new(Cell::new(false));
            let sockets = BrowserSockets::with_handler(
                BrowserSocketOptions {
                    max_clients,
                    limits: BrowserSocketLimits::from_config(
                        Number(32_768.0),
                        Number(0.0),
                        Number(16_384.0),
                    )
                    .unwrap(),
                    auth_disabled,
                    shutting_down: closing.clone(),
                },
                auth.clone(),
                Rc::new(Echo::default()),
            )
            .unwrap();
            let router = Rc::new(
                HttpRouter::new(
                    RouteMap::new(),
                    HttpRouteOptions {
                        base_path: base_path.into(),
                        auth_disabled,
                        compression_enabled: true,
                        server_instance_id: None,
                        shutting_down: closing,
                        unported_log: None,
                    },
                    Rc::new(HttpAuthentication::new(
                        auth.clone(),
                        "fixture-local-capability".into(),
                    )),
                )
                .unwrap()
                .with_browser_sockets(sockets.clone()),
            );
            let listener = Listener::bind("0.0.0.0", 0, 1024, 0).await.unwrap();
            let address = SocketAddr::from(([127, 0, 0, 1], listener.local_addr().unwrap().port()));
            let shutdown = CancellationToken::new();
            let listener = tokio::task::spawn_local(listener.serve(
                move |request, peer| {
                    let router = router.clone();
                    async move { router.handle(request, peer).await }
                },
                shutdown.clone(),
            ));
            Self {
                address,
                sockets,
                auth,
                shutdown,
                listener,
                _root: root,
            }
        }

        async fn stop(self) {
            self.shutdown.cancel();
            self.listener.await.unwrap();
            self.sockets.shutdown().await;
        }

        async fn register(&self) -> (String, VerifiedAuthClaims) {
            let session = self
                .auth
                .register(
                    &serde_json::json!({"username":"fixture-user","password":"fixture-password"}),
                    &CancellationToken::new(),
                )
                .await
                .unwrap();
            let claims = self
                .auth
                .tokens
                .verify_auth_token_claims(&self.auth.store, Some(&session.token))
                .await
                .unwrap()
                .unwrap();
            (session.token, claims)
        }

        async fn revoke(&self, claims: &VerifiedAuthClaims) -> Result<(), Box<dyn Error>> {
            self.auth
                .store
                .revoke_session(&claims.identity.owner_key, &claims.identity.session_id)
                .await
        }
    }

    #[tokio::test]
    async fn browser_transport_matches_bun_for_compression_fragments_limits_and_close_codes() {
        LocalSet::new()
            .run_until(async {
                let fixture = Fixture::start(true, "", 16).await;
                for endpoint in ["original".to_owned(), fixture.address.port().to_string()] {
                    let output = tokio::time::timeout(
                        Duration::from_secs(30),
                        tokio::process::Command::new("bun")
                            .arg(concat!(
                                env!("CARGO_MANIFEST_DIR"),
                                "/tests/oracles/browser-websocket.ts"
                            ))
                            .arg(&endpoint)
                            .kill_on_drop(true)
                            .output(),
                    )
                    .await
                    .unwrap()
                    .unwrap();
                    assert!(
                        output.status.success(),
                        "{endpoint}: {}{}",
                        String::from_utf8_lossy(&output.stdout),
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                fixture.stop().await;
            })
            .await;
    }

    async fn upgrade_wire(
        address: SocketAddr,
        path: &str,
        extra: &str,
    ) -> (tokio::net::TcpStream, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n{extra}\r\n").as_bytes()).await.unwrap();
        let head = tokio::time::timeout(Duration::from_secs(3), async {
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                head.push(stream.read_u8().await.unwrap());
            }
            String::from_utf8(head).unwrap()
        })
        .await
        .unwrap();
        (stream, head)
    }

    const HANDSHAKE: &str =
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";

    #[tokio::test]
    async fn mounts_browser_upgrades_and_releases_admission_when_upgrade_fails() {
        LocalSet::new().run_until(async {
            let fixture = Fixture::start(true, "/tools", 1).await;
            for (path, headers, status) in [
                ("/ws", HANDSHAKE, "404"),
                ("/tools/ws/", HANDSHAKE, "404"),
                ("/tools/ws", "Sec-WebSocket-Version: 13\r\n", "400"),
                ("/tools/ws", "Sec-WebSocket-Version: 12\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n", "426"),
            ] {
                let (_, head) = upgrade_wire(fixture.address, path, headers).await;
                assert!(head.starts_with(&format!("HTTP/1.1 {status} ")), "{head}");
            }
            let (first, head) = upgrade_wire(fixture.address, "/tools/ws", HANDSHAKE).await;
            assert!(head.starts_with("HTTP/1.1 101 "), "{head}");
            let (_, head) = upgrade_wire(fixture.address, "/tools/ws", HANDSHAKE).await;
            assert!(head.starts_with("HTTP/1.1 503 "), "{head}");
            drop(first);
            fixture.stop().await;
        }).await;
    }

    #[tokio::test]
    async fn revokes_an_open_browser_and_refuses_its_token_on_the_next_upgrade() {
        use tokio::io::AsyncReadExt;

        LocalSet::new()
            .run_until(async {
                let fixture = Fixture::start(false, "", 1).await;
                let (_, head) = upgrade_wire(
                    fixture.address,
                    "/ws",
                    &format!("{HANDSHAKE}Authorization: Bearer fixture-local-capability\r\n"),
                )
                .await;
                assert!(head.starts_with("HTTP/1.1 401 "), "{head}");
                let (token, claims) = fixture.register().await;
                let headers = format!(
                    "{HANDSHAKE}Sec-WebSocket-Protocol: garcon-auth.{token}, garcon-v1\r\n"
                );
                let (mut stream, head) = upgrade_wire(fixture.address, "/ws", &headers).await;
                assert!(head.starts_with("HTTP/1.1 101 "), "{head}");
                assert!(
                    head.contains("sec-websocket-protocol: garcon-v1\r\n"),
                    "{head}"
                );
                fixture.revoke(&claims).await.unwrap();
                let mut frame = [0; 16];
                tokio::time::timeout(Duration::from_secs(3), stream.read_exact(&mut frame))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(&frame, b"\x88\x0e\x0f\xa1AUTH_REVOKED");
                let (_, head) = upgrade_wire(fixture.address, "/ws", &headers).await;
                assert!(head.starts_with("HTTP/1.1 401 "), "{head}");
                fixture.stop().await;
            })
            .await;
    }

    #[tokio::test]
    async fn issues_shutdown_close_and_refuses_later_upgrades() {
        use tokio::io::AsyncReadExt;

        LocalSet::new()
            .run_until(async {
                let fixture = Fixture::start(true, "", 1).await;
                let (mut stream, head) = upgrade_wire(fixture.address, "/ws", HANDSHAKE).await;
                assert!(head.starts_with("HTTP/1.1 101 "), "{head}");
                fixture.sockets.shutdown().await;
                let mut frame = [0; 24];
                tokio::time::timeout(Duration::from_secs(3), stream.read_exact(&mut frame))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(&frame, b"\x88\x16\x03\xe9Server shutting down");
                let (_, head) = upgrade_wire(fixture.address, "/ws", HANDSHAKE).await;
                assert!(head.starts_with("HTTP/1.1 503 "), "{head}");
                fixture.stop().await;
            })
            .await;
    }

    #[tokio::test]
    async fn rechecks_the_session_between_admission_and_open() {
        use tokio::io::AsyncReadExt;

        LocalSet::new()
            .run_until(async {
                let fixture = Fixture::start(false, "", 1).await;
                let (_, claims) = fixture.register().await;
                let reservation = fixture
                    .sockets
                    .admission
                    .try_reserve(Uuid::new_v4())
                    .unwrap();
                fixture.revoke(&claims).await.unwrap();
                let (server, mut client) = tokio::io::duplex(1024);
                let transport = BrowserTransport::new(server, None, 1024, 1024).unwrap();
                tokio::time::timeout(
                    Duration::from_secs(3),
                    fixture.sockets.open_transport(
                        transport,
                        reservation,
                        BrowserPrincipal::Authenticated(claims),
                    ),
                )
                .await
                .unwrap();
                let mut frame = [0; 16];
                client.read_exact(&mut frame).await.unwrap();
                assert_eq!(&frame, b"\x88\x0e\x0f\xa1AUTH_REVOKED");
                assert!(
                    fixture
                        .sockets
                        .admission
                        .try_reserve(Uuid::new_v4())
                        .is_ok()
                );
                fixture.stop().await;
            })
            .await;
    }

    #[derive(Default)]
    struct UncertainSessionWriter {
        armed: Cell<bool>,
        inner: JsonFileStore,
    }

    #[async_trait::async_trait(?Send)]
    impl AuthWriter for UncertainSessionWriter {
        async fn write(&self, path: &str, value: &Value) -> Result<(), AuthWriteFailure> {
            AuthWriter::write(&self.inner, path, value).await?;
            if self.armed.get() && path.ends_with("auth-sessions.json") {
                return Err(AuthWriteFailure { renamed: true });
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn storage_failure_retires_authenticated_sockets_with_unavailable_reason() {
        use tokio::io::AsyncReadExt;

        LocalSet::new()
            .run_until(async {
                let writer = Rc::new(UncertainSessionWriter::default());
                let fixture = Fixture::with_writer(false, "", 1, writer.clone()).await;
                let (token, claims) = fixture.register().await;
                let headers = format!("{HANDSHAKE}Authorization: Bearer {token}\r\n");
                let (mut stream, head) = upgrade_wire(fixture.address, "/ws", &headers).await;
                assert!(head.starts_with("HTTP/1.1 101 "), "{head}");
                writer.armed.set(true);
                assert!(fixture.revoke(&claims).await.is_err());
                let expected = b"\x88\x1a\x0f\xa2AUTH_STORAGE_UNAVAILABLE";
                let mut frame = [0; 28];
                tokio::time::timeout(Duration::from_secs(3), stream.read_exact(&mut frame))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(&frame, expected);
                let (_, head) = upgrade_wire(fixture.address, "/ws", &headers).await;
                assert!(head.starts_with("HTTP/1.1 503 "), "{head}");
                fixture.stop().await;
            })
            .await;
    }

    #[test]
    fn narrows_buns_shared_listener_limits_in_option_order() {
        let limits = |max, idle, backpressure| {
            BrowserSocketLimits::from_config(Number(max), Number(idle), Number(backpressure))
        };
        assert_eq!(limits(1.0, 960.0, 1.0).unwrap().idle_seconds, 960);
        assert_eq!(limits(1.0, 65_536.0, 1.0).unwrap().idle_seconds, 0);
        assert_eq!(
            limits(1.0, 961.0, f64::INFINITY).err(),
            Some("websocket expects idleTimeout to be 960 or less")
        );
        assert_eq!(
            limits(f64::INFINITY, 961.0, 1.0).err(),
            Some("websocket expects maxPayloadLength to be an integer")
        );
        assert_eq!(
            limits(1.0, (1_u64 << 51) as f64, 1.0).err(),
            Some("websocket expects idleTimeout to be an integer")
        );
        assert_eq!(
            limits(1.0, 0.0, f64::INFINITY).err(),
            Some("websocket expects backpressureLimit to be an integer")
        );
        let limits = limits(4_294_967_304.0, 1.0, 4_294_967_296.0).unwrap();
        assert_eq!(limits.shared_message_bytes, 8);
        assert_eq!(limits.shared_backpressure_bytes, 0);
    }

    #[test]
    fn inbound_traffic_resets_buns_ping_grace_without_requiring_a_matching_pong() {
        let started = Instant::now();
        let mut idle = IdleTimer::new(14, started);
        let at = |seconds| started + Duration::from_secs(seconds);
        assert_eq!(idle.tick(at(11)), IdleAction::Wait);
        assert_eq!(idle.tick(at(12)), IdleAction::Ping);
        idle.observe(at(13));
        assert_eq!(idle.tick(at(16)), IdleAction::Wait);
        assert_eq!(idle.tick(at(25)), IdleAction::Ping);
        assert_eq!(idle.tick(at(29)), IdleAction::Terminate);
        let mut minimum = IdleTimer::new(1, started);
        assert_eq!(minimum.tick(at(3)), IdleAction::Wait);
        assert_eq!(minimum.tick(at(4)), IdleAction::Ping);
        assert_eq!(minimum.tick(at(8)), IdleAction::Terminate);
        assert_eq!(IdleTimer::new(0, started).tick(at(3600)), IdleAction::Wait);
    }
}
