use std::future::Future;

use garcon_base::server_runtime::create_server_runtime_proof;
use garcon_contract::server_runtime::{ServerRuntimeIdentity, parse_cli_runtime_descriptor};
use garcon_link::connection_url::create_executor_secret;
use garcon_link::link_handshake::LinkRole;
use garcon_link::rpc::RpcHandler;
use garcon_link::websocket_link::{WebSocketLink, WebSocketLinkOptions};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex};
use tokio::sync::mpsc;
use tokio::task::LocalSet;
use tokio::time::timeout;

use super::*;

const EXECUTOR: &str = "22222222-2222-4222-8222-222222222222";
const RUN: &str = "POST /api/v1/chats/run";
const CONTEXT: &str = "GET /api/v1/cli/context";
const CAPTURE_WAIT: Duration = Duration::from_secs(10);

async fn test(future: impl Future<Output = ()>) {
    LocalSet::new()
        .run_until(timeout(Duration::from_secs(25), future))
        .await
        .expect("gateway test did not settle");
}

fn reply(value: Value) -> Opaque {
    Opaque::from_value(value)
}

fn fixture_handler() -> RpcHandler {
    Rc::new(|call, _, _, _| {
        Box::pin(async move {
            let result = if call.method == "controllerCli.describe" {
                json!({ "serverInstanceId": "controller", "defaultExecutorId": EXECUTOR, "workspaceName": null })
            } else {
                json!({ "status": 201, "body": call.request })
            };
            Ok(Some(reply(result)))
        })
    })
}

fn link(role: LinkRole, secret: String) -> Rc<WebSocketLink> {
    let mut options = WebSocketLinkOptions::new(role, secret);
    options.no_tls = true;
    if role == LinkRole::Controller {
        options.executor_id = Some(EXECUTOR.to_owned());
    }
    WebSocketLink::new(options).unwrap()
}

fn sessions(link: &Rc<WebSocketLink>) -> mpsc::UnboundedReceiver<Rc<ExecutorRpcConnection>> {
    let (send, receive) = mpsc::unbounded_channel();
    let weak = Rc::downgrade(link);
    let _off = link
        .on_session(Rc::new(move |session| {
            let connection =
                ExecutorRpcConnection::new(weak.upgrade().unwrap(), session, Default::default())?;
            let _ = send.send(connection);
            Ok(())
        }))
        .unwrap();
    receive
}

async fn pair(
    handler: RpcHandler,
) -> (
    Rc<WebSocketLink>,
    Rc<WebSocketLink>,
    Rc<ExecutorRpcConnection>,
    Rc<ExecutorRpcConnection>,
) {
    let secret = create_executor_secret();
    let worker = link(LinkRole::Worker, secret.clone());
    let controller = link(LinkRole::Controller, secret);
    let mut worker_sessions = sessions(&worker);
    let mut controller_sessions = sessions(&controller);
    let address = worker.listen(0, "0.0.0.0", None).await.unwrap();
    controller.dial(&address).unwrap();
    let controller_connection = controller_sessions.recv().await.unwrap();
    let worker_connection = worker_sessions.recv().await.unwrap();
    let _off = controller_connection
        .on_endpoint(Rc::new(move |endpoint| {
            endpoint.handle(Rc::clone(&handler));
            Ok(())
        }))
        .unwrap();
    controller_connection
        .primary
        .transport
        .ready()
        .await
        .unwrap();
    worker_connection.primary.transport.ready().await.unwrap();
    controller_connection.activate().unwrap();
    worker_connection.activate().unwrap();
    worker_connection
        .acquire(RpcLane::Bulk, CancellationToken::new(), Some(5_000))
        .await
        .unwrap();
    (worker, controller, worker_connection, controller_connection)
}

struct Fixture {
    gateway: CliGateway,
    worker: Rc<WebSocketLink>,
    controller: Rc<WebSocketLink>,
    current_connection: Rc<RefCell<Option<Rc<ExecutorRpcConnection>>>>,
    _controller_connection: Rc<ExecutorRpcConnection>,
    _directory: tempfile::TempDir,
}

