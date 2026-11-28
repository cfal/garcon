use garcon_agents_common::auth::cli_login_controller::CliLoginOutputError;
use garcon_js::trim;

pub const CLAUDE_INCOMPLETE_AUTH_CODE_ERROR: &str =
    "Paste the complete authorization code, including the # suffix, and submit it again.";

pub fn validate_claude_auth_code(code: &str) -> Option<String> {
    let mut fields = code.split('#');
    let complete = !code.contains(['\r', '\n'])
        && (0..2).all(|_| fields.next().is_some_and(|field| !trim(field).is_empty()));
    (!complete).then(|| CLAUDE_INCOMPLETE_AUTH_CODE_ERROR.to_owned())
}

pub fn parse_claude_auth_login_error(line: &str) -> Option<CliLoginOutputError> {
    let line = trim(line);
    if line == "Invalid code. Please make sure the full code was copied." {
        return Some(CliLoginOutputError {
            retryable: true,
            message: CLAUDE_INCOMPLETE_AUTH_CODE_ERROR.to_owned(),
        });
    }
    if line.starts_with("Login failed:") {
        return Some(CliLoginOutputError {
            retryable: false,
            message: "Claude could not complete sign-in. Start a new sign-in attempt.".to_owned(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_cases::{CaseError, replay, text};
    use serde_json::json;

    #[test]
    fn recorded_auth_login_helpers_match() {
        replay(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/claude-auth-login"),
            |function, args| {
                let input = text(function, args.first())?.expect("recorded string");
                match function {
                    "validateClaudeAuthCode" => Ok(json!(validate_claude_auth_code(input))),
                    "parseClaudeAuthLoginError" => Ok(parse_claude_auth_login_error(input).map_or(
                        serde_json::Value::Null,
                        |error| json!({ "retryable": error.retryable, "message": error.message }),
                    )),
                    _ => Err(CaseError::unhandled(function)),
                }
            },
        );
    }
}
