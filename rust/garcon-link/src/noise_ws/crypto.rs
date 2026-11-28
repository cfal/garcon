use super::TypeError;
use super::cipher::NoiseCipher;
use super::errors::{NoiseError, NoiseErrorCode};
use super::handshake::NoiseHandshake;

/// The Noise state of one connection: the handshake, then one cipher per
/// direction. Any cipher error destroys that cipher; a socket crypto error
/// destroys both directions.
pub struct NoiseCrypto {
    handshake: Option<NoiseHandshake>,
    send_cipher: Option<NoiseCipher>,
    receive_cipher: Option<NoiseCipher>,
    record_limit: u64,
}

impl NoiseCrypto {
    pub fn new(
        initiator: bool,
        psk: &[u8],
        prologue: &[u8],
        record_limit: u64,
    ) -> Result<Self, TypeError> {
        Ok(Self {
            handshake: Some(NoiseHandshake::new(initiator, psk, prologue)?),
            send_cipher: None,
            receive_cipher: None,
            record_limit,
        })
    }

    pub fn send_remaining(&self) -> u64 {
        self.send_cipher.as_ref().map_or(0, NoiseCipher::remaining)
    }

    pub fn send_handshake(&mut self) -> Result<Vec<u8>, NoiseError> {
        let sent = (|| {
            let handshake = self
                .handshake
                .as_mut()
                .ok_or(NoiseErrorCode::ProtocolError)?;
            let result = handshake.write(&[])?;
            self.split()?;
            Ok(result)
        })();
        if sent.is_err() {
            self.destroy();
        }
        sent
    }

    /// Reads the peer's handshake message, which carries no payload.
    pub fn receive_handshake(&mut self, frame: &[u8]) -> Result<(), NoiseError> {
        let received = (|| {
            let handshake = self
                .handshake
                .as_mut()
                .ok_or(NoiseErrorCode::ProtocolError)?;
            let payload = handshake.read(frame)?;
            if !payload.is_empty() {
                return Err(NoiseErrorCode::ProtocolError.into());
            }
            self.split()
        })();
        if received.is_err() {
            self.destroy();
        }
        received
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let encrypted = match self.send_cipher.as_mut() {
            Some(cipher) => cipher.encrypt(plaintext, &[]),
            None => Err(NoiseErrorCode::NotOpen.into()),
        };
        if encrypted.is_err() {
            self.destroy();
        }
        encrypted
    }

    pub fn decrypt(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let decrypted = match self.receive_cipher.as_mut() {
            Some(cipher) => cipher.decrypt(ciphertext, &[]),
            None => Err(NoiseErrorCode::NotOpen.into()),
        };
        if decrypted.is_err() {
            self.destroy();
        }
        decrypted
    }

    pub fn destroy(&mut self) {
        if let Some(cipher) = self.send_cipher.as_mut() {
            cipher.destroy();
        }
        if let Some(cipher) = self.receive_cipher.as_mut() {
            cipher.destroy();
        }
        self.receive_cipher = None;
        self.send_cipher = None;
        if let Some(handshake) = self.handshake.as_mut() {
            handshake.destroy();
        }
        self.handshake = None;
    }

    fn split(&mut self) -> Result<(), NoiseError> {
        let Some(handshake) = self.handshake.as_mut() else {
            return Ok(());
        };
        if !handshake.complete() {
            return Ok(());
        }
        let keys = handshake.finish()?;
        self.handshake = None;
        // INFALLIBLE: the handshake keys are 32 bytes, and the record limit is validated by
        // `resolve_limits` before a connection builds its engine.
        self.send_cipher = Some(
            NoiseCipher::with_limit(&keys.tx, self.record_limit)
                .expect("the handshake keys and the record limit configure a cipher"),
        );
        // INFALLIBLE: same as the sending cipher.
        self.receive_cipher = Some(
            NoiseCipher::with_limit(&keys.rx, self.record_limit)
                .expect("the handshake keys and the record limit configure a cipher"),
        );
        Ok(())
    }
}
