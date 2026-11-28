//! Ports `test/websocket.test.ts`.

use std::cell::Cell;
use std::rc::Rc;

use futures::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::noise_ws::{
    MAX_MESSAGE_BYTES, NoiseConnection, NoiseErrorCode, NoiseLimits, NoiseMessage, NoiseOptions,
    NoiseReadyState, NoiseServerOptions, NoiseTlsOptions, connect_noise_web_socket,
    create_noise_server,
};

use super::helpers::{
    client_options, code, deadline, ignoring, inbox, large_exchange_ms, options, real, received,
    received_within, text, until,
};
use super::listener::{Reply, get, serve, tls_identity};

fn echo() -> NoiseOptions {
    options(Rc::new(|socket, message| {
        socket.send(message)?;
        Ok(())
    }))
}

async fn ready(socket: &NoiseConnection) {
    deadline(socket.ready(), 2_000)
        .await
        .expect("the connection opens");
}

#[test]
fn client_and_server_exchange_16_mib_streaming_text_and_immediate_on_open_messages_over_plain_ws() {
    real(async {
        let server = Rc::new(create_noise_server(NoiseServerOptions::default()).unwrap());
        let fixture = serve(None, move |_| Reply::Noise {
            server: Rc::clone(&server),
            options: NoiseOptions {
                on_open: Some(Rc::new(|socket, ()| Ok(socket.send(text("server-first"))?))),
                ..echo()
            },
        })
        .await;
        let (messages, handler) = inbox();
        let mut options = client_options(handler);
        options.on_open = Some(Rc::new(|socket, ()| Ok(socket.send(text("client-first"))?)));
        let socket = connect_noise_web_socket(&fixture.url("ws", "/node"), options).unwrap();
        ready(&socket).await;
        let mut expected = vec![text("server-first"), text("client-first")];
        for i in 0..100 {
            let message = text(&format!("token-{i}"));
            socket.send(message.clone()).unwrap();
            expected.push(message);
        }
        assert_eq!(received(&messages, expected.len()).await, expected);
        let message = NoiseMessage::Binary(vec![19; MAX_MESSAGE_BYTES]);
        socket.send(message.clone()).unwrap();
        let mut replies =
            received_within(&messages, expected.len() + 1, large_exchange_ms(5_000)).await;
        assert!(replies.pop().is_some_and(|reply| reply == message));
        socket.close();
    });
}

#[test]
fn wrong_psk_cannot_open_the_real_server_and_does_not_hold_admission() {
    real(async {
        let server = Rc::new(create_noise_server(NoiseServerOptions::default()).unwrap());
        let opened = Rc::new(Cell::new(false));
        let fixture = serve(None, {
            let server = Rc::clone(&server);
            let opened = Rc::clone(&opened);
            move |_| {
                let opened = Rc::clone(&opened);
                Reply::Noise {
                    server: Rc::clone(&server),
                    options: NoiseOptions {
                        on_open: Some(Rc::new(move |_, ()| {
                            opened.set(true);
                            Ok(())
                        })),
                        ..echo()
                    },
                }
            }
        })
        .await;
        let mut options = client_options(ignoring());
        options.psk.fill(91);
        let socket = connect_noise_web_socket(&fixture.url("ws", "/node"), options).unwrap();
        assert!(deadline(socket.ready(), 2_000).await.is_err());
        deadline(socket.closed(), 2_000).await;
        assert!(!opened.get());
        assert_eq!(server.size(), 0);
    });
}

#[test]
fn failed_upgrades_release_admission_and_server_close_rejects_future_upgrades() {
    real(async {
        let server = Rc::new(create_noise_server(NoiseServerOptions::default()).unwrap());
        let fixture = serve(None, {
            let server = Rc::clone(&server);
            move |_| Reply::Noise {
                server: Rc::clone(&server),
                options: echo(),
            }
        })
        .await;
        let url = fixture.url("http", "/node");
        assert_eq!(get(&url).await.status, 400);
        assert_eq!(server.size(), 0);
        server.close();
        assert_eq!(get(&url).await.status, 503);
    });
}

#[test]
fn stalled_raw_clients_time_out_and_free_their_copied_key_state() {
    real(async {
        let server = Rc::new(create_noise_server(NoiseServerOptions::default()).unwrap());
        let fixture = serve(None, {
            let server = Rc::clone(&server);
            move |_| Reply::Noise {
                server: Rc::clone(&server),
                options: NoiseOptions {
                    limits: Some(NoiseLimits {
                        handshake_timeout_ms: Some(30),
                        ..NoiseLimits::default()
                    }),
                    ..echo()
                },
            }
        })
        .await;
        let (mut raw, _) = connect_async(fixture.url("ws", "/node")).await.unwrap();
        deadline(raw.next(), 2_000).await;
        assert_eq!(server.size(), 0);
    });
}

