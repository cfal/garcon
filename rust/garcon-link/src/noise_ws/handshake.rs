use hkdf::Hkdf;
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use super::TypeError;
use super::cipher::NoiseCipher;
use super::errors::{NoiseError, NoiseErrorCode};
use super::options::{MAX_FRAME_BYTES, NOISE_PROTOCOL};

const KEY_BYTES: usize = 32;
const HANDSHAKE_BYTES: usize = KEY_BYTES + 16;

/// Key material the original zeroes as soon as it is replaced or dropped.
#[derive(Zeroize, ZeroizeOnDrop)]
struct Secret([u8; KEY_BYTES]);

impl Secret {
    fn to_bytes(&self) -> [u8; KEY_BYTES] {
        self.0
    }
}

/// The keys of a finished handshake: what this side sends with, what it
/// receives with, and the handshake hash.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SplitKeys {
    pub tx: [u8; KEY_BYTES],
    pub rx: [u8; KEY_BYTES],
    pub hash: [u8; KEY_BYTES],
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    WriteFirst,
    ReadFirst,
    WriteSecond,
    ReadSecond,
    Complete,
    Closed,
}

fn hash(parts: &[&[u8]]) -> Secret {
    let mut state = Sha256::new();
    for part in parts {
        state.update(part);
    }
    Secret(state.finalize().into())
}

fn derive<const OUTPUTS: usize>(chaining_key: &[u8], input: &[u8]) -> [Secret; OUTPUTS] {
    // Noise HKDF uses the chaining key as salt and empty info (Noise section 4.3).
    let hkdf = Hkdf::<Sha256>::new(Some(chaining_key), input);
    let mut material = Zeroizing::new([0_u8; 3 * KEY_BYTES]);
    // INFALLIBLE: at most three keys are far below HKDF's output limit.
    hkdf.expand(&[], &mut material[..OUTPUTS * KEY_BYTES])
        .expect("three keys fit in 255 blocks");
    std::array::from_fn(|index| {
        let start = index * KEY_BYTES;
        // INFALLIBLE: the material holds exactly `OUTPUTS` keys.
        Secret(
            material[start..start + KEY_BYTES]
                .try_into()
                .expect("a key is 32 bytes"),
        )
    })
}

/// Fixed NNpsk0 only: -> psk,e; <- e,ee. No pattern interpreter or negotiation.
pub struct NoiseHandshake {
    phase: Phase,
    initiator: bool,
    chaining_key: Secret,
    hash: Secret,
    cipher: Option<NoiseCipher>,
    ephemeral: Option<StaticSecret>,
    remote: Option<[u8; KEY_BYTES]>,
}

impl NoiseHandshake {
    /// Generates a fresh ephemeral X25519 key.
    pub fn new(initiator: bool, psk: &[u8], prologue: &[u8]) -> Result<Self, TypeError> {
        Self::build(
            initiator,
            psk,
            prologue,
            StaticSecret::random_from_rng(OsRng),
        )
    }

    /// Deterministic ephemeral input is internal to vector tests, never a socket option.
    #[cfg(test)]
    pub fn with_ephemeral(
        initiator: bool,
        psk: &[u8],
        prologue: &[u8],
        ephemeral: [u8; KEY_BYTES],
    ) -> Result<Self, TypeError> {
        Self::build(initiator, psk, prologue, StaticSecret::from(ephemeral))
    }

    fn build(
        initiator: bool,
        psk: &[u8],
        prologue: &[u8],
        ephemeral: StaticSecret,
    ) -> Result<Self, TypeError> {
        if psk.len() != KEY_BYTES {
            return Err(TypeError::new("Noise PSK must be exactly 32 bytes"));
        }
        // This fixed protocol name is exactly HASHLEN bytes; Noise does not hash it.
        // INFALLIBLE: `NOISE_PROTOCOL` is 32 bytes.
        let name: [u8; KEY_BYTES] = NOISE_PROTOCOL
            .as_bytes()
            .try_into()
            .expect("the protocol name is 32 bytes");
        let mut handshake = Self {
            phase: if initiator {
                Phase::WriteFirst
            } else {
                Phase::ReadFirst
            },
            initiator,
            chaining_key: Secret(name),
            hash: Secret(name),
            cipher: None,
            ephemeral: Some(ephemeral),
            remote: None,
        };
        handshake.mix_hash(prologue);
        let [chaining_key, temp_hash, cipher_key] = derive::<3>(&handshake.chaining_key.0, psk);
        handshake.chaining_key = chaining_key;
        handshake.mix_hash(&temp_hash.0);
        handshake.replace_cipher(&cipher_key);
        Ok(handshake)
    }

    pub fn complete(&self) -> bool {
        self.phase == Phase::Complete
    }

    /// Writes one handshake message: the ephemeral public key, then the
    /// encrypted payload. A failure destroys the handshake.
    pub fn write(&mut self, payload: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let written = self.write_inner(payload);
        if written.is_err() {
            self.destroy();
        }
        written
    }

