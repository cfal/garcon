//! Ports `test/connection.test.ts`.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use crate::noise_ws::connection::{
    CloseHandler, HandlerResult, NoiseConnection, NoiseFrame, NoiseReadyState, NoiseTransport,
    RejectedWrite,
};
use crate::noise_ws::crypto::NoiseCrypto;
use crate::noise_ws::errors::{NoiseError, NoiseErrorCode};
use crate::noise_ws::options::{
    MAX_RECORDS_PER_DIRECTION, NoiseCloseInfo, NoiseLimits, NoiseMessage, NoiseOptions,
    connection_prologue,
};
use crate::noise_ws::records::message_records;

use super::helpers::{
    CONTEXT, From, Overrides, PSK, Silent, binary, code, counting, deadline, frames, messages,
    pair, paused, settle, text, throwing, throws,
};

const AUTHENTICATION_FAILED: NoiseErrorCode = NoiseErrorCode::AuthenticationFailed;

#[test]
fn does_not_admit_either_peer_before_directional_key_confirmation() {
    paused(async {
        let fixture = pair(Overrides::default(), Overrides::default());
        let confirm = Rc::new(RefCell::new(None));
        fixture.set_filter({
            let confirm = Rc::clone(&confirm);
            Box::new(move |frame, from| {
                if from == From::Left && frame.len() == 17 {
                    *confirm.borrow_mut() = Some(frame.to_vec());
                    return Ok(None);
                }
                Ok(Some(frame.to_vec()))
            })
        });
        fixture.start();
        settle(1).await;
        assert!(confirm.borrow().is_some());
        assert_eq!(fixture.left.ready_state(), NoiseReadyState::Confirming);
        assert_eq!(fixture.right.ready_state(), NoiseReadyState::Confirming);
        assert_eq!(
            fixture.left.send(text("not yet")),
            Err(NoiseError::new(NoiseErrorCode::NotOpen))
        );
        let withheld = confirm
            .borrow()
            .clone()
            .expect("the confirmation was withheld");
        fixture.right.receive(NoiseFrame::Binary(&withheld));
        fixture.ready().await;
        fixture.close();
    });
}

