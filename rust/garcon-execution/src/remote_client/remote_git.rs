//! Ports `server/remote/client/remote-git.ts`.

use std::{future::Future, pin::pin, rc::Rc, time::Duration};

use async_trait::async_trait;
use garcon_contract::{
    gh::{self, GhMethod, is_gh_mutation},
    git::*,
    git_error::{GitServiceError, GitServiceErrorCode},
    git_execution::{
        ExecutionGhResult, ExecutionGitResult, ExecutionGitReviewDocumentFileBodiesOptions,
        ExecutionStageHunkOptions, ExecutionStageSelectionOptions, GIT_OPERATION_TIMEOUT_MS,
        GitExecutorScope, gh_operation_timeout_ms, is_git_mutation,
    },
    git_request_validation::{validate_gh_request, validate_git_request},
    git_result_validation::{validate_gh_result, validate_git_result},
};
use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome, AgentIntegrationErrorCode},
    git::{ExecutionGhService, ExecutionGitService},
    resources::{ExecutorCallOptions, ExecutorResult},
};
use garcon_js::{Number, json::Opaque};
use garcon_link::{git_protocol::GitCall, rpc_lane::RpcLane, rpc_routing::rpc_lane};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::time::sleep;

use super::{
    sessions::{HeldCallOptions, RemoteSessions},
    wire::{decode, encode, own_rpc_error, unknown_outcome},
};

pub(super) struct RemoteGitServices(pub Rc<RemoteSessions>);

#[derive(Clone, Copy)]
enum Method {
    Git(GitMethod),
    Gh(GhMethod),
}

impl Method {
    fn validate_request(self, request: &Value) -> Result<(), GitServiceError> {
        match self {
            Self::Git(method) => validate_git_request(method, request),
            Self::Gh(method) => validate_gh_request(method, request),
        }
    }

    fn validate_result(
        self,
        result: &Value,
        scope: &GitExecutorScope,
    ) -> Result<(), GitServiceError> {
        match self {
            Self::Git(method) => validate_git_result(method, result, scope),
            Self::Gh(method) => validate_gh_result(method, result, scope),
        }
    }

    fn mutation(self) -> bool {
        match self {
            Self::Git(method) => is_git_mutation(method),
            Self::Gh(method) => is_gh_mutation(method),
        }
    }

    fn timeout_ms(self) -> u64 {
        match self {
            Self::Git(_) => GIT_OPERATION_TIMEOUT_MS,
            Self::Gh(method) => gh_operation_timeout_ms(method),
        }
    }

    fn rpc(self) -> String {
        match self {
            Self::Git(method) => format!("git.{}", method.as_str()),
            Self::Gh(method) => format!("gh.{}", method.as_str()),
        }
    }

    fn uncertain(self) -> GitServiceError {
        let message = match self {
            Self::Git(GitMethod::Push) => {
                "Push could not be confirmed. Inspect the remote before pushing again."
            }
            Self::Git(_) => {
                "Git mutation could not be confirmed. Inspect the repository before trying again."
            }
            Self::Gh(_) => {
                "GitHub change could not be confirmed. Check the pull request before trying again."
            }
        };
        GitServiceError::new(GitServiceErrorCode::GIT_MUTATION_OUTCOME_UNKNOWN, message)
    }
}

