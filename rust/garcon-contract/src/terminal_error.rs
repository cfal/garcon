//! Ports `common/terminal-error.ts`.

use crate::terminal::TerminalErrorCode;

/// The error a terminal operation fails with. `status` is the HTTP status the
/// controller answers with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct TerminalError {
    pub code: TerminalErrorCode,
    pub message: String,
    pub status: u16,
}

impl TerminalError {
    pub fn new(code: TerminalErrorCode, message: impl Into<String>) -> TerminalError {
        TerminalError::with_status(code, message, 400)
    }

    pub fn with_status(
        code: TerminalErrorCode,
        message: impl Into<String>,
        status: u16,
    ) -> TerminalError {
        TerminalError {
            code,
            message: message.into(),
            status,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_carries_its_code_message_and_status() {
        let error =
            TerminalError::new(TerminalErrorCode::TERMINAL_NOT_FOUND, "Terminal not found.");
        assert_eq!(error.code, TerminalErrorCode::TERMINAL_NOT_FOUND);
        assert_eq!(error.message, "Terminal not found.");
        assert_eq!(error.status, 400);
        assert_eq!(error.to_string(), "Terminal not found.");

        let limited = TerminalError::with_status(
            TerminalErrorCode::TERMINAL_BACKPRESSURE,
            "Terminal attachment budget exhausted.",
            429,
        );
        assert_eq!(limited.status, 429);
        assert_eq!(limited.code.to_string(), "terminal-backpressure");
    }
}
