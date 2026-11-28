//! Ports `server/remote/server/git-rpc-server.ts`.

use std::rc::Rc;

use garcon_contract::{
    gh::GhMethod,
    git::GitMethod,
    git_error::{GitServiceError, GitServiceErrorCode},
    git_execution::{GIT_OPERATION_TIMEOUT_MS, gh_operation_timeout_ms},
    git_request_validation::{
        is_gh_method, is_git_method, validate_gh_request, validate_git_request,
    },
};
use garcon_interface::{execution_runtime::ExecutionRuntimeApi, resources::ExecutorCallOptions};
use garcon_js::{
    is_safe_integer,
    json::{self, as_number},
};
use garcon_link::{
    message_session::SessionError, rpc::RpcResult, rpc_protocol::ExecutorRpcRequest,
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::executor_rpc_server::{reply, shared_error};

pub(crate) struct GitRpcServer {
    executor: Rc<dyn ExecutionRuntimeApi>,
}

impl GitRpcServer {
    pub(crate) fn new(executor: Rc<dyn ExecutionRuntimeApi>) -> Self {
        Self { executor }
    }

    pub(crate) async fn handle(
        &self,
        call: &ExecutorRpcRequest,
        signal: CancellationToken,
    ) -> RpcResult {
        let gh = call.method.strip_prefix("gh.");
        let gh_method = gh.and_then(|method| is_gh_method(&Value::String(method.into())));
        let maximum = gh_method.map_or(GIT_OPERATION_TIMEOUT_MS, gh_operation_timeout_ms);
        let (input, budget_ms) = deadline(&call.request, maximum).map_err(shared_error)?;
        let options = Some(ExecutorCallOptions {
            signal: Some(signal),
            timeout_ms: Some(budget_ms),
            ..Default::default()
        });
        if gh.is_some() {
            let method =
                gh_method.ok_or_else(|| shared_error(invalid("Unsupported GitHub operation")))?;
            let service = self
                .executor
                .get_gh_service(options.clone())
                .await
                .map_err(Rc::from)?;
            validate_gh_request(method, input).map_err(shared_error)?;
            return match method {
                GhMethod::GetStatus => reply(service.get_status(options).await),
                GhMethod::ListPullRequests => reply(
                    service
                        .list_pull_requests(
                            typed_request("GitHub", method.as_str(), input)?,
                            options,
                        )
                        .await,
                ),
                GhMethod::GetPullRequest => reply(
                    service
                        .get_pull_request(typed_request("GitHub", method.as_str(), input)?, options)
                        .await,
                ),
                GhMethod::GetPullRequestReviewTarget => reply(
                    service
                        .get_pull_request_review_target(
                            typed_request("GitHub", method.as_str(), input)?,
                            options,
                        )
                        .await,
                ),
                GhMethod::CreatePullRequestComment => reply(
                    service
                        .create_pull_request_comment(
                            typed_request("GitHub", method.as_str(), input)?,
                            options,
                        )
                        .await,
                ),
                GhMethod::MinimizePullRequestComment => reply(
                    service
                        .minimize_pull_request_comment(
                            typed_request("GitHub", method.as_str(), input)?,
                            options,
                        )
                        .await,
                ),
            };
        }
        let method = call
            .method
            .strip_prefix("git.")
            .and_then(|method| is_git_method(&Value::String(method.into())))
            .ok_or_else(|| shared_error(invalid("Unsupported Git operation")))?;
        validate_git_request(method, input).map_err(shared_error)?;
        let service = self
            .executor
            .get_git_service(options.clone())
            .await
            .map_err(Rc::from)?;
        macro_rules! dispatch {
            ($($variant:ident => $service_method:ident),+ $(,)?) => {
                match method {
                    $(GitMethod::$variant => {
                        let request = typed_request("Git", method.as_str(), input)?;
                        reply(service.$service_method(request, options).await)
                    })+
                }
            };
        }
        dispatch! {
            GetStatus => get_status,
            InitialCommit => initial_commit,
            Commit => commit,
            GetBranches => get_branches,
            GetRefs => get_refs,
            Checkout => checkout,
            CreateBranch => create_branch,
            GetRemoteStatus => get_remote_status,
            GetRemotes => get_remotes,
            Fetch => fetch,
            Pull => pull,
            Push => push,
            Discard => discard,
            DeleteUntracked => delete_untracked,
            GetWorkbenchSnapshot => get_workbench_snapshot,
            GetWorkingTreeFingerprint => get_working_tree_fingerprint,
            GetQuickSummary => get_quick_summary,
            GetReviewDocumentFileBodies => get_review_document_file_bodies,
            GetHistoryCommits => get_history_commits,
            GetCommitSnapshot => get_commit_snapshot,
            GetComparisonSnapshot => get_comparison_snapshot,
            GetComparisonFreshness => get_comparison_freshness,
            StageSelection => stage_selection,
            StageHunk => stage_hunk,
            GetConflicts => get_conflicts,
            GetConflictDetails => get_conflict_details,
            AcceptConflictSide => accept_conflict_side,
            MarkConflictResolved => mark_conflict_resolved,
            GetStashes => get_stashes,
            CreateStash => create_stash,
            ApplyStash => apply_stash,
            PopStash => pop_stash,
            DropStash => drop_stash,
            GetFileHistory => get_file_history,
            GetBlame => get_blame,
            GetGraph => get_graph,
            GetRepoInfo => get_repo_info,
            GetWorktrees => get_worktrees,
            GetTargetCandidates => get_target_candidates,
            CreateWorktree => create_worktree,
            RemoveWorktree => remove_worktree,
            CommitIndex => commit_index,
            StagePaths => stage_paths,
            RevertCommit => revert_commit,
            CollectCommitMessageContext => collect_commit_message_context,
        }
    }
}

fn invalid(message: impl Into<String>) -> GitServiceError {
    GitServiceError::new(GitServiceErrorCode::GIT_INVALID_INPUT, message)
}

fn deadline(request: &Value, maximum: u64) -> Result<(&Value, f64), GitServiceError> {
    let bad = || invalid("Invalid Git operation deadline");
    let fields = request
        .as_object()
        .filter(|fields| {
            fields
                .keys()
                .all(|key| matches!(key.as_str(), "input" | "budgetMs"))
        })
        .ok_or_else(bad)?;
    let input = fields
        .get("input")
        .filter(|input| input.is_object())
        .ok_or_else(bad)?;
    let budget = fields
        .get("budgetMs")
        .and_then(as_number)
        .filter(|budget| is_safe_integer(*budget) && *budget > 0.0 && *budget <= maximum as f64)
        .ok_or_else(bad)?;
    Ok((input, budget))
}

fn typed_request<T: DeserializeOwned>(
    service: &str,
    method: &str,
    input: &Value,
) -> Result<T, SessionError> {
    // The opaque input stores JavaScript numbers as doubles; the wire form restores integers.
    json::from_str(&json::stringify(input))
        .map_err(|_| shared_error(invalid(format!("Invalid {service} {method} request"))))
}

#[cfg(test)]
mod tests;
