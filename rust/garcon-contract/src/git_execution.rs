//! Ports `common/git-execution.ts`.
use serde::{Deserialize, Serialize};

use crate::gh::{GhMethod, GhResults};
use crate::git::{
    GitCalls, GitMethod, GitRequests, GitResults, GitReviewBodyPurpose, StageHunkOptions,
    StageSelectionOptions,
};
use crate::git_diagnostics::GitOperationDiagnostics;

/// The executor and the instance that ran a Git call.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitExecutorScope {
    pub executor_id: String,
    pub instance_id: String,
}

/// The executor and the project a Git call runs on.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitProjectTarget {
    pub executor_id: String,
    pub project_path: String,
}

/// A review document an executor holds.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewDocumentRef {
    pub executor_id: String,
    pub instance_id: String,
    pub document_id: String,
}

/// What a staged selection must repeat: the document the selection was made
/// on, and the fingerprints of the file body and the patch it was shown in.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSelectionProof {
    pub document: GitReviewDocumentRef,
    pub body_fingerprint: String,
    pub patch_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionGitReviewDocumentFileBodiesOptions {
    pub project_path: String,
    pub files: Vec<String>,
    pub purpose: GitReviewBodyPurpose,
    pub document: GitReviewDocumentRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionStageSelectionOptions {
    #[serde(flatten)]
    pub selection: StageSelectionOptions,
    #[serde(flatten)]
    pub proof: GitSelectionProof,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionStageHunkOptions {
    #[serde(flatten)]
    pub hunk: StageHunkOptions,
    #[serde(flatten)]
    pub proof: GitSelectionProof,
}

pub type ExecutionGitRequests = GitRequests<
    ExecutionGitReviewDocumentFileBodiesOptions,
    ExecutionStageSelectionOptions,
    ExecutionStageHunkOptions,
>;

pub type ExecutionGitCalls = GitCalls<
    ExecutionGitReviewDocumentFileBodiesOptions,
    ExecutionStageSelectionOptions,
    ExecutionStageHunkOptions,
>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecutionGitResult<R> {
    #[serde(flatten)]
    pub result: R,
    #[serde(flatten)]
    pub scope: GitExecutorScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<GitOperationDiagnostics>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecutionGhResult<R> {
    #[serde(flatten)]
    pub result: R,
    #[serde(flatten)]
    pub scope: GitExecutorScope,
}

pub type ExecutionGitResults = ExecutionGitResult<GitResults>;
pub type ExecutionGhResults = ExecutionGhResult<GhResults>;

/// The Git calls that change the repository.
pub const GIT_MUTATIONS: &[GitMethod] = &[
    GitMethod::InitialCommit,
    GitMethod::Commit,
    GitMethod::Checkout,
    GitMethod::CreateBranch,
    GitMethod::Fetch,
    GitMethod::Pull,
    GitMethod::Push,
    GitMethod::Discard,
    GitMethod::DeleteUntracked,
    GitMethod::StageSelection,
    GitMethod::StageHunk,
    GitMethod::AcceptConflictSide,
    GitMethod::MarkConflictResolved,
    GitMethod::CreateStash,
    GitMethod::ApplyStash,
    GitMethod::PopStash,
    GitMethod::DropStash,
    GitMethod::CreateWorktree,
    GitMethod::RemoveWorktree,
    GitMethod::CommitIndex,
    GitMethod::StagePaths,
    GitMethod::RevertCommit,
];

pub fn is_git_mutation(method: GitMethod) -> bool {
    GIT_MUTATIONS.contains(&method)
}

pub const GIT_OPERATION_TIMEOUT_MS: u64 = 30_000;
pub const GH_DETAIL_TIMEOUT_MS: u64 = 60_000;

/// How long a GitHub call may take.
pub fn gh_operation_timeout_ms(method: GhMethod) -> u64 {
    match method {
        GhMethod::GetPullRequest
        | GhMethod::ListPullRequests
        | GhMethod::GetPullRequestReviewTarget => GH_DETAIL_TIMEOUT_MS,
        GhMethod::GetStatus
        | GhMethod::CreatePullRequestComment
        | GhMethod::MinimizePullRequestComment => GIT_OPERATION_TIMEOUT_MS,
    }
}

pub const GIT_MAX_RESULT_BYTES: usize = 4 * 1024 * 1024;
pub const GIT_MAX_CONCURRENT_QUERIES: usize = 8;
pub const GIT_MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
pub const GIT_MAX_REQUEST_PATHS: usize = 100_000;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gh::GH_METHODS;
    use crate::git::GIT_METHODS;

    #[test]
    fn names_the_git_calls_that_change_the_repository() {
        assert_eq!(GIT_MUTATIONS.len(), 22);
        for method in GIT_METHODS {
            let mutates = matches!(
                method,
                GitMethod::InitialCommit
                    | GitMethod::Commit
                    | GitMethod::Checkout
                    | GitMethod::CreateBranch
                    | GitMethod::Fetch
                    | GitMethod::Pull
                    | GitMethod::Push
                    | GitMethod::Discard
                    | GitMethod::DeleteUntracked
                    | GitMethod::StageSelection
                    | GitMethod::StageHunk
                    | GitMethod::AcceptConflictSide
                    | GitMethod::MarkConflictResolved
                    | GitMethod::CreateStash
                    | GitMethod::ApplyStash
                    | GitMethod::PopStash
                    | GitMethod::DropStash
                    | GitMethod::CreateWorktree
                    | GitMethod::RemoveWorktree
                    | GitMethod::CommitIndex
                    | GitMethod::StagePaths
                    | GitMethod::RevertCommit
            );
            assert_eq!(is_git_mutation(*method), mutates, "{method:?}");
        }
    }

    #[test]
    fn gives_pull_request_reads_longer_than_other_github_calls() {
        for method in GH_METHODS {
            let detail = matches!(
                method,
                GhMethod::GetPullRequest
                    | GhMethod::ListPullRequests
                    | GhMethod::GetPullRequestReviewTarget
            );
            assert_eq!(
                gh_operation_timeout_ms(*method),
                if detail { 60_000 } else { 30_000 },
                "{method:?}"
            );
        }
        assert_eq!(GIT_MAX_REQUEST_BYTES, 4 * 1024 * 1024);
        assert_eq!(GIT_MAX_REQUEST_PATHS, 100_000);
        assert_eq!(GIT_MAX_CONCURRENT_QUERIES, 8);
        assert_eq!(GIT_MAX_RESULT_BYTES, GIT_MAX_REQUEST_BYTES);
    }
}