#[test]
fn plaintext_protocol_downgrade_and_oversized_binary_frames_fail_closed() {
    real(async {
        for message in [
            Message::Text("{\"type\":\"hello\"}".into()),
            Message::Binary(vec![0; 65_536].into()),
        ] {
            let server = Rc::new(create_noise_server(NoiseServerOptions::default()).unwrap());
            let closed = Rc::new(Cell::new(None));
            let fixture = serve(None, {
                let server = Rc::clone(&server);
                let closed = Rc::clone(&closed);
                move |_| {
                    let closed = Rc::clone(&closed);
                    Reply::Noise {
                        server: Rc::clone(&server),
                        options: NoiseOptions {
                            on_close: Some(Rc::new(move |_, info| {
                                closed.set(Some(code(info)));
                                Ok(())
                            })),
                            ..echo()
                        },
                    }
                }
            })
            .await;
            let (mut raw, _) = connect_async(fixture.url("ws", "/node")).await.unwrap();
            raw.send(message).await.unwrap();
            until(|| closed.get().is_some()).await;
            assert_eq!(closed.get(), Some(NoiseErrorCode::ProtocolError));
            assert_eq!(server.size(), 0);
        }
    });
}

#[test]
fn abort_already_aborted_signals_and_refusal_settle_both_promises() {
    real(async {
        let server = Rc::new(create_noise_server(NoiseServerOptions::default()).unwrap());
        let fixture = serve(None, move |request| match request.uri().path() {
            "/node" => Reply::Noise {
                server: Rc::clone(&server),
                options: echo(),
            },
            _ => Reply::Text(404, ""),
        })
        .await;
        let signal = CancellationToken::new();
        let mut options = client_options(ignoring());
        options.signal = Some(signal.clone());
        let url = fixture.url("ws", "/node");
        let socket = connect_noise_web_socket(&url, options).unwrap();
        ready(&socket).await;
        signal.cancel();
        assert_eq!(
            code(deadline(socket.closed(), 2_000).await),
            NoiseErrorCode::Closed
        );
        let mut options = client_options(ignoring());
        options.signal = Some(signal);
        let already = connect_noise_web_socket(&url, options).unwrap();
        assert_eq!(already.ready_state(), NoiseReadyState::Closed);
        assert_eq!(
            already.ready().await.unwrap_err().code,
            NoiseErrorCode::Closed
        );
        let refused =
            connect_noise_web_socket(&fixture.url("ws", "/refused"), client_options(ignoring()))
                .unwrap();
        assert_eq!(
            deadline(refused.ready(), 2_000).await.unwrap_err().code,
            NoiseErrorCode::TransportError
        );
        assert_eq!(
            code(deadline(refused.closed(), 2_000).await),
            NoiseErrorCode::TransportError
        );
    });
}

fn verifies_tls(host: &str, wrong_host: &str) {
    real(async {
        let (tls, ca) = tls_identity(host);
        let server = Rc::new(create_noise_server(NoiseServerOptions::default()).unwrap());
        let fixture = serve(Some(tls), move |_| Reply::Noise {
            server: Rc::clone(&server),
            options: echo(),
        })
        .await;
        let url = format!("wss://{host}:{}/node", fixture.port);
        let untrusted = connect_noise_web_socket(&url, client_options(ignoring())).unwrap();
        assert!(deadline(untrusted.ready(), 2_000).await.is_err());
        let ca = NoiseTlsOptions { ca: Some(ca) };
        let mut options = client_options(ignoring());
        options.tls = Some(ca.clone());
        let wrong = connect_noise_web_socket(
            &format!("wss://{wrong_host}:{}/node", fixture.port),
            options,
        )
        .unwrap();
        assert!(deadline(wrong.ready(), 2_000).await.is_err());
        for insecure in [false, true] {
            let mut options = client_options(ignoring());
            options.tls = (!insecure).then(|| ca.clone());
            options.allow_unverified_tls = insecure;
            let socket = connect_noise_web_socket(&url, options).unwrap();
            ready(&socket).await;
            socket.close();
            let mut options = client_options(ignoring());
            options.tls = (!insecure).then(|| ca.clone());
            options.allow_unverified_tls = insecure;
            options.psk.fill(99);
            let wrong_key = connect_noise_web_socket(&url, options).unwrap();
            assert!(deadline(wrong_key.ready(), 2_000).await.is_err());
        }
    });
}

#[test]
fn tls_verifies_dns_names_and_still_requires_the_correct_psk() {
    verifies_tls("localhost", "127.0.0.1");
}

#[test]
fn tls_verifies_ip_addresses_and_still_requires_the_correct_psk() {
    verifies_tls("127.0.0.1", "localhost");
}

#[test]
fn rejects_credentials_in_urls_without_echoing_them() {
    for url in [
        "wss://host/#secret=sensitive",
        "wss://user:sensitive@host/",
        "sensitive",
        "http://host/",
    ] {
        let Err(error) = connect_noise_web_socket(url, client_options(ignoring())) else {
            panic!("accepted an invalid URL");
        };
        assert!(!error.message().contains("sensitive"));
    }
}
