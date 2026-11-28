//! Ports `test/crypto.test.ts`.

use hkdf::Hkdf;
use sha2::{Digest, Sha256};

use crate::noise_ws::cipher::NoiseCipher;
use crate::noise_ws::crypto::NoiseCrypto;
use crate::noise_ws::errors::{NoiseError, NoiseErrorCode};
use crate::noise_ws::handshake::NoiseHandshake;
use crate::noise_ws::options::{MAX_RECORDS_PER_DIRECTION, NOISE_PROTOCOL, connection_prologue};

use super::helpers::{CONTEXT, PSK};

fn throws(error: NoiseError, text: &str) {
    assert!(error.to_string().contains(text), "{error}");
}

#[test]
fn aes_gcm_authenticates_bytes_with_additional_data() {
    for size in [0, 1, 15, 16, 17, 255, 256, 65_519] {
        let mut tx = NoiseCipher::new(&PSK).expect("a cipher builds");
        let mut rx = NoiseCipher::new(&PSK).expect("a cipher builds");
        let plaintext = vec![49; size];
        let aad = b"transcript hash";
        let encrypted = tx.encrypt(&plaintext, aad).expect("it encrypts");
        assert_eq!(encrypted.len(), size + 16);
        assert_eq!(rx.decrypt(&encrypted, aad).expect("it decrypts"), plaintext);
        tx.destroy();
        rx.destroy();
    }
}

#[test]
fn failed_tags_or_associated_data_destroy_cipher_state_and_no_unauthenticated_plaintext_escapes() {
    for corrupt_tag in [true, false] {
        let mut tx = NoiseCipher::new(&PSK).expect("a cipher builds");
        let mut rx = NoiseCipher::new(&PSK).expect("a cipher builds");
        let encrypted = tx.encrypt(b"sensitive", b"bound").expect("it encrypts");
        let mut altered = encrypted.clone();
        if corrupt_tag {
            let last = altered.len() - 1;
            altered[last] ^= 1;
        }
        throws(
            rx.decrypt(
                &altered,
                if corrupt_tag {
                    &b"bound"[..]
                } else {
                    &b"wrong"[..]
                },
            )
            .expect_err("a bad tag or associated data fails"),
            "authentication failed",
        );
        assert_eq!(rx.remaining(), 0);
        throws(
            rx.decrypt(&encrypted, b"bound")
                .expect_err("a destroyed cipher fails"),
            "closed",
        );
        tx.destroy();
    }
}

#[test]
fn invalid_frame_sizes_destroy_cipher_state_and_do_not_modify_caller_key_bytes() {
    let key = [19; 32];
    for length in [0, 15, 65_536] {
        let mut cipher = NoiseCipher::new(&key).expect("a cipher builds");
        assert!(cipher.decrypt(&vec![0; length], &[]).is_err());
        assert_eq!(cipher.remaining(), 0);
    }
    let mut cipher = NoiseCipher::new(&key).expect("a cipher builds");
    throws(
        cipher
            .encrypt(&vec![0; 65_520], &[])
            .expect_err("an oversized frame fails"),
        "size limit",
    );
    assert_eq!(cipher.remaining(), 0);
    assert_eq!(key, [19; 32]);
}

#[test]
fn handshake_ordering_and_reuse_violations_destroy_state() {
    let mut a = NoiseHandshake::new(true, &PSK, &[]).expect("a handshake builds");
    let mut b = NoiseHandshake::new(false, &PSK, &[]).expect("a handshake builds");
    throws(
        b.write(&[]).expect_err("the responder writes first"),
        "protocol",
    );
    throws(
        b.read(&a.write(&[]).expect("it writes"))
            .expect_err("a destroyed handshake reads"),
        "protocol",
    );
    throws(
        a.write(&[]).expect_err("the initiator writes twice"),
        "protocol",
    );
    let mut early = NoiseHandshake::new(true, &PSK, &[]).expect("a handshake builds");
    throws(
        early
            .finish()
            .err()
            .expect("an unfinished handshake splits"),
        "protocol",
    );
    throws(
        early.write(&[]).expect_err("a destroyed handshake writes"),
        "protocol",
    );
    let mut initiator = NoiseHandshake::new(true, &PSK, &[]).expect("a handshake builds");
    let mut responder = NoiseHandshake::new(false, &PSK, &[]).expect("a handshake builds");
    responder
        .read(&initiator.write(&[]).expect("it writes"))
        .expect("it reads");
    initiator
        .read(&responder.write(&[]).expect("it writes"))
        .expect("it reads");
    assert!(initiator.complete());
    initiator.finish().expect("it splits");
    throws(
        initiator
            .finish()
            .err()
            .expect("a finished handshake splits again"),
        "protocol",
    );
    throws(
        initiator
            .write(&[])
            .expect_err("a finished handshake writes"),
        "protocol",
    );
    responder.destroy();
}

