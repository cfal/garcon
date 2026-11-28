use std::cell::RefCell;
use std::rc::Rc;

use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};
use tokio::task::LocalSet;

use super::*;
use crate::acp::protocol::garcon_initialize_params;
use crate::acp::reconnect_policy::reconnect_acp_session;
use crate::acp::testing::{FakeAcpControl, FakeAcpProcess};
use crate::acp::transport::AcpTransportOptions;

fn client(method: Option<&str>) -> (AcpClient, FakeAcpControl, UnboundedReceiver<String>) {
    let (process, control) = FakeAcpProcess::create();
    let (sent, received) = unbounded_channel();
    control.on_write(move |line| {
        sent.send(line.to_owned()).unwrap();
        line.len()
    });
    let process = RefCell::new(Some(process));
    let transport = AcpTransport::new(AcpTransportOptions {
        spawn: Some(Rc::new(move |_| {
            process
                .borrow_mut()
                .take()
                .ok_or_else(|| plain_error("already spawned"))
        })),
        request_timeout_ms: Some(200.0),
    });
    let client = AcpClient::new(
        transport,
        AcpClientOptions {
            initialize: garcon_initialize_params(None).unwrap(),
            authenticate_method_id: method.map(str::to_owned),
        },
    );
    (client, control, received)
}

fn spec() -> AcpSpawnSpec {
    AcpSpawnSpec {
        command: "agent".to_owned(),
        args: vec!["acp".to_owned()],
        cwd: "/work".to_owned(),
        env: Default::default(),
    }
}

async fn frame(received: &mut UnboundedReceiver<String>) -> Value {
    let read = tokio::time::timeout(std::time::Duration::from_secs(1), received.recv()).await;
    garcon_js::json::from_str(&read.unwrap().unwrap()).unwrap()
}

async fn initialize(
    control: &FakeAcpControl,
    received: &mut UnboundedReceiver<String>,
    result: Value,
) {
    assert_eq!(
        frame(received).await,
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientInfo": {"name": "garcon", "version": "1.0.0"},
                "clientCapabilities": {},
            }
        })
    );
    control.write_stdout_line(&json!({"id": 1, "result": result}));
}

struct Handshake<'a> {
    configured: &'a str,
    initialized: Value,
    authenticate: Option<&'a str>,
    auth_reply: Option<Value>,
    error: Option<&'a str>,
}

