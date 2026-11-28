use std::fmt;

use thiserror::Error;

/// The failure a Noise connection reports. Each code has one fixed message, so
/// a peer without the secret cannot steer what a log line says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum NoiseErrorCode {
    AuthenticationFailed,
    ProtocolError,
    HandshakeTimeout,
    MessageTimeout,
    MessageTooLarge,
    Backpressure,
    RecordLimit,
    TransportError,
    TransportClosed,
    HandlerError,
    NotOpen,
    Closed,
}

impl NoiseErrorCode {
    pub fn message(self) -> &'static str {
        match self {
            Self::AuthenticationFailed => "Noise authentication failed",
            Self::ProtocolError => "Invalid encrypted WebSocket protocol message",
            Self::HandshakeTimeout => "Noise handshake timed out",
            Self::MessageTimeout => "Encrypted message assembly timed out",
            Self::MessageTooLarge => "Message exceeds the configured size limit",
            Self::Backpressure => "Encrypted WebSocket buffer limit exceeded",
            Self::RecordLimit => "Noise record limit reached; reconnect with fresh keys",
            Self::TransportError => "WebSocket transport failed",
            Self::TransportClosed => "WebSocket closed without an authenticated close record",
            Self::HandlerError => "Encrypted WebSocket handler failed",
            Self::NotOpen => "Encrypted WebSocket is not open",
            Self::Closed => "Encrypted WebSocket is closed",
        }
    }

    /// The code under the name the original gives it, as a log line prints it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AuthenticationFailed => "AUTHENTICATION_FAILED",
            Self::ProtocolError => "PROTOCOL_ERROR",
            Self::HandshakeTimeout => "HANDSHAKE_TIMEOUT",
            Self::MessageTimeout => "MESSAGE_TIMEOUT",
            Self::MessageTooLarge => "MESSAGE_TOO_LARGE",
            Self::Backpressure => "BACKPRESSURE",
            Self::RecordLimit => "RECORD_LIMIT",
            Self::TransportError => "TRANSPORT_ERROR",
            Self::TransportClosed => "TRANSPORT_CLOSED",
            Self::HandlerError => "HANDLER_ERROR",
            Self::NotOpen => "NOT_OPEN",
            Self::Closed => "CLOSED",
        }
    }
}

/// A failure of a Noise connection, sanitized to its code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("{}", .code.message())]
pub struct NoiseError {
    pub code: NoiseErrorCode,
}

impl NoiseError {
    pub fn new(code: NoiseErrorCode) -> Self {
        Self { code }
    }
}

impl From<NoiseErrorCode> for NoiseError {
    fn from(code: NoiseErrorCode) -> Self {
        Self::new(code)
    }
}

impl fmt::Display for NoiseErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A configuration the original refuses with a `TypeError`, before it opens a
/// transport. The message is the original's.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct TypeError {
    message: String,
}

impl TypeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// The message, as `error.message` reads it. `to_string` adds nothing.
    pub fn message(&self) -> &str {
        &self.message
    }
}
