//! Ports `common/git-request-validation.ts`.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::gh::{
    GH_COMMENT_BODY_MAX_LENGTH, GH_COMMENT_ID_MAX_LENGTH, GH_COMMENT_MARKER_MAX_LENGTH, GhMethod,
};
use crate::gh_identity::{is_gh_actor_identity, is_gh_repository_identity};
use crate::git::GitMethod;
use crate::git_error::{GitServiceError, GitServiceErrorCode};
use crate::git_execution::{GIT_MAX_REQUEST_BYTES, GIT_MAX_REQUEST_PATHS};
use garcon_js::{is_safe_integer, utf16};

fn path(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        let length = utf16::len(text);
        length > 0 && length <= 4096 && !text.contains('\0')
    })
}

fn text(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| utf16::len(text) <= 64 * 1024 && !text.contains('\0'))
}

/// The largest integer a JavaScript `number` holds exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn integer(value: &Value, max: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|number| is_safe_integer(number) && number >= 0.0 && number <= max)
}

/// A path, one or more of them. A selection with too many is refused with an
/// error of its own.
fn paths(value: &Value) -> Result<bool, GitServiceError> {
    let Some(items) = value.as_array() else {
        return Ok(false);
    };
    if items.len() > GIT_MAX_REQUEST_PATHS {
        return Err(GitServiceError::new(
            GitServiceErrorCode::GIT_REQUEST_TOO_LARGE,
            format!("Git selection exceeds the {GIT_MAX_REQUEST_PATHS} path limit."),
        ));
    }
    Ok(!items.is_empty() && items.iter().all(path))
}

fn one_of(value: &Value, values: &[&str]) -> bool {
    value.as_str().is_some_and(|value| values.contains(&value))
}

fn fields(value: &Map<String, Value>, keys: &[&str]) -> bool {
    value.keys().all(|key| keys.contains(&key.as_str()))
}

fn optional(value: Option<&Value>, check: impl FnOnce(&Value) -> bool) -> bool {
    value.is_none_or(check)
}

fn revision(value: &Value) -> bool {
    value.as_object().is_some_and(|input| {
        input.get("kind").and_then(Value::as_str) == Some("revision")
            && input.get("revision").is_some_and(path)
            && fields(input, &["kind", "revision"])
    })
}

static HASH_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the original holds the same pattern as a regular expression literal.
    Regex::new(r"^[a-f0-9]{40,64}$").expect("the hash pattern compiles")
});

fn hash(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|hash| HASH_PATTERN.is_match(hash))
}

fn revision_expectation(value: &Value) -> bool {
    value.as_object().is_some_and(|input| {
        input.get("kind").and_then(Value::as_str) == Some("revision")
            && input.get("revision").is_some_and(path)
            && input.get("hash").is_some_and(hash)
            && fields(input, &["kind", "revision", "hash"])
    })
}

/// Whether `value` names a review document an executor holds.
pub fn is_git_document_ref(value: &Value) -> bool {
    value.as_object().is_some_and(|input| {
        input.get("executorId").is_some_and(path)
            && input.get("instanceId").is_some_and(path)
            && input.get("documentId").is_some_and(path)
            && fields(input, &["executorId", "instanceId", "documentId"])
    })
}

static PATCH_DIGEST_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the original holds the same pattern as a regular expression literal.
    Regex::new(r"^[a-f0-9]{64}$").expect("the patch digest pattern compiles")
});

/// What a staged selection must repeat of the document it was made on.
fn proof(value: &Map<String, Value>) -> bool {
    value.get("document").is_some_and(is_git_document_ref)
        && value.get("bodyFingerprint").is_some_and(path)
        && value
            .get("patchDigest")
            .and_then(Value::as_str)
            .is_some_and(|digest| PATCH_DIGEST_PATTERN.is_match(digest))
}