async fn handshake(case: Handshake<'_>) {
    let (client, control, mut received) = client(Some(case.configured));
    let spec = spec();
    let (connected, ()) = tokio::join!(client.connect(&spec), async {
        initialize(&control, &mut received, case.initialized).await;
        if let Some(authenticate) = case.authenticate {
            assert_eq!(
                frame(&mut received).await,
                json!({
                    "jsonrpc": "2.0", "id": 2, "method": "authenticate",
                    "params": {"methodId": authenticate}
                })
            );
            control.write_stdout_line(
                &case
                    .auth_reply
                    .unwrap_or_else(|| json!({"id": 2, "result": {}})),
            );
        }
        if case.error.is_none() {
            assert_eq!(
                frame(&mut received).await,
                json!({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
            );
        }
    });
    match case.error {
        Some(error) => assert_eq!(connected.unwrap_err().to_string(), error),
        None => assert_eq!(
            connected.unwrap().authenticated_method_id.as_deref(),
            case.authenticate
        ),
    }
    assert!(received.try_recv().is_err());
    client.close();
}

#[tokio::test]
async fn finishes_initialization_without_in_band_authentication_for_an_explicitly_empty_list() {
    LocalSet::new()
        .run_until(handshake(Handshake {
            configured: "oauth-personal",
            initialized: json!({"protocolVersion": 1, "authMethods": []}),
            authenticate: None,
            auth_reply: None,
            error: None,
        }))
        .await;
}

#[tokio::test]
async fn uses_the_configured_method_when_the_method_list_is_advertised_or_omitted() {
    LocalSet::new().run_until(async {
        for (method, initialized) in [
            ("oauth-personal", json!({"protocolVersion": 1, "authMethods": [{"id": "gemini-api-key"}, {"id": "oauth-personal"}]})),
            ("cursor_login", json!({"protocolVersion": 1})),
        ] {
            handshake(Handshake {
                configured: method,
                initialized,
                authenticate: Some(method),
                auth_reply: None,
                error: None,
            }).await;
        }
    }).await;
}

#[tokio::test]
async fn does_not_substitute_another_advertised_method() {
    LocalSet::new()
        .run_until(handshake(Handshake {
            configured: "oauth-personal",
            initialized: json!({"protocolVersion": 1, "authMethods": [{"id": "oauth-business"}]}),
            authenticate: None,
            auth_reply: None,
            error: Some(
                "ACP agent does not advertise the configured authentication method: oauth-personal",
            ),
        }))
        .await;
}

#[tokio::test]
async fn propagates_authentication_failure_for_the_advertised_method() {
    LocalSet::new()
        .run_until(handshake(Handshake {
            configured: "oauth-personal",
            initialized: json!({"protocolVersion": 1, "authMethods": [{"id": "oauth-personal"}]}),
            authenticate: Some("oauth-personal"),
            auth_reply: Some(
                json!({"id": 2, "error": {"code": -32603, "message": "Credential expired"}}),
            ),
            error: Some("Credential expired"),
        }))
        .await;
}

#[tokio::test]
async fn falls_back_only_on_a_recoverable_resume_error_and_keeps_the_native_session_id() {
    LocalSet::new().run_until(async {
        for (code, text) in [
            (-32601, "Missing method"),
            (-32602, "Session not found"),
            (-32603, "Resume refused"),
        ] {
            let (client, control, mut received) = client(None);
            let spec = spec();
            let (connected, ()) = tokio::join!(client.connect(&spec), async {
                initialize(&control, &mut received, json!({
                    "protocolVersion": 1,
                    "agentCapabilities": {"loadSession": true, "sessionCapabilities": {"resume": {}}}
                })).await;
            });
            connected.unwrap();
            assert_eq!(frame(&mut received).await["method"], "notifications/initialized");
            let target = AcpLoadSessionParams { cwd: "/work", mcp_servers: None, session_id: "original" };
            let (resumed, ()) = tokio::join!(reconnect_acp_session(&client, &target), async {
                let resume = frame(&mut received).await;
                assert_eq!(resume["method"], "session/resume");
                assert_eq!(resume["params"], json!({"cwd": "/work", "mcpServers": [], "sessionId": "original"}));
                control.write_stdout_line(&json!({"id": 2, "error": {"code": code, "message": text}}));
                if code != -32603 {
                    let load = frame(&mut received).await;
                    assert_eq!(load["method"], "session/load");
                    assert_eq!(load["params"], resume["params"]);
                    control.write_stdout_line(&json!({"id": 3, "result": {"sessionId": "wrong", "models": {}}}));
                }
            });
            if code == -32603 {
                assert_eq!(resumed.unwrap_err().to_string(), text);
            } else {
                assert_eq!(resumed.unwrap(), json!({"sessionId": "original", "models": {}}));
            }
            assert!(received.try_recv().is_err());
            client.close();
        }
    }).await;
}

#[tokio::test]
async fn matches_the_original_client_and_reconnect_wire_bytes() {
    use std::time::Duration;

    let mut oracle = tokio::process::Command::new("bun");
    oracle
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/acp-client-wire.ts"
        ))
        .kill_on_drop(true);
    let oracle = tokio::time::timeout(Duration::from_secs(5), oracle.output())
        .await
        .expect("original ACP client must finish")
        .unwrap();
    assert!(
        oracle.status.success(),
        "{}",
        String::from_utf8_lossy(&oracle.stderr)
    );
    let expected: Value = garcon_js::json::from_slice(&oracle.stdout).unwrap();

    LocalSet::new().run_until(tokio::time::timeout(Duration::from_secs(5), async {
        let (client, control, mut received) = client(Some("oauth-personal"));
        let spec = spec();
        let new = AcpNewSessionParams { cwd: "/work", mcp_servers: None, modes: None, model: None, config: None };
        let target = AcpLoadSessionParams { cwd: "/work", mcp_servers: None, session_id: "original" };
        let prompt = [json!({"type": "text", "text": "hello"})];
        let (actual, ()) = tokio::join!(
            async {
                let connection = client.connect(&spec).await.unwrap();
                let opened = client.new_session(new).await.unwrap();
                let loaded = reconnect_acp_session(&client, &target).await.unwrap();
                let reply = client.prompt_session(
                    AcpPromptSessionParams { session_id: "original", prompt: &prompt, config: None },
                    AcpRequestOptions { timeout_ms: Some(500.0), ..Default::default() },
                ).await.unwrap();
                client.cancel_session("original").unwrap();
                json!({
                    "connection": {"authenticatedMethodId": connection.authenticated_method_id},
                    "opened": opened,
                    "loaded": loaded,
                    "reply": reply,
                    "frames": control.written(),
                })
            },
            async {
                loop {
                    let request = frame(&mut received).await;
                    let result = match request["method"].as_str().unwrap() {
                        "initialize" => json!({
                            "protocolVersion": 1,
                            "authMethods": [{"id": "oauth-personal"}],
                            "agentCapabilities": {"loadSession": true, "sessionCapabilities": {"resume": null}},
                        }),
                        "authenticate" => json!({}),
                        "notifications/initialized" => continue,
                        "session/new" => json!({"sessionId": "created"}),
                        "session/resume" => {
                            control.write_stdout_line(&json!({
                                "id": request["id"], "error": {"code": -32601, "message": "Method not found"},
                            }));
                            continue;
                        }
                        "session/load" => json!({"sessionId": "wrong", "models": {"currentModelId": "model"}}),
                        "session/prompt" => json!({"stopReason": "end_turn"}),
                        "session/cancel" => break,
                        other => panic!("unexpected ACP method {other}"),
                    };
                    control.write_stdout_line(&json!({"id": request["id"], "result": result}));
                }
            },
        );
        assert_eq!(actual, expected);
        client.close();
    })).await.expect("Rust ACP client must finish");
}
