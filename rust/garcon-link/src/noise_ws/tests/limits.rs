//! Ports `test/limits.test.ts`.

use std::cell::Cell;
use std::rc::Rc;

use crate::noise_ws::cipher::NoiseCipher;
use crate::noise_ws::connection::{NoiseConnection, NoiseFrame, NoiseReadyState, RejectedWrite};
use crate::noise_ws::crypto::NoiseCrypto;
use crate::noise_ws::options::{
    MAX_RECORDS_PER_DIRECTION, NoiseLimits, NoiseMessage, NoiseOptions, connection_prologue,
    resolve_limits,
};
use crate::noise_ws::records::{MessageAssembler, message_records, record_count};

use super::helpers::{
    CONTEXT, From, Overrides, PSK, binary, code, counting, deadline, frames, messages, pair,
    paused, text, throwing, throws,
};

#[test]
fn canonical_fragmentation_round_trips_bytes() {
    for size in [
        0,
        1,
        65_513,
        65_514,
        65_515,
        131_032,
        131_033,
        16 * 1024 * 1024,
    ] {
        let payload = vec![37; size];
        let records: Vec<Vec<u8>> = message_records(&payload, false).collect();
        assert_eq!(records.len(), record_count(size));
        assert!(records.iter().all(|record| record.len() <= 65_519));
        let mut assembler = MessageAssembler::default();
        for (index, record) in records.iter().enumerate() {
            let message = assembler
                .receive(record, 16 * 1024 * 1024)
                .expect("a record reads");
            if index == records.len() - 1 {
                assert_eq!(message, Some(NoiseMessage::Binary(payload.clone())));
            } else {
                assert_eq!(message, None);
            }
        }
    }
}

#[test]
fn receiver_record_limit_prevents_extra_decryption_and_clears_the_connection() {
    paused(async {
        let fixture = pair(
            Overrides::default(),
            Overrides {
                limits: Some(NoiseLimits {
                    max_records_per_direction: Some(2),
                    ..NoiseLimits::default()
                }),
                ..Overrides::default()
            },
        );
        fixture.start();
        fixture.ready().await;
        fixture
            .left
            .send(text("last valid nonce"))
            .expect("it sends");
        fixture.left.send(text("exhausted")).expect("it sends");
        assert_eq!(
            code(deadline(fixture.right.closed(), 2_000).await),
            crate::noise_ws::NoiseErrorCode::RecordLimit
        );
        assert_eq!(
            messages(&fixture, From::Right),
            vec![text("last valid nonce")]
        );
        fixture.close();
    });
}

#[test]
fn message_requiring_too_many_records_is_rejected_before_any_fragment_is_encrypted() {
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
        let before = frames(&fixture, From::Left);
        throws(
            fixture
                .left
                .send(binary(65_515))
                .expect_err("too many records"),
            "record limit",
        );
        assert_eq!(frames(&fixture, From::Left), before);
        assert_eq!(
            code(deadline(fixture.left.closed(), 2_000).await),
            crate::noise_ws::NoiseErrorCode::RecordLimit
        );
        fixture.close();
    });
}

#[test]
fn cipher_exhaustion_is_terminal_in_both_directions_with_no_reset_or_retry() {
    let mut left = NoiseCipher::with_limit(&PSK, 2).expect("a cipher builds");
    let mut right = NoiseCipher::with_limit(&PSK, 2).expect("a cipher builds");
    let first = left.encrypt(b"first", &[]).expect("it encrypts");
    assert_eq!(right.decrypt(&first, &[]).expect("it decrypts"), b"first");
    let last = left.encrypt(b"last", &[]).expect("it encrypts");
    assert_eq!(right.decrypt(&last, &[]).expect("it decrypts"), b"last");
    assert_eq!(left.remaining(), 0);
    throws(
        left.encrypt(&[0; 1], &[]).expect_err("an exhausted cipher"),
        "record limit",
    );
    throws(
        right
            .decrypt(&[0; 17], &[])
            .expect_err("an exhausted cipher"),
        "record limit",
    );
    throws(
        left.encrypt(&[0; 1], &[]).expect_err("a destroyed cipher"),
        "closed",
    );
    throws(
        right
            .decrypt(&[0; 17], &[])
            .expect_err("a destroyed cipher"),
        "closed",
    );
    assert_eq!(MAX_RECORDS_PER_DIRECTION, 2_usize.pow(24));
}

#[test]
fn sending_the_maximum_message_plus_one_fails_before_copying_or_writing() {
    paused(async {
        let fixture = pair(Overrides::default(), Overrides::default());
        fixture.start();
        fixture.ready().await;
        throws(
            fixture
                .left
                .send(binary(16 * 1024 * 1024 + 1))
                .expect_err("an oversized message"),
            "size limit",
        );
        assert_eq!(fixture.left.ready_state(), NoiseReadyState::Open);
        assert_eq!(frames(&fixture, From::Left), 2);
        fixture.close();
    });
}

