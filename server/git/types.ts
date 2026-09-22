import type { AgentId } from '../../common/agents.ts';
import type { ApiProtocol } from '../../common/api-providers.js';
import type { ThinkingMode } from '../../common/chat-modes.js';
import { GIT_REF_RESULT_LIMITS } from '../../common/git-refs.js';
import type {
  GitRefKind,
  GitRefOption,
  GitRefsResponse,
  GitRefSort,
} from '../../common/git-refs.js';

export { GIT_REF_RESULT_LIMITS };
export type { GitRefKind, GitRefOption, GitRefsResponse, GitRefSort };

import type * as SharedGit from '../../common/git.js';
export * from '../../common/git.js';
import type { GitChangeKind, GitReviewMode, GitStageMode, GitFileReviewCategory, GitDiffLimitReason, GitReviewBodyState, GitReviewLimitReason, DiffStats, ChangeFacet, CompatibleTreeFields, TreeNode, GitTreeStatsState, ChangesTreeResult, GitCommitResult, CommitMessageGenerationResult, GitRenderedDiffRowKind, GitRenderedDiffRow, GitRenderedHunk, GitReviewDocumentLimits, GitReviewCollectionLimit, GitReviewFileSummary, GitReviewDocumentSummary, GitReviewFilePatchBody, GitReviewBodyPurpose, GitReviewDocumentFileBodiesReady, GitReviewDocumentFileBodiesStale, GitReviewDocumentFileBodiesExpired, GitReviewDocumentFileBodiesResponse, GitHistoryCommitListResponse, GitHistoryCommitListItem, GitCommitDetails, GitCommitParentOption, GitCommitFileStatus, GitCommitFileSummary, GitCommitSnapshotReady, GitCommitSnapshotNotFound, GitCommitSnapshotResponse, GitDiffFileRequest, GitComparisonMode, GitComparisonRevisionEndpoint, GitComparisonWorkingTreeEndpoint, GitComparisonFromEndpoint, GitComparisonToEndpoint, GitResolvedComparisonRevision, GitResolvedComparisonWorkingTree, GitResolvedComparisonTo, GitComparisonSnapshotReady, GitComparisonSnapshotNotFound, GitComparisonSnapshotNoMergeBase, GitComparisonSnapshotWorkingTreeChanging, GitComparisonSnapshotResponse, GitComparisonRevisionExpectation, GitComparisonWorkingTreeExpectation, GitComparisonFreshnessToExpectation, GitComparisonFreshnessReady, GitComparisonFreshnessNotFound, GitComparisonFreshnessResponse, GitComparisonFileRequest, GitWorkbenchSnapshotTarget, GitWorkbenchSnapshotReady, GitWorkbenchSnapshotNotRepository, GitWorkbenchSnapshotResponse, GitWorkingTreeFingerprintResponse, GitWorkingTreeFingerprintReady, GitWorkingTreeFingerprintNotRepository, GitWorkingTreeFingerprintUnknown, GitQuickSummaryResponse, GitQuickSummaryReady, GitQuickSummaryNotRepository, GitQuickSummaryUnknown, WorktreeInfo, RepoInfo, TargetCandidate, GitConflictStatus, GitConflictFile, GitConflictContentLimitReason, GitConflictContent, GitConflictDetails, GitStashEntry, GitFileHistoryEntry, GitBlameLine, GitGraphCommit, RemoteInfo } from '../../common/git.js';

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  disableOptionalLocks?: boolean;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface GitCommandTrace {
  args: string[];
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  failed?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  aborted?: boolean;
}

export type GitReviewRoutePhaseName =
  | 'resolve'
  | 'summary-git'
  | 'document-register'
  | 'freshness-before'
  | 'body-cache'
  | 'body-git'
  | 'body-split'
  | 'patch-scan'
  | 'freshness-after'
  | 'serialize';

export interface GitReviewRoutePhase {
  name: GitReviewRoutePhaseName;
  durationMs: number;
}

export interface GitReviewRouteMetrics {
  phases: GitReviewRoutePhase[];
  fileCount?: number;
  rowCount?: number;
  cacheHits?: number;
  batchCount?: number;
  bisectionCount?: number;
}

export interface GitProcessError extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  aborted?: boolean;
}

export type NumstatMap = Record<string, DiffStats>;

export interface PorcelainStatusEntry {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workTreeStatus: string;
}

export interface ChangeEntry extends PorcelainStatusEntry {
  stagedFacet?: ChangeFacet;
  unstagedFacet?: ChangeFacet;
}

export interface PatchHunk {
  rawHeader: string;
  lines: string[];
}

export interface ParsedPatch {
  header: string[];
  hunks: PatchHunk[];
}

export interface TransformedHunk {
  lines: string[];
  nextIndex: number;
}

export interface HunkLineCounts {
  oldCount: number;
  newCount: number;
}

