//! Ports `server-agents/interface/src/contracts/git.ts`.

use async_trait::async_trait;
use garcon_contract::gh::{self, GhStatusResponse};
use garcon_contract::git::*;
use garcon_contract::git_execution::{
    ExecutionGhResult, ExecutionGitResult, ExecutionGitReviewDocumentFileBodiesOptions,
    ExecutionStageHunkOptions, ExecutionStageSelectionOptions,
};

use crate::resources::{ExecutorCallOptions, ExecutorResult};

macro_rules! git_service {
    ($($method:ident($request:ty) -> $result:ty);+ $(;)?) => {
        #[async_trait(?Send)]
        pub trait ExecutionGitService {
            $(async fn $method(
                &self, request: $request, options: Option<ExecutorCallOptions>,
            ) -> ExecutorResult<ExecutionGitResult<$result>>;)+
        }
    };
}

git_service! {
    get_status(ProjectOptions) -> GitStatus;
    initial_commit(ProjectOptions) -> GitMutationResult;
    commit(CommitOptions) -> GitCommitResult;
    get_branches(ProjectOptions) -> GitBranchesResult;
    get_refs(GitRefsOptions) -> GitRefsResponse;
    checkout(CheckoutOptions) -> GitMutationResult;
    create_branch(BranchOptions) -> GitMutationResult;
    get_remote_status(ProjectOptions) -> GitRemoteStatus;
    get_remotes(ProjectOptions) -> GitRemotesResult;
    fetch(ProjectOptions) -> GitMutationResult;
    pull(ProjectOptions) -> GitMutationResult;
    push(PushOptions) -> GitMutationResult;
    discard(FileOptions) -> GitMutationResult;
    delete_untracked(FileOptions) -> GitMutationResult;
    get_workbench_snapshot(GitWorkbenchSnapshotOptions) -> GitWorkbenchSnapshotResponse;
    get_working_tree_fingerprint(GitWorkingTreeFingerprintOptions) -> GitWorkingTreeFingerprintResponse;
    get_quick_summary(GitQuickSummaryOptions) -> GitQuickSummaryResponse;
    get_review_document_file_bodies(ExecutionGitReviewDocumentFileBodiesOptions) -> GitReviewDocumentFileBodiesResponse;
    get_history_commits(GitHistoryCommitListOptions) -> GitHistoryCommitListResponse;
    get_commit_snapshot(GitCommitSnapshotOptions) -> GitCommitSnapshotResponse;
    get_comparison_snapshot(GitComparisonSnapshotOptions) -> GitComparisonSnapshotResponse;
    get_comparison_freshness(GitComparisonFreshnessOptions) -> GitComparisonFreshnessResponse;
    stage_selection(ExecutionStageSelectionOptions) -> GitMutationResult;
    stage_hunk(ExecutionStageHunkOptions) -> GitMutationResult;
    get_conflicts(ProjectOptions) -> GitConflictsResult;
    get_conflict_details(ConflictDetailsOptions) -> GitConflictDetails;
    accept_conflict_side(ConflictAcceptOptions) -> GitMutationResult;
    mark_conflict_resolved(FileOptions) -> GitMutationResult;
    get_stashes(ProjectOptions) -> GitStashesResult;
    create_stash(StashCreateOptions) -> GitMutationResult;
    apply_stash(StashRefOptions) -> GitMutationResult;
    pop_stash(StashRefOptions) -> GitMutationResult;
    drop_stash(StashRefOptions) -> GitMutationResult;
    get_file_history(FileHistoryOptions) -> GitFileHistoryResult;
    get_blame(BlameOptions) -> GitBlameResult;
    get_graph(GraphOptions) -> GitGraphResult;
    get_repo_info(ProjectOptions) -> RepoInfo;
    get_worktrees(ProjectOptions) -> GitWorktreesResult;
    get_target_candidates(ProjectOptions) -> GitTargetCandidatesResult;
    create_worktree(CreateWorktreeOptions) -> GitMutationResult;
    remove_worktree(RemoveWorktreeOptions) -> GitMutationResult;
    commit_index(CommitIndexOptions) -> GitMutationResult;
    stage_paths(StagePathsOptions) -> GitMutationResult;
    revert_commit(RevertCommitOptions) -> GitMutationResult;
    collect_commit_message_context(CommitMessageContextOptions) -> GitCommitMessageContextResult;
}

#[async_trait(?Send)]
pub trait ExecutionGhService {
    async fn get_status(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionGhResult<GhStatusResponse>>;
    async fn list_pull_requests(
        &self,
        request: gh::ListPullRequestsRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionGhResult<gh::PullRequestListResult>>;
    async fn get_pull_request(
        &self,
        request: gh::GetPullRequestRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionGhResult<gh::PullRequestDetail>>;
    async fn get_pull_request_review_target(
        &self,
        request: gh::GetPullRequestReviewTargetRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionGhResult<gh::PullRequestReviewTarget>>;
    async fn create_pull_request_comment(
        &self,
        request: gh::CreatePullRequestCommentRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionGhResult<gh::PullRequestCommentRef>>;
    async fn minimize_pull_request_comment(
        &self,
        request: gh::MinimizePullRequestCommentRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionGhResult<gh::PullRequestCommentMinimized>>;
}
