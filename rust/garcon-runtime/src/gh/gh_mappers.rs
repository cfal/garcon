//! Maps GitHub CLI JSON and parsed patches to the shared pull request DTOs.

use std::cmp::Ordering;
use std::sync::LazyLock;

use garcon_contract::gh::*;
use garcon_contract::gh_identity::{gh_repository_identity, is_gh_actor_identity};
use garcon_contract::git::{GitFileReviewCategory, GitReviewFilePatchBody, GitReviewFileSummary};
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Number, collation::Collation, number_to_string, trim_end};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use super::pull_request_diff::GitDiffPatchFile;

pub fn map_pr_state(raw: Option<&str>) -> PullRequestState {
    match raw.unwrap_or_default().to_uppercase().as_str() {
        "MERGED" => PullRequestState::Merged,
        "CLOSED" => PullRequestState::Closed,
        _ => PullRequestState::Open,
    }
}

pub fn map_mergeable(raw: Option<&str>) -> PullRequestMergeable {
    match raw.unwrap_or_default().to_uppercase().as_str() {
        "MERGEABLE" => PullRequestMergeable::Mergeable,
        "CONFLICTING" => PullRequestMergeable::Conflicting,
        _ => PullRequestMergeable::Unknown,
    }
}

pub fn map_review_decision(raw: Option<&str>) -> Option<PullRequestReviewDecision> {
    match raw.unwrap_or_default().to_uppercase().as_str() {
        "APPROVED" => Some(PullRequestReviewDecision::Approved),
        "CHANGES_REQUESTED" => Some(PullRequestReviewDecision::ChangesRequested),
        "REVIEW_REQUIRED" => Some(PullRequestReviewDecision::ReviewRequired),
        _ => None,
    }
}

fn map_check_state(check: &Value) -> PullRequestCheckState {
    use PullRequestCheckState::*;
    let status = text(check, "status").to_uppercase();
    if !status.is_empty() && status != "COMPLETED" {
        return Pending;
    }
    match check["conclusion"]
        .as_str()
        .unwrap_or_else(|| text(check, "state"))
        .to_uppercase()
        .as_str()
    {
        "SUCCESS" => Success,
        "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" => Failure,
        "SKIPPED" | "STALE" => Skipped,
        "" | "PENDING" | "IN_PROGRESS" | "QUEUED" | "EXPECTED" | "REQUESTED" | "WAITING" => Pending,
        _ => Neutral,
    }
}

pub fn map_checks(raw: &Value) -> Vec<PullRequestCheck> {
    array(raw)
        .iter()
        .map(|check| PullRequestCheck {
            name: nonempty(&check["name"])
                .or_else(|| nonempty(&check["context"]))
                .unwrap_or("check")
                .into(),
            state: map_check_state(check),
            url: nonempty(&check["detailsUrl"])
                .or_else(|| nonempty(&check["targetUrl"]))
                .map(str::to_owned),
        })
        .collect()
}

pub fn map_author_association(raw: Option<&str>) -> PullRequestAuthorAssociation {
    use PullRequestAuthorAssociation::*;
    match raw.unwrap_or_default().to_lowercase().as_str() {
        "owner" => Owner,
        "member" => Member,
        "collaborator" => Collaborator,
        "contributor" => Contributor,
        "first_time_contributor" => FirstTimeContributor,
        "first_timer" => FirstTimer,
        "mannequin" => Mannequin,
        _ => None,
    }
}

fn map_rollup_state(raw: &Value) -> PullRequestChecksState {
    use PullRequestChecksState::*;
    match raw.as_str().unwrap_or_default().to_uppercase().as_str() {
        "SUCCESS" => Passing,
        "FAILURE" | "ERROR" => Failing,
        "PENDING" | "EXPECTED" => Pending,
        _ => None,
    }
}

pub(super) fn text<'a>(raw: &'a Value, key: &str) -> &'a str {
    raw[key].as_str().unwrap_or_default()
}

fn nonempty(raw: &Value) -> Option<&str> {
    raw.as_str().filter(|value| !value.is_empty())
}

fn integer_or_zero(raw: &Value, key: &str) -> Number {
    Number(raw[key].as_f64().unwrap_or_default())
}

