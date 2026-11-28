//! Executor-local GitHub CLI operations, before transport validation.

use garcon_base::errors::{ErrorInput, NamedError};
use garcon_base::log::{Logger, create_logger};
use garcon_contract::gh::*;
use garcon_contract::gh_identity::{gh_repository_identity, same_gh_repository};
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode as Code};
use garcon_interface::resources::ExecutorResult;
use garcon_js::utf16;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::cancellation::check_cancelled;

use super::gh_error_classifier::classify_gh_error;
use super::gh_mappers::{array, build_detail, build_threads, text};
use super::gh_repository::{
    assert_gh_actor, read_posting_actor, require_gh_actor, resolve_checkout_repository,
};
use super::gh_review_reads::{read_pull_request_list, read_review_target};
use super::gh_status::derive_gh_status;
use super::gh_types::{GhCommandOptions, GhDomainError};
use super::pull_request_diff::parse_multi_file_diff_patches;
use super::run::{
    assert_accessible_directory, parse_gh_json, run_gh, run_gh_json, run_gh_mutation,
};

const VIEW_FIELDS: &str = "number,title,body,state,isDraft,author,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,createdAt,updatedAt,url,mergeable,reviewDecision,statusCheckRollup,files";
const MINIMIZE_MUTATION: &str = "mutation($id:ID!){
  minimizeComment(input:{subjectId:$id,classifier:OUTDATED}){minimizedComment{isMinimized}}
}";
const COMMENT_IDENTITY_QUERY: &str = "query($id:ID!){
  viewer{id login}
  node(id:$id){... on IssueComment{author{login ... on Node{id}} repository{nameWithOwner url}}}
}";
const STATUS_TIMEOUT_MS: f64 = 10_000.0;
const DIFF_TIMEOUT_MS: f64 = 60_000.0;

fn assert_pull_request_number(number: u64) -> Result<(), GhDomainError> {
    if number == 0 {
        return Err(GhDomainError::new(
            "INVALID_INPUT",
            "Pull request number must be a positive integer.",
        ));
    }
    Ok(())
}

