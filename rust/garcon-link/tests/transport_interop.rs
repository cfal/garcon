use std::process::Stdio;
use std::rc::Rc;
use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use garcon_js::json::{Opaque, parse};
use garcon_link::bulk_connection::BulkConnectionTiming;
use garcon_link::link_handshake::LinkRole;
use garcon_link::rpc::{ParkedRpcCalls, RpcCallOptions};
use garcon_link::rpc_connection::{ExecutorRpcConnection, ParkedRpcLanes, RpcConnectionOptions};
use garcon_link::rpc_journal::{RpcReplyJournal, RpcReplyJournalOptions};
use garcon_link::rpc_lane::RpcLane;
use garcon_link::websocket_link::{LinkClosureCause, WebSocketLink, WebSocketLinkOptions};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdout, Command};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

const EXECUTOR_ID: &str = "22222222-2222-4222-8222-222222222222";
const DEADLINE: Duration = Duration::from_secs(8);

fn bun(role: LinkRole, mode: &str, address: Option<&str>) -> Child {
    Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/transport-peer.ts"
        ))
        .arg(role.as_str())
        .arg(mode)
        .args(address)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("starts the Bun 1.4.3 oracle")
}

async fn line(lines: &mut Lines<BufReader<ChildStdout>>) -> Value {
    let text = tokio::time::timeout(DEADLINE, lines.next_line())
        .await
        .expect("the Bun peer produced output in time")
        .expect("the Bun peer's stdout is readable")
        .expect("the Bun peer did not exit");
    parse(&text).expect("the Bun peer wrote JSON")
}

fn link(role: LinkRole) -> Rc<WebSocketLink> {
    let mut options = WebSocketLinkOptions::new(role, URL_SAFE_NO_PAD.encode([7; 32]));
    options.executor_id = (role == LinkRole::Controller).then(|| EXECUTOR_ID.to_owned());
    options.no_tls = true;
    options.redial_delays_ms = Some(vec![25]);
    WebSocketLink::new(options).unwrap()
}

fn install(rust: &Rc<WebSocketLink>) -> UnboundedReceiver<Rc<ExecutorRpcConnection>> {
    let (send, recv) = unbounded_channel();
    let weak = Rc::downgrade(rust);
    let role = rust.role();
    let journal =
        (role == LinkRole::Worker).then(|| RpcReplyJournal::new(RpcReplyJournalOptions::default()));
    let primary = Rc::new(ParkedRpcCalls::default());
    let bulk = Rc::new(ParkedRpcCalls::default());
    let admission = Rc::default();
    let _unsubscribe = rust
        .on_session(Rc::new(move |session| {
            let link = weak.upgrade().expect("the test link is alive");
            let connection = ExecutorRpcConnection::new(
                link,
                Rc::clone(&session),
                RpcConnectionOptions {
                    parked: (role == LinkRole::Controller).then(|| ParkedRpcLanes {
                        primary: Rc::clone(&primary),
                        bulk: Rc::clone(&bulk),
                    }),
                    journal: journal.clone(),
                    admission: Rc::clone(&admission),
                    bulk_timing: BulkConnectionTiming {
                        redial_delays_ms: Some(vec![25]),
                        ..BulkConnectionTiming::default()
                    },
                    ..RpcConnectionOptions::default()
                },
            )?;
            let _endpoint = connection.on_endpoint(Rc::new(move |rpc| {
                rpc.handle(Rc::new(move |frame, _, _, _| {
                    Box::pin(async move {
                        Ok(Some(Opaque::from_value(
                            json!({"input": frame.request.as_value()}),
                        )))
                    })
                }));
                Ok(())
            }))?;
            let send = send.clone();
            tokio::task::spawn_local(async move {
                session.ready().await.expect("the native session attaches");
                if role == LinkRole::Controller {
                    connection
                        .primary
                        .reconcile_parked()
                        .await
                        .expect("the controller reconciles");
                }
                connection.activate().expect("the generation activates");
                let _ = send.send(connection);
            });
            Ok(())
        }))
        .unwrap();
    recv
}

