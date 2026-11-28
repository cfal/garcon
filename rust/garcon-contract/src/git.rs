//! Ports `common/git.ts`.
//!
//! The documents the Git calls request and return are not ported yet; this
//! holds the calls, their limits, and the fingerprint version.

use serde::{Deserialize, Serialize};

/// The limits of a rendered diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GitDiffLimits {
    pub max_batch_files: usize,
    pub max_context_lines: usize,
    pub max_patch_bytes: usize,
    pub max_rendered_rows: usize,
    pub max_line_bytes: usize,
}

pub const GIT_DIFF_LIMITS: GitDiffLimits = GitDiffLimits {
    max_batch_files: 64,
    max_context_lines: 50,
    max_patch_bytes: 1_000_000,
    max_rendered_rows: 20_000,
    max_line_bytes: 20_000,
};

/// The limits of a review document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GitReviewDocumentLimits {
    pub max_summary_files: usize,
    pub max_body_batch_files: usize,
    pub max_loaded_rows: usize,
    pub max_loaded_patch_bytes: usize,
    pub max_file_rows: usize,
    pub max_file_patch_bytes: usize,
    pub max_line_bytes: usize,
    pub max_context_lines: usize,
    pub body_concurrency: usize,
}

pub const GIT_REVIEW_DOCUMENT_LIMITS: GitReviewDocumentLimits = GitReviewDocumentLimits {
    max_summary_files: 10_000,
    max_body_batch_files: 24,
    max_loaded_rows: 100_000,
    max_loaded_patch_bytes: 10_000_000,
    max_file_rows: 50_000,
    max_file_patch_bytes: 5_000_000,
    max_line_bytes: GIT_DIFF_LIMITS.max_line_bytes,
    max_context_lines: GIT_DIFF_LIMITS.max_context_lines,
    body_concurrency: 4,
};

pub const GIT_WORKING_TREE_FINGERPRINT_VERSION: u8 = 1;

/// One Git call, named as the Git routes and the executor link name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitMethod {
    GetStatus,
    InitialCommit,
    Commit,
    GetBranches,
    GetRefs,
    Checkout,
    CreateBranch,
    GetRemoteStatus,
    GetRemotes,
    Fetch,
    Pull,
    Push,
    Discard,
    DeleteUntracked,
    GetWorkbenchSnapshot,
    GetWorkingTreeFingerprint,
    GetQuickSummary,
    GetReviewDocumentFileBodies,
    GetHistoryCommits,
    GetCommitSnapshot,
    GetComparisonSnapshot,
    GetComparisonFreshness,
    StageSelection,
    StageHunk,
    GetConflicts,
    GetConflictDetails,
    AcceptConflictSide,
    MarkConflictResolved,
    GetStashes,
    CreateStash,
    ApplyStash,
    PopStash,
    DropStash,
    GetFileHistory,
    GetBlame,
    GetGraph,
    GetRepoInfo,
    GetWorktrees,
    GetTargetCandidates,
    CreateWorktree,
    RemoveWorktree,
    CommitIndex,
    StagePaths,
    RevertCommit,
    CollectCommitMessageContext,
}

/// Every Git call, in the order the original lists them.
pub const GIT_METHODS: &[GitMethod] = &[
    GitMethod::GetStatus,
    GitMethod::InitialCommit,
    GitMethod::Commit,
    GitMethod::GetBranches,
    GitMethod::GetRefs,
    GitMethod::Checkout,
    GitMethod::CreateBranch,
    GitMethod::GetRemoteStatus,
    GitMethod::GetRemotes,
    GitMethod::Fetch,
    GitMethod::Pull,
    GitMethod::Push,
    GitMethod::Discard,
    GitMethod::DeleteUntracked,
    GitMethod::GetWorkbenchSnapshot,
    GitMethod::GetWorkingTreeFingerprint,
    GitMethod::GetQuickSummary,
    GitMethod::GetReviewDocumentFileBodies,
    GitMethod::GetHistoryCommits,
    GitMethod::GetCommitSnapshot,
    GitMethod::GetComparisonSnapshot,
    GitMethod::GetComparisonFreshness,
    GitMethod::StageSelection,
    GitMethod::StageHunk,
    GitMethod::GetConflicts,
    GitMethod::GetConflictDetails,
    GitMethod::AcceptConflictSide,
    GitMethod::MarkConflictResolved,
    GitMethod::GetStashes,
    GitMethod::CreateStash,
    GitMethod::ApplyStash,
    GitMethod::PopStash,
    GitMethod::DropStash,
    GitMethod::GetFileHistory,
    GitMethod::GetBlame,
    GitMethod::GetGraph,
    GitMethod::GetRepoInfo,
    GitMethod::GetWorktrees,
    GitMethod::GetTargetCandidates,
    GitMethod::CreateWorktree,
    GitMethod::RemoveWorktree,
    GitMethod::CommitIndex,
    GitMethod::StagePaths,
    GitMethod::RevertCommit,
    GitMethod::CollectCommitMessageContext,
];

