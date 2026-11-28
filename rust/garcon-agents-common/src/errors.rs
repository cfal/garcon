//! Ports `server-agents/common/src/lib/errors.ts`. The directory is not a
//! module of this crate, because `lib` names the crate root.

use std::borrow::Cow;

use garcon_base::errors::{ErrorInput, js_string};

pub use garcon_base::errors::has_node_error_code;

/// Returns the message of an `Error`; any other thrown value prints as `String(value)` does.
pub fn error_message(error: ErrorInput<'_>) -> Cow<'_, str> {
    js_string(error)
}

#[cfg(test)]
mod tests {
    use std::io;

    use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};

    use super::*;

    #[test]
    fn an_error_reads_its_message() {
        let native = io::Error::other("native failure");
        assert_eq!(error_message(ErrorInput::Error(&native)), "native failure");
        let integration =
            AgentIntegrationError::new(AgentIntegrationErrorCode::TIMEOUT, "Timed out", true, None);
        assert_eq!(error_message(ErrorInput::Error(&integration)), "Timed out");
        let named = garcon_base::errors::NamedError {
            name: "AbortError".to_owned(),
            message: "Aborted".to_owned(),
            code: None,
        };
        assert_eq!(error_message(ErrorInput::Diagnostic(&named)), "Aborted");
    }

    #[test]
    fn a_code_is_read_off_any_error_the_file_system_produces() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let missing = std::fs::metadata(directory.path().join("absent")).unwrap_err();
        let input = ErrorInput::Error(&missing);
        assert!(has_node_error_code(input, "ENOENT"));
        assert!(!has_node_error_code(input, "EACCES"));
        assert!(!has_node_error_code(ErrorInput::Undefined, "ENOENT"));
        assert!(!has_node_error_code(
            ErrorInput::Error(&io::Error::other("x")),
            "x"
        ));
    }
}
