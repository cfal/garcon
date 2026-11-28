//! Ports `test/adapters.test.ts`: the adapters on a listener that also serves
//! other routes.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::spawn_local;
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::noise_ws::connect_noise_web_socket;
use crate::noise_ws::connection::{MessageHandler, NoiseConnection, NoiseReadyState, OpenHandler};
use crate::noise_ws::options::{NoiseLimits, NoiseMessage};
use crate::noise_ws::server::{NoiseServerOptions, create_noise_server};

use super::helpers::{
    CONTEXT, PSK, client_options, deadline, ignoring, inbox, large_exchange_ms, options, real,
    received, received_within, server_options, until,
};
use super::listener::{Reply, get, serve};

#[test]
fn noise_composes_with_unrelated_http_and_websocket_routes_on_one_listener() {
    real(async {
        let noise =
            Rc::new(create_noise_server(NoiseServerOptions::default()).expect("a server builds"));
        let echo: MessageHandler = Rc::new(|socket, message| {
            socket.send(message)?;
            Ok(())
        });
        let fixture = serve(None, {
            let noise = Rc::clone(&noise);
            move |request| match request.uri().path() {
                "/noise" => Reply::Noise {
                    server: Rc::clone(&noise),
                    options: options(Rc::clone(&echo)),
                },
                "/ordinary" => Reply::Echo("ordinary hello"),
                _ => Reply::Text(200, "healthy"),
            }
        })
        .await;
        let health = get(&fixture.url("http", "/health")).await;
        assert_eq!((health.status, health.body.as_str()), (200, "healthy"));
        let (mut ordinary, _) = connect_async(fixture.url("ws", "/ordinary").as_str())
            .await
            .expect("the ordinary socket opens");
        assert_eq!(
            ordinary.next().await.unwrap().unwrap(),
            Message::Text("ordinary hello".into())
        );
        ordinary
            .send(Message::Text("ordinary echo".into()))
            .await
            .expect("the ordinary socket sends");
        assert_eq!(
            ordinary.next().await.unwrap().unwrap(),
            Message::Text("ordinary echo".into())
        );
        let (echoed, handler) = inbox();
        let mut options = client_options(handler);
        options.on_open = Some(Rc::new(|socket, ()| {
            socket.send(NoiseMessage::Text("encrypted echo".into()))?;
            Ok(())
        }));
        let encrypted = connect_noise_web_socket(fixture.url("ws", "/noise").as_str(), options)
            .expect("a connection builds");
        assert_eq!(
            received(&echoed, 1).await,
            [NoiseMessage::Text("encrypted echo".into())]
        );
        assert_eq!(noise.size(), 1);
        encrypted.close();
        let _ = ordinary.close(None).await;
    });
}

#[test]
fn pending_and_total_connection_limits_recover_after_timeout_and_close() {
    real(async {
        let noise = Rc::new(
            create_noise_server(NoiseServerOptions {
                max_connections: Some(2),
                max_pending_handshakes: Some(1),
            })
            .expect("a server builds"),
        );
        let fixture = serve(None, {
            let noise = Rc::clone(&noise);
            move |_| Reply::Noise {
                server: Rc::clone(&noise),
                options: server_options(
                    None,
                    Some(NoiseLimits {
                        handshake_timeout_ms: Some(150),
                        ..NoiseLimits::default()
                    }),
                ),
            }
        })
        .await;
        let url = fixture.url("ws", "/");
        // A raw client: it connects and never speaks.
        let (mut raw, _) = connect_async(url.as_str())
            .await
            .expect("the raw socket opens");
        until(|| noise.size() == 1).await;
        assert_eq!(get(&fixture.url("http", "/")).await.status, 503);
        deadline(async { while raw.next().await.is_some() {} }, 5_000).await;
        until(|| noise.size() == 0).await;
        let mut sockets = Vec::new();
        for _ in 0..2 {
            let socket = connect_noise_web_socket(url.as_str(), client_options(ignoring()))
                .expect("a connection builds");
            deadline(socket.ready(), 2_000).await.expect("it opens");
            sockets.push(socket);
        }
        assert_eq!(noise.size(), 2);
        assert_eq!(get(&fixture.url("http", "/")).await.status, 503);
        noise.close();
        assert_eq!(noise.size(), 0);
    });
}

