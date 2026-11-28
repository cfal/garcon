//! Cases recorded from common/git-result-validation.ts.

use garcon_cases::{CaseError, markers, unknown};
use garcon_contract::gh::GhMethod;
use garcon_contract::git::GitMethod;
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode};
use garcon_contract::git_execution::{GIT_MAX_RESULT_BYTES, GitExecutorScope};
use garcon_contract::git_result_validation::{
    is_git_patch_body, validate_gh_result, validate_git_result,
};
use serde_json::{Value, json};

fn asserted(result: Result<(), GitServiceError>) -> Result<Value, CaseError> {
    result.map(|()| markers::undefined()).map_err(|error| {
        CaseError::new("GitServiceError", error.message)
            .with_property("code", error.code.as_str())
            .with_property("status", error.status)
    })
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "isGitPatchBody" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_git_patch_body(&value)))
        }
        "validateGitResult" | "validateGhResult" => {
            let method = unknown(function, args.first())?.into_owned();
            let value = unknown(function, args.get(1))?;
            let scope = serde_json::from_value(unknown(function, args.get(2))?.into_owned())
                .map_err(|_| CaseError::unhandled(function))?;
            if function == "validateGitResult" {
                let method =
                    serde_json::from_value(method).map_err(|_| CaseError::unhandled(function))?;
                asserted(validate_git_result(method, &value, &scope))
            } else {
                let method =
                    serde_json::from_value(method).map_err(|_| CaseError::unhandled(function))?;
                asserted(validate_gh_result(method, &value, &scope))
            }
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn recorded_git_result_cases_match() {
    garcon_cases::replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/git-result-validation"
        ),
        dispatch,
    );
}

#[test]
fn enforces_the_json_byte_limit_before_validating_scope() {
    let scope = GitExecutorScope {
        executor_id: "local".into(),
        instance_id: "fixture".into(),
    };
    let mut result = json!({"executorId": "local", "instanceId": "fixture", "diff": ""});
    let capacity = GIT_MAX_RESULT_BYTES - garcon_js::json::stringify(&result).len();
    result["diff"] = json!(format!(
        "{}{}",
        "\"".repeat(capacity / 2),
        "x".repeat(capacity % 2)
    ));
    assert!(validate_git_result(GitMethod::CollectCommitMessageContext, &result, &scope).is_ok());

    result["diff"] = json!(format!("{}x", result["diff"].as_str().unwrap()));
    let query =
        validate_git_result(GitMethod::CollectCommitMessageContext, &result, &scope).unwrap_err();
    assert_eq!(query.code, GitServiceErrorCode::GIT_RESULT_TOO_LARGE);
    assert_eq!(query.message, "Git query result exceeds the 4 MiB limit");
    let mutation = validate_git_result(GitMethod::Commit, &result, &scope).unwrap_err();
    assert_eq!(
        mutation.code,
        GitServiceErrorCode::GIT_MUTATION_OUTCOME_UNKNOWN
    );
    assert_eq!(
        mutation.message,
        "Git mutation result exceeds the 4 MiB limit. Inspect the repository before trying again."
    );
    let gh = validate_gh_result(GhMethod::GetStatus, &result, &scope).unwrap_err();
    assert_eq!(gh.code, GitServiceErrorCode::GIT_RESULT_TOO_LARGE);
    assert_eq!(gh.message, "GitHub query result exceeds the 4 MiB limit");
}