#[test]
fn preserves_text_binary_empties_bom_and_large_messages_in_both_directions() {
    paused(async {
        let fixture = pair(Overrides::default(), Overrides::default());
        fixture.start();
        fixture.ready().await;
        let sent = [
            NoiseMessage::Text(String::new()),
            NoiseMessage::Text("\u{feff}hello\n\u{1f642}".to_owned()),
            NoiseMessage::Binary(Vec::new()),
            NoiseMessage::Binary(vec![0, 255, 13]),
            NoiseMessage::Text("large ".repeat(30_000)),
        ];
        for message in &sent {
            fixture.left.send(message.clone()).expect("it sends");
            fixture.right.send(message.clone()).expect("it sends");
        }
        settle(1).await;
        assert_eq!(messages(&fixture, From::Left), sent);
        assert_eq!(messages(&fixture, From::Right), sent);
        {
            let written = fixture.left_frames.borrow();
            assert!(written.iter().all(|frame| frame.len() <= 65_535));
            assert!(
                !written
                    .iter()
                    .any(|frame| frame.windows(6).any(|window| window == b"large "))
            );
        }
        fixture.close();
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wrong {
    Key,
    Context,
}

fn rejects_without_open_callbacks_or_application_delivery(wrong: Wrong) {
    paused(async {
        let opens = Rc::new(Cell::new(0));
        let fixture = pair(
            Overrides {
                on_open: Some(Rc::new(counting(Rc::clone(&opens)))),
                ..Overrides::default()
            },
            Overrides {
                psk: (wrong == Wrong::Key).then(|| vec![99; 32]),
                context: (wrong == Wrong::Context).then(|| "another-protocol".to_owned()),
                on_open: Some(Rc::new(counting(Rc::clone(&opens)))),
                ..Overrides::default()
            },
        );
        fixture.start();
        let closed = deadline(fixture.right.closed(), 2_000).await;
        assert_eq!(code(closed), AUTHENTICATION_FAILED);
        assert_eq!(
            deadline(fixture.right.ready(), 2_000).await,
            Err(NoiseError::new(AUTHENTICATION_FAILED))
        );
        assert_eq!(opens.get(), 0);
        assert!(messages(&fixture, From::Right).is_empty());
        fixture.close();
    });
}

#[test]
fn rejects_wrong_key_without_open_callbacks_or_application_delivery() {
    rejects_without_open_callbacks_or_application_delivery(Wrong::Key);
}

#[test]
fn rejects_wrong_context_without_open_callbacks_or_application_delivery() {
    rejects_without_open_callbacks_or_application_delivery(Wrong::Context);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Attack {
    Corrupt,
    Duplicate,
    Reorder,
    Reflect,
}

fn rejects_transport_records(attack: Attack) {
    paused(async {
        let fixture = pair(Overrides::default(), Overrides::default());
        fixture.start();
        fixture.ready().await;
        let held = Rc::new(RefCell::new(Vec::new()));
        fixture.set_filter({
            let held = Rc::clone(&held);
            Box::new(move |frame, from| {
                if from == From::Left {
                    held.borrow_mut().push(frame.to_vec());
                    return Ok(None);
                }
                Ok(Some(frame.to_vec()))
            })
        });
        fixture.left.send(text("first")).expect("it sends");
        fixture.left.send(text("second")).expect("it sends");
        let held = held.borrow().clone();
        let deliver = |socket: &Rc<NoiseConnection>, frame: &[u8]| {
            socket.receive(NoiseFrame::Binary(frame));
        };
        match attack {
            Attack::Corrupt => {
                let mut corrupt = held[0].clone();
                let last = corrupt.len() - 1;
                corrupt[last] ^= 1;
                deliver(&fixture.right, &corrupt);
            }
            Attack::Duplicate => {
                deliver(&fixture.right, &held[0]);
                deliver(&fixture.right, &held[0]);
            }
            Attack::Reorder => deliver(&fixture.right, &held[1]),
            Attack::Reflect => deliver(&fixture.left, &held[0]),
        }
        let attacked = match attack {
            Attack::Reflect => deadline(fixture.left.closed(), 2_000).await,
            _ => deadline(fixture.right.closed(), 2_000).await,
        };
        assert_eq!(code(attacked), AUTHENTICATION_FAILED);
        let delivered = if attack == Attack::Duplicate {
            vec![text("first")]
        } else {
            Vec::new()
        };
        assert_eq!(messages(&fixture, From::Right), delivered);
        fixture.close();
    });
}

#[test]
fn rejects_corrupt_transport_records() {
    rejects_transport_records(Attack::Corrupt);
}

#[test]
fn rejects_duplicate_transport_records() {
    rejects_transport_records(Attack::Duplicate);
}

#[test]
fn rejects_reordered_transport_records() {
    rejects_transport_records(Attack::Reorder);
}

#[test]
fn rejects_reflected_transport_records() {
    rejects_transport_records(Attack::Reflect);
}

#[test]
fn fresh_connections_reject_old_ciphertext_and_replayed_first_handshakes_cannot_reach_open() {
    paused(async {
        let previous = pair(Overrides::default(), Overrides::default());
        previous.start();
        previous.ready().await;
        previous.left.send(text("old payload")).expect("it sends");
        let ciphertext = previous
            .left_frames
            .borrow()
            .last()
            .cloned()
            .expect("a frame");
        let first_hello = previous.left_frames.borrow()[0].clone();
        previous.close();
        let replacement = pair(Overrides::default(), Overrides::default());
        replacement.start();
        replacement.ready().await;
        replacement.right.receive(NoiseFrame::Binary(&ciphertext));
        assert_eq!(
            code(deadline(replacement.right.closed(), 2_000).await),
            AUTHENTICATION_FAILED
        );
        replacement.close();
        let replayed = NoiseConnection::new(
            false,
            NoiseOptions {
                psk: PSK.to_vec(),
                context: CONTEXT.to_owned(),
                limits: Some(NoiseLimits {
                    handshake_timeout_ms: Some(20),
                    ..NoiseLimits::default()
                }),
                on_message: throwing("unreachable"),
                on_open: None,
                on_error: None,
                on_close: None,
            },
            None,
        )
        .expect("a connection builds");
        replayed.attach(Rc::new(Silent));
        replayed.receive(NoiseFrame::Binary(&first_hello));
        assert_eq!(replayed.ready_state(), NoiseReadyState::Confirming);
        assert_eq!(
            code(deadline(replayed.closed(), 2_000).await),
            NoiseErrorCode::HandshakeTimeout
        );
    });
}

#[test]
fn caps_messages_before_encryption_without_damaging_a_healthy_connection() {
    paused(async {
        let fixture = pair(
            Overrides {
                limits: Some(NoiseLimits {
                    max_message_bytes: Some(5),
                    ..NoiseLimits::default()
                }),
                ..Overrides::default()
            },
            Overrides::default(),
        );
        fixture.start();
        fixture.ready().await;
        let before = frames(&fixture, From::Left);
        throws(
            fixture
                .left
                .send(text("too large"))
                .expect_err("an oversized message"),
            "size limit",
        );
        assert_eq!(frames(&fixture, From::Left), before);
        fixture.left.send(text("valid")).expect("it sends");
        settle(1).await;
        assert_eq!(messages(&fixture, From::Right), vec![text("valid")]);
        fixture.close();
    });
}

#[test]
fn rejects_plaintext_malformed_and_oversized_wire_messages() {
    paused(async {
        let oversized = vec![0; 65_536];
        let short = vec![0; 18];
        for invalid in [
            NoiseFrame::Other,
            NoiseFrame::Binary(&[]),
            NoiseFrame::Binary(&oversized),
            NoiseFrame::Binary(&short),
        ] {
            let fixture = pair(Overrides::default(), Overrides::default());
            fixture.start();
            fixture.ready().await;
            fixture.right.receive(invalid);
            let closed = deadline(fixture.right.closed(), 2_000).await;
            assert!(!closed.authenticated);
            assert!(messages(&fixture, From::Right).is_empty());
            fixture.close();
        }
    });
}

#[test]
fn refuses_backpressure_before_encryption_but_treats_a_write_failure_as_terminal() {
    paused(async {
        let fixture = pair(Overrides::default(), Overrides::default());
        fixture.start();
        fixture.ready().await;
        fixture.set_buffered_amount(32 * 1024 * 1024);
        let before = frames(&fixture, From::Left);
        throws(
            fixture.left.send(text("test")).expect_err("a full buffer"),
            "buffer limit",
        );
        assert_eq!(fixture.left.ready_state(), NoiseReadyState::Open);
        assert_eq!(frames(&fixture, From::Left), before);
        fixture.set_buffered_amount(0);
        fixture
            .left
            .send(text("retry before any encryption"))
            .expect("it sends");
        settle(1).await;
        assert_eq!(
            messages(&fixture, From::Right),
            vec![text("retry before any encryption")]
        );
        fixture.set_write_error(true);
        assert_eq!(
            fixture.left.send(text("test")),
            Err(NoiseError::new(NoiseErrorCode::TransportError))
        );
        assert_eq!(
            code(deadline(fixture.left.closed(), 2_000).await),
            NoiseErrorCode::TransportError
        );
        assert_eq!(
            fixture.left.send(text("retry")),
            Err(NoiseError::new(NoiseErrorCode::NotOpen))
        );
        fixture.close();
    });
}

#[test]
fn enforces_the_record_budget_including_key_confirmation() {
    paused(async {
        let fixture = pair(
            Overrides {
                limits: Some(NoiseLimits {
                    max_records_per_direction: Some(2),
                    ..NoiseLimits::default()
                }),
                ..Overrides::default()
            },
            Overrides::default(),
        );
        fixture.start();
        fixture.ready().await;
        fixture
            .left
            .send(text("only allowed message"))
            .expect("it sends");
        throws(
            fixture
                .left
                .send(text("would exceed limit"))
                .expect_err("the budget is spent"),
            "record limit",
        );
        assert_eq!(
            code(deadline(fixture.left.closed(), 2_000).await),
            NoiseErrorCode::RecordLimit
        );
        assert_eq!(frames(&fixture, From::Left), 3);
        fixture.close();
        assert!(
            crate::noise_ws::options::resolve_limits(Some(NoiseLimits {
                max_records_per_direction: Some(MAX_RECORDS_PER_DIRECTION + 1),
                ..NoiseLimits::default()
            }))
            .is_err()
        );
    });
}

#[test]
fn unexpected_or_detached_native_frame_types_fail_closed_without_throwing_out_of_the_handler() {
    // A detached `ArrayBuffer` has no Rust counterpart: bytes are always readable.
    paused(async {
        let socket = NoiseConnection::new(
            false,
            NoiseOptions {
                psk: PSK.to_vec(),
                context: CONTEXT.to_owned(),
                limits: None,
                on_message: throwing("unreachable"),
                on_open: None,
                on_error: None,
                on_close: None,
            },
            None,
        )
        .expect("a connection builds");
        socket.attach(Rc::new(Silent));
        socket.receive(NoiseFrame::Other);
        assert!(deadline(socket.closed(), 2_000).await.error.is_some());
    });
}

#[test]
fn separates_an_authenticated_close_from_an_untrusted_transport_drop() {
    paused(async {
        let graceful = pair(Overrides::default(), Overrides::default());
        graceful.start();
        graceful.ready().await;
        graceful.left.close();
        assert_eq!(
            deadline(graceful.right.closed(), 2_000).await,
            NoiseCloseInfo {
                authenticated: true,
                error: None
            }
        );
        let dropped = pair(Overrides::default(), Overrides::default());
        dropped.start();
        dropped.ready().await;
        dropped.right.fail(NoiseErrorCode::TransportClosed);
        let closed = deadline(dropped.right.closed(), 2_000).await;
        assert!(!closed.authenticated);
        assert_eq!(code(closed), NoiseErrorCode::TransportClosed);
        dropped.close();
    });
}

#[test]
fn a_fragmented_message_has_a_total_deadline_rather_than_a_sliding_deadline() {
    paused(async {
        let fixture = pair(
            Overrides::default(),
            Overrides {
                limits: Some(NoiseLimits {
                    message_timeout_ms: Some(20),
                    ..NoiseLimits::default()
                }),
                ..Overrides::default()
            },
        );
        fixture.start();
        fixture.ready().await;
        let kept = Cell::new(false);
        fixture.set_filter(Box::new(move |frame, from| {
            if from != From::Left {
                return Ok(Some(frame.to_vec()));
            }
            // The first fragment is delivered; every later one is withheld.
            if kept.replace(true) {
                return Ok(None);
            }
            Ok(Some(frame.to_vec()))
        }));
        fixture.left.send(binary(200_000)).expect("it sends");
        assert_eq!(
            code(deadline(fixture.right.closed(), 2_000).await),
            NoiseErrorCode::MessageTimeout
        );
        assert!(messages(&fixture, From::Right).is_empty());
        fixture.close();
    });
}

#[test]
fn callbacks_settle_once_failures_are_sanitized_and_caller_psks_are_not_erased() {
    paused(async {
        let closes = Rc::new(Cell::new(0));
        let on_close: CloseHandler = {
            let closes = Rc::clone(&closes);
            Rc::new(move |_: &Rc<NoiseConnection>, _: NoiseCloseInfo| {
                closes.set(closes.get() + 1);
                Err("ignored".into())
            })
        };
        let fixture = pair(
            Overrides::default(),
            Overrides {
                on_message: Some(throwing("sensitive details")),
                on_close: Some(on_close),
                ..Overrides::default()
            },
        );
        fixture.start();
        fixture.ready().await;
        fixture.left.send(text("trigger")).expect("it sends");
        let result = deadline(fixture.right.closed(), 2_000).await;
        let error = result.error.expect("the handler failed").to_string();
        assert!(!error.contains("sensitive"));
        assert_eq!(code(result), NoiseErrorCode::HandlerError);
        fixture.right.fail(NoiseErrorCode::TransportError);
        fixture.close();
        assert_eq!(closes.get(), 1);
        assert_eq!(PSK, [42; 32]);
    });
}

#[test]
fn replaying_either_side_of_a_complete_transcript_cannot_open_a_new_connection() {
    paused(async {
        let previous = pair(Overrides::default(), Overrides::default());
        previous.start();
        previous.ready().await;
        previous
            .left
            .send(text("previous initiator"))
            .expect("it sends");
        previous
            .right
            .send(text("previous responder"))
            .expect("it sends");
        for initiator in [true, false] {
            let opens = Rc::new(Cell::new(0));
            let received = Rc::new(Cell::new(0));
            let on_message = {
                let received = Rc::clone(&received);
                Rc::new(move |_: &Rc<NoiseConnection>, _: NoiseMessage| {
                    received.set(received.get() + 1);
                    Ok(())
                })
            };
            let replay = NoiseConnection::new(
                initiator,
                NoiseOptions {
                    psk: PSK.to_vec(),
                    context: CONTEXT.to_owned(),
                    limits: None,
                    on_message,
                    on_open: Some(Rc::new(counting(Rc::clone(&opens)))),
                    on_error: None,
                    on_close: None,
                },
                None,
            )
            .expect("a connection builds");
            replay.attach(Rc::new(Silent));
            let transcript = if initiator {
                previous.right_frames.borrow().clone()
            } else {
                previous.left_frames.borrow().clone()
            };
            for frame in &transcript {
                replay.receive(NoiseFrame::Binary(frame));
            }
            assert_eq!(
                code(deadline(replay.closed(), 2_000).await),
                AUTHENTICATION_FAILED
            );
            assert_eq!(opens.get(), 0);
            assert_eq!(received.get(), 0);
        }
        previous.close();
    });
}

#[test]
fn the_wire_version_is_authenticated_as_part_of_the_prologue() {
    paused(async {
        let mut prologue = connection_prologue(CONTEXT).expect("a prologue");
        prologue[b"cfal/noise-ws\0".len()] = 2;
        let mut other_version =
            NoiseCrypto::new(true, &PSK, &prologue, MAX_RECORDS_PER_DIRECTION as u64)
                .expect("an engine builds");
        let opened = Rc::new(Cell::new(0_u32));
        let socket = NoiseConnection::new(
            false,
            NoiseOptions {
                psk: PSK.to_vec(),
                context: CONTEXT.to_owned(),
                limits: None,
                on_message: throwing("unreachable"),
                on_open: Some(Rc::new(counting(Rc::clone(&opened)))),
                on_error: None,
                on_close: None,
            },
            None,
        )
        .expect("a connection builds");
        socket.attach(Rc::new(Silent));
        let hello = other_version.send_handshake().expect("it sends");
        socket.receive(NoiseFrame::Binary(&hello));
        assert_eq!(
            code(deadline(socket.closed(), 2_000).await),
            AUTHENTICATION_FAILED
        );
        assert_eq!(opened.get(), 0);
        other_version.destroy();
    });
}

#[test]
fn async_callback_rejection_closes_once_without_leaking_the_rejection_reason() {
    paused(async {
        let errors = Rc::new(Cell::new(0));
        let closes = Rc::new(Cell::new(0));
        let fixture = pair(
            Overrides::default(),
            Overrides {
                on_message: Some(crate::noise_ws::async_handler(|_, _| async {
                    tokio::task::yield_now().await;
                    Err("secret asynchronous failure".into())
                })),
                on_error: Some(Rc::new({
                    let errors = Rc::clone(&errors);
                    move |_: &Rc<NoiseConnection>, _: NoiseError| {
                        errors.set(errors.get() + 1);
                        Ok(())
                    }
                })),
                on_close: Some(Rc::new({
                    let closes = Rc::clone(&closes);
                    move |_: &Rc<NoiseConnection>, _: NoiseCloseInfo| {
                        closes.set(closes.get() + 1);
                        Ok(())
                    }
                })),
                ..Overrides::default()
            },
        );
        fixture.start();
        fixture.ready().await;
        fixture.left.send(text("trigger")).expect("it sends");
        let info = deadline(fixture.right.closed(), 2_000).await;
        assert_eq!(code(info), NoiseErrorCode::HandlerError);
        assert!(!info.error.expect("an error").to_string().contains("secret"));
        fixture.close();
        fixture.close();
        assert_eq!(errors.get(), 1);
        assert_eq!(closes.get(), 1);
    });
}

/// An authenticated but malicious peer: it holds the secret and a raw engine,
/// so it can send records the protocol does not allow.
struct Malicious {
    engine: Rc<RefCell<NoiseCrypto>>,
    socket: Rc<NoiseConnection>,
    received: Rc<RefCell<Vec<NoiseMessage>>>,
}

impl Malicious {
    fn encrypt(&self, record: &[u8]) -> Vec<u8> {
        self.engine
            .borrow_mut()
            .encrypt(record)
            .expect("it encrypts")
    }

    fn close(&self) {
        self.socket.close();
        self.engine.borrow_mut().destroy();
    }
}

/// The socket's transport, which answers through the engine instead of a peer.
struct EngineTransport {
    engine: Rc<RefCell<NoiseCrypto>>,
    handshake: Cell<bool>,
}

impl NoiseTransport for EngineTransport {
    fn buffered_amount(&self) -> usize {
        0
    }

    fn write(&self, frame: Vec<u8>) -> Result<(), RejectedWrite> {
        let mut engine = self.engine.borrow_mut();
        if self.handshake.replace(false) {
            let _ = engine.receive_handshake(&frame);
        } else {
            let _ = engine.decrypt(&frame);
        }
        Ok(())
    }

    fn close(&self) {}

    fn abort(&self) {}
}

async fn malicious(limits: NoiseLimits) -> Malicious {
    let engine = Rc::new(RefCell::new(
        NoiseCrypto::new(
            true,
            &PSK,
            &connection_prologue(CONTEXT).expect("a prologue"),
            MAX_RECORDS_PER_DIRECTION as u64,
        )
        .expect("an engine builds"),
    ));
    let received: Rc<RefCell<Vec<NoiseMessage>>> = Rc::default();
    let on_message = {
        let received = Rc::clone(&received);
        Rc::new(
            move |_: &Rc<NoiseConnection>, message: NoiseMessage| -> HandlerResult {
                received.borrow_mut().push(message);
                Ok(())
            },
        )
    };
    let socket = NoiseConnection::new(
        false,
        NoiseOptions {
            psk: PSK.to_vec(),
            context: CONTEXT.to_owned(),
            limits: Some(limits),
            on_message,
            on_open: None,
            on_error: None,
            on_close: None,
        },
        None,
    )
    .expect("a connection builds");
    socket.attach(Rc::new(EngineTransport {
        engine: Rc::clone(&engine),
        handshake: Cell::new(true),
    }));
    let hello = engine.borrow_mut().send_handshake().expect("it sends");
    socket.receive(NoiseFrame::Binary(&hello));
    let ready = engine.borrow_mut().encrypt(&[1]).expect("it encrypts");
    socket.receive(NoiseFrame::Binary(&ready));
    socket.ready().await.expect("it opens");
    Malicious {
        engine,
        socket,
        received,
    }
}

#[test]
fn rejects_invalid_authenticated_record() {
    for record in [
        &[18, 1][..],
        &[255][..],
        &[16, 0, 0, 0, 2, 0],
        &[16, 0, 0, 0, 1, 255],
        &[1][..],
        &[3, 1],
    ] {
        paused(async {
            let fixture = malicious(NoiseLimits::default()).await;
            let frame = fixture.encrypt(record);
            fixture.socket.receive(NoiseFrame::Binary(&frame));
            assert_eq!(
                code(deadline(fixture.socket.closed(), 2_000).await),
                NoiseErrorCode::ProtocolError
            );
            assert!(fixture.received.borrow().is_empty(), "{record:?}");
            fixture.close();
        });
    }
}

#[test]
fn rejects_oversized_declared_messages_without_partial_delivery() {
    paused(async {
        let fixture = malicious(NoiseLimits {
            max_message_bytes: Some(100),
            ..NoiseLimits::default()
        })
        .await;
        let frame = fixture.encrypt(&[17, 255, 255, 255, 255]);
        fixture.socket.receive(NoiseFrame::Binary(&frame));
        assert_eq!(
            code(deadline(fixture.socket.closed(), 2_000).await),
            NoiseErrorCode::MessageTooLarge
        );
        fixture.close();
    });
}

#[test]
fn rejects_nested_starts_and_authenticated_close_during_partial_messages() {
    for record in [&[3_u8][..], &[17, 0, 0, 0, 0]] {
        paused(async {
            let fixture = malicious(NoiseLimits::default()).await;
            let start = message_records(&vec![0; 100_000], false)
                .next()
                .expect("a start record");
            let frame = fixture.encrypt(&start);
            fixture.socket.receive(NoiseFrame::Binary(&frame));
            let frame = fixture.encrypt(record);
            fixture.socket.receive(NoiseFrame::Binary(&frame));
            assert_eq!(
                code(deadline(fixture.socket.closed(), 2_000).await),
                NoiseErrorCode::ProtocolError
            );
            fixture.close();
        });
    }
}