#[test]
fn bun_accepted_but_backpressured_writes_are_never_retried_and_drain_without_corrupting_nonces() {
    real(async {
        let noise =
            Rc::new(create_noise_server(NoiseServerOptions::default()).expect("a server builds"));
        let payload = Rc::new(vec![73_u8; 16 * 1024 * 1024]);
        let server_socket: Rc<RefCell<Option<Rc<NoiseConnection>>>> = Rc::default();
        // What the sends answered: accepted, with bytes still queued.
        let accepted = Rc::new(Cell::new(None));
        let on_open: OpenHandler = {
            let payload = Rc::clone(&payload);
            let server_socket = Rc::clone(&server_socket);
            let accepted = Rc::clone(&accepted);
            Rc::new(move |socket: &Rc<NoiseConnection>, ()| {
                socket.send(NoiseMessage::Binary((*payload).clone()))?;
                socket.send(NoiseMessage::Text("after pressure".into()))?;
                accepted.set(Some(socket.buffered_amount()));
                *server_socket.borrow_mut() = Some(Rc::clone(socket));
                Ok(())
            })
        };
        let fixture = serve(None, {
            let noise = Rc::clone(&noise);
            let on_open = Rc::clone(&on_open);
            move |_| Reply::Noise {
                server: Rc::clone(&noise),
                options: server_options(Some(Rc::clone(&on_open)), None),
            }
        })
        .await;
        let (messages, on_message) = inbox();
        let socket =
            connect_noise_web_socket(fixture.url("ws", "/").as_str(), client_options(on_message))
                .expect("a connection builds");
        deadline(socket.ready(), large_exchange_ms(2_000))
            .await
            .expect("it opens");
        let messages = received_within(&messages, 2, large_exchange_ms(5_000)).await;
        assert!(matches!(&messages[0], NoiseMessage::Binary(bytes) if **payload == *bytes));
        assert_eq!(messages[1], NoiseMessage::Text("after pressure".into()));
        assert_eq!(socket.ready_state(), NoiseReadyState::Open);
        assert!(accepted.get().is_some_and(|queued| queued > 0));
        deadline(
            async {
                loop {
                    let queued = server_socket
                        .borrow()
                        .as_ref()
                        .map_or(0, |socket| socket.buffered_amount());
                    if queued == 0 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            },
            5_000,
        )
        .await;
    });
}

/// A relay without the secret: it forwards bytes and keeps what the client
/// sent, flipping a byte of it once `tamper` is set.
async fn relay(backend: u16, captures: Rc<RefCell<Vec<Vec<u8>>>>, tamper: Rc<Cell<bool>>) -> u16 {
    let listener = TcpListener::bind(("0.0.0.0", 0))
        .await
        .expect("the relay binds");
    let port = listener.local_addr().expect("the relay's address").port();
    spawn_local(async move {
        while let Ok((client, _)) = listener.accept().await {
            let Ok(Ok(upstream)) = timeout(
                Duration::from_secs(5),
                TcpStream::connect(("127.0.0.1", backend)),
            )
            .await
            else {
                continue;
            };
            let captures = Rc::clone(&captures);
            let tamper = Rc::clone(&tamper);
            spawn_local(async move {
                let (mut client_read, mut client_write) = tokio::io::split(client);
                let (mut upstream_read, mut upstream_write) = tokio::io::split(upstream);
                let to_upstream = async {
                    let mut chunk = vec![0_u8; 65_536];
                    loop {
                        let read = client_read.read(&mut chunk).await?;
                        if read == 0 {
                            break;
                        }
                        chunk.truncate(read);
                        captures.borrow_mut().push(chunk.clone());
                        if tamper.get() {
                            let last = read - 1;
                            chunk[last] ^= 1;
                        }
                        upstream_write.write_all(&chunk).await?;
                        chunk.resize(65_536, 0);
                    }
                    Ok::<(), std::io::Error>(())
                };
                let to_client = async {
                    tokio::io::copy(&mut upstream_read, &mut client_write)
                        .await
                        .map(|_| ())
                };
                tokio::select! {
                    _ = to_upstream => {}
                    _ = to_client => {}
                }
            });
        }
    });
    port
}

#[test]
fn a_relay_without_the_psk_only_sees_ciphertext_and_mutation_terminates_the_encrypted_connection() {
    real(async {
        let noise =
            Rc::new(create_noise_server(NoiseServerOptions::default()).expect("a server builds"));
        let delivered: Rc<RefCell<Vec<NoiseMessage>>> = Rc::default();
        let on_message = {
            let delivered = Rc::clone(&delivered);
            let on_message: MessageHandler = Rc::new(move |socket, message| {
                delivered.borrow_mut().push(message.clone());
                socket.send(message)?;
                Ok(())
            });
            on_message
        };
        let backend = serve(None, {
            let noise = Rc::clone(&noise);
            let on_message = Rc::clone(&on_message);
            move |_| Reply::Noise {
                server: Rc::clone(&noise),
                options: options(Rc::clone(&on_message)),
            }
        })
        .await;
        let captures: Rc<RefCell<Vec<Vec<u8>>>> = Rc::default();
        let tamper = Rc::new(Cell::new(false));
        let relay_port = relay(backend.port, Rc::clone(&captures), Rc::clone(&tamper)).await;
        let (echoed, handler) = inbox();
        let socket = connect_noise_web_socket(
            &format!("ws://127.0.0.1:{relay_port}/"),
            client_options(handler),
        )
        .expect("a connection builds");
        deadline(socket.ready(), 2_000).await.expect("it opens");
        let private = NoiseMessage::Text("private application payload".into());
        socket.send(private.clone()).expect("it sends");
        assert_eq!(received(&echoed, 1).await, std::slice::from_ref(&private));
        let payload = b"private application payload";
        for frame in captures.borrow().iter() {
            assert!(
                !frame.windows(PSK.len()).any(|window| window == PSK),
                "the key escaped"
            );
            assert!(
                !frame.windows(payload.len()).any(|window| window == payload),
                "the payload escaped"
            );
            assert!(
                !frame
                    .windows(CONTEXT.len())
                    .any(|window| window == CONTEXT.as_bytes()),
                "the context escaped"
            );
        }
        tamper.set(true);
        socket
            .send(NoiseMessage::Text("must not arrive".into()))
            .expect("it sends");
        deadline(socket.closed(), 2_000).await;
        assert_eq!(*delivered.borrow(), vec![private]);
    });
}