async fn next_connection(
    recv: &mut UnboundedReceiver<Rc<ExecutorRpcConnection>>,
) -> Rc<ExecutorRpcConnection> {
    tokio::time::timeout(DEADLINE, recv.recv())
        .await
        .unwrap()
        .unwrap()
}

async fn interoperates(role: LinkRole, dialer: bool) {
    let peer_role = match role {
        LinkRole::Controller => LinkRole::Worker,
        LinkRole::Worker => LinkRole::Controller,
    };
    let rust = link(role);
    let mut connections = install(&rust);
    let (mut bun, mut lines) = if dialer {
        let mut peer = bun(peer_role, "serve", None);
        let mut lines = BufReader::new(peer.stdout.take().unwrap()).lines();
        let listening = line(&mut lines).await;
        assert_eq!(listening["type"], "listening");
        rust.dial(listening["address"].as_str().unwrap()).unwrap();
        (peer, lines)
    } else {
        let address = rust.listen(0, "0.0.0.0", None).await.unwrap();
        let mut peer = bun(peer_role, "dial", Some(&address));
        let lines = BufReader::new(peer.stdout.take().unwrap()).lines();
        (peer, lines)
    };
    let connection = next_connection(&mut connections).await;
    let session = &connection.primary.transport;
    let initial = tokio::time::timeout(DEADLINE, rust.ready())
        .await
        .unwrap()
        .unwrap();
    assert!(Rc::ptr_eq(session, &initial));
    let info = line(&mut lines).await;
    assert_eq!(info["type"], "ready");
    assert_eq!(session.id, info["sessionId"]);
    assert_eq!(session.executor_id, EXECUTOR_ID);
    assert_eq!(session.executor_id, info["executorId"]);
    assert_eq!(
        session.peer_runtime_id,
        format!("synthetic-bun-{}", peer_role.as_str())
    );

    let input = json!({ "synthetic": "ordered through the Noise socket 😀" });
    let result = tokio::time::timeout(
        DEADLINE,
        connection.primary.call(
            "",
            "projects.inspect",
            Opaque::from_value(input.clone()),
            RpcCallOptions::default(),
        ),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    assert_eq!(
        result.as_value(),
        &json!({ "peer": peer_role.as_str(), "input": input })
    );
    let bulk = tokio::time::timeout(DEADLINE, connection.bulk.wait(None, None))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bulk.transport.lane, RpcLane::Bulk);
    assert!(connection.owns(&bulk));
    let info = line(&mut lines).await;
    assert_eq!(info["type"], "bulk-ready");
    assert_eq!(session.id, info["primarySessionId"]);
    assert_eq!(bulk.transport.id, info["sessionId"]);
    assert_eq!(bulk.transport.primary_session_id, session.id);
    let request = Opaque::from_value(json!({ "bytes": "b".repeat(1024 * 1024) }));
    let result = tokio::time::timeout(
        DEADLINE,
        bulk.call("", "files.list", request.clone(), RpcCallOptions::default()),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    assert_eq!(result["input"], request.as_value().clone());

    if role == LinkRole::Controller {
        bulk.transport.close(None);
        assert!(session.connected());
        let recovered_bulk = tokio::time::timeout(DEADLINE, connection.bulk.wait(None, None))
            .await
            .unwrap()
            .unwrap();
        assert_ne!(recovered_bulk.transport.id, bulk.transport.id);
        assert_eq!(recovered_bulk.transport.primary_session_id, session.id);
        let info = line(&mut lines).await;
        assert_eq!(info["type"], "bulk-ready");
        assert_eq!(info["sessionId"], recovered_bulk.transport.id);
        assert!(connection.primary.active());
        let request = json!({"hold": true});
        let reply = connection.primary.call(
            "",
            "projects.inspect",
            Opaque::from_value(request.clone()),
            RpcCallOptions::default(),
        );
        let held = line(&mut lines).await;
        assert_eq!(held["type"], "held");
        assert_eq!(held["count"].as_f64(), Some(1.0));
        let bulk_request = json!({"projectPath":"/synthetic", "holdBulk":true});
        let bulk_reply = recovered_bulk.call(
            "",
            "files.list",
            Opaque::from_value(bulk_request.clone()),
            RpcCallOptions::default(),
        );
        let held = line(&mut lines).await;
        assert_eq!(held["type"], "held-bulk");
        assert_eq!(held["count"].as_f64(), Some(1.0));
        recovered_bulk.transport.close(None);
        let new_bulk = tokio::time::timeout(DEADLINE, connection.bulk.wait(None, None))
            .await
            .unwrap()
            .unwrap();
        assert_ne!(new_bulk.transport.id, recovered_bulk.transport.id);
        let info = line(&mut lines).await;
        assert_eq!(info["type"], "bulk-ready");
        assert_eq!(info["sessionId"], new_bulk.transport.id);
        assert!(connection.primary.active());
        bun.stdin
            .as_mut()
            .unwrap()
            .write_all(b"release-bulk\n")
            .await
            .unwrap();
        let bulk_value = tokio::time::timeout(DEADLINE, bulk_reply)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            bulk_value.as_value(),
            &json!({"peer":"worker","input":bulk_request})
        );
        session.close(None);
        assert!(!new_bulk.transport.connected());
        let replacement = next_connection(&mut connections).await;
        assert_ne!(replacement.primary.transport.id, session.id);
        assert_eq!(
            replacement.primary.transport.peer_runtime_id,
            session.peer_runtime_id
        );
        let info = line(&mut lines).await;
        assert_eq!(info["type"], "ready");
        assert_eq!(info["sessionId"], replacement.primary.transport.id);
        bun.stdin
            .as_mut()
            .unwrap()
            .write_all(b"release\n")
            .await
            .unwrap();
        let value = tokio::time::timeout(DEADLINE, reply)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(value.as_value(), &json!({"peer":"worker","input":request}));

        if dialer {
            let (close, mut closed) = unbounded_channel();
            let _off = rust.on_closure(Rc::new(move |closure| {
                if closure.lane == RpcLane::Primary {
                    let _ = close.send(closure.clone());
                }
            }));
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(20)).await;
            tokio::time::resume();
            let closure = tokio::time::timeout(DEADLINE, closed.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(closure.cause, LinkClosureCause::LivenessTimeout);
            assert_eq!(closure.session_id, replacement.primary.transport.id);
            let redialed = next_connection(&mut connections).await;
            assert_ne!(
                redialed.primary.transport.id,
                replacement.primary.transport.id
            );
        }
    }
    rust.dispose().await;
    drop(bun.stdin.take());
    assert!(
        tokio::time::timeout(DEADLINE, bun.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}

#[tokio::test]
async fn typescript_transport_interoperates_in_both_roles_and_dial_directions() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for role in [LinkRole::Controller, LinkRole::Worker] {
                for dialer in [true, false] {
                    interoperates(role, dialer).await;
                }
            }
        })
        .await;
}