impl Fixture {
    async fn new(handler: RpcHandler) -> Self {
        let (worker, controller, connection, controller_connection) = pair(handler).await;
        let root = tempfile::tempdir().unwrap();
        let current_connection = Rc::new(RefCell::new(Some(connection)));
        let gateway = CliGateway::start(
            root.path().join("executor").to_str().unwrap(),
            Rc::new({
                let current = Rc::clone(&current_connection);
                move || current.borrow().clone()
            }),
        )
        .await
        .unwrap();
        Self {
            gateway,
            worker,
            controller,
            current_connection,
            _controller_connection: controller_connection,
            _directory: root,
        }
    }

    async fn connect(&self) -> TcpStream {
        TcpStream::connect(self.endpoint().base_url.strip_prefix("http://").unwrap())
            .await
            .unwrap()
    }

    fn endpoint(&self) -> &RuntimeEndpoint {
        &self.gateway.descriptor.endpoint
    }

    fn auth(&self) -> String {
        format!(
            "Authorization: Bearer {}\r\n",
            self.endpoint().local_capability
        )
    }

    async fn request(&self, route: &str, headers: &str, body: &[u8]) -> Reply {
        request(&mut self.connect().await, route, headers, body).await
    }

    async fn close(self) {
        self.gateway.dispose().await.unwrap();
        self.controller.dispose().await;
        self.worker.dispose().await;
    }
}

struct Reply {
    status: u16,
    headers: String,
    body: Value,
}

impl Reply {
    fn assert_error(&self, status: u16, code: &str) {
        assert_eq!(self.status, status, "{:?}", self.body.get("errorCode"));
        assert_eq!(self.body["errorCode"], code, "{}", self.body);
    }
}

async fn send(io: &mut (impl AsyncWrite + Unpin), route: &str, headers: &str, body: &[u8]) {
    io.write_all(format!("{route} HTTP/1.1\r\nHost: localhost\r\n{headers}\r\n").as_bytes())
        .await
        .unwrap();
    io.write_all(body).await.unwrap();
}

async fn receive(io: &mut (impl AsyncRead + Unpin)) -> Reply {
    let mut bytes = Vec::new();
    io.read_to_end(&mut bytes).await.unwrap();
    let end = bytes
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .unwrap();
    let headers = std::str::from_utf8(&bytes[..end])
        .unwrap()
        .to_ascii_lowercase();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = if bytes.len() == end + 4 {
        Value::Null
    } else {
        json::from_slice(&bytes[end + 4..]).unwrap()
    };
    Reply {
        status,
        headers,
        body,
    }
}

async fn request(
    io: &mut (impl AsyncRead + AsyncWrite + Unpin),
    route: &str,
    headers: &str,
    body: &[u8],
) -> Reply {
    send(io, route, headers, body).await;
    receive(io).await
}