/// The fields each Git call accepts beside the project path.
pub fn git_request_fields(method: GitMethod) -> &'static [&'static str] {
    match method {
        GitMethod::GetStatus
        | GitMethod::InitialCommit
        | GitMethod::GetBranches
        | GitMethod::GetRemoteStatus
        | GitMethod::GetRemotes
        | GitMethod::Fetch
        | GitMethod::Pull
        | GitMethod::GetConflicts
        | GitMethod::GetStashes
        | GitMethod::GetRepoInfo
        | GitMethod::GetWorktrees
        | GitMethod::GetTargetCandidates
        | GitMethod::GetWorkingTreeFingerprint
        | GitMethod::GetQuickSummary => &[],
        GitMethod::Commit => &["message", "files"],
        GitMethod::GetRefs => &["query", "limit", "sort"],
        GitMethod::Checkout => &["ref", "refKind"],
        GitMethod::CreateBranch => &["branch", "baseRef"],
        GitMethod::Push => &["remote", "remoteBranch"],
        GitMethod::Discard | GitMethod::DeleteUntracked => &["file"],
        GitMethod::GetWorkbenchSnapshot => {
            &["mode", "context", "selectedFile", "bodyCandidateCount"]
        }
        GitMethod::GetReviewDocumentFileBodies => &["document", "files", "purpose"],
        GitMethod::GetHistoryCommits => &["ref", "limit", "offset"],
        GitMethod::GetCommitSnapshot => &["commit", "parent", "context", "bodyCandidateCount"],
        GitMethod::GetComparisonSnapshot => {
            &["from", "to", "mode", "context", "bodyCandidateCount"]
        }
        GitMethod::GetComparisonFreshness => &["from", "to"],
        GitMethod::StageSelection => &[
            "file",
            "mode",
            "selection",
            "contextLines",
            "document",
            "bodyFingerprint",
            "patchDigest",
        ],
        GitMethod::StageHunk => &[
            "file",
            "mode",
            "hunkIndex",
            "contextLines",
            "document",
            "bodyFingerprint",
            "patchDigest",
        ],
        GitMethod::GetConflictDetails | GitMethod::MarkConflictResolved => &["file"],
        GitMethod::AcceptConflictSide => &["file", "side"],
        GitMethod::CreateStash => &["message", "includeUntracked"],
        GitMethod::ApplyStash | GitMethod::PopStash | GitMethod::DropStash => {
            &["stashRef", "expectedHash"]
        }
        GitMethod::GetFileHistory => &["file", "limit"],
        GitMethod::GetBlame => &["file", "ref", "limit"],
        GitMethod::GetGraph => &["limit"],
        GitMethod::CreateWorktree => &["worktreePath", "branch", "newBranch", "baseRef", "detach"],
        GitMethod::RemoveWorktree => &["worktreePath", "force"],
        GitMethod::CommitIndex => &["message"],
        GitMethod::StagePaths => &["paths", "mode"],
        GitMethod::RevertCommit => &["commit"],
        GitMethod::CollectCommitMessageContext => &["files"],
    }
}

/// The Git call `value` names.
pub fn is_git_method(value: &Value) -> Option<GitMethod> {
    let name = value.as_str()?;
    crate::git::GIT_METHODS
        .iter()
        .copied()
        .find(|method| method.as_str() == name)
}

/// The fields each GitHub call accepts.
pub fn gh_request_fields(method: GhMethod) -> &'static [&'static str] {
    match method {
        GhMethod::GetStatus => &[],
        GhMethod::ListPullRequests => &["projectPath", "repository"],
        GhMethod::GetPullRequest => &["projectPath", "repository", "number"],
        GhMethod::GetPullRequestReviewTarget => &["projectPath", "repository", "number", "marker"],
        GhMethod::CreatePullRequestComment => &[
            "projectPath",
            "repository",
            "actor",
            "number",
            "body",
            "expected",
        ],
        GhMethod::MinimizePullRequestComment => {
            &["projectPath", "repository", "actor", "commentId"]
        }
    }
}

