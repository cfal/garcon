//! Replays the original's GitHub CLI mappers, classifier, and diff parser.

use garcon_base::errors::{ErrorInput, NamedError};
use garcon_cases::{
    CaseError, ReplayOptions, ResultOrderException, javascript_number, markers, replay,
    replay_with_options, text, unknown,
};
use garcon_contract::git_error::GitServiceError;
use garcon_interface::resources::ExecutorResult;
use garcon_runtime::gh::gh_error_classifier::classify_gh_error;
use garcon_runtime::gh::gh_mappers::{
    build_detail, build_patch_file_set, build_pull_request_list, build_review_target,
    build_threads, map_author_association, map_checks, map_mergeable, map_pr_state,
    map_review_decision, map_summary,
};
use garcon_runtime::gh::gh_status::derive_gh_status;
use garcon_runtime::gh::pull_request_diff::parse_multi_file_diff_patches;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

const CASES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/gh");

fn encode(value: impl Serialize) -> Result<Value, CaseError> {
    let text =
        serde_json::to_vec(&value).map_err(|error| CaseError::undeliverable(error.to_string()))?;
    garcon_js::json::from_slice(&text).map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn result(value: ExecutorResult<impl Serialize>) -> Result<Value, CaseError> {
    match value {
        Ok(value) => encode(value),
        Err(error) => {
            if let Some(error) = error.downcast_ref::<GitServiceError>() {
                return Err(CaseError::new("GitServiceError", &error.message)
                    .with_property("code", error.code.as_str())
                    .with_property("status", error.status));
            }
            Err(CaseError::new("Error", error.to_string()))
        }
    }
}

fn typed<T: DeserializeOwned>(function: &str, arg: Option<&Value>) -> Result<T, CaseError> {
    let value = unknown(function, arg)?;
    serde_json::from_value(value.into_owned())
        .map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn on_error<R>(
    function: &str,
    value: Option<&Value>,
    call: impl FnOnce(ErrorInput<'_>) -> R,
) -> Result<R, CaseError> {
    if let Some(error) = value.filter(|value| markers::kind(value) == Some("error")) {
        let error = NamedError {
            name: text(function, error.get("name"))?
                .ok_or_else(|| CaseError::unhandled(function))?
                .into(),
            message: text(function, error.get("message"))?
                .ok_or_else(|| CaseError::unhandled(function))?
                .into(),
            code: error["properties"]["code"].as_str().map(str::to_owned),
        };
        return Ok(call(ErrorInput::Diagnostic(&error)));
    }
    if value.is_none_or(markers::is_undefined) {
        return Ok(call(ErrorInput::Undefined));
    }
    let value = unknown(function, value)?;
    Ok(call(ErrorInput::Json(&value)))
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let raw = |index| unknown(function, args.get(index));
    let string = |index| text(function, args.get(index));
    let required = |index| string(index)?.ok_or_else(|| CaseError::unhandled(function));
    match function {
        "classifyGhError" => encode(on_error(function, args.first(), classify_gh_error)?),
        "deriveGhStatus" => {
            let raw = raw(0)?;
            if args
                .get(1)
                .is_some_and(|value| !markers::is_undefined(value) && !value.is_null())
            {
                encode(on_error(function, args.get(1), |error| {
                    derive_gh_status(&raw, Some(error))
                })?)
            } else {
                encode(derive_gh_status(&raw, None))
            }
        }
        "parseMultiFileDiffPatches" => encode(parse_multi_file_diff_patches(required(0)?)),
        "mapPrState" => encode(map_pr_state(string(0)?)),
        "mapMergeable" => encode(map_mergeable(string(0)?)),
        "mapReviewDecision" => encode(map_review_decision(string(0)?)),
        "mapAuthorAssociation" => encode(map_author_association(string(0)?)),
        "mapChecks" => encode(map_checks(raw(0)?.as_ref())),
        "mapSummary" => {
            let requested = args
                .get(2)
                .filter(|value| markers::kind(value) == Some("set"))
                .and_then(|value| value["value"].as_array())
                .ok_or_else(|| CaseError::unhandled(function))?;
            let requested = requested
                .iter()
                .map(|number| javascript_number(function, Some(number)))
                .collect::<Result<Vec<_>, _>>()?;
            result(map_summary(raw(0)?.as_ref(), string(1)?, &requested))
        }
        "buildPullRequestList" => result(build_pull_request_list(raw(0)?.as_ref())),
        "buildReviewTarget" => encode(build_review_target(raw(0)?.as_ref(), required(1)?)),
        "buildThreads" => result(build_threads(
            raw(0)?
                .as_array()
                .ok_or_else(|| CaseError::unhandled(function))?,
        )),
        "buildPatchFileSet" => encode(build_patch_file_set(
            typed(function, args.first())?,
            raw(1)?.as_ref(),
        )),
        "buildDetail" => result(build_detail(
            raw(0)?.as_ref(),
            typed(function, args.get(1))?,
            typed(function, args.get(2))?,
        )),
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn recorded_gh_mappers_match() {
    const REASON: &str =
        "pass-through of the upstream response's own object; key order is the upstream's";
    replay_with_options(
        format!("{CASES}/mappers"),
        ReplayOptions {
            result_order_exceptions: &[
                ResultOrderException {
                    function: "buildReviewTarget",
                    path: "$.result.viewer",
                    reason: REASON,
                },
                ResultOrderException {
                    function: "buildReviewTarget",
                    path: "$.result.markedComments[*].author",
                    reason: REASON,
                },
            ],
            ..Default::default()
        },
        dispatch,
    );
}

#[test]
fn recorded_gh_classifier_matches() {
    replay(format!("{CASES}/error-classifier"), dispatch);
}

#[test]
fn recorded_gh_status_matches() {
    replay(format!("{CASES}/status"), dispatch);
}

#[test]
fn recorded_pull_request_diff_matches() {
    replay(format!("{CASES}/pull-request-diff"), dispatch);
}

#[test]
fn keeps_a_proto_path_as_an_own_file_body_when_the_original_result_cannot_be_recorded() {
    let diff = "diff --git a/__proto__ b/__proto__\n--- a/__proto__\n+++ b/__proto__\n@@ -1 +1 @@\n-old\n+new";
    let set = build_patch_file_set(parse_multi_file_diff_patches(diff), &Value::Null);
    assert_eq!(set.files[0].path, "__proto__");
    assert_eq!(set.file_bodies["__proto__"].path, "__proto__");
}