    fn write_inner(&mut self, payload: &[u8]) -> Result<Vec<u8>, NoiseError> {
        if !matches!(self.phase, Phase::WriteFirst | Phase::WriteSecond) {
            return Err(NoiseErrorCode::ProtocolError.into());
        }
        if payload.len() > MAX_FRAME_BYTES - HANDSHAKE_BYTES {
            return Err(NoiseErrorCode::MessageTooLarge.into());
        }
        let first = self.phase == Phase::WriteFirst;
        let ephemeral = PublicKey::from(
            self.ephemeral
                .as_ref()
                // INFALLIBLE: the ephemeral key lives until the handshake is destroyed, and
                // a destroyed handshake is refused above.
                .expect("the ephemeral key lives"),
        )
        .to_bytes();
        self.mix_hash(&ephemeral);
        // The e token also mixes a key in every PSK pattern.
        self.mix_key(&ephemeral);
        if !first {
            self.mix_dh()?;
        }
        // INFALLIBLE: the constructor installs the cipher, and only `destroy` removes it.
        let cipher = self.cipher.as_mut().expect("the handshake cipher lives");
        let encrypted = cipher.encrypt(payload, &self.hash.0)?;
        self.mix_hash(&encrypted);
        self.phase = if first {
            Phase::ReadSecond
        } else {
            Phase::Complete
        };
        let mut message = Vec::with_capacity(KEY_BYTES + encrypted.len());
        message.extend_from_slice(&ephemeral);
        message.extend_from_slice(&encrypted);
        Ok(message)
    }

    /// Reads one handshake message and returns its payload. A failure destroys
    /// the handshake.
    pub fn read(&mut self, message: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let read = self.read_inner(message);
        if read.is_err() {
            self.destroy();
        }
        read
    }

    fn read_inner(&mut self, message: &[u8]) -> Result<Vec<u8>, NoiseError> {
        if !matches!(self.phase, Phase::ReadFirst | Phase::ReadSecond) {
            return Err(NoiseErrorCode::ProtocolError.into());
        }
        if message.len() < HANDSHAKE_BYTES || message.len() > MAX_FRAME_BYTES {
            return Err(NoiseErrorCode::ProtocolError.into());
        }
        let first = self.phase == Phase::ReadFirst;
        // INFALLIBLE: the length was checked against the key size.
        let remote: [u8; KEY_BYTES] = message[..KEY_BYTES].try_into().expect("the key fits");
        self.remote = Some(remote);
        self.mix_hash(&remote);
        self.mix_key(&remote);
        if !first {
            self.mix_dh()?;
        }
        let ciphertext = &message[KEY_BYTES..];
        // INFALLIBLE: the constructor installs the cipher, and only `destroy` removes it.
        let cipher = self.cipher.as_mut().expect("the handshake cipher lives");
        let payload = cipher.decrypt(ciphertext, &self.hash.0)?;
        self.mix_hash(ciphertext);
        self.phase = if first {
            Phase::WriteSecond
        } else {
            Phase::Complete
        };
        Ok(payload)
    }

    pub fn finish(&mut self) -> Result<SplitKeys, NoiseError> {
        if !self.complete() {
            self.destroy();
            return Err(NoiseErrorCode::ProtocolError.into());
        }
        let [initiator_send, responder_send] = derive::<2>(&self.chaining_key.0, &[]);
        let (tx, rx) = if self.initiator {
            (initiator_send.to_bytes(), responder_send.to_bytes())
        } else {
            (responder_send.to_bytes(), initiator_send.to_bytes())
        };
        let result = SplitKeys {
            tx,
            rx,
            hash: self.hash.to_bytes(),
        };
        self.destroy();
        Ok(result)
    }

    pub fn destroy(&mut self) {
        self.phase = Phase::Closed;
        self.chaining_key.zeroize();
        self.hash.zeroize();
        if let Some(cipher) = self.cipher.as_mut() {
            cipher.destroy();
        }
        self.cipher = None;
        self.ephemeral = None;
        self.remote = None;
    }

    fn mix_hash(&mut self, data: &[u8]) {
        self.hash = hash(&[&self.hash.0, data]);
    }

    fn mix_key(&mut self, input: &[u8]) {
        let [chaining_key, cipher_key] = derive::<2>(&self.chaining_key.0, input);
        self.chaining_key = chaining_key;
        self.replace_cipher(&cipher_key);
    }

    fn replace_cipher(&mut self, key: &Secret) {
        if let Some(cipher) = self.cipher.as_mut() {
            cipher.destroy();
        }
        // INFALLIBLE: the key is 32 bytes and the limit is the default, a valid configuration.
        self.cipher = Some(NoiseCipher::new(&key.0).expect("a derived key configures a cipher"));
    }

    fn mix_dh(&mut self) -> Result<(), NoiseError> {
        // INFALLIBLE: both keys live until the handshake is destroyed, and a destroyed
        // handshake is refused by the caller.
        let ephemeral = self.ephemeral.as_ref().expect("the ephemeral key lives");
        let remote = self.remote.expect("the remote key was read first");
        let shared = ephemeral.diffie_hellman(&PublicKey::from(remote));
        if *shared.as_bytes() == [0_u8; KEY_BYTES] {
            return Err(NoiseErrorCode::AuthenticationFailed.into());
        }
        self.mix_key(shared.as_bytes());
        Ok(())
    }
}