#[tokio::test]
async fn private_descriptor_proves_endpoint_and_does_not_remove_its_replacement() {
    test(async {
        let f = Fixture::new(fixture_handler()).await;
        let raw: Value = json::from_slice(&tokio::fs::read(&f.gateway.runtime_file).await.unwrap()).unwrap();
        let descriptor = parse_cli_runtime_descriptor(&raw).unwrap();
        assert_eq!(descriptor.endpoint().instance_id, f.endpoint().instance_id);
        assert!(raw.get("workspaceDir").is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file = std::path::Path::new(&f.gateway.runtime_file);
            for (path, mode) in [(file, 0o600), (file.parent().unwrap(), 0o700)] {
                let actual = tokio::fs::metadata(path).await.unwrap().permissions().mode();
                assert_eq!(actual & 0o777, mode);
            }
        }
        assert!(f.endpoint().base_url.starts_with("http://127.0.0.1:"));
        let challenge = "a".repeat(43);
        let result = f.request(&format!("GET /api/v1/runtime?challenge={challenge}"), "", b"").await;
        assert_eq!(result.status, 200);
        assert!(result.headers.contains("cache-control: no-store"));
        let proof_state = ServerRuntimeState {
            identity: ServerRuntimeIdentity {
                schema_version: f.endpoint().schema_version,
                instance_id: f.endpoint().instance_id.clone(),
                started_at: f.endpoint().started_at.clone(),
                workspace_dir: String::new(),
            },
            local_capability: f.endpoint().local_capability.clone(),
        };
        assert_eq!(result.body["proof"], create_server_runtime_proof(&proof_state, &challenge).unwrap());
        assert!(result.body.get("localCapability").is_none());
        let context = f.request(CONTEXT, &f.auth(), b"").await;
        assert_eq!(context.body, json!({ "serverInstanceId": "controller", "defaultExecutorId": EXECUTOR, "workspaceName": null }));
        let replacement = CliGateway::start(f._directory.path().join("executor").to_str().unwrap(), Rc::new(|| None)).await.unwrap();
        f.gateway.dispose().await.unwrap();
        let current: Value = json::from_slice(&tokio::fs::read(&replacement.runtime_file).await.unwrap()).unwrap();
        assert_eq!(current["instanceId"], replacement.descriptor.endpoint.instance_id);
        assert_ne!(replacement.descriptor.endpoint.local_capability, f.endpoint().local_capability);
        replacement.dispose().await.unwrap();
        assert!(!tokio::fs::try_exists(&replacement.runtime_file).await.unwrap());
        f.close().await;
    }).await;
}

#[tokio::test]
async fn authentication_allowlist_generation_and_json_fences_precede_dispatch() {
    test(async {
        let calls = Rc::new(Cell::new(0));
        let fallback = fixture_handler();
        let f = Fixture::new(Rc::new({
            let calls = Rc::clone(&calls);
            move |call, signal, guard, observe| {
                if call.method == "controllerCli.request" {
                    assert_eq!(call.request["expectedServerInstanceId"], "controller");
                    calls.update(|n| n + 1);
                }
                fallback(call, signal, guard, observe)
            }
        }))
        .await;
        let auth = f.auth();
        let valid = format!("{auth}{CLI_SERVER_INSTANCE_HEADER}: controller\r\n");
        f.request(RUN, "Authorization: Bearer invalid\r\n", b"")
            .await
            .assert_error(403, "CLI_ACCESS_DENIED");
        f.request(RUN, &format!("Authorization: Bearer invalid\r\n{valid}"), b"")
            .await
            .assert_error(403, "CLI_ACCESS_DENIED");
        f.request(
            RUN,
            &format!("{valid}Origin: http://browser.invalid\r\n"),
            b"",
        )
        .await
        .assert_error(403, "CLI_ACCESS_DENIED");
        f.request("GET /api/v1/api-providers", &valid, b"")
            .await
            .assert_error(403, "CLI_ACCESS_DENIED");
        f.request("GET /api/v1/chats/run", &valid, b"")
            .await
            .assert_error(403, "CLI_ACCESS_DENIED");
        f.request(RUN, &auth, b"")
            .await
            .assert_error(400, "VALIDATION_FAILED");
        f.request(
            CONTEXT,
            &format!("{auth}{CLI_SERVER_INSTANCE_HEADER}: old\r\n"),
            b"",
        )
        .await
        .assert_error(409, "CLI_CONTROLLER_CHANGED");
        for (body, media, status) in [
            (b"{".as_slice(), "application/json", 400),
            (b"\"\xff\"".as_slice(), "application/json", 400),
            (b"{}".as_slice(), "text/plain", 415),
        ] {
            let headers = format!(
                "{valid}Content-Type: {media}\r\nContent-Length: {}\r\n",
                body.len()
            );
            f.request(RUN, &headers, body)
                .await
                .assert_error(status, "VALIDATION_FAILED");
        }
        assert_eq!(calls.get(), 0);
        let body = br#"{"chatId":"1234567890123456","questionReply":{"answer":"  Staging  "}}"#;
        let headers = format!(
            "{valid}Authorization: Bearer invalid\r\nContent-Type: application/json\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n",
            body.len()
        );
        let result = f
            .request(&format!("{RUN}?a=1&b=two+words&a=%2B"), &headers, body)
            .await;
        assert_eq!(result.status, 201);
        assert_eq!(
            result.body,
            json!({
                "expectedServerInstanceId": "controller",
                "http": {"operation": RUN, "query": [["a","1"],["b","two words"],["a","+"]],
                     "body": json::from_slice::<Value>(body).unwrap()},
            })
        );
        assert!(!result.headers.contains("access-control-allow-origin:"));
        assert!(
            !result
                .body
                .to_string()
                .contains(&f.endpoint().local_capability)
        );
        assert_eq!(calls.get(), 1);
        f.close().await;
    })
    .await;
}

