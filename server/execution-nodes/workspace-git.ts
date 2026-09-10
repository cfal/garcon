import type {
  BlameOptions,
  BranchOptions,
  CapturedCommitMessageSource,
  CheckoutOptions,
  CommitIndexOptions,
  CommitMessageSourceOptions,
  CommitOptions,
  ConflictAcceptOptions,
  ConflictDetailsOptions,
  CreateWorktreeOptions,
  FileHistoryOptions,
  FileOptions,
  GitBlameLine,
  GitBranchListResult,
  GitCommandMutationResult,
  GitCommitResult,
  GitCommitSnapshotOptions,
  GitCommitSnapshotResponse,
  GitComparisonFreshnessOptions,
  GitComparisonFreshnessResponse,
  GitComparisonSnapshotOptions,
  GitComparisonSnapshotResponse,
  GitConflictDetails,
  GitConflictFile,
  GitFetchResult,
  GitFileHistoryEntry,
  GitGraphCommit,
  GitHistoryCommitListOptions,
  GitHistoryCommitListResponse,
  GitInitialCommitResult,
  GitMessageMutationResult,
  GitMutationResult,
  GitQuickSummaryOptions,
  GitQuickSummaryResponse,
  GitRefsOptions,
  GitRefsResponse,
  GitRemoteBranchMutationResult,
  GitRemoteListResult,
  GitRemoteStatusResult,
  GitReviewDocumentFileBodiesOptions,
  GitReviewDocumentFileBodiesResponse,
  GitStashEntry,
  GitStatusResult,
  GitWorkbenchSnapshotOptions,
  GitWorkbenchSnapshotResponse,
  GitWorkingTreeFingerprintOptions,
  GitWorkingTreeFingerprintResponse,
  GitWorktreeCreateResult,
  GraphOptions,
  ProjectOptions,
  PushOptions,
  RemoveWorktreeOptions,
  RepoInfo,
  RevertCommitOptions,
  StageHunkOptions,
  StagePathsOptions,
  StageSelectionOptions,
  StashCreateOptions,
  StashRefOptions,
  TargetCandidate,
  WorktreeInfo,
} from '../git/types.js';

/** Owns repository IO and review state; controller generation consumes captured source text. */
export interface WorkspaceGitService {
  getStatus(options: ProjectOptions): Promise<GitStatusResult>;
  initialCommit(options: ProjectOptions): Promise<GitInitialCommitResult>;
  commit(options: CommitOptions): Promise<GitCommitResult>;
  getBranches(options: ProjectOptions): Promise<GitBranchListResult>;
  getRefs(options: GitRefsOptions): Promise<GitRefsResponse>;
  checkout(options: CheckoutOptions): Promise<GitCommandMutationResult>;
  createBranch(options: BranchOptions): Promise<GitCommandMutationResult>;
  captureCommitMessageSource(options: CommitMessageSourceOptions): Promise<CapturedCommitMessageSource>;
  getRemoteStatus(options: ProjectOptions): Promise<GitRemoteStatusResult>;
  getRemotes(options: ProjectOptions): Promise<GitRemoteListResult>;
  fetch(options: ProjectOptions): Promise<GitFetchResult>;
  pull(options: ProjectOptions): Promise<GitRemoteBranchMutationResult>;
  push(options: PushOptions): Promise<GitRemoteBranchMutationResult>;
  discard(options: FileOptions): Promise<GitMessageMutationResult>;
  deleteUntracked(options: FileOptions): Promise<GitMessageMutationResult>;
  getWorkbenchSnapshot(options: GitWorkbenchSnapshotOptions): Promise<GitWorkbenchSnapshotResponse>;
  getWorkingTreeFingerprint(
    options: GitWorkingTreeFingerprintOptions,
  ): Promise<GitWorkingTreeFingerprintResponse>;
  getQuickSummary(options: GitQuickSummaryOptions): Promise<GitQuickSummaryResponse>;
  getReviewDocumentFileBodies(
    options: GitReviewDocumentFileBodiesOptions,
  ): Promise<GitReviewDocumentFileBodiesResponse>;
  getHistoryCommits(options: GitHistoryCommitListOptions): Promise<GitHistoryCommitListResponse>;
  getCommitSnapshot(options: GitCommitSnapshotOptions): Promise<GitCommitSnapshotResponse>;
  getComparisonSnapshot(
    options: GitComparisonSnapshotOptions,
  ): Promise<GitComparisonSnapshotResponse>;
  getComparisonFreshness(
    options: GitComparisonFreshnessOptions,
  ): Promise<GitComparisonFreshnessResponse>;
  stageSelection(options: StageSelectionOptions): Promise<GitMutationResult>;
  stageHunk(options: StageHunkOptions): Promise<GitMutationResult>;
  getConflicts(options: ProjectOptions): Promise<{ conflicts: GitConflictFile[] }>;
  getConflictDetails(options: ConflictDetailsOptions): Promise<GitConflictDetails>;
  acceptConflictSide(options: ConflictAcceptOptions): Promise<GitMutationResult>;
  markConflictResolved(options: FileOptions): Promise<GitMutationResult>;
  getStashes(options: ProjectOptions): Promise<{ stashes: GitStashEntry[] }>;
  createStash(options: StashCreateOptions): Promise<GitCommandMutationResult>;
  applyStash(options: StashRefOptions): Promise<GitMutationResult>;
  popStash(options: StashRefOptions): Promise<GitMutationResult>;
  dropStash(options: StashRefOptions): Promise<GitMutationResult>;
  getFileHistory(options: FileHistoryOptions): Promise<{ commits: GitFileHistoryEntry[] }>;
  getBlame(options: BlameOptions): Promise<{ lines: GitBlameLine[]; truncated: boolean }>;
  getGraph(options: GraphOptions): Promise<{ commits: GitGraphCommit[] }>;
  getRepoInfo(options: ProjectOptions): Promise<RepoInfo>;
  getWorktrees(options: ProjectOptions): Promise<{ worktrees: WorktreeInfo[] }>;
  getTargetCandidates(options: ProjectOptions): Promise<{ targets: TargetCandidate[] }>;
  createWorktree(options: CreateWorktreeOptions): Promise<GitWorktreeCreateResult>;
  removeWorktree(options: RemoveWorktreeOptions): Promise<GitCommandMutationResult>;
  commitIndex(options: CommitIndexOptions): Promise<GitCommandMutationResult>;
  stagePaths(options: StagePathsOptions): Promise<GitMutationResult>;
  revertCommit(options: RevertCommitOptions): Promise<GitCommandMutationResult>;
}
