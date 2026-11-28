use std::cell::RefCell;
use std::process::Stdio;
use std::rc::Rc;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader, Lines};
use tokio::process::{Child, ChildStdout, Command};

use crate::noise_ws::{
    NoiseCloseInfo, NoiseErrorCode, NoiseLimits, NoiseMessage, NoiseOptions, NoiseServerOptions,
    connect_noise_web_socket, create_noise_server,
};

use super::helpers::{
    client_options, code, deadline, ignoring, inbox, options, real, received, text,
};
use super::listener::{Reply, serve};

fn bun(mode: &str, url: Option<String>) -> Child {
    let mut command = Command::new("bun");
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/noise_ws/tests/fixtures/bun-peer.ts"
        ))
        .arg(mode)
        .args(url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true);
    command.spawn().expect("starts the Bun 1.4.3 oracle")
}

fn output(child: &mut Child) -> Lines<BufReader<ChildStdout>> {
    BufReader::new(child.stdout.take().expect("Bun stdout")).lines()
}

async fn line(output: &mut Lines<BufReader<ChildStdout>>) -> String {
    deadline(output.next_line(), 10_000)
        .await
        .expect("reads the Bun oracle's stdout")
        .expect("the Bun oracle produced a line")
}

async fn expect_close(output: &mut Lines<BufReader<ChildStdout>>, result: Value) {
    let actual: Value = garcon_js::json::from_str(&line(output).await).unwrap();
    assert_eq!(actual, result);
}

#[test]
fn rust_client_interoperates_with_the_typescript_server() {
    real(async {
        let mut peer = bun("serve", None);
        let mut output = output(&mut peer);
        let address = line(&mut output).await;
        let (messages, handler) = inbox();
        let socket =
            connect_noise_web_socket(&format!("{address}/normal"), client_options(handler))
                .expect("a connection builds");
        deadline(socket.ready(), 2_000).await.unwrap();
        let payloads = [text("Rust to Bun"), NoiseMessage::Binary(vec![19; 150_000])];
        for payload in &payloads {
            socket.send(payload.clone()).unwrap();
        }
        assert_eq!(received(&messages, payloads.len()).await, payloads);
        socket.close();
        expect_close(
            &mut output,
            json!({
                "path": "/normal", "opened": true, "authenticated": true, "error": null
            }),
        )
        .await;
        for path in ["/wrong-key", "/wrong-context"] {
            let mut options = client_options(ignoring());
            if path == "/wrong-key" {
                options.psk.fill(99);
            } else {
                options.context.push_str("-wrong");
            }
            let wrong = connect_noise_web_socket(&format!("{address}{path}"), options).unwrap();
            assert_eq!(
                deadline(wrong.ready(), 2_000).await.unwrap_err().code,
                NoiseErrorCode::TransportClosed
            );
            expect_close(&mut output, json!({
                "path": path, "opened": false, "authenticated": false, "error": "AUTHENTICATION_FAILED"
            })).await;
        }
        let oversized =
            connect_noise_web_socket(&format!("{address}/oversized"), client_options(ignoring()))
                .unwrap();
        deadline(oversized.ready(), 2_000).await.unwrap();
        oversized.send(text("more than eight bytes")).unwrap();
        assert_eq!(
            code(deadline(oversized.closed(), 2_000).await),
            NoiseErrorCode::TransportClosed
        );
        expect_close(&mut output, json!({
            "path": "/oversized", "opened": true, "authenticated": false, "error": "MESSAGE_TOO_LARGE"
        })).await;
        drop(peer.stdin.take());
        assert!(deadline(peer.wait(), 2_000).await.unwrap().success());
    });
}

#[test]
fn typescript_client_interoperates_with_the_rust_server() {
    real(async {
        let server = Rc::new(create_noise_server(NoiseServerOptions::default()).unwrap());
        let closes = Rc::new(RefCell::new(Vec::new()));
        let fixture = serve(None, {
            let closes = Rc::clone(&closes);
            let server = Rc::clone(&server);
            move |request| {
                let path = request.uri().path().to_owned();
                let oversized = path == "/oversized";
                let closes = Rc::clone(&closes);
                Reply::Noise {
                    server: Rc::clone(&server),
                    options: NoiseOptions {
                        limits: oversized.then_some(NoiseLimits {
                            max_message_bytes: Some(8),
                            ..NoiseLimits::default()
                        }),
                        on_close: Some(Rc::new(move |_, info| {
                            closes.borrow_mut().push((path.clone(), info));
                            Ok(())
                        })),
                        ..options(Rc::new(|socket, message| {
                            socket.send(message)?;
                            Ok(())
                        }))
                    },
                }
            }
        })
        .await;
        let mut peer = bun("dial", Some(fixture.url("ws", "")));
        assert!(deadline(peer.wait(), 15_000).await.unwrap().success());
        let failure = |code: NoiseErrorCode| NoiseCloseInfo {
            authenticated: false,
            error: Some(code.into()),
        };
        assert_eq!(
            *closes.borrow(),
            [
                (
                    "/normal".to_owned(),
                    NoiseCloseInfo {
                        authenticated: true,
                        error: None
                    }
                ),
                (
                    "/wrong-key".to_owned(),
                    failure(NoiseErrorCode::AuthenticationFailed)
                ),
                (
                    "/wrong-context".to_owned(),
                    failure(NoiseErrorCode::AuthenticationFailed)
                ),
                (
                    "/oversized".to_owned(),
                    failure(NoiseErrorCode::MessageTooLarge)
                ),
            ]
        );
        assert_eq!(server.size(), 0);
    });
}