#[tokio::test]
async fn refuses_a_typescript_peer_with_a_different_release_or_protocol_revision() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for mode in ["bad-version", "bad-revision"] {
                let mut bun = bun(LinkRole::Worker, mode, None);
                let mut lines = BufReader::new(bun.stdout.take().unwrap()).lines();
                let listening = line(&mut lines).await;
                let rust = link(LinkRole::Controller);
                let (errors, mut reported) = unbounded_channel();
                let _unsubscribe = rust.on_error(Rc::new(move |failure| {
                    let _ = errors.send(failure.clone());
                }));
                rust.dial(listening["address"].as_str().unwrap()).unwrap();
                let failure = tokio::time::timeout(DEADLINE, reported.recv())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(failure.lane, Some(RpcLane::Primary));
                assert_eq!(failure.count, 1);
                assert!(
                    failure
                        .message
                        .starts_with("Executor version mismatch: local "),
                    "{failure:?}"
                );
                assert!(failure.message.contains("+protocol.71"));
                assert!(failure.message.ends_with("Use matching builds."));
                assert!(rust.current().is_none());
                rust.dispose().await;
                drop(bun.stdin.take());
                assert!(
                    tokio::time::timeout(DEADLINE, bun.wait())
                        .await
                        .unwrap()
                        .unwrap()
                        .success()
                );
            }
        })
        .await;
}
