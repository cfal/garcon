use std::cell::Cell;

use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::{LocalSet, yield_now};
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::bulk_connection::{BulkConnectionTiming, BulkPhase};
use crate::limits::{BULK_CONTROL_RESERVE_MESSAGES, RPC_QUEUE_MESSAGES};
use crate::message_session::SessionSocket;
use crate::noise_ws::{NoiseFrame, NoiseTransport, RejectedWrite};
use crate::rpc::{ExecutorRpc, RpcCallOptions};
use crate::rpc_admission::RpcAdmissionBudgets;
use crate::rpc_connection::{ExecutorRpcConnection, ParkedRpcLanes, RpcConnectionOptions};
use crate::rpc_journal::{RpcReplyJournal, RpcReplyJournalOptions};
use crate::rpc_lane::{BulkConnectionControl, BulkControlType};

use super::*;

const EXECUTOR_ID: &str = "22222222-2222-4222-8222-222222222222";

fn options(role: LinkRole) -> WebSocketLinkOptions {
    let mut options = WebSocketLinkOptions::new(role, URL_SAFE_NO_PAD.encode([42; 32]));
    options.executor_id = Some(EXECUTOR_ID.to_owned());
    options.no_tls = true;
    options.redial_delays_ms = Some(vec![20]);
    options
}

async fn within<T>(future: impl Future<Output = T>) -> T {
    timeout(Duration::from_secs(3), future).await.unwrap()
}

async fn eventually(mut condition: impl FnMut() -> bool) {
    within(async {
        while !condition() {
            sleep(Duration::from_millis(2)).await;
        }
    })
    .await;
}

async fn listen(link: &Rc<WebSocketLink>) -> String {
    link.listen(0, "0.0.0.0", None).await.unwrap()
}

fn connected(link: &WebSocketLink) -> Option<Rc<SessionTransport>> {
    link.current().filter(|session| session.connected())
}

fn raw_worker(address: &str, hello: LinkHello) -> Rc<NoiseConnection> {
    let hello = Opaque::parse(&serde_json::to_string(&hello).unwrap()).unwrap();
    let peer = RefCell::new(None);
    connect_noise_web_socket(
        address,
        NoiseClientOptions {
            psk: vec![42; 32],
            context: EXECUTOR_NOISE_CONTEXT.to_owned(),
            limits: None,
            on_open: Some(Rc::new({
                let hello = hello.clone();
                move |socket, ()| {
                    socket.send(NoiseMessage::Text(stringify(hello.as_value())))?;
                    Ok(())
                }
            })),
            on_message: Rc::new(move |socket, message| {
                let NoiseMessage::Text(message) = message else {
                    return Ok(());
                };
                let frame = parse(&message).unwrap();
                if frame["type"] == "hello" {
                    *peer.borrow_mut() = Some(frame);
                } else if frame["type"] == "proof" {
                    let transcript = json!([
                        "garcon-executor",
                        "worker",
                        [peer.borrow().as_ref().unwrap(), hello.as_value()]
                    ]);
                    let secret = URL_SAFE_NO_PAD.encode([42; 32]);
                    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
                    mac.update(stringify(&transcript).as_bytes());
                    socket.send(NoiseMessage::Text(
                        json!({
                            "type": "proof", "signature": hex(&mac.finalize().into_bytes())
                        })
                        .to_string(),
                    ))?;
                }
                Ok(())
            }),
            on_error: None,
            on_close: None,
            tls: None,
            allow_unverified_tls: false,
            signal: None,
        },
    )
    .unwrap()
}

fn worker_hello() -> LinkHello {
    LinkHello {
        version: LINK_VERSION.clone(),
        role: LinkRole::Worker,
        executor_id: Some(EXECUTOR_ID.to_owned()),
        runtime_id: "synthetic-runtime".to_owned(),
        nonce: "42".repeat(32),
        lane: RpcLane::Primary,
        session_id: None,
        primary_session_id: None,
    }
}

#[derive(Clone, Copy, Default)]
enum Fault {
    #[default]
    None,
    Blackhole,
    FirstFrameOnly,
    Corrupt,
    Short,
    FailWrite,
    FullBuffer,
}

struct EncryptedWire {
    peer: Weak<NoiseConnection>,
    fault: Rc<Cell<Fault>>,
}

impl NoiseTransport for EncryptedWire {
    fn buffered_amount(&self) -> usize {
        if matches!(self.fault.get(), Fault::FullBuffer) {
            32 * 1024 * 1024
        } else {
            0
        }
    }

    fn write(&self, mut frame: Vec<u8>) -> Result<(), RejectedWrite> {
        match self.fault.get() {
            Fault::Blackhole => return Ok(()),
            Fault::FirstFrameOnly => self.fault.set(Fault::Blackhole),
            Fault::Corrupt => frame[0] ^= 1,
            Fault::Short => frame.truncate(8),
            Fault::FailWrite => return Err(RejectedWrite),
            _ => {}
        }
        let peer = self.peer.upgrade().ok_or(RejectedWrite)?;
        spawn_local(async move { peer.receive(NoiseFrame::Binary(&frame)) });
        Ok(())
    }

    fn close(&self) {
        if let Some(peer) = self.peer.upgrade() {
            spawn_local(async move { peer.fail(NoiseErrorCode::TransportClosed) });
        }
    }

    fn abort(&self) {
        self.close();
    }
}

struct EncryptedPath {
    from_left: Rc<Cell<Fault>>,
    from_right: Rc<Cell<Fault>>,
    left: Rc<NoiseConnection>,
    right: Rc<NoiseConnection>,
}

fn connect_in_memory(
    left: &Rc<WebSocketLink>,
    right: &Rc<WebSocketLink>,
    target: LinkDialTarget,
) -> EncryptedPath {
    connect_with_fault(left, right, target, Fault::None)
}

fn connect_with_fault(
    left: &Rc<WebSocketLink>,
    right: &Rc<WebSocketLink>,
    target: LinkDialTarget,
    fault: Fault,
) -> EncryptedPath {
    let a = NoiseConnection::new(true, left.noise_options(Some(target)), None).unwrap();
    let b = NoiseConnection::new(false, right.noise_options(None), None).unwrap();
    left.track_socket(a.clone(), None);
    right.track_socket(b.clone(), None);
    let from_left = Rc::new(Cell::new(fault));
    let from_right = Rc::default();
    b.attach(Rc::new(EncryptedWire {
        peer: Rc::downgrade(&a),
        fault: Rc::clone(&from_right),
    }));
    a.attach(Rc::new(EncryptedWire {
        peer: Rc::downgrade(&b),
        fault: Rc::clone(&from_left),
    }));
    EncryptedPath {
        from_left,
        from_right,
        left: a,
        right: b,
    }
}

