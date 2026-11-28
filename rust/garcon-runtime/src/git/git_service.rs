//! Composes executor-local Git operations, as in server/runtime/git/git-service.ts.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_contract::git::*;
use garcon_contract::git_execution::{
    ExecutionGitResult, ExecutionGitReviewDocumentFileBodiesOptions, ExecutionStageHunkOptions,
    ExecutionStageSelectionOptions,
};
use garcon_interface::git::ExecutionGitService;
use garcon_interface::resources::{ExecutorCallOptions, ExecutorResult};

use super::comparison::ComparisonOperations;
use super::diff_engine::{DiffEngine, not_repository_snapshot};
use super::quick_summary::{get_quick_summary, not_repository_quick_summary};
use super::review_document_registry::GitReviewDocumentRegistry;
use super::review_document_service::GitReviewDocumentOperations;
use super::runtime::GitRuntime;
use super::temporary_index::TemporaryGitIndexEnvironment;
use super::working_tree_observation::{get_working_tree_fingerprint, not_repository_fingerprint};
use super::worktrees::{self, ProjectPathAllowed, WorktreeOperations};
use super::{commit_history, conflicts, discard, file_history, stashes, status};

pub(super) struct GitOperations {
    registry: Rc<GitReviewDocumentRegistry>,
    diff: DiffEngine,
    comparisons: ComparisonOperations,
    documents: GitReviewDocumentOperations,
    worktrees: WorktreeOperations,
    pub(super) temporary_index: TemporaryGitIndexEnvironment,
}

impl GitOperations {
    pub(super) fn new(
        registry: Option<Rc<GitReviewDocumentRegistry>>,
        boundary: Rc<dyn ProjectPathAllowed>,
    ) -> Self {
        let registry =
            registry.unwrap_or_else(|| Rc::new(GitReviewDocumentRegistry::new(Default::default())));
        Self {
            diff: DiffEngine::new(registry.clone()),
            comparisons: ComparisonOperations::new(registry.clone(), Some(boundary.clone())),
            documents: GitReviewDocumentOperations::new(registry.clone()),
            worktrees: WorktreeOperations {
                assert_project_path_allowed: Some(boundary),
                ..Default::default()
            },
            temporary_index: TemporaryGitIndexEnvironment::default(),
            registry,
        }
    }
}

macro_rules! methods {
    ($( $name:ident($request:ty) -> $result:ty = $method:ident, $fallback:expr,
        |$ops:ident, $r:ident, $c:ident| $call:block; )+) => {
        #[async_trait(?Send)]
        impl ExecutionGitService for GitRuntime {
            $(
                async fn $name(
                    &self, request: $request, options: Option<ExecutorCallOptions>,
                ) -> ExecutorResult<ExecutionGitResult<$result>> {
                    self.invoke(
                        GitMethod::$method, request, options, $fallback,
                        async |$ops, $r, $c| $call,
                    ).await
                }
            )+
        }
    };
}

