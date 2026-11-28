use super::TypeError;
use super::connection::{CloseHandler, ErrorHandler, MessageHandler, OpenHandler};
use super::errors::NoiseError;

pub const NOISE_PROTOCOL: &str = "Noise_NNpsk0_25519_AESGCM_SHA256";
pub const MAX_FRAME_BYTES: usize = 65_535;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
// Reconnect well before Noise's nonce/data-volume limits: at most 1 TiB per AES-GCM key.
pub const MAX_RECORDS_PER_DIRECTION: usize = 1 << 24;

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const MAX_TIMEOUT_MS: u64 = (1 << 31) - 1;
const MAX_BUFFERED_BYTES: usize = 128 * 1024 * 1024;
const PROTOCOL_PREFIX: &[u8] = b"cfal/noise-ws\0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoiseCloseInfo {
    /// True only when the peer's encrypted close record was received. Not a delivery receipt.
    pub authenticated: bool,
    pub error: Option<NoiseError>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NoiseLimits {
    pub handshake_timeout_ms: Option<u64>,
    pub message_timeout_ms: Option<u64>,
    pub max_message_bytes: Option<usize>,
    pub max_buffered_bytes: Option<usize>,
    pub max_records_per_direction: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedNoiseLimits {
    pub handshake_timeout_ms: u64,
    pub message_timeout_ms: u64,
    pub max_message_bytes: usize,
    pub max_buffered_bytes: usize,
    pub max_records_per_direction: usize,
}

/// A complete application message, exactly as the peer sent it: text or bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoiseMessage {
    Text(String),
    Binary(Vec<u8>),
}

pub struct NoiseOptions {
    /// Exactly 32 cryptographically random bytes, provisioned out of band. Not a password.
    pub psk: Vec<u8>,
    /// Must match on both peers. Bind this connection to its application/protocol.
    pub context: String,
    pub limits: Option<NoiseLimits>,
    pub on_message: MessageHandler,
    pub on_open: Option<OpenHandler>,
    pub on_error: Option<ErrorHandler>,
    pub on_close: Option<CloseHandler>,
}

/// Whether a value is an integer JavaScript can hold exactly.
pub(super) fn is_safe_integer(value: u64) -> bool {
    value <= MAX_SAFE_INTEGER
}

pub fn resolve_limits(limits: Option<NoiseLimits>) -> Result<ResolvedNoiseLimits, TypeError> {
    let limits = limits.unwrap_or_default();
    let resolved = ResolvedNoiseLimits {
        handshake_timeout_ms: limits.handshake_timeout_ms.unwrap_or(5_000),
        message_timeout_ms: limits.message_timeout_ms.unwrap_or(30_000),
        max_message_bytes: limits.max_message_bytes.unwrap_or(MAX_MESSAGE_BYTES),
        max_buffered_bytes: limits.max_buffered_bytes.unwrap_or(32 * 1024 * 1024),
        max_records_per_direction: limits
            .max_records_per_direction
            .unwrap_or(MAX_RECORDS_PER_DIRECTION),
    };
    for (key, value) in [
        ("handshakeTimeoutMs", resolved.handshake_timeout_ms as u128),
        ("messageTimeoutMs", resolved.message_timeout_ms as u128),
        ("maxMessageBytes", resolved.max_message_bytes as u128),
        ("maxBufferedBytes", resolved.max_buffered_bytes as u128),
        (
            "maxRecordsPerDirection",
            resolved.max_records_per_direction as u128,
        ),
    ] {
        if value < 1 || value > MAX_SAFE_INTEGER as u128 {
            return Err(TypeError::new(format!("Invalid Noise limit: {key}")));
        }
    }
    if resolved.max_message_bytes > MAX_MESSAGE_BYTES
        || resolved.max_buffered_bytes < MAX_FRAME_BYTES
        || resolved.max_buffered_bytes > MAX_BUFFERED_BYTES
        || resolved.max_records_per_direction < 2
        || resolved.max_records_per_direction > MAX_RECORDS_PER_DIRECTION
        || resolved.handshake_timeout_ms > MAX_TIMEOUT_MS
        || resolved.message_timeout_ms > MAX_TIMEOUT_MS
    {
        return Err(TypeError::new("Noise limits exceed supported bounds"));
    }
    Ok(resolved)
}

pub fn connection_prologue(context: &str) -> Result<Vec<u8>, TypeError> {
    if context.is_empty() || context.len() > 1024 {
        return Err(TypeError::new(
            "Noise context must contain 1 to 1024 UTF-8 bytes",
        ));
    }
    let bytes = context.as_bytes();
    let mut prologue = Vec::with_capacity(PROTOCOL_PREFIX.len() + 3 + bytes.len());
    prologue.extend_from_slice(PROTOCOL_PREFIX);
    prologue.push(1);
    prologue.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    prologue.extend_from_slice(bytes);
    Ok(prologue)
}