#[tokio::test]
async fn forwards_http_status_retry_metadata_and_bounded_envelopes() {
    test(async {
        let calls = Rc::new(Cell::new(0));
        let f = Fixture::new(Rc::new({
            let calls = Rc::clone(&calls);
            move |call, _, _, _| {
                assert_eq!(call.method, "controllerCli.request");
                let status = [422, 409, 503, 504, 504][calls.get()];
                let code = ["INVALID_SETTINGS", "SESSION_BUSY", "UNAVAILABLE", "TIMEOUT", "TIMEOUT"][calls.get()];
                let retryable = matches!(calls.get(), 1..=3);
                calls.update(|n| n + 1);
                Box::pin(async move {
                    Ok(Some(reply(json!({
                        "status": status, "body": { "errorCode": code, "retryable": retryable, "error": "Synthetic" },
                        "retryAfter": "2"
                    }))))
                })
            }
        })).await;
        let valid = format!("{}{CLI_SERVER_INSTANCE_HEADER}: controller\r\n", f.auth());
        let limit = cli_request_bytes(RpcLane::Bulk);
        let oversized = format!("{valid}Content-Length: {}\r\n", limit + 1);
        f.request(RUN, &oversized, b"").await.assert_error(413, "CLI_REQUEST_TOO_LARGE");
        let body = format!("{{\"command\":\"{}\"}}", "x".repeat(limit - 15));
        assert!(body.len() < limit);
        let headers = format!("{valid}Content-Type: application/json\r\nContent-Length: {}\r\n", body.len());
        f.request(RUN, &headers, body.as_bytes()).await.assert_error(413, "CLI_REQUEST_TOO_LARGE");
        assert_eq!(calls.get(), 0);
        for (status, code, retryable) in [
            (422, "INVALID_SETTINGS", false), (409, "SESSION_BUSY", true), (503, "UNAVAILABLE", true),
            (504, "TIMEOUT", true), (504, "TIMEOUT", false),
        ] {
            let reply = f.request(RUN, &valid, b"").await;
            reply.assert_error(status, code);
            assert_eq!(reply.body["retryable"], retryable);
            assert!(reply.headers.contains("retry-after: 2"));
        }
        assert_eq!(calls.get(), 5);
        f.close().await;
    }).await;
}

#[tokio::test]
async fn bulk_uploads_reserve_slots_before_body_and_leave_primary_usable() {
    test(async {
        let f = Fixture::new(fixture_handler()).await;
        let valid = format!("{}{CLI_SERVER_INSTANCE_HEADER}: controller\r\n", f.auth());
        let mut uploads = Vec::new();
        let headers = format!("{valid}Content-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n");
        for _ in 0..12 {
            let mut upload = f.connect().await;
            send(&mut upload, RUN, &headers, b"").await;
            let mut started = [0; b"HTTP/1.1 100 Continue\r\n\r\n".len()];
            upload.read_exact(&mut started).await.unwrap();
            assert_eq!(&started, b"HTTP/1.1 100 Continue\r\n\r\n");
            uploads.push(upload);
        }
        let rejected = f.request(RUN, &valid, b"").await;
        rejected.assert_error(503, "CLI_SERVICE_BUSY");
        assert!(rejected.headers.contains("retry-after: 1"));
        assert_eq!(f.request(CONTEXT, &valid, b"").await.status, 200);
        assert_eq!(f.request("POST /api/v1/chats/stop", &valid, b"").await.status, 201);
        drop(uploads);
        f.close().await;
    }).await;
}