fn primary_target() -> LinkDialTarget {
    LinkDialTarget {
        lane: RpcLane::Primary,
        session_id: None,
        primary_session_id: None,
    }
}

fn closures(link: &WebSocketLink) -> mpsc::UnboundedReceiver<LinkClosure> {
    let (send, receive) = mpsc::unbounded_channel();
    let _off = link.on_closure(Rc::new(move |closure| {
        let _ = send.send(closure.clone());
    }));
    receive
}

#[tokio::test(start_paused = true)]
async fn displaces_unproven_sockets_before_proven_ones_and_never_displaces_an_open_socket() {
    LocalSet::new()
        .run_until(async {
            let controller = WebSocketLink::new(options(LinkRole::Controller)).unwrap();
            let worker = WebSocketLink::new(options(LinkRole::Worker)).unwrap();
            let _opened = connect_in_memory(&worker, &controller, primary_target());
            within(controller.ready()).await.unwrap();
            let proving_peer = WebSocketLink::new(options(LinkRole::Worker)).unwrap();
            let proven = connect_with_fault(
                &proving_peer,
                &controller,
                primary_target(),
                Fault::FirstFrameOnly,
            );
            eventually(|| proven.right.ready_state() == NoiseReadyState::Confirming).await;
            let silent = NoiseConnection::new(false, controller.noise_options(None), None).unwrap();
            controller.track_socket(silent.clone(), None);
            let to_displace = displaceable_socket(&controller.state.borrow()).unwrap();
            assert!(Rc::ptr_eq(&to_displace, &silent));
            to_displace.close();
            let to_displace = displaceable_socket(&controller.state.borrow()).unwrap();
            assert!(Rc::ptr_eq(&to_displace, &proven.right));
            to_displace.close();
            assert!(displaceable_socket(&controller.state.borrow()).is_none());
            assert!(controller.current().unwrap().connected());
            controller.dispose().await;
            worker.dispose().await;
            proving_peer.dispose().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn reports_a_dial_whose_encrypted_handshake_never_completes() {
    LocalSet::new()
        .run_until(async {
            let mut config = options(LinkRole::Controller);
            config.noise_limits = Some(NoiseLimits {
                handshake_timeout_ms: Some(50),
                ..NoiseLimits::default()
            });
            let controller = WebSocketLink::new(config).unwrap();
            let worker = WebSocketLink::new(options(LinkRole::Worker)).unwrap();
            let (send, mut failures) = mpsc::unbounded_channel();
            let _off =
                controller.on_error(Rc::new(move |failure| send.send(failure.clone()).unwrap()));
            let _blackhole =
                connect_with_fault(&controller, &worker, primary_target(), Fault::Blackhole);
            assert_eq!(
                within(failures.recv()).await.unwrap(),
                LinkFailure {
                    lane: Some(RpcLane::Primary),
                    message: "Executor encrypted connection failed (HANDSHAKE_TIMEOUT)".to_owned(),
                    count: 1,
                    reason: None,
                }
            );
            assert!(controller.current().is_none());
            controller.dispose().await;
            worker.dispose().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn closure_diagnostics_distinguish_noise_record_errors_socket_writes_and_network_loss() {
    LocalSet::new()
        .run_until(async {
            use LinkClosureCause::{ProtocolError, SocketClosed, SocketError};
            for dialer in [LinkRole::Controller, LinkRole::Worker] {
                let other = if dialer == LinkRole::Controller {
                    LinkRole::Worker
                } else {
                    LinkRole::Controller
                };
                for (fault, left_cause, left_reason, right_cause, right_reason) in [
                    (
                        Fault::Corrupt,
                        SocketClosed,
                        "TRANSPORT_CLOSED",
                        ProtocolError,
                        "AUTHENTICATION_FAILED",
                    ),
                    (
                        Fault::Short,
                        SocketClosed,
                        "TRANSPORT_CLOSED",
                        ProtocolError,
                        "PROTOCOL_ERROR",
                    ),
                    (
                        Fault::FailWrite,
                        SocketError,
                        "TRANSPORT_ERROR",
                        SocketClosed,
                        "TRANSPORT_CLOSED",
                    ),
                    (
                        Fault::FullBuffer,
                        SocketError,
                        "BACKPRESSURE",
                        SocketClosed,
                        "TRANSPORT_CLOSED",
                    ),
                    (
                        Fault::Blackhole,
                        SocketClosed,
                        "TRANSPORT_CLOSED",
                        SocketClosed,
                        "TRANSPORT_CLOSED",
                    ),
                ] {
                    let left = WebSocketLink::new(options(dialer)).unwrap();
                    let right = WebSocketLink::new(options(other)).unwrap();
                    let mut left_closed = closures(&left);
                    let mut right_closed = closures(&right);
                    let path = connect_in_memory(&left, &right, primary_target());
                    let sending = within(left.ready()).await.unwrap();
                    within(right.ready()).await.unwrap();
                    path.from_left.set(fault);
                    match fault {
                        Fault::Blackhole => {
                            path.left.fail(NoiseErrorCode::TransportClosed);
                            path.right.fail(NoiseErrorCode::TransportClosed);
                        }
                        Fault::FullBuffer => path.left.close(),
                        _ => {
                            let _ = sending.send("synthetic payload".to_owned());
                        }
                    }
                    for (closure, cause, reason) in [
                        (
                            within(left_closed.recv()).await.unwrap(),
                            left_cause,
                            left_reason,
                        ),
                        (
                            within(right_closed.recv()).await.unwrap(),
                            right_cause,
                            right_reason,
                        ),
                    ] {
                        assert_primary_closure(
                            closure,
                            &sending.id,
                            cause,
                            1,
                            Some(&format!("Encrypted connection failed ({reason})")),
                        );
                    }
                    assert!(left_closed.try_recv().is_err());
                    assert!(right_closed.try_recv().is_err());
                    left.dispose().await;
                    right.dispose().await;
                }
            }
        })
        .await;
}

#[tokio::test]
async fn reconnects_after_exhausting_record_budget_and_keeps_new_session_usable() {
    LocalSet::new()
        .run_until(async {
            for dialer in [LinkRole::Controller, LinkRole::Worker] {
                let configured = |role| {
                    let mut config = options(role);
                    config.noise_limits = Some(NoiseLimits {
                        max_records_per_direction: Some(32),
                        ..NoiseLimits::default()
                    });
                    WebSocketLink::new(config).unwrap()
                };
                let controller = configured(LinkRole::Controller);
                let worker = configured(LinkRole::Worker);
                let mut worker_closed = closures(&worker);
                let mut controller_closed = closures(&controller);
                let (dialing, listening) = if dialer == LinkRole::Controller {
                    (&controller, &worker)
                } else {
                    (&worker, &controller)
                };
                dialing.dial(&listen(listening).await).unwrap();
                let sending = within(worker.ready()).await.unwrap();
                within(controller.ready()).await.unwrap();
                let mut rejected = false;
                for index in 0..32 {
                    if sending.send(format!("synthetic message {index}")).is_err() {
                        rejected = true;
                        break;
                    }
                }
                assert!(rejected);
                assert_primary_closure(
                    within(worker_closed.recv()).await.unwrap(),
                    &sending.id,
                    LinkClosureCause::RecordLimit,
                    1,
                    Some("Encrypted connection failed (RECORD_LIMIT)"),
                );
                assert_primary_closure(
                    within(controller_closed.recv()).await.unwrap(),
                    &sending.id,
                    LinkClosureCause::SocketClosed,
                    1,
                    Some("Encrypted connection failed (TRANSPORT_CLOSED)"),
                );
                eventually(|| {
                    connected(&worker).is_some_and(|next| next.id != sending.id)
                        && connected(&controller).is_some_and(|next| next.id != sending.id)
                })
                .await;
                let (send, mut received) = mpsc::unbounded_channel();
                let _off = controller
                    .current()
                    .unwrap()
                    .on_message(Rc::new(move |message| {
                        send.send(message.to_owned()).unwrap();
                        Ok(())
                    }));
                worker
                    .current()
                    .unwrap()
                    .send("new encrypted session".to_owned())
                    .unwrap();
                assert_eq!(
                    within(received.recv()).await.as_deref(),
                    Some("new encrypted session")
                );
                worker.dispose().await;
                controller.dispose().await;
            }
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn oversized_encrypted_messages_are_attributed_to_the_receiver() {
    LocalSet::new()
        .run_until(async {
            let mut config = options(LinkRole::Controller);
            config.noise_limits = Some(NoiseLimits {
                max_message_bytes: Some(1024),
                ..NoiseLimits::default()
            });
            let controller = WebSocketLink::new(config).unwrap();
            let worker = WebSocketLink::new(options(LinkRole::Worker)).unwrap();
            let mut closure = closures(&controller);
            let _path = connect_in_memory(&worker, &controller, primary_target());
            let sending = within(worker.ready()).await.unwrap();
            within(controller.ready()).await.unwrap();
            sending.send("x".repeat(4096)).unwrap();
            assert_primary_closure(
                within(closure.recv()).await.unwrap(),
                &sending.id,
                LinkClosureCause::ProtocolError,
                1,
                Some("Encrypted connection failed (MESSAGE_TOO_LARGE)"),
            );
            worker.dispose().await;
            controller.dispose().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn counts_an_encrypted_message_that_never_completes_as_a_liveness_timeout() {
    LocalSet::new()
        .run_until(async {
            let mut config = options(LinkRole::Controller);
            config.noise_limits = Some(NoiseLimits {
                message_timeout_ms: Some(20),
                ..NoiseLimits::default()
            });
            let controller = WebSocketLink::new(config).unwrap();
            let worker = WebSocketLink::new(options(LinkRole::Worker)).unwrap();
            let mut closed = closures(&controller);
            let path = connect_in_memory(&worker, &controller, primary_target());
            within(worker.ready()).await.unwrap();
            let receiving = within(controller.ready()).await.unwrap();
            path.from_left.set(Fault::FirstFrameOnly);
            path.left
                .send(NoiseMessage::Binary(vec![0; 70_000]))
                .unwrap();
            assert_primary_closure(
                within(closed.recv()).await.unwrap(),
                &receiving.id,
                LinkClosureCause::LivenessTimeout,
                1,
                Some("Encrypted connection failed (MESSAGE_TIMEOUT)"),
            );
            assert!(!receiving.connected());
            worker.dispose().await;
            controller.dispose().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn slow_bulk_stays_live_and_silent_bulk_retires_without_primary_loss_in_either_direction() {
    LocalSet::new()
        .run_until(async {
            for dialer in [LinkRole::Controller, LinkRole::Worker] {
                let other = if dialer == LinkRole::Controller {
                    LinkRole::Worker
                } else {
                    LinkRole::Controller
                };
                let left = WebSocketLink::new(options(dialer)).unwrap();
                let right = WebSocketLink::new(options(other)).unwrap();
                let _primary = connect_in_memory(&left, &right, primary_target());
                let sending = within(left.ready()).await.unwrap();
                let receiving = within(right.ready()).await.unwrap();
                let id = uuid::Uuid::new_v4().to_string();
                left.prepare_bulk(&sending, id.clone()).unwrap();
                right.prepare_bulk(&receiving, id.clone()).unwrap();
                let path = connect_in_memory(
                    &left,
                    &right,
                    LinkDialTarget {
                        lane: RpcLane::Bulk,
                        session_id: Some(id),
                        primary_session_id: Some(sending.id.clone()),
                    },
                );
                eventually(|| {
                    left.bulk().is_some_and(|session| session.connected())
                        && right.bulk().is_some_and(|session| session.connected())
                })
                .await;
                let mut left_closed = closures(&left);
                let mut right_closed = closures(&right);
                let bulk = right.bulk().unwrap();
                let (send, mut received) = mpsc::unbounded_channel();
                let _unsubscribe = bulk.on_message(Rc::new(move |message| {
                    send.send(message.to_owned()).unwrap();
                    Ok(())
                }));
                const FRAGMENT: usize = 32 * 1024;
                // A peer with no heartbeat task proves that fragments alone keep
                // the receiver live. Its outbound records must stay in sequence.
                let peer = left
                    .state
                    .borrow()
                    .connections
                    .iter()
                    .find(|connection| Rc::ptr_eq(&connection.socket, &path.left))
                    .unwrap()
                    .clone();
                peer.state.borrow_mut().heartbeat.take().unwrap().abort();
                path.from_right.set(Fault::Blackhole);
                for _ in 0..7 {
                    let mut fragment = vec![b'x'; 1 + FRAGMENT];
                    fragment[0] = 0;
                    path.left.send(NoiseMessage::Binary(fragment)).unwrap();
                    yield_now().await;
                    tokio::time::advance(Duration::from_millis(2700)).await;
                }
                path.left.send(NoiseMessage::Binary(vec![1, b'x'])).unwrap();
                assert_eq!(
                    within(received.recv()).await.unwrap(),
                    "x".repeat(7 * FRAGMENT + 1)
                );
                assert!(left_closed.try_recv().is_err());
                assert!(right_closed.try_recv().is_err());

                path.from_left.set(Fault::Blackhole);
                tokio::time::sleep(Duration::from_secs(21)).await;
                let left_closure = within(left_closed.recv()).await.unwrap();
                let right_closure = within(right_closed.recv()).await.unwrap();
                assert!(
                    left_closure.cause == LinkClosureCause::LivenessTimeout
                        || right_closure.cause == LinkClosureCause::LivenessTimeout
                );
                for closure in [left_closure, right_closure] {
                    assert_eq!(closure.lane, RpcLane::Bulk);
                    assert_eq!(closure.session_id, bulk.id);
                    assert_eq!(closure.primary_session_id, sending.id);
                    assert_eq!(closure.count, 1);
                }
                assert!(Rc::ptr_eq(&left.current().unwrap(), &sending));
                assert!(Rc::ptr_eq(&right.current().unwrap(), &receiving));
                assert!(sending.connected() && receiving.connected());
                left.dispose().await;
                right.dispose().await;
            }
        })
        .await;
}

async fn probe(address: &str, headers: &str) -> u16 {
    let address = Url::parse(address).unwrap();
    let mut socket = TcpStream::connect(address.authority()).await.unwrap();
    socket
        .write_all(
            format!(
                "GET /executor HTTP/1.1\r\nHost: {}\r\n{headers}\r\n",
                address.authority(),
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut head = [0; 12];
    within(socket.read_exact(&mut head)).await.unwrap();
    std::str::from_utf8(&head[9..]).unwrap().parse().unwrap()
}

#[tokio::test(start_paused = true)]
async fn accept_continues_after_aborted_clients_and_backs_off_on_other_errors() {
    use std::io::{Error, ErrorKind};
    let mut accepts = [
        Err(Error::from(ErrorKind::ConnectionAborted)),
        Err(Error::from(ErrorKind::ConnectionReset)),
        Err(Error::from(ErrorKind::ConnectionRefused)),
        Err(Error::from(ErrorKind::Interrupted)),
        Err(Error::other("synthetic resource exhaustion")),
        Ok("next client"),
    ]
    .into_iter();
    let started = Instant::now();
    let next = within(accept_client(&CancellationToken::new(), || {
        std::future::ready(accepts.next().unwrap())
    }))
    .await;
    assert_eq!(next, Some("next client"));
    assert!(started.elapsed() > Duration::ZERO);
}

#[tokio::test]
async fn listener_advertises_the_requested_dns_name() {
    LocalSet::new()
        .run_until(async {
            let link = WebSocketLink::new(options(LinkRole::Worker)).unwrap();
            let address = link.listen(0, "localhost", None).await.unwrap();
            let url = Url::parse(&address).unwrap();
            assert_eq!(url.host_str(), Some("localhost"));
            assert_ne!(url.port(), Some(0));
            assert_eq!(url.path(), "/executor");
            link.dispose().await;
        })
        .await;
}

#[tokio::test]
async fn repeated_connection_headers_allow_upgrade_and_preserve_version_diagnostics() {
    use futures::StreamExt;
    const HEADERS: &str = "Upgrade: websocket\r\nConnection: keep-alive\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
    LocalSet::new()
        .run_until(async {
            let link = WebSocketLink::new(options(LinkRole::Worker)).unwrap();
            let address = listen(&link).await;
            assert_eq!(
                probe(&address, &format!("{HEADERS}Sec-WebSocket-Version: 12\r\n")).await,
                426
            );
            let mut silent = Vec::new();
            for _ in 0..MAX_SOCKETS {
                silent.push(within(connect_async(&address)).await.unwrap().0);
            }
            assert_eq!(
                probe(&address, &format!("{HEADERS}Sec-WebSocket-Version: 13\r\n")).await,
                101
            );
            assert!(matches!(
                within(silent[0].next()).await,
                None | Some(Err(_) | Ok(Message::Close(_)))
            ));
            assert!(
                timeout(Duration::from_millis(20), silent[1].next())
                    .await
                    .is_err()
            );
            link.dispose().await;
        })
        .await;
}

#[test]
fn repeated_upgrade_headers_do_not_look_like_a_single_websocket_upgrade() {
    let request = Request::builder()
        .header("Upgrade", "WebSocket")
        .header("Upgrade", "h2c")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    assert!(!is_web_socket_upgrade(&request));
}

#[tokio::test]
async fn invalid_upgrades_do_not_evict_sockets_but_a_valid_peer_displaces_the_oldest_pending_socket()
 {
    use futures::StreamExt;

    LocalSet::new()
        .run_until(async {
            let mut config = options(LinkRole::Controller);
            config.noise_limits = Some(NoiseLimits {
                handshake_timeout_ms: Some(60_000),
                ..NoiseLimits::default()
            });
            let controller = WebSocketLink::new(config).unwrap();
            let worker = WebSocketLink::new(options(LinkRole::Worker)).unwrap();
            let address = listen(&controller).await;
            let failures = Rc::new(Cell::new(0));
            let _off = controller.on_error(Rc::new({
                let failures = failures.clone();
                move |_| failures.set(failures.get() + 1)
            }));
            let mut silent = Vec::new();
            for _ in 0..MAX_SOCKETS {
                silent.push(within(connect_async(&address)).await.unwrap().0);
            }
            assert_eq!(probe(&address, "").await, 400);
            assert_eq!(
                probe(
                    &address,
                    "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
                )
                .await,
                400
            );
            assert!(
                timeout(Duration::from_millis(50), silent[0].next())
                    .await
                    .is_err()
            );

            worker.dial(&address).unwrap();
            within(controller.ready()).await.unwrap();
            within(worker.ready()).await.unwrap();
            let oldest = within(silent[0].next()).await;
            assert!(matches!(
                oldest,
                None | Some(Err(_) | Ok(Message::Close(_)))
            ));
            for survivor in &mut silent[1..] {
                assert!(
                    timeout(Duration::from_millis(20), survivor.next())
                        .await
                        .is_err()
                );
            }
            assert_eq!(failures.get(), 0);
            worker.dispose().await;
            controller.dispose().await;
        })
        .await;
}

#[tokio::test]
async fn reports_a_peer_that_never_starts_the_encrypted_handshake() {
    LocalSet::new()
        .run_until(async {
            let mut config = options(LinkRole::Controller);
            config.noise_limits = Some(NoiseLimits {
                handshake_timeout_ms: Some(50),
                ..NoiseLimits::default()
            });
            let link = WebSocketLink::new(config).unwrap();
            let (send, mut failures) = mpsc::unbounded_channel();
            let _off = link.on_error(Rc::new(move |failure| send.send(failure.clone()).unwrap()));
            let _silent = within(connect_async(listen(&link).await)).await.unwrap();
            let failure = within(failures.recv()).await.unwrap();
            assert_eq!(
                failure,
                LinkFailure {
                    lane: None,
                    message: "Executor encrypted connection failed (HANDSHAKE_TIMEOUT)".to_owned(),
                    count: 1,
                    reason: None,
                }
            );
            assert!(link.current().is_none());
            link.dispose().await;
        })
        .await;
}

#[tokio::test]
async fn bulk_rejects_stale_grants_peer_identities_versions_and_duplicates_without_retiring_primary()
 {
    LocalSet::new()
        .run_until(async {
            let controller = WebSocketLink::new(options(LinkRole::Controller)).unwrap();
            let worker = WebSocketLink::new(options(LinkRole::Worker)).unwrap();
            let address = listen(&controller).await;
            worker.dial(&address).unwrap();
            let primary = within(controller.ready()).await.unwrap();
            let peer = within(worker.ready()).await.unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            controller.prepare_bulk(&primary, id.clone()).unwrap();
            worker.prepare_bulk(&peer, id.clone()).unwrap();
            let valid = LinkHello {
                executor_id: Some(primary.executor_id.clone()),
                runtime_id: worker.runtime_id.clone(),
                lane: RpcLane::Bulk,
                session_id: Some(id.clone()),
                primary_session_id: Some(primary.id.clone()),
                ..worker_hello()
            };
            for invalid in [
                LinkHello {
                    session_id: Some(uuid::Uuid::new_v4().to_string()),
                    ..valid.clone()
                },
                LinkHello {
                    primary_session_id: Some(uuid::Uuid::new_v4().to_string()),
                    ..valid.clone()
                },
                LinkHello {
                    runtime_id: "a-different-runtime".to_owned(),
                    ..valid.clone()
                },
                LinkHello {
                    executor_id: Some("another-executor".to_owned()),
                    ..valid.clone()
                },
                LinkHello {
                    version: "wrong-version".to_owned(),
                    ..valid.clone()
                },
            ] {
                let attempted = raw_worker(&address, invalid);
                within(attempted.closed()).await;
                assert!(controller.bulk().is_none());
                assert!(primary.connected() && peer.connected());
            }
            worker.dial_bulk(&peer, &id).unwrap();
            eventually(|| {
                controller.bulk().is_some_and(|bulk| bulk.connected())
                    && worker.bulk().is_some_and(|bulk| bulk.connected())
            })
            .await;
            let bulk = controller.bulk().unwrap();
            assert_eq!(bulk.id, id);
            assert_eq!(bulk.primary_session_id, primary.id);
            assert_eq!(bulk.peer_runtime_id, primary.peer_runtime_id);
            within(raw_worker(&address, valid.clone()).closed()).await;
            assert!(Rc::ptr_eq(&bulk, &controller.bulk().unwrap()));
            assert!(bulk.connected() && primary.connected());
            controller
                .prepare_bulk(&primary, uuid::Uuid::new_v4().to_string())
                .unwrap();
            within(raw_worker(&address, valid).closed()).await;
            assert!(controller.bulk().is_none());
            assert!(primary.connected());
            worker.dispose().await;
            controller.dispose().await;
        })
        .await;
}

#[tokio::test]
async fn reports_a_lost_connection_while_its_session_is_current_before_its_closure() {
    LocalSet::new()
        .run_until(async {
            let link = WebSocketLink::new(options(LinkRole::Controller)).unwrap();
            let events = Rc::new(RefCell::new(Vec::new()));
            let _on_error = link.on_error(Rc::new({
                let weak = Rc::downgrade(&link);
                let events = events.clone();
                move |failure| {
                    assert!(weak.upgrade().unwrap().current().is_some());
                    assert_eq!(failure.message, "Executor connection lost");
                    assert_eq!(
                        failure.reason.as_deref(),
                        Some("Session packets require binary framing")
                    );
                    events.borrow_mut().push("failure");
                }
            }));
            let _on_closure = link.on_closure(Rc::new({
                let events = events.clone();
                move |closure| {
                    assert_eq!(closure.cause, LinkClosureCause::ProtocolError);
                    assert_eq!(closure.count, 1);
                    events.borrow_mut().push("closure");
                }
            }));
            let peer = raw_worker(&listen(&link).await, worker_hello());
            let session = within(link.ready()).await.unwrap();
            peer.send(NoiseMessage::Text("synthetic text frame".to_owned()))
                .unwrap();
            eventually(|| events.borrow().len() == 2).await;
            assert_eq!(*events.borrow(), ["failure", "closure"]);
            assert!(!session.connected());
            assert!(link.current().is_none());
            peer.close();
            link.dispose().await;
        })
        .await;
}

fn assert_primary_closure(
    closure: LinkClosure,
    id: &str,
    cause: LinkClosureCause,
    count: usize,
    reason: Option<&str>,
) {
    assert_eq!(closure.lane, RpcLane::Primary);
    assert_eq!(closure.session_id, id);
    assert_eq!(closure.primary_session_id, id);
    assert!(closure.queues.is_some());
    assert_eq!(closure.cause, cause);
    assert_eq!(closure.count, count);
    assert_eq!(closure.reason.as_deref(), reason);
}

#[tokio::test]
async fn counts_session_closures_by_cause_and_attributes_retirement_and_disposal_in_each_direction()
{
    LocalSet::new()
        .run_until(async {
            for dialer in [LinkRole::Controller, LinkRole::Worker] {
                let dialing = WebSocketLink::new(options(dialer)).unwrap();
                let peer_role = if dialer == LinkRole::Controller {
                    LinkRole::Worker
                } else {
                    LinkRole::Controller
                };
                let listening = WebSocketLink::new(options(peer_role)).unwrap();
                let (send_dialing, mut dialing_events) = mpsc::unbounded_channel();
                let _off_dialing = dialing.on_closure(Rc::new(move |closure| {
                    let _ = send_dialing.send(closure.clone());
                }));
                let (send_listening, mut listening_events) = mpsc::unbounded_channel();
                let _off_listening = listening.on_closure(Rc::new(move |closure| {
                    let _ = send_listening.send(closure.clone());
                }));
                dialing.dial(&listen(&listening).await).unwrap();
                within(dialing.ready()).await.unwrap();
                within(listening.ready()).await.unwrap();

                for count in 1..=2 {
                    let id = connected(&dialing).unwrap().id.clone();
                    listening.disconnect();
                    assert_primary_closure(
                        within(listening_events.recv()).await.unwrap(),
                        &id,
                        LinkClosureCause::LocalClose,
                        count,
                        None,
                    );
                    assert_primary_closure(
                        within(dialing_events.recv()).await.unwrap(),
                        &id,
                        LinkClosureCause::SocketClosed,
                        count,
                        None,
                    );
                    eventually(|| {
                        connected(&dialing).is_some_and(|session| session.id != id)
                            && connected(&listening).is_some_and(|session| session.id != id)
                    })
                    .await;
                }
                let session = connected(&dialing).unwrap();
                session.close(Some(Rc::new(LinkError("Synthetic session retirement"))));
                assert_primary_closure(
                    within(dialing_events.recv()).await.unwrap(),
                    &session.id,
                    LinkClosureCause::SessionRetired,
                    1,
                    Some("Synthetic session retirement"),
                );
                assert_primary_closure(
                    within(listening_events.recv()).await.unwrap(),
                    &session.id,
                    LinkClosureCause::SocketClosed,
                    1,
                    None,
                );
                eventually(|| {
                    connected(&dialing).is_some_and(|next| next.id != session.id)
                        && connected(&listening).is_some_and(|next| next.id != session.id)
                })
                .await;
                let id = connected(&listening).unwrap().id.clone();
                listening.dispose().await;
                assert_primary_closure(
                    within(listening_events.recv()).await.unwrap(),
                    &id,
                    LinkClosureCause::LocalClose,
                    3,
                    None,
                );
                assert_primary_closure(
                    within(dialing_events.recv()).await.unwrap(),
                    &id,
                    LinkClosureCause::SocketClosed,
                    3,
                    None,
                );
                dialing.dispose().await;
            }
        })
        .await;
}

#[tokio::test]
async fn redials_at_once_after_a_stable_session_and_backs_off_after_a_short_one() {
    LocalSet::new()
        .run_until(async {
            for dialer in [LinkRole::Controller, LinkRole::Worker] {
                let other = if dialer == LinkRole::Controller {
                    LinkRole::Worker
                } else {
                    LinkRole::Controller
                };
                let mut config = options(dialer);
                config.redial_delays_ms = Some(vec![0, 60_000]);
                config.stable_session_ms = Some(250);
                let dialing = WebSocketLink::new(config).unwrap();
                let listening = WebSocketLink::new(options(other)).unwrap();
                dialing.dial(&listen(&listening).await).unwrap();
                let first = within(dialing.ready()).await.unwrap();
                within(listening.ready()).await.unwrap();
                sleep(Duration::from_millis(275)).await;
                listening.disconnect();
                eventually(|| {
                    connected(&dialing).is_some_and(|next| next.id != first.id)
                        && connected(&listening).is_some_and(|next| next.id != first.id)
                })
                .await;
                listening.disconnect();
                eventually(|| dialing.current().is_none()).await;
                sleep(Duration::from_millis(50)).await;
                assert!(dialing.current().is_none());
                assert!(listening.current().is_none());
                dialing.dispose().await;
                listening.dispose().await;
            }
        })
        .await;
}

#[test]
fn link_failures_count_by_kind_and_reason_and_log_at_powers_of_two() {
    let link = WebSocketLink::new(options(LinkRole::Worker)).unwrap();
    let reports = Rc::new(RefCell::new(Vec::new()));
    let _off = link.on_error(Rc::new({
        let reports = reports.clone();
        move |failure| reports.borrow_mut().push(failure.clone())
    }));
    for (kind, reason) in [
        ("KEY", "original"),
        ("CONTEXT", "separate"),
        ("KEY", "original"),
        ("KEY", "different"),
    ] {
        link.report_failure(
            kind,
            "Synthetic failure".into(),
            Some(reason.into()),
            Some(RpcLane::Primary),
        );
    }
    assert_eq!(
        reports
            .borrow()
            .iter()
            .map(|report| report.count)
            .collect::<Vec<_>>(),
        [1, 1, 2, 1]
    );
    let mut report = reports.borrow()[0].clone();
    let logged: Vec<_> = (1..=16)
        .filter(|count| {
            report.count = *count;
            should_log_link_failure(&report)
        })
        .collect();
    assert_eq!(logged, [1, 2, 4, 8, 16]);
}

#[derive(Default)]
struct Gate {
    blocked: Cell<bool>,
    sent: RefCell<Vec<Value>>,
}

impl SessionSocket for Gate {
    fn send(&self, frame: String) -> Result<(), SessionError> {
        self.sent.borrow_mut().push(parse(&frame).unwrap());
        Ok(())
    }

    fn close(&self) {}

    fn can_send(&self, _: usize) -> bool {
        !self.blocked.get()
    }
}

fn gated_primary(role: LinkRole) -> (Rc<WebSocketLink>, Rc<SessionTransport>, Rc<Gate>) {
    let link = WebSocketLink::new(options(role)).unwrap();
    let primary = SessionTransport::new(
        uuid::Uuid::new_v4().to_string(),
        "synthetic-peer".to_owned(),
        Rc::new(|_| {}),
        SessionTransportOptions {
            budget: Some(link.queue_budget.clone()),
            ..SessionTransportOptions::default()
        },
    )
    .unwrap();
    let gate = Rc::new(Gate::default());
    gate.blocked.set(true);
    primary.attach(gate.clone()).unwrap();
    link.state.borrow_mut().current = Some(primary.clone());
    (link, primary, gate)
}

fn not_dispatched<T>(result: Result<T, SessionError>) {
    let Err(error) = result else {
        panic!("unavailable connection returned an endpoint")
    };
    assert_eq!(
        error.downcast_ref::<AgentCallError>().unwrap().outcome,
        AgentDeliveryOutcome::NotDispatched
    );
}

#[tokio::test]
async fn bulk_setup_timeout_captures_phase_identities_retry_and_pressure_without_closing_primary() {
    LocalSet::new()
        .run_until(async {
            let (link, primary, _) = gated_primary(LinkRole::Controller);
            let (send, mut failures) = mpsc::unbounded_channel();
            let connection = ExecutorRpcConnection::new(
                link.clone(),
                primary.clone(),
                RpcConnectionOptions {
                    bulk_timing: BulkConnectionTiming {
                        setup_timeout_ms: Some(300),
                        redial_delays_ms: Some(vec![60_000]),
                        ..BulkConnectionTiming::default()
                    },
                    bulk_failed: Some(Rc::new(move |failure| send.send(failure).unwrap())),
                    ..RpcConnectionOptions::default()
                },
            )
            .unwrap();
            connection.activate().unwrap();
            let attempt = connection.status().session_id.unwrap();
            let report = within(failures.recv()).await.unwrap();
            let failure = report.failure;
            assert_eq!(failure.lane, RpcLane::Bulk);
            assert_eq!(failure.phase, BulkPhase::Preparing);
            assert_eq!(failure.primary_session_id, primary.id);
            assert_eq!(failure.session_id, attempt);
            assert_eq!(failure.reason, "Bulk preparing timed out");
            assert_eq!(failure.retries, 0);
            assert_eq!(failure.setup_timeout_ms, 300);
            let queues = failure.queues.unwrap();
            assert_eq!(
                (
                    queues.total.messages,
                    queues.primary.messages,
                    queues.bulk.messages
                ),
                (1, 1, 0)
            );
            assert!(queues.primary.oldest_age_ms >= 250);
            assert_eq!(report.calls, RpcAdmissionBudgets::default().snapshot());
            assert!(primary.connected());
            assert_eq!(connection.status().phase, BulkPhase::Reconnecting);
            primary.close(None);
            link.dispose().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn full_ordinary_primary_queue_preserves_lifecycle_control_reserve_without_retirement() {
    LocalSet::new()
        .run_until(async {
            let (link, primary, gate) = gated_primary(LinkRole::Controller);
            let connection = ExecutorRpcConnection::new(
                link.clone(),
                primary.clone(),
                RpcConnectionOptions::default(),
            )
            .unwrap();
            let ordinary = json!({"type":"reply-ack","ids":[]}).to_string();
            while primary.channel.can_admit(&ordinary) {
                primary.send(ordinary.clone()).unwrap();
            }
            let capacity = RPC_QUEUE_MESSAGES - BULK_CONTROL_RESERVE_MESSAGES;
            assert_eq!(primary.channel.queued_frames(), capacity);
            connection.activate().unwrap();
            assert_eq!(primary.channel.queued_frames(), capacity + 1);
            let frame = BulkConnectionControl::new(
                BulkControlType::Prepare,
                connection.status().session_id.unwrap(),
            );
            for _ in 1..BULK_CONTROL_RESERVE_MESSAGES {
                assert!(primary.channel.offer_bulk_control(&frame));
            }
            assert!(!primary.channel.offer_bulk_control(&frame));
            assert!(primary.connected());
            gate.blocked.set(false);
            eventually(|| primary.channel.queued_frames() == 0).await;
            assert_eq!(gate.sent.borrow().len(), RPC_QUEUE_MESSAGES);
            assert!(primary.channel.offer_bulk_control(&frame));
            assert!(primary.connected());
            assert!(link.bulk().is_none());
            primary.close(None);
            link.dispose().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn bulk_wait_cancellation_and_quiescence_do_not_retire_a_live_primary() {
    LocalSet::new()
        .run_until(async {
            let (link, primary, _) = gated_primary(LinkRole::Controller);
            let connection = ExecutorRpcConnection::new(
                link.clone(),
                primary.clone(),
                RpcConnectionOptions::default(),
            )
            .unwrap();
            let cancelled = CancellationToken::new();
            let wait = connection.bulk.wait(Some(cancelled.clone()), None);
            tokio::pin!(wait);
            assert!(futures::poll!(&mut wait).is_pending());
            cancelled.cancel();
            not_dispatched(within(wait).await);
            connection.activate().unwrap();
            assert_eq!(connection.status().phase, BulkPhase::Preparing);
            let wait = connection.bulk.wait(None, None);
            tokio::pin!(wait);
            assert!(futures::poll!(&mut wait).is_pending());
            link.quiesce();
            not_dispatched(within(wait).await);
            assert!(primary.connected());
            assert!(link.state.borrow().bulk_grant.is_none());
            connection.activate().unwrap();
            assert!(connection.bulk.current().is_none());
            primary.close(None);
            link.dispose().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn reverse_lane_acquisition_is_budgeted_and_cannot_follow_a_replacement_primary() {
    LocalSet::new()
        .run_until(async {
            let (link, primary, _) = gated_primary(LinkRole::Worker);
            let admission = Rc::new(RpcAdmissionBudgets::default());
            let connection = ExecutorRpcConnection::new(
                link.clone(),
                primary.clone(),
                RpcConnectionOptions {
                    admission: admission.clone(),
                    ..RpcConnectionOptions::default()
                },
            )
            .unwrap();
            let signal = CancellationToken::new();
            let wait = connection.acquire(RpcLane::Bulk, signal.clone(), None);
            tokio::pin!(wait);
            assert!(futures::poll!(&mut wait).is_pending());
            assert_eq!(admission.outgoing.size(), 1);
            let (rpc, deadline) = connection
                .acquire(RpcLane::Primary, signal.clone(), Some(5000))
                .await
                .unwrap();
            assert!(Rc::ptr_eq(&rpc, &connection.primary));
            assert_eq!(deadline, Some(5000));
            primary.close(None);
            not_dispatched(within(wait).await);
            assert_eq!(admission.outgoing.size(), 0);
            assert_eq!(connection.status().phase, BulkPhase::Offline);
            not_dispatched(connection.acquire(RpcLane::Bulk, signal, None).await);
            link.dispose().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn parent_loss_fences_a_pending_bulk_attempt_and_rejects_its_waiters() {
    LocalSet::new()
        .run_until(async {
            let (link, primary, _) = gated_primary(LinkRole::Controller);
            let connection = ExecutorRpcConnection::new(
                link.clone(),
                primary.clone(),
                RpcConnectionOptions::default(),
            )
            .unwrap();
            connection.activate().unwrap();
            assert_eq!(connection.status().phase, BulkPhase::Preparing);
            let id = connection.status().session_id.unwrap();
            let wait = connection.bulk.wait(None, None);
            tokio::pin!(wait);
            assert!(futures::poll!(&mut wait).is_pending());
            primary.close(None);
            not_dispatched(within(wait).await);
            assert_eq!(connection.status().phase, BulkPhase::Offline);
            assert!(connection.bulk.current().is_none());
            assert!(link.state.borrow().bulk_grant.is_none());
            assert!(link.dial_bulk(&primary, &id).is_err());
            link.dispose().await;
        })
        .await;
}

struct PairedRpc {
    controller: Rc<WebSocketLink>,
    worker: Rc<WebSocketLink>,
    caller: Rc<ExecutorRpcConnection>,
    service: Rc<ExecutorRpcConnection>,
    journal: Rc<RpcReplyJournal>,
    executions: Rc<Cell<usize>>,
    _primary: EncryptedPath,
}

impl PairedRpc {
    async fn new(dialer: LinkRole) -> Self {
        let controller = WebSocketLink::new(options(LinkRole::Controller)).unwrap();
        let worker = WebSocketLink::new(options(LinkRole::Worker)).unwrap();
        let (left, right) = if dialer == LinkRole::Controller {
            (&controller, &worker)
        } else {
            (&worker, &controller)
        };
        let primary = connect_in_memory(left, right, primary_target());
        let caller_transport = within(controller.ready()).await.unwrap();
        let worker_transport = within(worker.ready()).await.unwrap();
        let caller = ExecutorRpcConnection::new(
            controller.clone(),
            caller_transport,
            RpcConnectionOptions {
                parked: Some(ParkedRpcLanes {
                    primary: Rc::default(),
                    bulk: Rc::default(),
                }),
                bulk_timing: BulkConnectionTiming {
                    redial_delays_ms: Some(vec![0]),
                    ..BulkConnectionTiming::default()
                },
                ..RpcConnectionOptions::default()
            },
        )
        .unwrap();
        let journal = RpcReplyJournal::new(RpcReplyJournalOptions::default());
        let service = ExecutorRpcConnection::new(
            worker.clone(),
            worker_transport,
            RpcConnectionOptions {
                journal: Some(journal.clone()),
                ..RpcConnectionOptions::default()
            },
        )
        .unwrap();
        let executions = Rc::new(Cell::new(0));
        let _off = service
            .on_endpoint(Rc::new({
                let executions = executions.clone();
                move |endpoint| {
                    let executions = executions.clone();
                    endpoint.handle(Rc::new(move |call, _, _, _| {
                        if call.method == "files.list" {
                            executions.set(executions.get() + 1);
                        }
                        Box::pin(async { Ok(Some(Opaque::from_value(json!(["synthetic-file"])))) })
                    }));
                    Ok(())
                }
            }))
            .unwrap();
        caller.activate().unwrap();
        Self {
            controller,
            worker,
            caller,
            service,
            journal,
            executions,
            _primary: primary,
        }
    }

    async fn attach_bulk(
        &self,
        dialer: LinkRole,
        hold_controller_reconciliation: bool,
    ) -> BulkPath {
        eventually(|| {
            self.caller.status().phase == BulkPhase::Connecting
                && self.service.status().phase == BulkPhase::Connecting
        })
        .await;
        let (left, right) = if dialer == LinkRole::Controller {
            (&self.controller, &self.worker)
        } else {
            (&self.worker, &self.controller)
        };
        let encrypted = connect_in_memory(
            left,
            right,
            LinkDialTarget {
                lane: RpcLane::Bulk,
                session_id: self.caller.status().session_id,
                primary_session_id: Some(self.caller.primary.transport.id.clone()),
            },
        );
        let (controller_gate, worker_gate) = if dialer == LinkRole::Controller {
            (encrypted.from_left.clone(), encrypted.from_right.clone())
        } else {
            (encrypted.from_right.clone(), encrypted.from_left.clone())
        };
        let off = self
            .controller
            .on_bulk_session(Rc::new({
                let gate = controller_gate.clone();
                move |_| {
                    if hold_controller_reconciliation {
                        gate.set(Fault::FullBuffer);
                    }
                    Ok(())
                }
            }))
            .unwrap();
        eventually(|| {
            self.controller.bulk().is_some_and(|bulk| bulk.connected())
                && self.worker.bulk().is_some_and(|bulk| bulk.connected())
        })
        .await;
        off();
        BulkPath {
            controller_gate,
            worker_gate,
            _encrypted: encrypted,
        }
    }

    async fn active_bulk(&self) -> (Rc<ExecutorRpc>, Rc<ExecutorRpc>) {
        let (caller, service) = within(futures::future::join(
            self.caller.bulk.wait(None, None),
            self.service.bulk.wait(None, None),
        ))
        .await;
        (caller.unwrap(), service.unwrap())
    }

    async fn dispose(self) {
        self.controller.dispose().await;
        self.worker.dispose().await;
        self.journal.dispose();
    }
}

struct BulkPath {
    controller_gate: Rc<Cell<Fault>>,
    worker_gate: Rc<Cell<Fault>>,
    _encrypted: EncryptedPath,
}

#[tokio::test(start_paused = true)]
async fn both_directions_stay_recovery_only_until_bulk_reconciliation_activates() {
    LocalSet::new()
        .run_until(async {
            for role in [LinkRole::Controller, LinkRole::Worker] {
                let pair = PairedRpc::new(role).await;
                let primary = pair.caller.primary.call(
                    "",
                    "projects.inspect",
                    Opaque::from_value(json!({"projectPath":"/synthetic"})),
                    RpcCallOptions::default(),
                );
                assert!(within(primary).await.is_ok());
                let (send, mut received) = mpsc::unbounded_channel();
                let _off = pair
                    .service
                    .on_endpoint(Rc::new(move |endpoint| {
                        if endpoint.transport.lane == RpcLane::Bulk {
                            send.send(endpoint).unwrap();
                        }
                        Ok(())
                    }))
                    .unwrap();
                let path = pair.attach_bulk(role, true).await;
                let worker = within(received.recv()).await.unwrap();
                assert!(pair.caller.bulk.current().is_none());
                assert!(pair.service.bulk.current().is_none());
                let request = Opaque::from_value(json!({
                    "expectedServerInstanceId":"synthetic",
                    "http":{"operation":"GET /api/v1/chats","query":[],"body":null},
                }));
                not_dispatched(
                    worker
                        .call(
                            "",
                            "controllerCli.request",
                            request,
                            RpcCallOptions::default(),
                        )
                        .await,
                );
                path.controller_gate.set(Fault::None);
                let (_, ready) = pair.active_bulk().await;
                assert!(Rc::ptr_eq(&ready, &worker));
                pair.dispose().await;
            }
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn bulk_recovery_resends_nonreceipt_and_reuses_a_lost_reply_without_repeating_execution() {
    LocalSet::new()
        .run_until(async {
            for role in [LinkRole::Controller, LinkRole::Worker] {
                for received in [false, true] {
                    let pair = PairedRpc::new(role).await;
                    let path = pair.attach_bulk(role, false).await;
                    let (bulk, peer) = pair.active_bulk().await;
                    assert_eq!(
                        bulk.transport.primary_session_id,
                        pair.caller.primary.transport.id
                    );
                    if received {
                        path.worker_gate.set(Fault::FullBuffer);
                    } else {
                        path.controller_gate.set(Fault::FullBuffer);
                    }
                    let call = bulk.call(
                        "",
                        "files.list",
                        Opaque::from_value(json!({"projectPath":"/synthetic"})),
                        RpcCallOptions::default(),
                    );
                    if received {
                        eventually(|| peer.transport.channel.queued_frames() > 0).await;
                        assert_eq!(pair.executions.get(), 1);
                    } else {
                        assert_eq!(bulk.transport.channel.queued_frames(), 1);
                        assert_eq!(pair.executions.get(), 0);
                    }
                    bulk.transport.close(None);
                    let _replacement = pair.attach_bulk(role, false).await;
                    let (fresh, _) = pair.active_bulk().await;
                    assert_ne!(fresh.transport.id, bulk.transport.id);
                    assert!(!peer.transport.connected());
                    let result = within(call).await.unwrap().unwrap();
                    assert_eq!(result.as_value(), &json!(["synthetic-file"]));
                    assert_eq!(pair.executions.get(), 1);
                    assert!(pair.caller.primary.active());
                    assert!(pair.service.primary.active());
                    pair.dispose().await;
                }
            }
        })
        .await;
}