#[test]
fn write_failure_on_handshake_flight_is_terminal_with_no_early_callback() {
    for failed_flight in 0..4 {
        paused(async {
            let opens = Rc::new(Cell::new(0));
            let fixture = pair(
                Overrides {
                    on_open: Some(Rc::new(counting(Rc::clone(&opens)))),
                    ..Overrides::default()
                },
                Overrides {
                    on_open: Some(Rc::new(counting(Rc::clone(&opens)))),
                    ..Overrides::default()
                },
            );
            let flight = Cell::new(0);
            fixture.set_filter(Box::new(move |frame, _from| {
                let current = flight.get();
                flight.set(current + 1);
                if current == failed_flight {
                    Err(RejectedWrite)
                } else {
                    Ok(Some(frame.to_vec()))
                }
            }));
            fixture.start();
            deadline(
                futures::future::join(fixture.left.closed(), fixture.right.closed()),
                2_000,
            )
            .await;
            assert_eq!(opens.get(), 0, "failed flight {failed_flight}");
            fixture.close();
        });
    }
}

#[test]
fn middle_fragment_write_failure_never_delivers_a_partial_application_message() {
    paused(async {
        let fixture = pair(Overrides::default(), Overrides::default());
        fixture.start();
        fixture.ready().await;
        let count = Cell::new(0);
        fixture.set_filter(Box::new(move |frame, from| {
            if from == From::Left {
                let current = count.get();
                count.set(current + 1);
                if current == 1 {
                    return Err(RejectedWrite);
                }
            }
            Ok(Some(frame.to_vec()))
        }));
        throws(
            fixture
                .left
                .send(binary(200_000))
                .expect_err("a write fails"),
            "transport failed",
        );
        deadline(fixture.right.closed(), 2_000).await;
        assert!(messages(&fixture, From::Right).is_empty());
        fixture.close();
    });
}

#[test]
fn rejects_handshake_mutation_truncation_extension_and_reflection() {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Attack {
        Mutation,
        Truncation,
        Extension,
        Reflection,
    }
    for attack in [
        Attack::Mutation,
        Attack::Truncation,
        Attack::Extension,
        Attack::Reflection,
    ] {
        paused(async {
            let fixture = pair(Overrides::default(), Overrides::default());
            let left = Rc::clone(&fixture.left);
            fixture.set_filter(Box::new(move |frame, from| {
                if from != From::Left {
                    return Ok(Some(frame.to_vec()));
                }
                match attack {
                    Attack::Truncation => Ok(Some(frame[..frame.len() - 1].to_vec())),
                    Attack::Extension => {
                        let mut extended = frame.to_vec();
                        extended.push(0);
                        Ok(Some(extended))
                    }
                    Attack::Reflection => {
                        let reflected = frame.to_vec();
                        spawn_reflection(Rc::clone(&left), reflected);
                        Ok(None)
                    }
                    Attack::Mutation => {
                        let mut mutated = frame.to_vec();
                        let last = mutated.len() - 1;
                        mutated[last] ^= 1;
                        Ok(Some(mutated))
                    }
                }
            }));
            fixture.start();
            deadline(
                futures::future::join(fixture.left.closed(), fixture.right.closed()),
                2_000,
            )
            .await;
            assert!(messages(&fixture, From::Right).is_empty(), "{attack:?}");
            fixture.close();
        });
    }
}

/// `queueMicrotask(() => peer.receive(frame))` from inside a filter.
fn spawn_reflection(peer: Rc<NoiseConnection>, frame: Vec<u8>) {
    tokio::task::spawn_local(async move {
        peer.receive(NoiseFrame::Binary(&frame));
    });
}

#[test]
fn invalid_keys_contexts_and_limits_fail_before_opening_a_transport() {
    for length in [0, 31, 33] {
        let error = NoiseCrypto::new(
            true,
            &vec![0; length],
            &[],
            MAX_RECORDS_PER_DIRECTION as u64,
        )
        .err()
        .expect("a key of another length");
        assert!(error.to_string().contains("exactly 32"), "{error}");
    }
    for invalid in ["", &"a".repeat(1025)] {
        assert!(connection_prologue(invalid).is_err());
    }
    for limits in [
        NoiseLimits {
            max_message_bytes: Some(0),
            ..NoiseLimits::default()
        },
        NoiseLimits {
            max_buffered_bytes: Some(65_534),
            ..NoiseLimits::default()
        },
        NoiseLimits {
            max_records_per_direction: Some(2_usize.pow(32)),
            ..NoiseLimits::default()
        },
        NoiseLimits {
            max_records_per_direction: Some(1),
            ..NoiseLimits::default()
        },
        NoiseLimits {
            max_message_bytes: Some(16 * 1024 * 1024 + 1),
            ..NoiseLimits::default()
        },
    ] {
        assert!(resolve_limits(Some(limits)).is_err(), "{limits:?}");
    }
    paused(async {
        let socket = NoiseConnection::new(
            true,
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
        socket.close();
        assert_eq!(socket.ready_state(), NoiseReadyState::Closed);
    });
}