impl GitMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            GitMethod::GetStatus => "getStatus",
            GitMethod::InitialCommit => "initialCommit",
            GitMethod::Commit => "commit",
            GitMethod::GetBranches => "getBranches",
            GitMethod::GetRefs => "getRefs",
            GitMethod::Checkout => "checkout",
            GitMethod::CreateBranch => "createBranch",
            GitMethod::GetRemoteStatus => "getRemoteStatus",
            GitMethod::GetRemotes => "getRemotes",
            GitMethod::Fetch => "fetch",
            GitMethod::Pull => "pull",
            GitMethod::Push => "push",
            GitMethod::Discard => "discard",
            GitMethod::DeleteUntracked => "deleteUntracked",
            GitMethod::GetWorkbenchSnapshot => "getWorkbenchSnapshot",
            GitMethod::GetWorkingTreeFingerprint => "getWorkingTreeFingerprint",
            GitMethod::GetQuickSummary => "getQuickSummary",
            GitMethod::GetReviewDocumentFileBodies => "getReviewDocumentFileBodies",
            GitMethod::GetHistoryCommits => "getHistoryCommits",
            GitMethod::GetCommitSnapshot => "getCommitSnapshot",
            GitMethod::GetComparisonSnapshot => "getComparisonSnapshot",
            GitMethod::GetComparisonFreshness => "getComparisonFreshness",
            GitMethod::StageSelection => "stageSelection",
            GitMethod::StageHunk => "stageHunk",
            GitMethod::GetConflicts => "getConflicts",
            GitMethod::GetConflictDetails => "getConflictDetails",
            GitMethod::AcceptConflictSide => "acceptConflictSide",
            GitMethod::MarkConflictResolved => "markConflictResolved",
            GitMethod::GetStashes => "getStashes",
            GitMethod::CreateStash => "createStash",
            GitMethod::ApplyStash => "applyStash",
            GitMethod::PopStash => "popStash",
            GitMethod::DropStash => "dropStash",
            GitMethod::GetFileHistory => "getFileHistory",
            GitMethod::GetBlame => "getBlame",
            GitMethod::GetGraph => "getGraph",
            GitMethod::GetRepoInfo => "getRepoInfo",
            GitMethod::GetWorktrees => "getWorktrees",
            GitMethod::GetTargetCandidates => "getTargetCandidates",
            GitMethod::CreateWorktree => "createWorktree",
            GitMethod::RemoveWorktree => "removeWorktree",
            GitMethod::CommitIndex => "commitIndex",
            GitMethod::StagePaths => "stagePaths",
            GitMethod::RevertCommit => "revertCommit",
            GitMethod::CollectCommitMessageContext => "collectCommitMessageContext",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_call_keeps_its_name_on_the_wire() {
        assert_eq!(GIT_METHODS.len(), 45);
        for method in GIT_METHODS {
            assert_eq!(json!(method), json!(method.as_str()), "{method:?}");
            assert_eq!(
                serde_json::from_value::<GitMethod>(json!(method.as_str())).unwrap(),
                *method
            );
        }
        assert_eq!(
            GitMethod::GetComparisonFreshness.as_str(),
            "getComparisonFreshness"
        );
        assert!(serde_json::from_value::<GitMethod>(json!("getStatus ")).is_err());
    }

    #[test]
    fn review_limits_share_the_diff_limits() {
        assert_eq!(
            GIT_REVIEW_DOCUMENT_LIMITS.max_line_bytes,
            GIT_DIFF_LIMITS.max_line_bytes
        );
        assert_eq!(
            GIT_REVIEW_DOCUMENT_LIMITS.max_context_lines,
            GIT_DIFF_LIMITS.max_context_lines
        );
        assert_eq!(GIT_DIFF_LIMITS.max_batch_files, 64);
        assert_eq!(GIT_REVIEW_DOCUMENT_LIMITS.body_concurrency, 4);
        assert_eq!(GIT_WORKING_TREE_FINGERPRINT_VERSION, 1);
    }
}
