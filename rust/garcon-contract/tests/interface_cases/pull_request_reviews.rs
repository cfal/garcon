use garcon_cases::{CaseError, javascript_number, markers, text, unknown};
use garcon_contract::{pull_request_reviews::*, template_tokens::TemplateExpansionError};
use serde_json::{Value, json};

use crate::helpers::recorded_cases;

fn serialize(value: impl serde::Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(&value).unwrap()).unwrap()
}

#[test]
fn pull_request_review_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/pull-request-reviews"
        ),
        "common/pull-request-reviews.ts",
        |function, args| {
            let string = |i: usize| {
                text(function, args.get(i))?.ok_or_else(|| CaseError::unhandled(function))
            };
            let number = |i: usize| javascript_number(function, args.get(i));
            let input = || unknown(function, args.first());
            Ok(match function {
                "isActivePullRequestReviewRun" => {
                    let state = garcon_js::json::from_str(&input()?.to_string())
                        .map_err(|_| CaseError::unhandled(function))?;
                    json!(is_active_pull_request_review_run(state))
                }
                "renderPullRequestReviewPrompt" => {
                    let values = unknown(function, args.get(1))?;
                    let field = |key: &str| {
                        values[key]
                            .as_str()
                            .ok_or_else(|| CaseError::unhandled(function))
                    };
                    let values = PullRequestReviewPromptValues {
                        repository: field("repository")?,
                        repository_url: field("repositoryUrl")?,
                        number: values["number"]
                            .as_f64()
                            .ok_or_else(|| CaseError::unhandled(function))?,
                        project_path: field("projectPath")?,
                    };
                    match render_pull_request_review_prompt(string(0)?, &values) {
                        Ok(prompt) => json!(prompt),
                        Err(TemplateExpansionError::TooLong(error)) => json!({
                            "$": "error", "name": "TemplateExpansionTooLongError", "message": error.to_string(),
                            "properties": {"maxLength": markers::number(error.max_length)},
                        }),
                        Err(error @ TemplateExpansionError::MissingValue) => json!({
                            "$": "error", "name": "TypeError", "message": error.to_string(), "properties": {},
                        }),
                    }
                }
                "pullRequestReviewPromptFits" => {
                    json!(pull_request_review_prompt_fits(string(0)?, string(1)?))
                }
                "parseReviewedCommit" => json!(parse_reviewed_commit(string(0)?)),
                "pullRequestReviewMarkerPrefix" => {
                    json!(pull_request_review_marker_prefix(string(0)?, number(1)?))
                }
                "pullRequestReviewCommentBody" => json!(pull_request_review_comment_body(
                    string(0)?,
                    string(1)?,
                    number(2)?,
                    string(3)?
                )),
                "normalizePullRequestReviewSettings" => {
                    serialize(normalize_pull_request_review_settings(input()?.as_ref()))
                }
                "normalizePullRequestReviewRepositoryInput" => serialize(
                    normalize_pull_request_review_repository_input(input()?.as_ref()),
                ),
                "isPullRequestReviewsSnapshot" => {
                    json!(is_pull_request_reviews_snapshot(input()?.as_ref()))
                }
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}