/// The GitHub call `value` names.
pub fn is_gh_method(value: &Value) -> Option<GhMethod> {
    let name = value.as_str()?;
    crate::gh::GH_METHODS
        .iter()
        .copied()
        .find(|method| method.as_str() == name)
}

fn bounded(value: &Value, max: usize) -> bool {
    value.as_str().is_some_and(|text| {
        let length = utf16::len(text);
        length > 0 && length <= max && !text.contains('\0')
    })
}

static HEAD_REF_OID_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the original holds the same pattern as a regular expression literal.
    Regex::new(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$").expect("the head ref pattern compiles")
});

/// Checks that `request` is a request the GitHub call `method` accepts, and
/// fails with `GIT_INVALID_INPUT` when it is not.
pub fn validate_gh_request(method: GhMethod, request: &Value) -> Result<(), GitServiceError> {
    let keys = gh_request_fields(method);
    let has = |key: &str| keys.contains(&key);
    let field = |key: &str| request.as_object().and_then(|input| input.get(key));
    let expected = request.as_object().and_then(|input| input.get("expected"));
    let valid = request.as_object().is_some_and(|input| fields(input, keys))
        && (!has("projectPath") || field("projectPath").is_some_and(path))
        && (!has("repository")
            || (method == GhMethod::ListPullRequests && field("repository").is_none())
            || field("repository").is_some_and(is_gh_repository_identity))
        && (!has("actor") || field("actor").is_some_and(is_gh_actor_identity))
        && (!has("number")
            || field("number").is_some_and(|number| {
                integer(number, MAX_SAFE_INTEGER) && number.as_f64() != Some(0.0)
            }))
        && (!has("marker")
            || field("marker").is_some_and(|marker| bounded(marker, GH_COMMENT_MARKER_MAX_LENGTH)))
        && (!has("body")
            || field("body").is_some_and(|body| bounded(body, GH_COMMENT_BODY_MAX_LENGTH)))
        && (!has("expected")
            || expected.and_then(Value::as_object).is_some_and(|expected| {
                expected.get("state").and_then(Value::as_str) == Some("open")
                    && expected
                        .get("headRefOid")
                        .and_then(Value::as_str)
                        .is_some_and(|oid| HEAD_REF_OID_PATTERN.is_match(oid))
                    && fields(expected, &["state", "headRefOid"])
            }))
        && (!has("commentId")
            || field("commentId")
                .is_some_and(|comment_id| bounded(comment_id, GH_COMMENT_ID_MAX_LENGTH)));
    if !valid {
        return Err(GitServiceError::new(
            GitServiceErrorCode::GIT_INVALID_INPUT,
            format!("Invalid GitHub {} request", method.as_str()),
        ));
    }
    Ok(())
}