#[test]
fn fresh_ephemeral_keys_are_generated_and_caller_psks_are_copied_before_mutation() {
    let mut key = PSK;
    let mut a = NoiseHandshake::new(true, &key, &[]).expect("a handshake builds");
    let mut b = NoiseHandshake::new(false, &key, &[]).expect("a handshake builds");
    key.fill(0);
    let first = a.write(&[]).expect("it writes");
    assert!(b.read(&first).expect("it reads").is_empty());
    a.read(&b.write(&[]).expect("it writes")).expect("it reads");
    let mut next = NoiseHandshake::new(true, &PSK, &[]).expect("a handshake builds");
    assert_ne!(next.write(&[]).expect("it writes")[..32], first[..32]);
    a.destroy();
    b.destroy();
    next.destroy();
}

fn hash(parts: &[&[u8]]) -> [u8; 32] {
    let mut state = Sha256::new();
    for part in parts {
        state.update(part);
    }
    state.finalize().into()
}

#[test]
fn authenticated_low_order_ephemeral_public_keys_fail_at_x25519_and_cannot_produce_transport_keys()
{
    let prologue = connection_prologue(CONTEXT).expect("a prologue");
    for value in [0, 1] {
        let mut ephemeral = [0; 32];
        ephemeral[0] = value;
        let initial = NOISE_PROTOCOL.as_bytes();
        let mut mixed = [0; 96];
        Hkdf::<Sha256>::new(Some(initial), &PSK)
            .expand(&[], &mut mixed)
            .expect("three keys fit");
        let h = hash(&[
            &hash(&[&hash(&[initial, &prologue]), &mixed[32..64]]),
            &ephemeral,
        ]);
        let mut next = [0; 64];
        Hkdf::<Sha256>::new(Some(&mixed[..32]), &ephemeral)
            .expand(&[], &mut next)
            .expect("two keys fit");
        let mut cipher = NoiseCipher::new(&next[32..]).expect("a cipher builds");
        let encrypted = cipher.encrypt(&[], &h).expect("it encrypts");
        let mut frame = ephemeral.to_vec();
        frame.extend_from_slice(&encrypted);
        let mut responder =
            NoiseHandshake::new(false, &PSK, &prologue).expect("a handshake builds");
        assert!(responder.read(&frame).expect("it reads").is_empty());
        throws(
            responder.write(&[]).expect_err("a low-order key fails"),
            "authentication failed",
        );
        throws(
            responder
                .finish()
                .err()
                .expect("a destroyed handshake splits"),
            "protocol",
        );
        cipher.destroy();
        mixed.fill(0);
        next.fill(0);
    }
}

#[test]
fn the_socket_crypto_engine_disallows_handshake_payloads_and_destroys_both_directions_on_a_bad_record()
 {
    let mut malicious = NoiseHandshake::new(
        true,
        &PSK,
        &connection_prologue(CONTEXT).expect("a prologue"),
    )
    .expect("a handshake builds");
    let mut target = NoiseCrypto::new(
        false,
        &PSK,
        &connection_prologue(CONTEXT).expect("a prologue"),
        MAX_RECORDS_PER_DIRECTION as u64,
    )
    .expect("an engine builds");
    throws(
        target
            .receive_handshake(&malicious.write(b"no 0-RTT").expect("it writes"))
            .expect_err("a handshake payload is refused"),
        "protocol",
    );
    assert_eq!(
        target
            .send_handshake()
            .expect_err("a destroyed engine sends"),
        NoiseErrorCode::ProtocolError.into()
    );
    malicious.destroy();
    let mut a = NoiseCrypto::new(true, &PSK, &[], MAX_RECORDS_PER_DIRECTION as u64)
        .expect("an engine builds");
    let mut b = NoiseCrypto::new(false, &PSK, &[], MAX_RECORDS_PER_DIRECTION as u64)
        .expect("an engine builds");
    b.receive_handshake(&a.send_handshake().expect("it sends"))
        .expect("it receives");
    a.receive_handshake(&b.send_handshake().expect("it sends"))
        .expect("it receives");
    let mut record = a.encrypt(&[]).expect("it encrypts");
    let last = record.len() - 1;
    record[last] ^= 1;
    throws(
        b.decrypt(&record).expect_err("a bad record fails"),
        "authentication failed",
    );
    throws(
        b.encrypt(&[]).expect_err("a destroyed engine encrypts"),
        "not open",
    );
    assert_eq!(b.send_remaining(), 0);
    a.destroy();
}