export interface HunkHeaderResult {
  header: string;
  nextOffset: number;
}

export interface CommitMessageOptions {
  nodeId?: string | null;
  model?: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  thinkingMode?: ThinkingMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  customPrompt?: string;
}

export interface RunSingleQueryOptions extends CommitMessageOptions {
  [key: string]: unknown;
  agentId: AgentId;
}

export interface GitAgentRunner {
  runSingleQuery(prompt: string, options: RunSingleQueryOptions): Promise<string>;
}

export interface ClassifiedGitError {
  status: number;
  message: string;
  details?: unknown;
}

export interface CreateGitServiceOptions {
  agents: GitAgentRunner;
  classifyGitError(error: unknown): ClassifiedGitError;
  assertProjectPathAllowed?(projectPath: string): Promise<string>;
}

export interface CommitMessageFileOptions extends ProjectOptions, CommitMessageOptions {
  files: string[];
  agentId: AgentId;
  useCommonDirPrefix?: boolean;
}

export type LocalGitOptions<T> = T & { trace?: GitCommandTrace[]; metrics?: GitReviewRouteMetrics; signal?: AbortSignal };
export type CommitMessageContextOptions = LocalGitOptions<SharedGit.CommitMessageContextOptions>;

export type ProjectOptions = LocalGitOptions<SharedGit.ProjectOptions>;
export type FileOptions = LocalGitOptions<SharedGit.FileOptions>;
export type CommitOptions = LocalGitOptions<SharedGit.CommitOptions>;
export type GitRefsOptions = LocalGitOptions<SharedGit.GitRefsOptions>;
export type CheckoutOptions = LocalGitOptions<SharedGit.CheckoutOptions>;
export type BranchOptions = LocalGitOptions<SharedGit.BranchOptions>;
export type PushOptions = LocalGitOptions<SharedGit.PushOptions>;
export type GitReviewDocumentFileBodiesOptions = LocalGitOptions<SharedGit.GitReviewDocumentFileBodiesOptions>;
export type GitHistoryCommitListOptions = LocalGitOptions<SharedGit.GitHistoryCommitListOptions>;
export type GitCommitSnapshotOptions = LocalGitOptions<SharedGit.GitCommitSnapshotOptions>;
export type GitComparisonSnapshotOptions = LocalGitOptions<SharedGit.GitComparisonSnapshotOptions>;
export type GitComparisonFreshnessOptions = LocalGitOptions<SharedGit.GitComparisonFreshnessOptions>;
export type GitWorkbenchSnapshotOptions = LocalGitOptions<SharedGit.GitWorkbenchSnapshotOptions>;
export type GitWorkingTreeFingerprintOptions = LocalGitOptions<SharedGit.GitWorkingTreeFingerprintOptions>;
export type GitQuickSummaryOptions = LocalGitOptions<SharedGit.GitQuickSummaryOptions>;
export type StageSelectionOptions = LocalGitOptions<SharedGit.StageSelectionOptions>;
export type StageHunkOptions = LocalGitOptions<SharedGit.StageHunkOptions>;
export type ConflictDetailsOptions = LocalGitOptions<SharedGit.ConflictDetailsOptions>;
export type ConflictAcceptOptions = LocalGitOptions<SharedGit.ConflictAcceptOptions>;
export type StashCreateOptions = LocalGitOptions<SharedGit.StashCreateOptions>;
export type StashRefOptions = LocalGitOptions<SharedGit.StashRefOptions>;
export type FileHistoryOptions = LocalGitOptions<SharedGit.FileHistoryOptions>;
export type BlameOptions = LocalGitOptions<SharedGit.BlameOptions>;
export type GraphOptions = LocalGitOptions<SharedGit.GraphOptions>;
export type CreateWorktreeOptions = LocalGitOptions<SharedGit.CreateWorktreeOptions>;
export type RemoveWorktreeOptions = LocalGitOptions<SharedGit.RemoveWorktreeOptions>;
export type CommitIndexOptions = LocalGitOptions<SharedGit.CommitIndexOptions>;
export type StagePathsOptions = LocalGitOptions<SharedGit.StagePathsOptions>;
export type RevertCommitOptions = LocalGitOptions<SharedGit.RevertCommitOptions>;
export type MutableTreeNode = Omit<TreeNode, 'children'> & { children?: TreeMap | TreeNode[] };
export type TreeMap = Map<string, MutableTreeNode>;
export type GitOperations = { [K in SharedGit.GitMethod]: (options: LocalGitOptions<SharedGit.GitRequests[K]>) => Promise<SharedGit.GitResults[K]> };
export interface GitService extends GitOperations {
  generateCommitMessageForFiles(options: CommitMessageFileOptions): Promise<CommitMessageGenerationResult>;
  toHttpError(error: unknown): Response;
}
