//! Ports `test/vectors.test.ts`, and replays the transcripts that
//! `fixtures/record_flynn_noise.ts` records from the Go reference program the
//! package ships for its own interop check: random keys and prologues, empty
//! and maximum lengths, and counters crossing 255 and 256 in both directions.

use garcon_js::json::from_slice;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::noise_ws::cipher::NoiseCipher;
use crate::noise_ws::handshake::NoiseHandshake;
use crate::noise_ws::options::NOISE_PROTOCOL;

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).expect("two hex digits"))
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn digest(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value[name].as_str().expect(name)
}

fn item(value: &Value, name: &str, index: usize) -> Vec<u8> {
    unhex(value[name][index].as_str().expect("an item"))
}

fn key(bytes: Vec<u8>) -> [u8; 32] {
    bytes.try_into().expect("a 32-byte key")
}

// Public-domain vector from the independent Haskell Noise implementation.
// https://github.com/centromere/cacophony/blob/8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247/vectors/cacophony.txt#L8716-L8750
#[test]
fn matches_the_published_cacophony_nnpsk0_handshake_hash_and_every_transport_ciphertext() {
    let vector: Value =
        from_slice(include_bytes!("fixtures/cacophony.json")).expect("the vector parses");
    assert_eq!(field(&vector, "protocol_name"), NOISE_PROTOCOL);
    let prologue = unhex(field(&vector, "init_prologue"));
    let mut left = NoiseHandshake::with_ephemeral(
        true,
        &item(&vector, "init_psks", 0),
        &prologue,
        key(unhex(field(&vector, "init_ephemeral"))),
    )
    .expect("the initiator builds");
    let mut right = NoiseHandshake::with_ephemeral(
        false,
        &item(&vector, "resp_psks", 0),
        &unhex(field(&vector, "resp_prologue")),
        key(unhex(field(&vector, "resp_ephemeral"))),
    )
    .expect("the responder builds");
    let messages = vector["messages"].as_array().expect("messages");

    for (index, message) in messages[..2].iter().enumerate() {
        let payload = unhex(field(message, "payload"));
        let (sender, receiver) = if index == 0 {
            (&mut left, &mut right)
        } else {
            (&mut right, &mut left)
        };
        let ciphertext = sender.write(&payload).expect("the handshake writes");
        assert_eq!(hex(&ciphertext), field(message, "ciphertext"));
        assert_eq!(
            hex(&receiver.read(&ciphertext).expect("the handshake reads")),
            field(message, "payload")
        );
    }
    let a = left.finish().expect("the initiator finishes");
    let b = right.finish().expect("the responder finishes");
    assert_eq!(hex(&a.hash), field(&vector, "handshake_hash"));
    assert_eq!(hex(&b.hash), field(&vector, "handshake_hash"));

    let mut senders = [
        NoiseCipher::new(&a.tx).expect("a key configures a cipher"),
        NoiseCipher::new(&b.tx).expect("a key configures a cipher"),
    ];
    let mut receivers = [
        NoiseCipher::new(&b.rx).expect("a key configures a cipher"),
        NoiseCipher::new(&a.rx).expect("a key configures a cipher"),
    ];
    for index in 2..messages.len() {
        let payload = unhex(field(&messages[index], "payload"));
        let ciphertext = senders[index % 2]
            .encrypt(&payload, &[])
            .expect("it encrypts");
        assert_eq!(hex(&ciphertext), field(&messages[index], "ciphertext"));
        assert_eq!(
            hex(&receivers[index % 2]
                .decrypt(&ciphertext, &[])
                .expect("it decrypts")),
            field(&messages[index], "payload")
        );
    }
}

/// The hash stream the recording script names its inputs by.
fn stream(label: &str, length: usize) -> Vec<u8> {
    let mut bytes = vec![0_u8; length];
    for (block, chunk) in bytes.chunks_mut(32).enumerate() {
        let digest: [u8; 32] = Sha256::digest(format!("noise-ws vector {label} {block}")).into();
        chunk.copy_from_slice(&digest[..chunk.len()]);
    }
    bytes
}

#[test]
fn matches_flynn_noise_on_recorded_transcripts() {
    let recorded: Value =
        from_slice(include_bytes!("fixtures/flynn-noise.json")).expect("the transcripts parse");
    assert_eq!(
        field(&recorded, "reference"),
        "github.com/flynn/noise v1.1.0, commit 4d9f71cd4ba1fe81415efac312664ccc4bc79b46"
    );
    let mut messages = 0;
    for (index, case) in recorded["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .enumerate()
    {
        let label = index.to_string();
        let mut left = NoiseHandshake::with_ephemeral(
            true,
            &unhex(field(case, "psk")),
            &unhex(field(case, "prologue")),
            key(unhex(field(case, "initiator"))),
        )
        .expect("the initiator builds");
        let mut right = NoiseHandshake::with_ephemeral(
            false,
            &unhex(field(case, "psk")),
            &unhex(field(case, "prologue")),
            key(unhex(field(case, "responder"))),
        )
        .expect("the responder builds");
        let sizes = case["sizes"].as_array().expect("sizes");
        let digests = case["digests"].as_array().expect("digests");
        let payload = |position: usize| {
            stream(
                &format!("payload {label} {position}"),
                usize::try_from(sizes[position].as_u64().expect("a size")).expect("a size"),
            )
        };

        for (position, expected_digest) in digests[..2].iter().enumerate() {
            let (sender, receiver) = if position == 0 {
                (&mut left, &mut right)
            } else {
                (&mut right, &mut left)
            };
            let ciphertext = sender
                .write(&payload(position))
                .expect("the handshake writes");
            assert_eq!(
                receiver.read(&ciphertext).expect("the handshake reads"),
                payload(position)
            );
            assert_eq!(
                digest(&ciphertext),
                expected_digest.as_str().expect("a digest"),
                "transcript {index}, message {position}"
            );
        }
        let a = left.finish().expect("the initiator finishes");
        let b = right.finish().expect("the responder finishes");
        assert_eq!(hex(&a.hash), field(case, "hash"), "transcript {index}");
        assert_eq!(hex(&b.hash), field(case, "hash"), "transcript {index}");

        let mut senders = [
            NoiseCipher::new(&a.tx).expect("a key configures a cipher"),
            NoiseCipher::new(&b.tx).expect("a key configures a cipher"),
        ];
        let mut receivers = [
            NoiseCipher::new(&b.rx).expect("a key configures a cipher"),
            NoiseCipher::new(&a.rx).expect("a key configures a cipher"),
        ];
        for position in 2..sizes.len() {
            let ciphertext = senders[position % 2]
                .encrypt(&payload(position), &[])
                .expect("it encrypts");
            assert_eq!(
                digest(&ciphertext),
                digests[position].as_str().expect("a digest"),
                "transcript {index}, message {position}"
            );
            assert_eq!(
                receivers[position % 2]
                    .decrypt(&ciphertext, &[])
                    .expect("it decrypts"),
                payload(position)
            );
            messages += 1;
        }
    }
    assert_eq!(messages, 1_508);
}