async fn load_review_threads(
    project: &str,
    repository: &GhRepositoryIdentity,
    number: u64,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<Vec<PullRequestThread>> {
    let result = async {
        let raw = run_gh_json(
            project,
            vec![
                "api".into(),
                "--hostname".into(),
                repository.host.clone(),
                "--paginate".into(),
                "--slurp".into(),
                format!(
                    "repos/{}/pulls/{number}/comments",
                    repository.name_with_owner
                ),
            ],
            GhCommandOptions::for_signal(signal),
        )
        .await?;
        let comments: Vec<_> = array(&raw)
            .iter()
            .flat_map(|page| match page {
                Value::Array(entries) => entries.as_slice(),
                value => std::slice::from_ref(value),
            })
            .cloned()
            .collect();
        build_threads(&comments)
    }
    .await;
    match result {
        Ok(threads) => Ok(threads),
        Err(error) => {
            check_cancelled(signal)?;
            let code = classify_gh_error(ErrorInput::Error(error.as_ref())).code;
            create_logger("gh:service")
                .warn(&format!("[gh] failed to load review threads: {code}"));
            Ok(Vec::new())
        }
    }
}

pub struct GhOperations {
    status_directory: String,
}

impl GhOperations {
    pub fn new(status_directory: String) -> Self {
        Self { status_directory }
    }

    pub async fn get_status(
        &self,
        signal: Option<&CancellationToken>,
    ) -> ExecutorResult<GhStatusResponse> {
        let options = GhCommandOptions {
            timeout_ms: Some(STATUS_TIMEOUT_MS),
            ..GhCommandOptions::for_signal(signal)
        };
        match run_gh_json(
            &self.status_directory,
            ["auth", "status", "--json", "hosts"]
                .map(str::to_owned)
                .into(),
            options,
        )
        .await
        {
            Ok(raw) => Ok(derive_gh_status(&raw, None)),
            Err(error) => {
                check_cancelled(signal)?;
                let status =
                    derive_gh_status(&Value::Null, Some(ErrorInput::Error(error.as_ref())));
                if status.reason == GhAvailabilityReason::Unknown {
                    let code = classify_gh_error(ErrorInput::Error(error.as_ref())).code;
                    create_logger("gh:service")
                        .warn(&format!("[gh] failed to resolve gh auth status: {code}"));
                }
                Ok(status)
            }
        }
    }

    pub async fn list_pull_requests(
        &self,
        request: ListPullRequestsRequest,
        signal: Option<&CancellationToken>,
    ) -> ExecutorResult<PullRequestListResult> {
        let project = &request.project_path;
        assert_accessible_directory(project).await?;
        let identity =
            resolve_checkout_repository(project, request.repository.as_ref(), signal).await?;
        read_pull_request_list(project, &identity, signal).await
    }

    pub async fn get_pull_request(
        &self,
        request: GetPullRequestRequest,
        signal: Option<&CancellationToken>,
    ) -> ExecutorResult<PullRequestDetail> {
        assert_pull_request_number(request.number)?;
        let project = &request.project_path;
        let repository = &request.repository;
        assert_accessible_directory(project).await?;
        resolve_checkout_repository(project, Some(repository), signal).await?;
        let repo = format!("{}/{}", repository.host, repository.name_with_owner);
        let (raw, diff, threads) = tokio::try_join!(biased;
            run_gh_json(project, vec![
                "pr".into(), "view".into(), request.number.to_string(), "--repo".into(), repo.clone(),
                "--json".into(), VIEW_FIELDS.into(),
            ], GhCommandOptions::for_signal(signal)),
            run_gh(project, vec![
                "pr".into(), "diff".into(), request.number.to_string(), "--repo".into(), repo,
            ], GhCommandOptions { timeout_ms: Some(DIFF_TIMEOUT_MS), ..GhCommandOptions::for_signal(signal) }),
            load_review_threads(project, repository, request.number, signal),
        )?;
        build_detail(&raw, parse_multi_file_diff_patches(&diff.stdout), threads)
    }

    pub async fn get_pull_request_review_target(
        &self,
        request: GetPullRequestReviewTargetRequest,
        signal: Option<&CancellationToken>,
    ) -> ExecutorResult<PullRequestReviewTarget> {
        assert_pull_request_number(request.number)?;
        let project = &request.project_path;
        assert_accessible_directory(project).await?;
        resolve_checkout_repository(project, Some(&request.repository), signal).await?;
        read_review_target(
            project,
            &request.repository,
            request.number,
            &request.marker,
            signal,
        )
        .await
    }

    pub async fn create_pull_request_comment(
        &self,
        request: CreatePullRequestCommentRequest,
        signal: Option<&CancellationToken>,
    ) -> ExecutorResult<PullRequestCommentRef> {
        let result: ExecutorResult<_> = async {
            assert_pull_request_number(request.number)?;
            let project = &request.project_path;
            let repository = &request.repository;
            assert_accessible_directory(project).await?;
            resolve_checkout_repository(project, Some(repository), signal).await?;
            assert_gh_actor(&read_posting_actor(project, repository, signal).await?, &request.actor)?;
            let current = run_gh_json(project, vec![
                "pr".into(), "view".into(), request.number.to_string(), "--repo".into(),
                format!("{}/{}", repository.host, repository.name_with_owner), "--json".into(), "state,headRefOid".into(),
            ], GhCommandOptions::for_signal(signal)).await?;
            if current["state"] != "OPEN" || current["headRefOid"] != request.expected.head_ref_oid {
                return Err(GitServiceError::new(Code::GH_STALE_PULL_REQUEST,
                    "The pull request is no longer open at the reviewed commit, so this review was not posted.",
                ).into());
            }
            let outcome = run_gh_mutation(project, vec![
                "api".into(), "--hostname".into(), repository.host.clone(), "--method".into(), "POST".into(),
                format!("repos/{}/issues/{}/comments", repository.name_with_owner, request.number),
                "-F".into(), "body=@-".into(),
            ], GhCommandOptions { stdin: Some(request.body), ..GhCommandOptions::for_signal(signal) }).await?;
            posted_comment(&outcome.stdout, &request.actor).ok_or_else(|| GitServiceError::new(
                Code::GIT_MUTATION_OUTCOME_UNKNOWN,
                "GitHub did not return a usable comment identity. Check for the comment before trying again.",
            ).into())
        }.await;
        match result {
            Err(error)
                if !error
                    .downcast_ref::<GitServiceError>()
                    .is_some_and(|error| {
                        matches!(
                            error.code,
                            Code::GIT_MUTATION_OUTCOME_UNKNOWN | Code::GH_STALE_PULL_REQUEST
                        )
                    }) =>
            {
                Err(GitServiceError::new(Code::GH_MUTATION_REJECTED, error.to_string()).into())
            }
            result => result,
        }
    }

    pub async fn minimize_pull_request_comment(
        &self,
        request: MinimizePullRequestCommentRequest,
        signal: Option<&CancellationToken>,
    ) -> ExecutorResult<PullRequestCommentMinimized> {
        let project = &request.project_path;
        let repository = &request.repository;
        assert_accessible_directory(project).await?;
        resolve_checkout_repository(project, Some(repository), signal).await?;
        let args = |query| {
            vec![
                "api".into(),
                "graphql".into(),
                "--hostname".into(),
                repository.host.clone(),
                "-f".into(),
                format!("id={}", request.comment_id),
                "-f".into(),
                format!("query={query}"),
            ]
        };
        let identity = run_gh_json(
            project,
            args(COMMENT_IDENTITY_QUERY),
            GhCommandOptions::for_signal(signal),
        )
        .await?;
        let data = &identity["data"];
        assert_gh_actor(&require_gh_actor(&data["viewer"])?, &request.actor)?;
        assert_gh_actor(&require_gh_actor(&data["node"]["author"])?, &request.actor)?;
        let repo = &data["node"]["repository"];
        if !gh_repository_identity(text(repo, "nameWithOwner"), text(repo, "url"))
            .is_some_and(|actual| same_gh_repository(&actual, repository))
        {
            return Err(GitServiceError::new(
                Code::GIT_CONFLICT,
                "The comment belongs to another GitHub repository.",
            )
            .into());
        }
        let output = run_gh_mutation(
            project,
            args(MINIMIZE_MUTATION),
            GhCommandOptions::for_signal(signal),
        )
        .await?;
        let raw = parse_gh_json(&output.stdout, "api")?;
        if raw.is_null() {
            return Err(NamedError {
                name: "TypeError".into(),
                code: None,
                message: "null is not an object (evaluating 'raw.data')".into(),
            }
            .into());
        }
        Ok(PullRequestCommentMinimized {
            minimized: raw["data"]["minimizeComment"]["minimizedComment"]["isMinimized"] == true,
        })
    }
}

fn posted_comment(stdout: &str, actor: &GhActorIdentity) -> Option<PullRequestCommentRef> {
    let created = parse_gh_json(stdout, "api").ok()?;
    let id = created["node_id"].as_str()?;
    if id.is_empty() || utf16::len(id) > GH_COMMENT_ID_MAX_LENGTH || id.contains('\0') {
        return None;
    }
    let url = match created.get("html_url") {
        Some(value) => value.as_str()?,
        None => "",
    };
    if created["user"]["node_id"] != actor.id {
        return None;
    }
    Some(PullRequestCommentRef {
        id: id.into(),
        url: url.into(),
    })
}
