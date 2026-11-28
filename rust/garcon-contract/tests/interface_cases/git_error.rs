//! The recorded cases of `common/git-error.ts`.

use garcon_cases::{CaseError, text, unknown};
use garcon_contract::git_error::{GitServiceError, is_git_service_error_code};
use serde_json::{Value, json};

use super::helpers;

fn dispatch_git_error(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "isGitServiceErrorCode" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_git_service_error_code(&value).is_some()))
        }
        "new GitServiceError" => {
            let code = text(function, args.first())?;
            let message = text(function, args.get(1))?;
            match (code, message) {
                (Some(code), Some(message)) => match is_git_service_error_code(&json!(code)) {
                    Some(code) => {
                        let error = GitServiceError::new(code, message);
                        Err(CaseError::new("GitServiceError", error.message)
                            .with_property("code", code.as_str())
                            .with_property("status", error.status))
                    }
                    None => Err(CaseError::unhandled(function)),
                },
                _ => Err(CaseError::unhandled(function)),
            }
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn git_error_cases_match() {
    helpers::recorded_cases(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/git-error"),
        "common/git-error.ts",
        dispatch_git_error,
    );
}