#[tokio::test]
async fn upload_cannot_dispatch_to_a_replaced_controller() {
    test(async {
        let (dispatched, mut calls) = mpsc::unbounded_channel();
        let fallback = fixture_handler();
        let f = Fixture::new(Rc::new(move |call, signal, guard, observe| {
            if call.method == "controllerCli.request" {
                dispatched.send(()).unwrap();
            }
            fallback(call, signal, guard, observe)
        }))
        .await;
        let valid = format!("{}{CLI_SERVER_INSTANCE_HEADER}: controller\r\n", f.auth());
        let headers = format!(
            "{valid}Content-Type: application/json\r\nContent-Length: 2\r\nExpect: 100-continue\r\n"
        );
        let mut upload = f.connect().await;
        send(&mut upload, RUN, &headers, b"").await;
        let mut started = [0; b"HTTP/1.1 100 Continue\r\n\r\n".len()];
        upload.read_exact(&mut started).await.unwrap();
        assert_eq!(&started, b"HTTP/1.1 100 Continue\r\n\r\n");

        let replacement = Fixture::new(fixture_handler()).await;
        let retired = f
            .current_connection
            .replace(replacement.current_connection.borrow().clone())
            .unwrap();
        assert!(retired.primary.active());
        upload.write_all(b"{}").await.unwrap();
        receive(&mut upload)
            .await
            .assert_error(503, "CLI_CONTROLLER_UNAVAILABLE");
        assert!(calls.try_recv().is_err());
        assert_eq!(f.request(CONTEXT, &valid, b"").await.status, 200);
        f.close().await;
        replacement.close().await;
    })
    .await;
}

#[tokio::test]
async fn slow_response_drains_keep_slots_after_the_rpc_replies() {
    test(async {
        let (started, mut responses) = mpsc::unbounded_channel();
        let fallback = fixture_handler();
        let (worker, controller, connection, _controller_connection) =
            pair(Rc::new(move |call, signal, guard, observe| {
                if call.method == "controllerCli.describe" {
                    return fallback(call, signal, guard, observe);
                }
                started.send(()).unwrap();
                Box::pin(async {
                    Ok(Some(reply(
                        json!({"status":200,"body": {"data":"x".repeat(96 * 1024)}}),
                    )))
                })
            }))
            .await;
        let directory = tempfile::tempdir().unwrap();
        let runtime =
            create_server_runtime_state(directory.path().to_str().unwrap(), &SystemClock).unwrap();
        let valid = format!(
            "Authorization: Bearer {}\r\n{CLI_SERVER_INSTANCE_HEADER}: controller\r\n",
            runtime.local_capability
        );
        let gateway = Rc::new(Gateway {
            runtime,
            current_connection: Rc::new(move || Some(Rc::clone(&connection))),
            stop: CancellationToken::new(),
            admission: CliAdmission::default(),
            responses: Rc::default(),
        });
        let mut clients = Vec::new();
        let mut sockets = JoinSet::new();
        for _ in 0..12 {
            let (mut client, server) = duplex(512);
            sockets.spawn_local(serve_http(server, Rc::clone(&gateway), HTTP_TIMEOUTS));
            send(&mut client, "GET /api/v1/chats", &valid, b"").await;
            responses.recv().await.unwrap();
            // Wait for the first response byte, then leave the bounded pipe full.
            assert_eq!(client.read_u8().await.unwrap(), b'H');
            clients.push(client);
        }
        let connect = |sockets: &mut JoinSet<()>| -> DuplexStream {
            let (client, server) = duplex(512);
            sockets.spawn_local(serve_http(server, Rc::clone(&gateway), HTTP_TIMEOUTS));
            client
        };
        request(&mut connect(&mut sockets), "GET /api/v1/chats", &valid, b"")
            .await
            .assert_error(503, "CLI_SERVICE_BUSY");
        assert_eq!(
            request(&mut connect(&mut sockets), CONTEXT, &valid, b"")
                .await
                .status,
            200
        );
        for mut client in clients {
            let mut data = Vec::new();
            client.read_to_end(&mut data).await.unwrap();
            assert!(data.len() > 96 * 1024);
        }
        while sockets.join_next().await.is_some() {}
        assert_eq!(gateway.responses.total.get(), 0);
        controller.dispose().await;
        worker.dispose().await;
    })
    .await;
}

