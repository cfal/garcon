use aes_gcm::aead::consts::U12;
use aes_gcm::aead::{Aead, AeadInPlace, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use zeroize::{Zeroize, Zeroizing};

use super::TypeError;
use super::errors::{NoiseError, NoiseErrorCode};
use super::options::{MAX_FRAME_BYTES, MAX_RECORDS_PER_DIRECTION, is_safe_integer};

const KEY_BYTES: usize = 32;
const TAG_BYTES: usize = 16;

/// Noise AESGCM: 32 zero bits followed by a big-endian 64-bit counter.
pub struct NoiseCipher {
    key: Option<Zeroizing<[u8; KEY_BYTES]>>,
    counter: u64,
    limit: u64,
}

impl NoiseCipher {
    pub fn new(key: &[u8]) -> Result<Self, TypeError> {
        Self::with_limit(key, MAX_RECORDS_PER_DIRECTION as u64)
    }

    /// Checks before every encryption and decryption, and terminates at `limit`
    /// records. There is no nonce reset, ciphertext retry, or rekey.
    pub fn with_limit(key: &[u8], limit: u64) -> Result<Self, TypeError> {
        let invalid = || TypeError::new("Invalid Noise cipher configuration");
        let key: [u8; KEY_BYTES] = key.try_into().map_err(|_| invalid())?;
        if !is_safe_integer(limit) || limit < 1 || limit > MAX_RECORDS_PER_DIRECTION as u64 {
            return Err(invalid());
        }
        Ok(Self {
            key: Some(Zeroizing::new(key)),
            counter: 0,
            limit,
        })
    }

    pub fn remaining(&self) -> u64 {
        match self.key {
            Some(_) => self.limit - self.counter,
            None => 0,
        }
    }

    /// Any failure destroys this state; the returned bytes end with the tag.
    pub fn encrypt(
        &mut self,
        plaintext: &[u8],
        additional_data: &[u8],
    ) -> Result<Vec<u8>, NoiseError> {
        let (key, nonce) = match self.live() {
            Ok(live) => live,
            Err(error) => {
                self.destroy();
                return Err(error);
            }
        };
        if plaintext.len() > MAX_FRAME_BYTES - TAG_BYTES {
            self.destroy();
            return Err(NoiseErrorCode::MessageTooLarge.into());
        }
        let cipher = Aes256Gcm::new(&(*key).into());
        let encrypted = cipher.encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: additional_data,
            },
        );
        match encrypted {
            Ok(bytes) => {
                self.counter += 1;
                Ok(bytes)
            }
            Err(_) => {
                self.destroy();
                Err(NoiseErrorCode::AuthenticationFailed.into())
            }
        }
    }

    /// A failed tag destroys this state. Decrypted bytes are never returned
    /// before the tag is validated.
    pub fn decrypt(
        &mut self,
        ciphertext: &[u8],
        additional_data: &[u8],
    ) -> Result<Vec<u8>, NoiseError> {
        let (key, nonce) = match self.live() {
            Ok(live) => live,
            Err(error) => {
                self.destroy();
                return Err(error);
            }
        };
        if ciphertext.len() < TAG_BYTES || ciphertext.len() > MAX_FRAME_BYTES {
            self.destroy();
            return Err(NoiseErrorCode::ProtocolError.into());
        }
        let cipher = Aes256Gcm::new(&(*key).into());
        // The length is at least the tag's, so the split point is inside.
        let (body, tag) = ciphertext.split_at(ciphertext.len() - TAG_BYTES);
        let mut plaintext = body.to_vec();
        let decrypted = cipher.decrypt_in_place_detached(
            &nonce,
            additional_data,
            &mut plaintext,
            Tag::from_slice(tag),
        );
        match decrypted {
            Ok(()) => {
                self.counter += 1;
                Ok(plaintext)
            }
            Err(_) => {
                plaintext.zeroize();
                self.destroy();
                Err(NoiseErrorCode::AuthenticationFailed.into())
            }
        }
    }

    pub fn destroy(&mut self) {
        self.key = None;
    }

    fn live(&self) -> Result<(&[u8; KEY_BYTES], Nonce<U12>), NoiseError> {
        let Some(key) = self.key.as_deref() else {
            return Err(NoiseErrorCode::Closed.into());
        };
        if self.counter >= self.limit {
            return Err(NoiseErrorCode::RecordLimit.into());
        }
        let mut nonce = Nonce::<U12>::default();
        nonce[4..].copy_from_slice(&self.counter.to_be_bytes());
        Ok((key, nonce))
    }
}