/// Checks that `request` is a request the Git call `method` accepts. It fails
/// with `GIT_INVALID_INPUT`, or with `GIT_REQUEST_TOO_LARGE` for a request or
/// a selection beyond its limit.
pub fn validate_git_request(method: GitMethod, request: &Value) -> Result<(), GitServiceError> {
    let fail = || {
        GitServiceError::new(
            GitServiceErrorCode::GIT_INVALID_INPUT,
            format!("Invalid Git {} request", method.as_str()),
        )
    };
    let Some(input) = request.as_object() else {
        return Err(fail());
    };
    let null = Value::Null;
    let field = |key: &str| input.get(key);
    let is = |key: &str, text: &str| field(key).and_then(Value::as_str) == Some(text);
    if !field("projectPath").is_some_and(path)
        || !input
            .keys()
            .all(|key| key == "projectPath" || git_request_fields(method).contains(&key.as_str()))
    {
        return Err(fail());
    }
    // The byte length of the request as the original serializes it.
    if garcon_js::json::stringify(request).len() > GIT_MAX_REQUEST_BYTES {
        return Err(GitServiceError::new(
            GitServiceErrorCode::GIT_REQUEST_TOO_LARGE,
            "Git request is too large. Select fewer paths.",
        ));
    }
    for key in [
        "file",
        "worktreePath",
        "branch",
        "newBranch",
        "ref",
        "baseRef",
        "remote",
        "remoteBranch",
        "commit",
        "stashRef",
    ] {
        if !optional(field(key), path) {
            return Err(fail());
        }
    }
    if !optional(field("message"), text)
        || !(optional(field("query"), path) || is("query", ""))
        || !optional(field("limit"), |limit| {
            integer(limit, 100_000.0) && limit.as_f64() != Some(0.0)
        })
        || !optional(field("offset"), |offset| integer(offset, 100_000.0))
        || !optional(field("context"), |context| integer(context, 50.0))
        || !optional(field("contextLines"), |lines| integer(lines, 50.0))
        || !optional(field("bodyCandidateCount"), |count| integer(count, 24.0))
        || !optional(field("selectedFile"), |file| {
            file == &Value::Null || path(file)
        })
        || !optional(field("parent"), |parent| {
            parent == &Value::Null || path(parent)
        })
    {
        return Err(fail());
    }
    for key in ["force", "detach", "includeUntracked"] {
        if !optional(field(key), |value| value.is_boolean()) {
            return Err(fail());
        }
    }
    if input.contains_key("file") && !field("file").is_some_and(path) {
        return Err(fail());
    }
    // The message is refused unless it is text and not empty.
    let message = |key: &str| !field(key).is_some_and(text) || is(key, "");
    match method {
        GitMethod::Commit => {
            if message("message") || !paths(field("files").unwrap_or(&null))? {
                return Err(fail());
            }
        }
        GitMethod::CommitIndex => {
            if message("message") {
                return Err(fail());
            }
        }
        GitMethod::CollectCommitMessageContext => {
            if !paths(field("files").unwrap_or(&null))? {
                return Err(fail());
            }
        }
        GitMethod::GetRefs => {
            let sorted = |sort: &Value| {
                sort.as_object().is_some_and(|sort| {
                    one_of(
                        sort.get("key").unwrap_or(&Value::Null),
                        &["name", "updated"],
                    ) && one_of(
                        sort.get("direction").unwrap_or(&Value::Null),
                        &["asc", "desc"],
                    ) && fields(sort, &["key", "direction"])
                })
            };
            if !optional(field("sort"), sorted) {
                return Err(fail());
            }
        }
        GitMethod::Checkout => {
            if !field("ref").is_some_and(path)
                || !optional(field("refKind"), |kind| {
                    one_of(kind, &["local-branch", "remote-branch", "tag", "other"])
                })
            {
                return Err(fail());
            }
        }
        GitMethod::CreateBranch => {
            if !field("branch").is_some_and(path) {
                return Err(fail());
            }
        }
        GitMethod::RevertCommit | GitMethod::GetCommitSnapshot => {
            if !field("commit").is_some_and(path) {
                return Err(fail());
            }
        }
        GitMethod::CreateWorktree => {
            if !field("worktreePath").is_some_and(path) {
                return Err(fail());
            }
            if field("newBranch").is_some()
                && (field("branch").is_some() || field("detach") == Some(&Value::Bool(true)))
            {
                return Err(fail());
            }
        }
        GitMethod::RemoveWorktree => {
            if !field("worktreePath").is_some_and(path) {
                return Err(fail());
            }
        }
        GitMethod::ApplyStash | GitMethod::PopStash | GitMethod::DropStash => {
            if !field("stashRef").is_some_and(path) || !field("expectedHash").is_some_and(hash) {
                return Err(fail());
            }
        }
        GitMethod::GetWorkbenchSnapshot => {
            if !one_of(field("mode").unwrap_or(&null), &["working", "staged"])
                || !field("context").is_some_and(|context| integer(context, 50.0))
            {
                return Err(fail());
            }
        }
        GitMethod::GetReviewDocumentFileBodies => {
            let files = field("files").unwrap_or(&null);
            if !field("document").is_some_and(is_git_document_ref)
                || !paths(files)?
                || files.as_array().is_none_or(|files| files.len() > 24)
                || !one_of(field("purpose").unwrap_or(&null), &["visible", "prefetch"])
            {
                return Err(fail());
            }
        }
        GitMethod::StagePaths => {
            if !paths(field("paths").unwrap_or(&null))?
                || !one_of(field("mode").unwrap_or(&null), &["stage", "unstage"])
            {
                return Err(fail());
            }
        }
        GitMethod::StageSelection | GitMethod::StageHunk => {
            if !field("file").is_some_and(path)
                || !proof(input)
                || !one_of(field("mode").unwrap_or(&null), &["stage", "unstage"])
                || !field("contextLines").is_some_and(|lines| integer(lines, 50.0))
            {
                return Err(fail());
            }
            let valid = match method {
                GitMethod::StageHunk => {
                    field("hunkIndex").is_some_and(|index| integer(index, 100_000.0))
                }
                _ => field("selection")
                    .and_then(Value::as_object)
                    .is_some_and(|selection| {
                        fields(selection, &["lineIndices"])
                            && selection
                                .get("lineIndices")
                                .and_then(Value::as_array)
                                .is_some_and(|indices| {
                                    !indices.is_empty()
                                        && indices.len() <= 50_000
                                        && indices.iter().all(|index| integer(index, 100_000.0))
                                })
                    }),
            };
            if !valid {
                return Err(fail());
            }
        }
        GitMethod::AcceptConflictSide => {
            if !field("file").is_some_and(path)
                || !one_of(field("side").unwrap_or(&null), &["ours", "theirs"])
            {
                return Err(fail());
            }
        }
        GitMethod::Discard
        | GitMethod::DeleteUntracked
        | GitMethod::GetConflictDetails
        | GitMethod::MarkConflictResolved
        | GitMethod::GetFileHistory
        | GitMethod::GetBlame => {
            if !field("file").is_some_and(path) {
                return Err(fail());
            }
        }
        GitMethod::GetComparisonSnapshot => {
            let working_tree = || {
                field("to").and_then(Value::as_object).is_some_and(|to| {
                    to.get("kind").and_then(Value::as_str) == Some("working-tree")
                })
            };
            if !field("from").is_some_and(revision)
                || !field("to").is_some_and(Value::is_object)
                || !(field("to").is_some_and(revision)
                    || (working_tree()
                        && field("to")
                            .and_then(Value::as_object)
                            .is_some_and(|to| fields(to, &["kind"]))))
                || !one_of(field("mode").unwrap_or(&null), &["direct", "merge-base"])
                || (working_tree() && field("mode").and_then(Value::as_str) != Some("direct"))
            {
                return Err(fail());
            }
        }
        GitMethod::GetComparisonFreshness => {
            if !field("from").is_some_and(revision_expectation)
                || !field("to").is_some_and(Value::is_object)
                || !(field("to").is_some_and(revision_expectation)
                    || field("to").and_then(Value::as_object).is_some_and(|to| {
                        to.get("kind").and_then(Value::as_str) == Some("working-tree")
                            && to.get("fingerprint").is_some_and(path)
                            && fields(to, &["kind", "fingerprint"])
                    }))
            {
                return Err(fail());
            }
        }
        GitMethod::GetStatus
        | GitMethod::InitialCommit
        | GitMethod::GetBranches
        | GitMethod::GetRemoteStatus
        | GitMethod::GetRemotes
        | GitMethod::Fetch
        | GitMethod::Pull
        | GitMethod::Push
        | GitMethod::GetWorkingTreeFingerprint
        | GitMethod::GetQuickSummary
        | GitMethod::GetHistoryCommits
        | GitMethod::GetConflicts
        | GitMethod::GetStashes
        | GitMethod::CreateStash
        | GitMethod::GetGraph
        | GitMethod::GetRepoInfo
        | GitMethod::GetWorktrees
        | GitMethod::GetTargetCandidates => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn repository() -> Value {
        json!({ "host": "github.example.invalid", "nameWithOwner": "acme/app" })
    }

    fn actor() -> Value {
        json!({ "id": "actor-a", "login": "viewer" })
    }

    fn without(request: &Value, key: &str) -> Value {
        let mut copy = request.clone();
        copy.as_object_mut().unwrap().shift_remove(key);
        copy
    }

    fn with(request: &Value, key: &str, value: Value) -> Value {
        let mut copy = request.clone();
        copy[key] = value;
        copy
    }

    #[test]
    fn github_operations_require_explicit_destination_and_mutation_actor_identities() {
        let requests = [
            (
                GhMethod::GetPullRequest,
                json!({ "projectPath": "/work/app", "repository": repository(), "number": 7 }),
            ),
            (
                GhMethod::GetPullRequestReviewTarget,
                json!({ "projectPath": "/work/app", "repository": repository(), "number": 7, "marker": "garcon-review " }),
            ),
            (
                GhMethod::CreatePullRequestComment,
                json!({
                    "projectPath": "/work/app", "repository": repository(), "actor": actor(),
                    "expected": { "state": "open", "headRefOid": "a".repeat(40) }, "number": 7, "body": "Review",
                }),
            ),
            (
                GhMethod::MinimizePullRequestComment,
                json!({ "projectPath": "/work/app", "repository": repository(), "actor": actor(), "commentId": "comment" }),
            ),
        ];
        for (method, request) in &requests {
            assert!(validate_gh_request(*method, request).is_ok(), "{request}");
            assert!(validate_gh_request(*method, &without(request, "repository")).is_err());
            assert!(
                validate_gh_request(
                    *method,
                    &with(
                        request,
                        "repository",
                        json!({ "host": "--invalid", "nameWithOwner": "acme/app" })
                    )
                )
                .is_err()
            );
            if request.get("actor").is_some() {
                assert!(
                    validate_gh_request(
                        *method,
                        &with(request, "actor", json!({ "login": "viewer" }))
                    )
                    .is_err()
                );
            }
        }
        assert!(
            validate_gh_request(
                GhMethod::ListPullRequests,
                &json!({ "projectPath": "/work/app" })
            )
            .is_ok()
        );
        assert!(
            validate_gh_request(
                GhMethod::ListPullRequests,
                &json!({ "projectPath": "/work/app", "repository": repository() })
            )
            .is_ok()
        );
    }

    #[test]
    fn comment_creation_requires_the_reviewed_open_head_before_mutation_admission() {
        let method = GhMethod::CreatePullRequestComment;
        let request = json!({
            "projectPath": "/work/app", "repository": repository(), "actor": actor(), "number": 7, "body": "Review",
        });
        for head_ref_oid in ["a".repeat(40), "b".repeat(64)] {
            let expected = json!({ "state": "open", "headRefOid": head_ref_oid });
            assert!(validate_gh_request(method, &with(&request, "expected", expected)).is_ok());
        }
        let invalid = [
            None,
            Some(json!({ "state": "closed", "headRefOid": "a".repeat(40) })),
            Some(json!({ "state": "open", "headRefOid": "a".repeat(41) })),
            Some(json!({ "state": "open", "headRefOid": "main" })),
            Some(json!({ "state": "open", "headRefOid": "a".repeat(40), "extra": true })),
        ];
        for expected in invalid {
            let request = match expected {
                Some(expected) => with(&request, "expected", expected),
                None => request.clone(),
            };
            let error = validate_gh_request(method, &request)
                .expect_err("the head was not reviewed")
                .to_string();
            assert_eq!(error, "Invalid GitHub createPullRequestComment request");
        }
    }

    #[test]
    fn untrusted_fields_are_rejected_before_execution() {
        let project_path = "/synthetic/repo";
        let invalid = |method: GitMethod, request: Value| {
            let error = validate_git_request(method, &request)
                .expect_err("the request is refused")
                .to_string();
            assert!(error.starts_with("Invalid Git "), "{error}");
        };
        invalid(
            GitMethod::Checkout,
            json!({ "projectPath": project_path, "ref": "main", "env": { "GIT_DIR": "/wrong" } }),
        );
        invalid(
            GitMethod::StageSelection,
            json!({ "projectPath": project_path, "file": "x", "mode": "stage", "selection": { "lineIndices": [0] } }),
        );
        for method in [
            GitMethod::ApplyStash,
            GitMethod::PopStash,
            GitMethod::DropStash,
        ] {
            invalid(
                method,
                json!({ "projectPath": project_path, "stashRef": "stash@{0}" }),
            );
            invalid(
                method,
                json!({ "projectPath": project_path, "stashRef": "stash@{0}", "expectedHash": "HEAD" }),
            );
            assert!(
                validate_git_request(
                    method,
                    &json!({ "projectPath": project_path, "stashRef": "stash@{0}", "expectedHash": "a".repeat(40) })
                )
                .is_ok()
            );
        }
    }

    #[test]
    fn selections_beyond_their_limits_are_typed_size_errors() {
        let project_path = "/synthetic/repo";
        let commit = |count: usize| {
            json!({
                "projectPath": project_path,
                "files": (0..count).map(|index| format!("file-{index}.txt")).collect::<Vec<_>>(),
                "message": "synthetic",
            })
        };
        // A selection at the path ceiling still passes.
        assert!(validate_git_request(GitMethod::Commit, &commit(100_000)).is_ok());
        assert!(validate_git_request(GitMethod::Commit, &commit(12_000)).is_ok());
        let too_many = validate_git_request(GitMethod::Commit, &commit(100_001))
            .expect_err("too many paths")
            .to_string();
        assert_eq!(too_many, "Git selection exceeds the 100000 path limit.");
        // A selection under the ceiling whose request is too large.
        let large = json!({
            "projectPath": project_path,
            "files": vec!["x".repeat(3000); 2000],
            "message": "synthetic",
        });
        let error = validate_git_request(GitMethod::Commit, &large)
            .expect_err("too many bytes")
            .to_string();
        assert_eq!(error, "Git request is too large. Select fewer paths.");
    }

    #[test]
    fn names_the_calls_and_the_fields_they_accept() {
        assert_eq!(
            is_git_method(&json!("getStatus")),
            Some(GitMethod::GetStatus)
        );
        assert_eq!(is_git_method(&json!("getStatus ")), None);
        assert_eq!(is_git_method(&json!("toString")), None);
        assert_eq!(is_git_method(&json!(null)), None);
        assert_eq!(
            is_gh_method(&json!("listPullRequests")),
            Some(GhMethod::ListPullRequests)
        );
        assert_eq!(is_gh_method(&json!("constructor")), None);
        for method in crate::git::GIT_METHODS {
            let fields = git_request_fields(*method);
            let mut unique = fields.to_vec();
            unique.sort_unstable();
            unique.dedup();
            assert_eq!(unique.len(), fields.len(), "{method:?}");
            assert!(!fields.contains(&"projectPath"), "{method:?}");
        }
        assert_eq!(git_request_fields(GitMethod::Commit), &["message", "files"]);
        assert_eq!(
            git_request_fields(GitMethod::StageHunk),
            &[
                "file",
                "mode",
                "hunkIndex",
                "contextLines",
                "document",
                "bodyFingerprint",
                "patchDigest"
            ]
        );
        assert_eq!(gh_request_fields(GhMethod::GetStatus), &[] as &[&str]);
        assert!(
            validate_gh_request(GhMethod::GetStatus, &json!({})).is_ok()
                && validate_gh_request(GhMethod::GetStatus, &json!({ "extra": 1 })).is_err()
        );
    }
}