fn required_number(raw: &Value, method: &str) -> Result<Number, GitServiceError> {
    raw.as_f64()
        .map(Number)
        .ok_or_else(|| invalid_result(method))
}

fn invalid_result(method: &str) -> GitServiceError {
    GitServiceError::new(
        GitServiceErrorCode::GIT_INVALID_RESULT,
        format!("Invalid GitHub {method} response"),
    )
}

fn projected_pr_number(
    raw: &Value,
    method: &str,
    author: Option<&Value>,
) -> Result<Number, GitServiceError> {
    let number = required_number(&raw["number"], method)?;
    // The original copies these values verbatim and rejects the wrong type at the RPC boundary.
    let text_fields = [
        "title",
        "headRefName",
        "baseRefName",
        "createdAt",
        "updatedAt",
        "url",
        "headRefOid",
    ];
    let number_fields = ["additions", "deletions", "changedFiles"];
    if text_fields
        .iter()
        .any(|key| !(raw[*key].is_null() || raw[*key].is_string()))
        || number_fields
            .iter()
            .any(|key| !(raw[*key].is_null() || raw[*key].is_number()))
        || author.is_some_and(|value| !value.is_string())
    {
        return Err(invalid_result(method));
    }
    Ok(number)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

pub(super) fn array(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

fn nodes(value: &Value) -> impl Iterator<Item = &Value> {
    array(&value["nodes"]).iter().filter(|node| !node.is_null())
}

pub fn map_summary(
    raw: &Value,
    viewer_login: Option<&str>,
    requested_numbers: &[f64],
) -> ExecutorResult<PullRequestSummary> {
    let login = &raw["author"]["login"];
    let number = projected_pr_number(raw, "listPullRequests", truthy(login).then_some(login))?;
    let author = nonempty(&raw["author"]["login"]).unwrap_or("unknown");
    let requested_directly = viewer_login.is_some_and(|viewer| {
        nodes(&raw["reviewRequests"]).any(|request| {
            let reviewer = &request["requestedReviewer"];
            reviewer["__typename"] == "User" && reviewer["login"] == viewer
        })
    });
    let checks = nodes(&raw["commits"])
        .next()
        .map(|commit| &commit["commit"]["statusCheckRollup"]["state"]);
    Ok(PullRequestSummary {
        number,
        title: text(raw, "title").into(),
        state: map_pr_state(raw["state"].as_str()),
        is_draft: truthy(&raw["isDraft"]),
        author: author.into(),
        head_ref_name: text(raw, "headRefName").into(),
        base_ref_name: text(raw, "baseRefName").into(),
        additions: integer_or_zero(raw, "additions"),
        deletions: integer_or_zero(raw, "deletions"),
        changed_files: integer_or_zero(raw, "changedFiles"),
        created_at: text(raw, "createdAt").into(),
        updated_at: text(raw, "updatedAt").into(),
        url: text(raw, "url").into(),
        review_decision: map_review_decision(raw["reviewDecision"].as_str()),
        checks_state: map_rollup_state(checks.unwrap_or(&Value::Null)),
        head_ref_oid: text(raw, "headRefOid").into(),
        is_cross_repository: truthy(&raw["isCrossRepository"]),
        author_association: map_author_association(raw["authorAssociation"].as_str()),
        author_is_bot: raw["author"]["__typename"] == "Bot",
        authored_by_viewer: viewer_login == Some(author),
        labels: nodes(&raw["labels"])
            .filter_map(|label| nonempty(&label["name"]).map(str::to_owned))
            .collect(),
        review_request: if requested_directly {
            Some(PullRequestReviewRequest::Me)
        } else if requested_numbers.contains(&number.0) {
            Some(PullRequestReviewRequest::Team)
        } else {
            None
        },
    })
}

pub fn build_pull_request_list(raw: &Value) -> ExecutorResult<PullRequestListResult> {
    let repo = &raw["data"]["repository"];
    if !truthy(repo) {
        return Err("gh api returned no repository for this project.".into());
    }
    let viewer_login = nonempty(&raw["data"]["viewer"]["login"]);
    let requested: Vec<_> = nodes(&raw["data"]["requested"])
        .filter_map(|node| node["number"].as_f64())
        .collect();
    Ok(PullRequestListResult {
        pulls: nodes(&repo["pullRequests"])
            .map(|pull| map_summary(pull, viewer_login, &requested))
            .collect::<ExecutorResult<_>>()?,
        repo: nonempty(&repo["nameWithOwner"]).map(|name| PullRequestRepository {
            name_with_owner: name.into(),
            url: text(repo, "url").into(),
        }),
        viewer_login: viewer_login.map(str::to_owned),
    })
}

pub(super) fn actor(raw: &Value) -> Option<GhActorIdentity> {
    if !is_gh_actor_identity(raw) {
        return None;
    }
    Some(GhActorIdentity {
        id: text(raw, "id").into(),
        login: text(raw, "login").into(),
    })
}

static CANONICAL_MARKER: LazyLock<regress::Regex> = LazyLock::new(|| {
    // INFALLIBLE: the original's marker pattern is a fixed regular expression.
    regress::Regex::new(
        r"<!-- garcon-review [^\s#]+/[^\s#]+#[1-9]\d* (?:[a-f0-9]{40}|[a-f0-9]{64}) -->\s*$",
    )
    .expect("valid review marker")
});

pub fn build_review_target(raw: &Value, marker_prefix: &str) -> Option<PullRequestReviewTarget> {
    let repo = &raw["data"]["repository"];
    let pull = &repo["pullRequest"];
    let repository = gh_repository_identity(text(repo, "nameWithOwner"), text(repo, "url"))?;
    let viewer = actor(&raw["data"]["viewer"])?;
    let number = Number(pull["number"].as_f64()?);
    let prefix = format!("<!-- {}", marker_prefix.to_lowercase());
    let marked_comments = nodes(&pull["comments"])
        .filter_map(|comment| {
            let id = nonempty(&comment["id"])?;
            let body = text(comment, "body");
            let marker = trim_end(&body[CANONICAL_MARKER.find(body)?.range()]);
            if !marker.to_lowercase().starts_with(&prefix) {
                return None;
            }
            Some(PullRequestMarkedComment {
                comment: PullRequestCommentRef {
                    id: id.into(),
                    url: text(comment, "url").into(),
                },
                marker: marker.into(),
                is_minimized: truthy(&comment["isMinimized"]),
                author: actor(&comment["author"]),
            })
        })
        .collect();
    Some(PullRequestReviewTarget {
        repository,
        viewer,
        number,
        state: map_pr_state(pull["state"].as_str()),
        head_ref_oid: text(pull, "headRefOid").into(),
        marked_comments,
    })
}

pub fn build_threads(comments: &[Value]) -> ExecutorResult<Vec<PullRequestThread>> {
    let mut groups: IndexMap<u64, Vec<(&Value, Number)>> = IndexMap::new();
    for comment in comments {
        let id = required_number(&comment["id"], "getPullRequest")?;
        let root_id = comment["in_reply_to_id"].as_f64().unwrap_or(id.0);
        let key = if root_id == 0.0 { 0 } else { root_id.to_bits() };
        groups.entry(key).or_default().push((comment, id));
    }
    let collation = Collation::english();
    let mut threads = Vec::with_capacity(groups.len());
    for (key, mut group) in groups {
        let root_id = f64::from_bits(key);
        group.sort_by(|(a, _), (b, _)| {
            collation.compare(text(a, "created_at"), text(b, "created_at"))
        });
        let Some((root, _)) = group
            .iter()
            .find(|(_, id)| id.0 == root_id)
            .or_else(|| group.first())
        else {
            continue;
        };
        threads.push(PullRequestThread {
            id: number_to_string(root_id),
            path: text(root, "path").into(),
            side: if text(root, "side").to_uppercase() == "LEFT" {
                PullRequestThreadSide::Before
            } else {
                PullRequestThreadSide::After
            },
            line: Number(
                root["line"]
                    .as_f64()
                    .or_else(|| root["original_line"].as_f64())
                    .unwrap_or_default(),
            ),
            diff_hunk: text(root, "diff_hunk").into(),
            is_outdated: root["line"].is_null(),
            comments: group
                .iter()
                .map(|(comment, id)| PullRequestReviewCommentItem {
                    id: *id,
                    author: comment["user"]["login"]
                        .as_str()
                        .unwrap_or("unknown")
                        .into(),
                    body: text(comment, "body").into(),
                    created_at: text(comment, "created_at").into(),
                })
                .collect(),
        });
    }
    threads.sort_by(|a, b| {
        collation
            .compare(&a.path, &b.path)
            .then_with(|| a.line.0.partial_cmp(&b.line.0).unwrap_or(Ordering::Equal))
    });
    Ok(threads)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestPatchFileSet {
    pub files: Vec<GitReviewFileSummary>,
    pub file_bodies: IndexMap<String, GitReviewFilePatchBody>,
}

pub fn build_patch_file_set(
    patches: Vec<GitDiffPatchFile>,
    gh_files: &Value,
) -> PullRequestPatchFileSet {
    let gh_files: IndexMap<_, _> = array(gh_files)
        .iter()
        .filter_map(|file| Some((file["path"].as_str()?, file)))
        .collect();
    let mut files = Vec::with_capacity(patches.len());
    let mut bodies = IndexMap::new();
    for file in patches {
        let source = gh_files
            .get(file.path.as_str())
            .copied()
            .unwrap_or(&Value::Null);
        let body = file.body;
        files.push(GitReviewFileSummary {
            path: file.path.clone(),
            original_path: file.original_path.filter(|path| !path.is_empty()),
            index_status: " ".into(),
            work_tree_status: file.status,
            category: body.category,
            additions: Number(source["additions"].as_f64().unwrap_or(file.additions.0)),
            deletions: Number(source["deletions"].as_f64().unwrap_or(file.deletions.0)),
            stats_known: None,
            estimated_rows: body.rendered_row_count,
            body_state: body.body_state,
            body_fingerprint: body.body_fingerprint.clone(),
            is_generated: body.category == GitFileReviewCategory::Generated,
            is_binary: body.is_binary,
            is_too_large: body.is_too_large,
            limit_reason: body.limit_reason,
            limit_message: body
                .limit_message
                .as_ref()
                .filter(|message| !message.is_empty())
                .cloned(),
        });
        bodies.insert(file.path, body);
    }
    let mut keys: Vec<_> = bodies.keys().cloned().collect();
    garcon_js::sort_object_keys(&mut keys);
    let file_bodies = keys
        .into_iter()
        .filter_map(|key| bodies.swap_remove_entry(&key))
        .collect();
    PullRequestPatchFileSet { files, file_bodies }
}

pub fn build_detail(
    raw: &Value,
    patches: Vec<GitDiffPatchFile>,
    threads: Vec<PullRequestThread>,
) -> ExecutorResult<PullRequestDetail> {
    let PullRequestPatchFileSet { files, file_bodies } =
        build_patch_file_set(patches, &raw["files"]);
    let is_draft = truthy(&raw["isDraft"]);
    let author = &raw["author"];
    let author = [&author["login"], &author["name"]]
        .into_iter()
        .find(|value| truthy(value));
    let number = projected_pr_number(raw, "getPullRequest", author)?;
    if !(raw["body"].is_null() || raw["body"].is_string()) {
        return Err(invalid_result("getPullRequest").into());
    }
    Ok(PullRequestDetail {
        number,
        title: text(raw, "title").into(),
        body: text(raw, "body").into(),
        state: if is_draft {
            PullRequestState::Open
        } else {
            map_pr_state(raw["state"].as_str())
        },
        is_draft,
        author: author.and_then(Value::as_str).unwrap_or("unknown").into(),
        head_ref_name: text(raw, "headRefName").into(),
        base_ref_name: text(raw, "baseRefName").into(),
        additions: integer_or_zero(raw, "additions"),
        deletions: integer_or_zero(raw, "deletions"),
        changed_files: Number(raw["changedFiles"].as_f64().unwrap_or(files.len() as f64)),
        created_at: text(raw, "createdAt").into(),
        updated_at: text(raw, "updatedAt").into(),
        url: text(raw, "url").into(),
        head_ref_oid: text(raw, "headRefOid").into(),
        mergeable: map_mergeable(raw["mergeable"].as_str()),
        review_decision: map_review_decision(raw["reviewDecision"].as_str()),
        checks: map_checks(&raw["statusCheckRollup"]),
        files,
        file_bodies,
        threads,
    })
}