#[tokio::test]
async fn incomplete_headers_and_uploads_have_total_deadlines() {
    test(async {
        let (worker, controller, connection, _controller_connection) =
            pair(Rc::new(|_, _, _, _| panic!("An unfinished request reached the controller"))).await;
        let dir = tempfile::tempdir().unwrap();
        let runtime = create_server_runtime_state(dir.path().to_str().unwrap(), &SystemClock).unwrap();
        let valid = format!("Authorization: Bearer {}\r\n{CLI_SERVER_INSTANCE_HEADER}: controller\r\nContent-Length: 2\r\n", runtime.local_capability);
        let gateway = Rc::new(Gateway {
            runtime,
            current_connection: Rc::new(move || Some(Rc::clone(&connection))),
            stop: CancellationToken::new(),
            admission: CliAdmission::default(),
            responses: Rc::default(),
        });
        for partial in [
            "GET / HTTP/1.1\r\n".to_owned(),
            format!("{RUN} HTTP/1.1\r\nHost: localhost\r\n{valid}\r\n{{"),
        ] {
            let (mut client, server) = duplex(512);
            let task = tokio::task::spawn_local(serve_http(server, Rc::clone(&gateway), HttpTimeouts {
                head: Duration::from_millis(100),
                request: Duration::from_millis(250),
            }));
            client.write_all(partial.as_bytes()).await.unwrap();
            let response = timeout(Duration::from_secs(2), receive(&mut client)).await.unwrap();
            assert_eq!(response.status, 408);
            assert!(response.headers.contains("connection: close"));
            task.await.unwrap();
        }
        controller.dispose().await;
        worker.dispose().await;
    }).await;
}

#[tokio::test]
async fn socket_abort_cancels_rpc_and_link_loss_never_replays_mutations() {
    test(async {
        let (entered, mut calls) = mpsc::unbounded_channel();
        let (cancelled, mut aborts) = mpsc::unbounded_channel();
        let f = Fixture::new(Rc::new(move |call, signal, _, _| {
            assert_eq!(call.method, "controllerCli.request");
            entered.send(()).unwrap();
            let cancelled = cancelled.clone();
            Box::pin(async move {
                signal.cancelled().await;
                cancelled.send(()).unwrap();
                Ok(Some(reply(json!({"status":200,"body":{"ok":true}}))))
            })
        }))
        .await;
        let valid = format!("{}{CLI_SERVER_INSTANCE_HEADER}: controller\r\n", f.auth());
        let mut abandoned = f.connect().await;
        send(&mut abandoned, "POST /api/v1/chats/fork", &valid, b"").await;
        calls.recv().await.unwrap();
        drop(abandoned);
        timeout(CAPTURE_WAIT, aborts.recv())
            .await
            .expect("HTTP close did not reach the controller")
            .unwrap();

        let mut pending = f.connect().await;
        send(&mut pending, RUN, &valid, b"").await;
        calls.recv().await.unwrap();
        f.controller.dispose().await;
        let failure = receive(&mut pending).await;
        failure.assert_error(503, "CLI_OUTCOME_UNKNOWN");
        assert_eq!(failure.body["retryable"], false);
        let disconnected = f.request(RUN, &valid, b"").await;
        disconnected.assert_error(503, "CLI_CONTROLLER_UNAVAILABLE");
        assert_eq!(disconnected.body["retryable"], true);
        assert!(calls.try_recv().is_err());
        f.close().await;
    })
    .await;
}
