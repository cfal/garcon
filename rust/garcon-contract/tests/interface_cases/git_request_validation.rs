//! The recorded cases of `common/git-request-validation.ts`.

use garcon_cases::{CaseError, markers, unknown};
use garcon_contract::git_error::GitServiceError;
use garcon_contract::git_request_validation::{
    is_gh_method, is_git_document_ref, is_git_method, validate_gh_request, validate_git_request,
};
use serde_json::{Value, json};

use super::helpers::{self, typed};

/// The outcome of a check the original makes: it returns nothing, or throws
/// its error.
fn asserted(result: Result<(), GitServiceError>) -> Result<Value, CaseError> {
    match result {
        Ok(()) => Ok(markers::undefined()),
        Err(error) => Err(CaseError::new("GitServiceError", error.message)
            .with_property("code", error.code.as_str())
            .with_property("status", error.status)),
    }
}

fn dispatch_git_request_validation(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "isGitMethod" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_git_method(&value).is_some()))
        }
        "isGhMethod" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_gh_method(&value).is_some()))
        }
        "isGitDocumentRef" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_git_document_ref(&value)))
        }
        "validateGhRequest" => {
            // The call is typed; the request it checks is `unknown`.
            let method = typed(function, args, is_gh_method)?;
            let request = unknown(function, args.get(1))?;
            asserted(validate_gh_request(method, &request))
        }
        "validateGitRequest" => {
            let method = typed(function, args, is_git_method)?;
            let request = unknown(function, args.get(1))?;
            asserted(validate_git_request(method, &request))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn git_request_validation_cases_match() {
    helpers::recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/git-request-validation"
        ),
        "common/git-request-validation.ts",
        dispatch_git_request_validation,
    );
}