impl RemoteGitServices {
    async fn call<R: DeserializeOwned>(
        &self,
        method: Method,
        request: impl Serialize,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<R> {
        let input = encode(request)?;
        method.validate_request(&input)?;
        let services = &self.0.latest()?.info.services;
        let unavailable = match method {
            Method::Git(_) if !services.git => Some("Git is unavailable on this executor"),
            Method::Gh(_) if !services.gh => Some("GitHub CLI is unavailable on this executor"),
            _ => None,
        };
        if let Some(message) = unavailable {
            return Err(AgentCallError::with_code(
                AgentDeliveryOutcome::NotDispatched,
                message,
                AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
            )
            .into());
        }
        let result = with_deadline(options, method.timeout_ms(), |options| {
            self.call_on_lane(method, input, options)
        })
        .await;
        let reply = match result {
            Ok(reply) => reply,
            Err(error)
                if method.mutation()
                    && (unknown_outcome(error.as_ref())
                        || error
                            .downcast_ref::<GitServiceError>()
                            .is_some_and(|error| {
                                error.code == GitServiceErrorCode::GIT_INVALID_RESULT
                            })) =>
            {
                return Err(method.uncertain().into());
            }
            Err(error) => return Err(error),
        };
        decode(reply.as_ref())
    }

    async fn call_on_lane(
        &self,
        method: Method,
        input: Opaque,
        options: HeldCallOptions,
    ) -> ExecutorResult<Option<Opaque>> {
        let rpc_method = method.rpc();
        let lane = rpc_lane(&rpc_method, &input, RpcLane::Primary)?;
        let held = self.0.acquire(lane, &options).await?;
        let budget_ms = held.timeout_ms.unwrap_or(method.timeout_ms() as f64);
        let request = encode(GitCall {
            input,
            budget_ms: Number(budget_ms),
        })?;
        let reply = held
            .backing
            .rpc
            .call("", &rpc_method, request, held.rpc_options(&options))
            .await
            .map_err(own_rpc_error)
            .map_err(|error| {
                if !method.mutation()
                    && options
                        .signal
                        .as_ref()
                        .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
                    && unknown_outcome(error.as_ref())
                {
                    GitServiceError::new(
                        GitServiceErrorCode::GIT_TIMEOUT,
                        "Git operation expired or was cancelled",
                    )
                    .into()
                } else {
                    error
                }
            })?;
        method.validate_result(
            reply.as_deref().unwrap_or(&Value::Null),
            &GitExecutorScope {
                executor_id: held.backing.info.executor_id.clone(),
                instance_id: held.backing.info.instance_id.clone(),
            },
        )?;
        Ok(reply)
    }
}

async fn with_deadline<T, F: Future<Output = ExecutorResult<T>>>(
    options: Option<ExecutorCallOptions>,
    maximum: u64,
    operation: impl FnOnce(HeldCallOptions) -> F,
) -> ExecutorResult<T> {
    let explicit = options
        .as_ref()
        .and_then(|options| options.timeout_ms)
        .unwrap_or(maximum as f64);
    let mut options = HeldCallOptions::from(options);
    let timeout_ms = explicit.clamp(1.0, maximum as f64);
    let signal = options
        .signal
        .take()
        .map_or_else(Default::default, |signal| signal.child_token());
    options.signal = Some(signal.clone());
    options.timeout_ms = Some(timeout_ms);
    let mut result = pin!(operation(options));
    let delay = Duration::from_millis(if timeout_ms.is_nan() {
        1
    } else {
        timeout_ms as u64
    });
    tokio::select! {
        biased;
        result = &mut result => result,
        () = sleep(delay) => {
            signal.cancel();
            result.await
        }
    }
}

macro_rules! remote_git {
    ($($name:ident($request:ty) -> $result:ty = $method:ident);+ $(;)?) => {
        #[async_trait(?Send)]
        impl ExecutionGitService for RemoteGitServices {
            $(async fn $name(&self, request: $request, options: Option<ExecutorCallOptions>) -> ExecutorResult<ExecutionGitResult<$result>> {
                self.call(Method::Git(GitMethod::$method), request, options).await
            })+
        }
    };
}

remote_git! {
    get_status(ProjectOptions) -> GitStatus = GetStatus;
    initial_commit(ProjectOptions) -> GitMutationResult = InitialCommit;
    commit(CommitOptions) -> GitCommitResult = Commit;
    get_branches(ProjectOptions) -> GitBranchesResult = GetBranches;
    get_refs(GitRefsOptions) -> GitRefsResponse = GetRefs;
    checkout(CheckoutOptions) -> GitMutationResult = Checkout;
    create_branch(BranchOptions) -> GitMutationResult = CreateBranch;
    get_remote_status(ProjectOptions) -> GitRemoteStatus = GetRemoteStatus;
    get_remotes(ProjectOptions) -> GitRemotesResult = GetRemotes;
    fetch(ProjectOptions) -> GitMutationResult = Fetch;
    pull(ProjectOptions) -> GitMutationResult = Pull;
    push(PushOptions) -> GitMutationResult = Push;
    discard(FileOptions) -> GitMutationResult = Discard;
    delete_untracked(FileOptions) -> GitMutationResult = DeleteUntracked;
    get_workbench_snapshot(GitWorkbenchSnapshotOptions) -> GitWorkbenchSnapshotResponse = GetWorkbenchSnapshot;
    get_working_tree_fingerprint(GitWorkingTreeFingerprintOptions) -> GitWorkingTreeFingerprintResponse = GetWorkingTreeFingerprint;
    get_quick_summary(GitQuickSummaryOptions) -> GitQuickSummaryResponse = GetQuickSummary;
    get_review_document_file_bodies(ExecutionGitReviewDocumentFileBodiesOptions) -> GitReviewDocumentFileBodiesResponse = GetReviewDocumentFileBodies;
    get_history_commits(GitHistoryCommitListOptions) -> GitHistoryCommitListResponse = GetHistoryCommits;
    get_commit_snapshot(GitCommitSnapshotOptions) -> GitCommitSnapshotResponse = GetCommitSnapshot;
    get_comparison_snapshot(GitComparisonSnapshotOptions) -> GitComparisonSnapshotResponse = GetComparisonSnapshot;
    get_comparison_freshness(GitComparisonFreshnessOptions) -> GitComparisonFreshnessResponse = GetComparisonFreshness;
    stage_selection(ExecutionStageSelectionOptions) -> GitMutationResult = StageSelection;
    stage_hunk(ExecutionStageHunkOptions) -> GitMutationResult = StageHunk;
    get_conflicts(ProjectOptions) -> GitConflictsResult = GetConflicts;
    get_conflict_details(ConflictDetailsOptions) -> GitConflictDetails = GetConflictDetails;
    accept_conflict_side(ConflictAcceptOptions) -> GitMutationResult = AcceptConflictSide;
    mark_conflict_resolved(FileOptions) -> GitMutationResult = MarkConflictResolved;
    get_stashes(ProjectOptions) -> GitStashesResult = GetStashes;
    create_stash(StashCreateOptions) -> GitMutationResult = CreateStash;
    apply_stash(StashRefOptions) -> GitMutationResult = ApplyStash;
    pop_stash(StashRefOptions) -> GitMutationResult = PopStash;
    drop_stash(StashRefOptions) -> GitMutationResult = DropStash;
    get_file_history(FileHistoryOptions) -> GitFileHistoryResult = GetFileHistory;
    get_blame(BlameOptions) -> GitBlameResult = GetBlame;
    get_graph(GraphOptions) -> GitGraphResult = GetGraph;
    get_repo_info(ProjectOptions) -> RepoInfo = GetRepoInfo;
    get_worktrees(ProjectOptions) -> GitWorktreesResult = GetWorktrees;
    get_target_candidates(ProjectOptions) -> GitTargetCandidatesResult = GetTargetCandidates;
    create_worktree(CreateWorktreeOptions) -> GitMutationResult = CreateWorktree;
    remove_worktree(RemoveWorktreeOptions) -> GitMutationResult = RemoveWorktree;
    commit_index(CommitIndexOptions) -> GitMutationResult = CommitIndex;
    stage_paths(StagePathsOptions) -> GitMutationResult = StagePaths;
    revert_commit(RevertCommitOptions) -> GitMutationResult = RevertCommit;
    collect_commit_message_context(CommitMessageContextOptions) -> GitCommitMessageContextResult = CollectCommitMessageContext;
}

macro_rules! remote_gh {
    ($($name:ident($request:ty) -> $result:ty = $method:ident);+ $(;)?) => {
        #[async_trait(?Send)]
        impl ExecutionGhService for RemoteGitServices {
            async fn get_status(&self, options: Option<ExecutorCallOptions>) -> ExecutorResult<ExecutionGhResult<gh::GhStatusResponse>> {
                self.call(Method::Gh(GhMethod::GetStatus), json!({}), options).await
            }

            $(async fn $name(&self, request: $request, options: Option<ExecutorCallOptions>) -> ExecutorResult<ExecutionGhResult<$result>> {
                self.call(Method::Gh(GhMethod::$method), request, options).await
            })+
        }
    };
}

remote_gh! {
    list_pull_requests(gh::ListPullRequestsRequest) -> gh::PullRequestListResult = ListPullRequests;
    get_pull_request(gh::GetPullRequestRequest) -> gh::PullRequestDetail = GetPullRequest;
    get_pull_request_review_target(gh::GetPullRequestReviewTargetRequest) -> gh::PullRequestReviewTarget = GetPullRequestReviewTarget;
    create_pull_request_comment(gh::CreatePullRequestCommentRequest) -> gh::PullRequestCommentRef = CreatePullRequestComment;
    minimize_pull_request_comment(gh::MinimizePullRequestCommentRequest) -> gh::PullRequestCommentMinimized = MinimizePullRequestComment;
}
