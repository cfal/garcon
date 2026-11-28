//! The recorded cases of `common/git-error.ts`.

use garcon_cases::{CaseError, text, unknown};
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode, is_git_service_error_code};
use serde_json::{Value, json};

use super::helpers;

fn dispatch_git_error(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "isGitServiceErrorCode" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_git_service_error_code(&value).is_some()))
        }
        "new GitServiceError" => {
            let code: GitServiceErrorCode =
                serde_json::from_value(unknown(function, args.first())?.into_owned())
                    .map_err(|_| CaseError::unhandled(function))?;
            let message =
                text(function, args.get(1))?.ok_or_else(|| CaseError::unhandled(function))?;
            let error = GitServiceError::new(code, message);
            Err(CaseError::new("GitServiceError", error.message)
                .with_property("code", error.code.as_str())
                .with_property("status", error.status))
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
