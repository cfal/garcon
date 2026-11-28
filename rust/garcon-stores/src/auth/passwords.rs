use std::borrow::Cow;
use std::error::Error;

use argon2::{Argon2, PasswordHash, PasswordVerifier, password_hash::Error as PasswordHashError};
use sha2::{Digest, Sha512};

type BoxError = Box<dyn Error>;

#[derive(Debug, thiserror::Error)]
enum VerificationError {
    #[error("Password verification failed with error \"InvalidEncoding\"")]
    InvalidEncoding,
    #[error("Password verification failed with error \"UnsupportedAlgorithm\"")]
    UnsupportedAlgorithm,
}

#[async_trait::async_trait(?Send)]
pub trait Passwords {
    async fn verify(&self, password: &str, hash: &str) -> Result<bool, BoxError>;
    async fn hash(&self, password: &str) -> Result<String, BoxError>;
}

/// Bun writes bcrypt and detects the algorithm of an existing hash.
pub struct BunPasswords;

fn bcrypt_input(password: &[u8]) -> Cow<'_, [u8]> {
    if password.len() > 72 {
        Cow::Owned(Sha512::digest(password).to_vec())
    } else {
        Cow::Borrowed(password)
    }
}

fn verify_password(password: &[u8], hash: &str) -> Result<bool, VerificationError> {
    if password.is_empty() || hash.is_empty() {
        return Ok(false);
    }
    if hash.starts_with("$2") {
        // The input is at most 72 bytes after Bun's prehash; bcrypt's
        // non-truncating API also rejects the exactly-72-byte case.
        return bcrypt::verify(bcrypt_input(password), hash)
            .map_err(|_| VerificationError::InvalidEncoding);
    }
    if ["$argon2id$", "$argon2i$", "$argon2d$"]
        .iter()
        .any(|prefix| hash.starts_with(prefix))
    {
        let parsed = PasswordHash::new(hash).map_err(|_| VerificationError::InvalidEncoding)?;
        return match Argon2::default().verify_password(password, &parsed) {
            Ok(()) => Ok(true),
            Err(PasswordHashError::Password) => Ok(false),
            Err(_) => Err(VerificationError::InvalidEncoding),
        };
    }
    Err(VerificationError::UnsupportedAlgorithm)
}

#[async_trait::async_trait(?Send)]
impl Passwords for BunPasswords {
    async fn verify(&self, password: &str, hash: &str) -> Result<bool, BoxError> {
        let password = password.to_owned();
        let hash = hash.to_owned();
        Ok(
            tokio::task::spawn_blocking(move || verify_password(password.as_bytes(), &hash))
                .await??,
        )
    }

    async fn hash(&self, password: &str) -> Result<String, BoxError> {
        let password = password.to_owned();
        Ok(tokio::task::spawn_blocking(move || {
            bcrypt::hash_with_result(bcrypt_input(password.as_bytes()), 12)
                .map(|parts| parts.format_for_version(bcrypt::Version::TwoB))
        })
        .await??)
    }
}
