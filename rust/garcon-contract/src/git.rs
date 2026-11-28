//! Ports `common/git.ts`.

use garcon_js::{Number, OptionalNullable};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize, Serializer, ser::SerializeStruct};

pub use crate::git_refs::{
    GIT_REF_RESULT_LIMITS, GitRefKind, GitRefOption, GitRefSort, GitRefsResponse,
};

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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitReviewMode {
    Working,
    Staged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitStageMode {
    Stage,
    Unstage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitFileReviewCategory {
    Normal,
    Generated,
    Lockfile,
    Binary,
    Large,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitReviewBodyState {
    Unloaded,
    Loading,
    Loaded,
    Binary,
    TooLarge,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitDiffLimitReason {
    PatchTooLarge,
    TooManyRows,
    LineTooLong,
    Binary,
    UnsupportedFileKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitReviewLimitReason {
    CollectionTooManyFiles,
    CollectionTooManyRows,
    CollectionTooManyBytes,
    FileTooManyRows,
    FileTooManyBytes,
    LineTooLong,
    Binary,
    UnsupportedFileKind,
    GitTimeout,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewCollectionLimit {
    pub reason: GitReviewLimitReason,
    pub message: String,
    pub visible_files: Number,
    pub total_files_known: Number,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewFileSummary {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub index_status: String,
    pub work_tree_status: String,
    pub category: GitFileReviewCategory,
    pub additions: Number,
    pub deletions: Number,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats_known: Option<bool>,
    pub estimated_rows: Number,
    pub body_state: GitReviewBodyState,
    pub body_fingerprint: String,
    pub is_generated: bool,
    pub is_binary: bool,
    pub is_too_large: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_reason: Option<GitReviewLimitReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewDocumentSummary {
    pub document_id: String,
    pub project: String,
    pub mode: GitReviewMode,
    pub context: Number,
    pub files: Vec<GitReviewFileSummary>,
    pub limits: GitReviewDocumentLimits,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_limit: Option<GitReviewCollectionLimit>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewFilePatchBody {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch_digest: Option<String>,
    pub body_fingerprint: String,
    pub body_state: GitReviewBodyState,
    pub category: GitFileReviewCategory,
    pub is_binary: bool,
    pub is_too_large: bool,
    pub rendered_row_count: Number,
    pub patch_bytes: Number,
    pub patch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_reason: Option<GitReviewLimitReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStats {
    pub additions: Number,
    pub deletions: Number,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_binary: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeFacet {
    pub status: String,
    pub change_kind: GitChangeKind,
    pub stats: DiffStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<GitFileReviewCategory>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibleTreeFields {
    pub staged: bool,
    pub has_unstaged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_kind: Option<GitChangeKind>,
    pub additions: Number,
    pub deletions: Number,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<GitFileReviewCategory>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TreeNodeKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub path: String,
    pub name: String,
    pub kind: TreeNodeKind,
    pub index_status: String,
    pub work_tree_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staged_facet: Option<ChangeFacet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unstaged_facet: Option<ChangeFacet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<GitFileReviewCategory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staged: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_unstaged: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_kind: Option<GitChangeKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<Number>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOptions {
    pub project_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitTreeStatsState {
    Pending,
    Loaded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesTreeResult {
    pub root: Vec<TreeNode>,
    pub has_commits: bool,
    pub stats_state: GitTreeStatsState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOptions {
    pub project_path: String,
    pub file: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOptions {
    pub project_path: String,
    pub message: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitCommitScope {
    SelectedFiles,
    WholeIndex,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub success: bool,
    pub output: String,
    pub commit_scope: GitCommitScope,
    pub index_synchronized: bool,
}

impl Serialize for GitCommitResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut result = serializer.serialize_struct("GitCommitResult", 4)?;
        result.serialize_field("success", &self.success)?;
        result.serialize_field("output", &self.output)?;
        // The selected-file branch appends its scope after spreading the commit result.
        match self.commit_scope {
            GitCommitScope::SelectedFiles => {
                result.serialize_field("indexSynchronized", &self.index_synchronized)?;
                result.serialize_field("commitScope", &self.commit_scope)?;
            }
            GitCommitScope::WholeIndex => {
                result.serialize_field("commitScope", &self.commit_scope)?;
                result.serialize_field("indexSynchronized", &self.index_synchronized)?;
            }
        }
        result.end()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRefsOptions {
    pub project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort: Option<GitRefSort>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutOptions {
    pub project_path: String,
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_kind: Option<GitRefKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchOptions {
    pub project_path: String,
    pub branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessageGenerationResult {
    pub message: String,
    pub directory_prefix: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOptions {
    pub project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_branch: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitRenderedDiffRowKind {
    Hunk,
    Context,
    Add,
    Del,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRenderedDiffRow {
    pub key: String,
    pub kind: GitRenderedDiffRowKind,
    pub hunk_index: Number,
    pub hunk_id: String,
    pub before_line: Option<Number>,
    pub after_line: Option<Number>,
    pub text: String,
    pub diff_line_index: Number,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRenderedHunk {
    pub id: String,
    pub header: String,
    pub old_start: Number,
    pub old_lines: Number,
    pub new_start: Number,
    pub new_lines: Number,
    pub row_start_index: Number,
    pub row_end_index: Number,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitReviewBodyPurpose {
    Visible,
    Prefetch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewDocumentFileBodiesOptions {
    pub project_path: String,
    pub document_id: String,
    pub files: Vec<String>,
    pub purpose: GitReviewBodyPurpose,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum GitReviewDocumentFileBodiesResponse {
    Ready {
        document_id: String,
        files: IndexMap<String, GitReviewFilePatchBody>,
        errors: IndexMap<String, String>,
        deferred_files: Vec<String>,
    },
    Stale {
        document_id: String,
        changed_paths: Vec<String>,
        message: String,
    },
    DocumentExpired {
        document_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryCommitListOptions {
    pub project_path: String,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryCommitListResponse {
    pub project: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub commits: Vec<GitHistoryCommitListItem>,
    pub next_offset: Option<Number>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryCommitListItem {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub author_date: String,
    pub committer: String,
    pub committer_email: String,
    pub committer_date: String,
    pub subject: String,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetails {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub author_date: String,
    pub committer: String,
    pub committer_email: String,
    pub committer_date: String,
    pub subject: String,
    pub body: String,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitParentOption {
    pub hash: String,
    pub short_hash: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitCommitFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFileSummary {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub status: GitCommitFileStatus,
    pub raw_status: String,
    pub category: GitFileReviewCategory,
    pub additions: Number,
    pub deletions: Number,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats_known: Option<bool>,
    pub estimated_rows: Number,
    pub body_state: GitReviewBodyState,
    pub body_fingerprint: String,
    pub is_generated: bool,
    pub is_binary: bool,
    pub is_too_large: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_reason: Option<GitReviewLimitReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum GitCommitSnapshotResponse {
    Ready(Box<GitCommitSnapshotReady>),
    NotFound {
        project: String,
        commit: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSnapshotReady {
    pub project: String,
    pub document_id: String,
    pub commit: GitCommitDetails,
    pub selected_parent: Option<String>,
    pub parent_options: Vec<GitCommitParentOption>,
    pub files: Vec<GitCommitFileSummary>,
    pub limits: GitReviewDocumentLimits,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_limit: Option<GitReviewCollectionLimit>,
    pub first_body_candidates: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSnapshotOptions {
    pub project_path: String,
    pub commit: String,
    #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
    pub parent: OptionalNullable<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_candidate_count: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffFileRequest {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
}

pub type GitComparisonFileRequest = GitDiffFileRequest;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitComparisonMode {
    Direct,
    MergeBase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitComparisonRevisionKind {
    Revision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitComparisonRevisionEndpoint {
    pub kind: GitComparisonRevisionKind,
    pub revision: String,
}

pub type GitComparisonFromEndpoint = GitComparisonRevisionEndpoint;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum GitComparisonToEndpoint {
    Revision { revision: String },
    WorkingTree,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitResolvedComparisonRevision {
    pub kind: GitComparisonRevisionKind,
    pub requested_revision: String,
    pub label: String,
    pub hash: String,
    pub short_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum GitResolvedComparisonTo {
    Revision {
        requested_revision: String,
        label: String,
        hash: String,
        short_hash: String,
    },
    WorkingTree {
        label: String,
        branch: String,
        head_hash: Option<String>,
        fingerprint: String,
        short_fingerprint: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitComparisonEndpointSide {
    From,
    To,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum GitComparisonSnapshotResponse {
    Ready(Box<GitComparisonSnapshotReady>),
    NotFound {
        project: String,
        endpoint: GitComparisonEndpointSide,
        revision: String,
        message: String,
    },
    NoMergeBase {
        project: String,
        from: GitResolvedComparisonRevision,
        to: GitResolvedComparisonRevision,
        message: String,
    },
    WorkingTreeChanging {
        project: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitComparisonSnapshotReady {
    pub project: String,
    pub repo_root: String,
    pub document_id: String,
    pub mode: GitComparisonMode,
    pub from: GitResolvedComparisonRevision,
    pub to: GitResolvedComparisonTo,
    pub effective_from_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_base_hash: Option<String>,
    pub files: Vec<GitCommitFileSummary>,
    pub limits: GitReviewDocumentLimits,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_limit: Option<GitReviewCollectionLimit>,
    pub first_body_candidates: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitComparisonSnapshotOptions {
    pub project_path: String,
    pub from: GitComparisonFromEndpoint,
    pub to: GitComparisonToEndpoint,
    pub mode: GitComparisonMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_candidate_count: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitComparisonRevisionExpectation {
    pub kind: GitComparisonRevisionKind,
    pub revision: String,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum GitComparisonFreshnessToExpectation {
    Revision { revision: String, hash: String },
    WorkingTree { fingerprint: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitComparisonFreshnessOptions {
    pub project_path: String,
    pub from: GitComparisonRevisionExpectation,
    pub to: GitComparisonFreshnessToExpectation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum GitComparisonFreshnessTo {
    Revision { hash: String },
    WorkingTree { fingerprint: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum GitComparisonFreshnessResponse {
    Ready {
        project: String,
        changed_endpoints: Vec<GitComparisonEndpointSide>,
        from_hash: String,
        to: GitComparisonFreshnessTo,
    },
    NotFound {
        project: String,
        endpoint: GitComparisonEndpointSide,
        revision: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitWorkbenchSource {
    ChatProject,
    Worktree,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkbenchSnapshotTarget {
    pub project_path: String,
    pub repo_root: String,
    pub worktree_path: String,
    pub label: String,
    pub branch: String,
    pub source: GitWorkbenchSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitWorkbenchTreeStatsState {
    Loaded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkbenchChangesTree {
    pub root: Vec<TreeNode>,
    pub has_commits: bool,
    pub stats_state: GitWorkbenchTreeStatsState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkbenchSnapshotReady {
    pub project: String,
    pub target: GitWorkbenchSnapshotTarget,
    pub tree: GitWorkbenchChangesTree,
    pub review_summary: GitReviewDocumentSummary,
    pub selected_file: Option<String>,
    pub first_body_candidates: Vec<String>,
    pub snapshot_id: String,
    pub workbench_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum GitWorkbenchSnapshotResponse {
    Ready(Box<GitWorkbenchSnapshotReady>),
    NotGitRepository {
        project: String,
        target: (),
        tree: (),
        review_summary: (),
        selected_file: (),
        first_body_candidates: [String; 0],
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkbenchSnapshotOptions {
    pub project_path: String,
    pub mode: GitReviewMode,
    pub context: u8,
    #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
    pub selected_file: OptionalNullable<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_candidate_count: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum GitWorkingTreeFingerprintResponse {
    Ready {
        project: String,
        fingerprint_version: u8,
        fingerprint: String,
        changed_path_count: Number,
    },
    NotGitRepository {
        project: String,
        fingerprint_version: u8,
        fingerprint: (),
        message: String,
    },
    Unknown {
        project: String,
        fingerprint_version: u8,
        fingerprint: (),
        message: String,
    },
}

pub type GitWorkingTreeFingerprintOptions = ProjectOptions;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GitQuickSummaryDiffStats {
    pub additions: Number,
    pub deletions: Number,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum GitQuickSummaryResponse {
    Ready {
        project: String,
        branch: String,
        has_changes: bool,
        has_untracked: bool,
        diff_stats: Option<GitQuickSummaryDiffStats>,
    },
    NotGitRepository {
        project: String,
        message: String,
    },
    Unknown {
        project: String,
        message: String,
    },
}

pub type GitQuickSummaryOptions = ProjectOptions;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLineSelection {
    pub line_indices: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageSelectionOptions {
    pub project_path: String,
    pub file: String,
    pub mode: GitStageMode,
    pub selection: GitLineSelection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_lines: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageHunkOptions {
    pub project_path: String,
    pub file: String,
    pub mode: GitStageMode,
    pub hunk_index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_lines: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub name: String,
    pub is_current: bool,
    pub is_main: bool,
    pub is_path_missing: bool,
    pub last_modified_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub is_git_repository: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_worktree_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetCandidate {
    #[serde(flatten)]
    pub target: GitWorkbenchSnapshotTarget,
    pub is_current: bool,
    pub is_missing: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GitConflictStatus {
    UU,
    AA,
    DD,
    AU,
    UA,
    DU,
    UD,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictFile {
    pub path: String,
    pub status: GitConflictStatus,
    pub base_available: bool,
    pub ours_available: bool,
    pub theirs_available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitConflictContentLimitReason {
    ContentTooLarge,
    TooManyLines,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictContent {
    pub content: Option<String>,
    pub truncated: bool,
    pub byte_length: Number,
    pub line_count: Number,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_reason: Option<GitConflictContentLimitReason>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GitConflictDetails {
    pub path: String,
    pub base: GitConflictContent,
    pub ours: GitConflictContent,
    pub theirs: GitConflictContent,
    pub working: GitConflictContent,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GitStashEntry {
    pub index: Number,
    #[serde(rename = "ref")]
    pub reference: String,
    pub hash: String,
    pub date: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitFileHistoryEntry {
    pub hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameLine {
    pub line: Number,
    pub original_line: Number,
    pub final_line: Number,
    pub commit: String,
    pub author: String,
    pub author_mail: String,
    pub author_time: String,
    pub summary: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitGraphCommit {
    pub graph: String,
    pub hash: String,
    pub parents: Vec<String>,
    pub decorations: Vec<String>,
    pub author: String,
    pub date: String,
    pub subject: String,
}

pub type ConflictDetailsOptions = FileOptions;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitConflictSide {
    Ours,
    Theirs,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictAcceptOptions {
    pub project_path: String,
    pub file: String,
    pub side: GitConflictSide,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashCreateOptions {
    pub project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_untracked: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashRefOptions {
    pub project_path: String,
    pub stash_ref: String,
    pub expected_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryOptions {
    pub project_path: String,
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameOptions {
    pub project_path: String,
    pub file: String,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphOptions {
    pub project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeOptions {
    pub project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    pub worktree_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detach: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveWorktreeOptions {
    pub project_path: String,
    pub worktree_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitIndexOptions {
    pub project_path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagePathsOptions {
    pub project_path: String,
    pub paths: Vec<String>,
    pub mode: GitStageMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertCommitOptions {
    pub project_path: String,
    pub commit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub has_commits: bool,
    pub modified: Vec<String>,
    pub added: Vec<String>,
    pub deleted: Vec<String>,
    pub untracked: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteStatus {
    pub has_remote: bool,
    pub has_upstream: bool,
    pub branch: String,
    pub remote_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_up_to_date: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitMutationResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessageContextOptions {
    pub project_path: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitBranchesResult {
    pub branches: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitRemotesResult {
    pub remotes: Vec<RemoteInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitConflictsResult {
    pub conflicts: Vec<GitConflictFile>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GitStashesResult {
    pub stashes: Vec<GitStashEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitFileHistoryResult {
    pub commits: Vec<GitFileHistoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GitBlameResult {
    pub lines: Vec<GitBlameLine>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitGraphResult {
    pub commits: Vec<GitGraphCommit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitWorktreesResult {
    pub worktrees: Vec<WorktreeInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitTargetCandidatesResult {
    pub targets: Vec<TargetCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitCommitMessageContextResult {
    pub diff: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCall<Q> {
    pub input: Q,
    pub budget_ms: Number,
}

macro_rules! git_methods {
    ($review:ident, $selection:ident, $hunk:ident; $($variant:ident, $name:literal, $rpc:literal, $input:ty, $output:ty);+ $(;)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum GitMethod {
            $(#[serde(rename = $name)] $variant),+
        }

        pub const GIT_METHODS: &[GitMethod] = &[$(GitMethod::$variant),+];

        impl GitMethod {
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $name),+ }
            }

            pub const fn rpc_method(self) -> &'static str {
                match self { $(Self::$variant => $rpc),+ }
            }
        }

        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(tag = "method", content = "request")]
        pub enum GitRequests<
            $review = GitReviewDocumentFileBodiesOptions,
            $selection = StageSelectionOptions,
            $hunk = StageHunkOptions,
        > {
            $(#[serde(rename = $name)] $variant($input)),+
        }

        impl<$review, $selection, $hunk> GitRequests<$review, $selection, $hunk> {
            pub const fn method(&self) -> GitMethod {
                match self { $(Self::$variant(_) => GitMethod::$variant),+ }
            }
        }

        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(tag = "method", content = "request")]
        pub enum GitCalls<$review, $selection, $hunk> {
            $(#[serde(rename = $rpc)] $variant(GitCall<$input>)),+
        }

        impl<$review, $selection, $hunk> GitCalls<$review, $selection, $hunk> {
            pub const fn method(&self) -> GitMethod {
                match self { $(Self::$variant(_) => GitMethod::$variant),+ }
            }
        }

        #[derive(Debug, Clone, PartialEq, Serialize)]
        #[serde(untagged)]
        pub enum GitResults {
            $($variant($output)),+
        }
    };
}

git_methods! {
    ReviewBodies, Selection, Hunk;
    GetStatus, "getStatus", "git.getStatus", ProjectOptions, GitStatus;
    InitialCommit, "initialCommit", "git.initialCommit", ProjectOptions, GitMutationResult;
    Commit, "commit", "git.commit", CommitOptions, GitCommitResult;
    GetBranches, "getBranches", "git.getBranches", ProjectOptions, GitBranchesResult;
    GetRefs, "getRefs", "git.getRefs", GitRefsOptions, GitRefsResponse;
    Checkout, "checkout", "git.checkout", CheckoutOptions, GitMutationResult;
    CreateBranch, "createBranch", "git.createBranch", BranchOptions, GitMutationResult;
    GetRemoteStatus, "getRemoteStatus", "git.getRemoteStatus", ProjectOptions, GitRemoteStatus;
    GetRemotes, "getRemotes", "git.getRemotes", ProjectOptions, GitRemotesResult;
    Fetch, "fetch", "git.fetch", ProjectOptions, GitMutationResult;
    Pull, "pull", "git.pull", ProjectOptions, GitMutationResult;
    Push, "push", "git.push", PushOptions, GitMutationResult;
    Discard, "discard", "git.discard", FileOptions, GitMutationResult;
    DeleteUntracked, "deleteUntracked", "git.deleteUntracked", FileOptions, GitMutationResult;
    GetWorkbenchSnapshot, "getWorkbenchSnapshot", "git.getWorkbenchSnapshot", GitWorkbenchSnapshotOptions, GitWorkbenchSnapshotResponse;
    GetWorkingTreeFingerprint, "getWorkingTreeFingerprint", "git.getWorkingTreeFingerprint", GitWorkingTreeFingerprintOptions, GitWorkingTreeFingerprintResponse;
    GetQuickSummary, "getQuickSummary", "git.getQuickSummary", GitQuickSummaryOptions, GitQuickSummaryResponse;
    GetReviewDocumentFileBodies, "getReviewDocumentFileBodies", "git.getReviewDocumentFileBodies", ReviewBodies, GitReviewDocumentFileBodiesResponse;
    GetHistoryCommits, "getHistoryCommits", "git.getHistoryCommits", GitHistoryCommitListOptions, GitHistoryCommitListResponse;
    GetCommitSnapshot, "getCommitSnapshot", "git.getCommitSnapshot", GitCommitSnapshotOptions, GitCommitSnapshotResponse;
    GetComparisonSnapshot, "getComparisonSnapshot", "git.getComparisonSnapshot", GitComparisonSnapshotOptions, GitComparisonSnapshotResponse;
    GetComparisonFreshness, "getComparisonFreshness", "git.getComparisonFreshness", GitComparisonFreshnessOptions, GitComparisonFreshnessResponse;
    StageSelection, "stageSelection", "git.stageSelection", Selection, GitMutationResult;
    StageHunk, "stageHunk", "git.stageHunk", Hunk, GitMutationResult;
    GetConflicts, "getConflicts", "git.getConflicts", ProjectOptions, GitConflictsResult;
    GetConflictDetails, "getConflictDetails", "git.getConflictDetails", ConflictDetailsOptions, GitConflictDetails;
    AcceptConflictSide, "acceptConflictSide", "git.acceptConflictSide", ConflictAcceptOptions, GitMutationResult;
    MarkConflictResolved, "markConflictResolved", "git.markConflictResolved", FileOptions, GitMutationResult;
    GetStashes, "getStashes", "git.getStashes", ProjectOptions, GitStashesResult;
    CreateStash, "createStash", "git.createStash", StashCreateOptions, GitMutationResult;
    ApplyStash, "applyStash", "git.applyStash", StashRefOptions, GitMutationResult;
    PopStash, "popStash", "git.popStash", StashRefOptions, GitMutationResult;
    DropStash, "dropStash", "git.dropStash", StashRefOptions, GitMutationResult;
    GetFileHistory, "getFileHistory", "git.getFileHistory", FileHistoryOptions, GitFileHistoryResult;
    GetBlame, "getBlame", "git.getBlame", BlameOptions, GitBlameResult;
    GetGraph, "getGraph", "git.getGraph", GraphOptions, GitGraphResult;
    GetRepoInfo, "getRepoInfo", "git.getRepoInfo", ProjectOptions, RepoInfo;
    GetWorktrees, "getWorktrees", "git.getWorktrees", ProjectOptions, GitWorktreesResult;
    GetTargetCandidates, "getTargetCandidates", "git.getTargetCandidates", ProjectOptions, GitTargetCandidatesResult;
    CreateWorktree, "createWorktree", "git.createWorktree", CreateWorktreeOptions, GitMutationResult;
    RemoveWorktree, "removeWorktree", "git.removeWorktree", RemoveWorktreeOptions, GitMutationResult;
    CommitIndex, "commitIndex", "git.commitIndex", CommitIndexOptions, GitMutationResult;
    StagePaths, "stagePaths", "git.stagePaths", StagePathsOptions, GitMutationResult;
    RevertCommit, "revertCommit", "git.revertCommit", RevertCommitOptions, GitMutationResult;
    CollectCommitMessageContext, "collectCommitMessageContext", "git.collectCommitMessageContext", CommitMessageContextOptions, GitCommitMessageContextResult;
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
