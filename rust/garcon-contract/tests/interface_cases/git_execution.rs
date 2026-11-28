use garcon_cases::{CaseError, text};
use garcon_contract::{
    gh::{GH_METHODS, is_gh_mutation},
    git::GIT_METHODS,
    git_execution::{gh_operation_timeout_ms, is_git_mutation},
};
use serde_json::json;

use crate::helpers::recorded_cases;

#[test]
fn gh_classification_cases_match() {
    recorded_cases(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/gh"),
        "common/gh.ts",
        |function, args| {
            let name = text(function, args.first())?;
            if function == "isGhMutation"
                && let Some(method) = GH_METHODS
                    .iter()
                    .find(|method| Some(method.as_str()) == name)
            {
                return Ok(json!(is_gh_mutation(*method)));
            }
            Err(CaseError::unhandled(function))
        },
    );
}

#[test]
fn git_execution_classification_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/git-execution"
        ),
        "common/git-execution.ts",
        |function, args| {
            let name = text(function, args.first())?;
            match function {
                "isGitMutation" => GIT_METHODS
                    .iter()
                    .find(|method| Some(method.as_str()) == name)
                    .map(|method| json!(is_git_mutation(*method))),
                "ghOperationTimeoutMs" => GH_METHODS
                    .iter()
                    .find(|method| Some(method.as_str()) == name)
                    .map(|method| json!(gh_operation_timeout_ms(*method))),
                _ => None,
            }
            .ok_or_else(|| CaseError::unhandled(function))
        },
    );
}