methods! {
    get_status(ProjectOptions) -> GitStatus = GetStatus, None, |_ops, r, _c| {
        status::get_status(&r.project_path).await
    };
    initial_commit(ProjectOptions) -> GitMutationResult = InitialCommit, None, |_ops, r, _c| {
        status::initial_commit(&r.project_path).await
    };
    commit(CommitOptions) -> GitCommitResult = Commit, None, |ops, r, _c| {
        status::commit(&r, &ops.temporary_index).await
    };
    get_branches(ProjectOptions) -> GitBranchesResult = GetBranches, None, |_ops, r, c| {
        status::get_branches(&r.project_path, c.signal).await
    };
    get_refs(GitRefsOptions) -> GitRefsResponse = GetRefs, None, |_ops, r, c| {
        status::get_refs(&r, c.signal).await
    };
    checkout(CheckoutOptions) -> GitMutationResult = Checkout, None, |_ops, r, c| {
        status::checkout(&r, c.signal).await
    };
    create_branch(BranchOptions) -> GitMutationResult = CreateBranch, None, |_ops, r, c| {
        status::create_branch(&r, c.signal).await
    };
    get_remote_status(ProjectOptions) -> GitRemoteStatus = GetRemoteStatus, None, |_ops, r, _c| {
        status::get_remote_status(&r.project_path).await
    };
    get_remotes(ProjectOptions) -> GitRemotesResult = GetRemotes, None, |_ops, r, _c| {
        status::get_remotes(&r.project_path).await
    };
    fetch(ProjectOptions) -> GitMutationResult = Fetch, None, |_ops, r, _c| {
        status::fetch(&r.project_path).await
    };
    pull(ProjectOptions) -> GitMutationResult = Pull, None, |_ops, r, _c| {
        status::pull(&r.project_path).await
    };
    push(PushOptions) -> GitMutationResult = Push, None, |_ops, r, _c| {
        status::push(&r).await
    };
    discard(FileOptions) -> GitMutationResult = Discard, None, |_ops, r, _c| {
        discard::discard(&r).await
    };
    delete_untracked(FileOptions) -> GitMutationResult = DeleteUntracked, None, |_ops, r, _c| {
        status::delete_untracked(&r).await
    };
    get_workbench_snapshot(GitWorkbenchSnapshotOptions) -> GitWorkbenchSnapshotResponse = GetWorkbenchSnapshot,
        Some(not_repository_snapshot), |ops, r, c| {
        ops.diff.get_workbench_snapshot(&r, c).await
    };
    get_working_tree_fingerprint(GitWorkingTreeFingerprintOptions) -> GitWorkingTreeFingerprintResponse = GetWorkingTreeFingerprint,
        Some(not_repository_fingerprint), |_ops, r, c| {
        get_working_tree_fingerprint(&r.project_path, c.trace, c.signal).await
    };
    get_quick_summary(GitQuickSummaryOptions) -> GitQuickSummaryResponse = GetQuickSummary,
        Some(not_repository_quick_summary), |_ops, r, c| {
        get_quick_summary(&r.project_path, c.trace, c.signal).await
    };
    get_review_document_file_bodies(ExecutionGitReviewDocumentFileBodiesOptions) -> GitReviewDocumentFileBodiesResponse =
        GetReviewDocumentFileBodies, None, |ops, r, c| {
        ops.documents.get_review_document_file_bodies(&GitReviewDocumentFileBodiesOptions {
            project_path: r.project_path, document_id: r.document.document_id, files: r.files, purpose: r.purpose,
        }, c).await
    };
    get_history_commits(GitHistoryCommitListOptions) -> GitHistoryCommitListResponse = GetHistoryCommits, None, |_ops, r, c| {
        commit_history::get_history_commits(&r, c.trace, c.signal).await
    };
    get_commit_snapshot(GitCommitSnapshotOptions) -> GitCommitSnapshotResponse = GetCommitSnapshot, None, |ops, r, c| {
        commit_history::get_commit_snapshot(&r, &ops.registry, c.trace, c.metrics, c.signal).await
    };
    get_comparison_snapshot(GitComparisonSnapshotOptions) -> GitComparisonSnapshotResponse = GetComparisonSnapshot, None, |ops, r, c| {
        ops.comparisons.get_comparison_snapshot(&r, c).await
    };
    get_comparison_freshness(GitComparisonFreshnessOptions) -> GitComparisonFreshnessResponse = GetComparisonFreshness, None, |ops, r, c| {
        ops.comparisons.get_comparison_freshness(&r, c).await
    };
    stage_selection(ExecutionStageSelectionOptions) -> GitMutationResult = StageSelection, None, |ops, r, c| {
        ops.diff.stage_selection(&r, c).await
    };
    stage_hunk(ExecutionStageHunkOptions) -> GitMutationResult = StageHunk, None, |ops, r, c| {
        ops.diff.stage_hunk(&r, c).await
    };
    get_conflicts(ProjectOptions) -> GitConflictsResult = GetConflicts, None, |_ops, r, c| {
        conflicts::get_conflicts(&r.project_path, c.signal).await
    };
    get_conflict_details(ConflictDetailsOptions) -> GitConflictDetails = GetConflictDetails, None, |_ops, r, c| {
        conflicts::get_conflict_details(&r, c.signal).await
    };
    accept_conflict_side(ConflictAcceptOptions) -> GitMutationResult = AcceptConflictSide, None, |_ops, r, c| {
        conflicts::accept_conflict_side(&r, c.signal).await
    };
    mark_conflict_resolved(FileOptions) -> GitMutationResult = MarkConflictResolved, None, |_ops, r, c| {
        conflicts::mark_conflict_resolved(&r, c.signal).await
    };
    get_stashes(ProjectOptions) -> GitStashesResult = GetStashes, None, |_ops, r, c| {
        stashes::get_stashes(&r.project_path, c.signal.cloned()).await
    };
    create_stash(StashCreateOptions) -> GitMutationResult = CreateStash, None, |_ops, r, c| {
        stashes::create_stash(&r, c.signal.cloned()).await
    };
    apply_stash(StashRefOptions) -> GitMutationResult = ApplyStash, None, |_ops, r, c| {
        stashes::apply_stash(&r, c.signal.cloned()).await
    };
    pop_stash(StashRefOptions) -> GitMutationResult = PopStash, None, |_ops, r, c| {
        stashes::pop_stash(&r, c.signal.cloned()).await
    };
    drop_stash(StashRefOptions) -> GitMutationResult = DropStash, None, |_ops, r, c| {
        stashes::drop_stash(&r, c.signal.cloned()).await
    };
    get_file_history(FileHistoryOptions) -> GitFileHistoryResult = GetFileHistory, None, |_ops, r, c| {
        file_history::get_file_history(&r, c.signal.cloned()).await
    };
    get_blame(BlameOptions) -> GitBlameResult = GetBlame, None, |_ops, r, c| {
        file_history::get_blame(&r, c.signal.cloned()).await
    };
    get_graph(GraphOptions) -> GitGraphResult = GetGraph, None, |_ops, r, c| {
        file_history::get_graph(&r, c.signal.cloned()).await
    };
    get_repo_info(ProjectOptions) -> RepoInfo = GetRepoInfo, None, |_ops, r, _c| {
        Ok(worktrees::get_repo_info(&r.project_path).await)
    };
    get_worktrees(ProjectOptions) -> GitWorktreesResult = GetWorktrees, None, |ops, r, c| {
        let mut trace = Vec::new();
        let result = ops.worktrees.get_worktrees(&r.project_path, c.trace.map(|_| &mut trace)).await;
        if let Some(output) = c.trace { output.borrow_mut().extend(trace); }
        result
    };
    get_target_candidates(ProjectOptions) -> GitTargetCandidatesResult = GetTargetCandidates, None, |ops, r, c| {
        let mut trace = Vec::new();
        let result = ops.worktrees.get_target_candidates(&r.project_path, c.trace.map(|_| &mut trace)).await;
        if let Some(output) = c.trace { output.borrow_mut().extend(trace); }
        result
    };
    create_worktree(CreateWorktreeOptions) -> GitMutationResult = CreateWorktree, None, |_ops, r, _c| {
        worktrees::create_worktree(&r).await
    };
    remove_worktree(RemoveWorktreeOptions) -> GitMutationResult = RemoveWorktree, None, |_ops, r, _c| {
        worktrees::remove_worktree(&r).await
    };
    commit_index(CommitIndexOptions) -> GitMutationResult = CommitIndex, None, |_ops, r, _c| {
        status::commit_index(&r).await
    };
    stage_paths(StagePathsOptions) -> GitMutationResult = StagePaths, None, |_ops, r, _c| {
        status::stage_paths(&r).await
    };
    revert_commit(RevertCommitOptions) -> GitMutationResult = RevertCommit, None, |_ops, r, _c| {
        status::revert_commit(&r).await
    };
    collect_commit_message_context(CommitMessageContextOptions) -> GitCommitMessageContextResult =
        CollectCommitMessageContext, None, |_ops, r, c| {
        status::collect_commit_message_context(&r, c.signal).await
    };
}
