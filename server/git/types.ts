import type { AgentId } from '../../common/agents.ts';
import type { ApiProtocol } from '../../common/api-providers.js';
import type { ThinkingMode } from '../../common/chat-modes.js';

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  disableOptionalLocks?: boolean;
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

export interface GitProcessError extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  aborted?: boolean;
}

export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
export type GitReviewMode = 'working' | 'staged';
export type GitStageMode = 'stage' | 'unstage';
export type GitFileReviewCategory = 'normal' | 'generated' | 'lockfile' | 'binary' | 'large';
export type GitDiffLimitReason =
  'patch-too-large' | 'too-many-rows' | 'line-too-long' | 'binary' | 'unsupported-file-kind';

export type GitReviewBodyState =
  'unloaded' | 'loading' | 'loaded' | 'binary' | 'too-large' | 'error';
export type GitReviewLimitReason =
  | 'collection-too-many-files'
  | 'collection-too-many-rows'
  | 'collection-too-many-bytes'
  | 'file-too-many-rows'
  | 'file-too-many-bytes'
  | 'line-too-long'
  | 'binary'
  | 'unsupported-file-kind'
  | 'git-timeout';

export const GIT_DIFF_LIMITS = Object.freeze({
  maxBatchFiles: 64,
  maxContextLines: 50,
  maxPatchBytes: 1_000_000,
  maxRenderedRows: 20_000,
  maxLineBytes: 20_000,
});

export const GIT_REVIEW_DOCUMENT_LIMITS = Object.freeze({
  maxSummaryFiles: 10_000,
  maxBodyBatchFiles: 24,
  maxLoadedRows: 100_000,
  maxLoadedPatchBytes: 10_000_000,
  maxFileRows: 50_000,
  maxFilePatchBytes: 5_000_000,
  maxLineBytes: GIT_DIFF_LIMITS.maxLineBytes,
  maxContextLines: GIT_DIFF_LIMITS.maxContextLines,
  bodyConcurrency: 4,
});

export const GIT_WORKING_TREE_FINGERPRINT_VERSION = 1;
export const GIT_QUICK_SUMMARY_FINGERPRINT_VERSION = 1;

export interface DiffStats {
  additions: number;
  deletions: number;
  isBinary?: boolean;
}

export type NumstatMap = Record<string, DiffStats>;

export interface PorcelainStatusEntry {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workTreeStatus: string;
}

export interface ChangeFacet {
  status: string;
  changeKind: GitChangeKind;
  stats: DiffStats;
  originalPath?: string;
  category?: GitFileReviewCategory;
}

export interface ChangeEntry extends PorcelainStatusEntry {
  stagedFacet?: ChangeFacet;
  unstagedFacet?: ChangeFacet;
}

export interface CompatibleTreeFields {
  staged: boolean;
  hasUnstaged: boolean;
  changeKind?: GitChangeKind;
  additions: number;
  deletions: number;
  category?: GitFileReviewCategory;
}

export interface TreeNode extends Partial<CompatibleTreeFields> {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  indexStatus: string;
  workTreeStatus: string;
  stagedFacet?: ChangeFacet;
  unstagedFacet?: ChangeFacet;
  children?: TreeMap | TreeNode[];
  category?: GitFileReviewCategory;
}

export type TreeMap = Map<string, TreeNode>;

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
  cwd: string;
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

export interface ProjectOptions {
  projectPath: string;
  trace?: GitCommandTrace[];
  signal?: AbortSignal;
}

export type GitTreeStatsState = 'pending' | 'loaded';

export interface ChangesTreeResult {
  root: TreeNode[];
  hasCommits: boolean;
  statsState: GitTreeStatsState;
}

export interface FileOptions extends ProjectOptions {
  file: string;
}

export interface CommitOptions extends ProjectOptions {
  message: string;
  files: string[];
}

export type GitRefKind = 'local-branch' | 'remote-branch' | 'tag' | 'other';

export const GIT_REF_RESULT_LIMITS = Object.freeze({
  default: 200,
  max: 500,
});

export interface GitRefOption {
  name: string;
  ref: string;
  kind: GitRefKind;
  isCurrent?: boolean;
}

export interface GitRefsResponse {
  refs: GitRefOption[];
}

export interface GitRefsOptions extends ProjectOptions {
  query?: string;
  limit?: number;
}

export interface CheckoutOptions extends ProjectOptions {
  ref: string;
  refKind?: GitRefKind;
}

export interface BranchOptions extends ProjectOptions {
  branch: string;
  baseRef?: string;
}

export interface CommitMessageFileOptions extends ProjectOptions, CommitMessageOptions {
  files: string[];
  agentId: AgentId;
  useCommonDirPrefix?: boolean;
}

export interface CommitMessageGenerationResult {
  message: string;
  directoryPrefix: string;
}

export interface PushOptions extends ProjectOptions {
  remote?: string;
  remoteBranch?: string;
}

export interface FileReviewOptions extends FileOptions {
  mode?: GitReviewMode;
  context?: number;
  signal?: AbortSignal;
}

export interface ReviewFileBodiesOptions extends ProjectOptions {
  documentId: string;
  files: string[];
  mode?: GitReviewMode;
  context?: number;
}

export type GitRenderedDiffRowKind = 'hunk' | 'context' | 'add' | 'del';

export interface GitRenderedDiffRow {
  key: string;
  kind: GitRenderedDiffRowKind;
  hunkIndex: number;
  hunkId: string;
  beforeLine: number | null;
  afterLine: number | null;
  text: string;
  diffLineIndex: number;
}

export interface GitRenderedHunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  rowStartIndex: number;
  rowEndIndex: number;
}

export interface GitFileReviewData {
  path: string;
  mode: GitReviewMode;
  indexStatus?: string;
  workTreeStatus?: string;
  isBinary: boolean;
  truncated: boolean;
  truncatedReason?: string;
  limitReason?: GitDiffLimitReason;
  category?: GitFileReviewCategory;
  rows: GitRenderedDiffRow[];
  hunks: GitRenderedHunk[];
  error?: string;
}

export interface GitReviewDocumentLimits {
  maxSummaryFiles: number;
  maxBodyBatchFiles: number;
  maxLoadedRows: number;
  maxLoadedPatchBytes: number;
  maxFileRows: number;
  maxFilePatchBytes: number;
  maxLineBytes: number;
  maxContextLines: number;
  bodyConcurrency: number;
}

export interface GitReviewCollectionLimit {
  reason: GitReviewLimitReason;
  message: string;
  visibleFiles: number;
  totalFilesKnown: number;
}

export interface GitReviewFileSummary {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workTreeStatus: string;
  category: GitFileReviewCategory;
  additions: number;
  deletions: number;
  statsKnown?: boolean;
  estimatedRows: number;
  bodyState: GitReviewBodyState;
  bodyFingerprint: string;
  isGenerated: boolean;
  isBinary: boolean;
  isTooLarge: boolean;
  limitReason?: GitReviewLimitReason;
  limitMessage?: string;
}

export interface GitReviewDocumentSummary {
  documentId: string;
  project: string;
  mode: GitReviewMode;
  context: number;
  files: GitReviewFileSummary[];
  limits: GitReviewDocumentLimits;
  collectionLimit?: GitReviewCollectionLimit;
}

export interface GitReviewFileBody {
  path: string;
  bodyFingerprint: string;
  bodyState: GitReviewBodyState;
  category: GitFileReviewCategory;
  isBinary: boolean;
  isTooLarge: boolean;
  renderedRowCount: number;
  patchBytes: number;
  rows: GitRenderedDiffRow[];
  hunks: GitRenderedHunk[];
  limitReason?: GitReviewLimitReason;
  limitMessage?: string;
  error?: string;
}

export interface GitReviewFileBodiesResponse {
  documentId: string;
  files: Record<string, GitReviewFileBody>;
  errors: Record<string, string>;
}

export interface GitHistoryCommitListOptions extends ProjectOptions {
  ref?: string;
  limit?: number;
  offset?: number;
}

export interface GitHistoryCommitListResponse {
  project: string;
  ref: string;
  commits: GitHistoryCommitListItem[];
  nextOffset: number | null;
}

export interface GitHistoryCommitListItem {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: string;
  committer: string;
  committerEmail: string;
  committerDate: string;
  subject: string;
  refs: string[];
}

export interface GitCommitDetails {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: string;
  committer: string;
  committerEmail: string;
  committerDate: string;
  subject: string;
  body: string;
  refs: string[];
}

export interface GitCommitParentOption {
  hash: string;
  shortHash: string;
  label: string;
}

export type GitCommitFileStatus =
  'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed' | 'unknown';

export interface GitCommitFileSummary {
  path: string;
  originalPath?: string;
  status: GitCommitFileStatus;
  rawStatus: string;
  category: GitFileReviewCategory;
  additions: number;
  deletions: number;
  statsKnown?: boolean;
  estimatedRows: number;
  bodyState: GitReviewBodyState;
  bodyFingerprint: string;
  isGenerated: boolean;
  isBinary: boolean;
  isTooLarge: boolean;
  limitReason?: GitReviewLimitReason;
  limitMessage?: string;
}

export type GitCommitFileBody = GitReviewFileBody;

export interface GitCommitSnapshotReady {
  status: 'ready';
  project: string;
  documentId: string;
  commit: GitCommitDetails;
  selectedParent: string | null;
  parentOptions: GitCommitParentOption[];
  files: GitCommitFileSummary[];
  limits: GitReviewDocumentLimits;
  collectionLimit?: GitReviewCollectionLimit;
  firstBodyCandidates: string[];
}

export interface GitCommitSnapshotNotFound {
  status: 'not-found';
  project: string;
  commit: string;
  message: string;
}

export type GitCommitSnapshotResponse = GitCommitSnapshotReady | GitCommitSnapshotNotFound;

export interface GitCommitSnapshotOptions extends ProjectOptions {
  commit: string;
  parent?: string | null;
  context?: number;
  bodyCandidateCount?: number;
}

export interface GitDiffFileRequest {
  path: string;
  originalPath?: string;
}

export interface GitCommitFileBodiesOptions extends ProjectOptions {
  documentId: string;
  commit: string;
  parent?: string | null;
  context?: number;
  files: GitDiffFileRequest[];
}

export interface GitCommitFileBodiesResponse {
  documentId: string;
  files: Record<string, GitCommitFileBody>;
  errors: Record<string, string>;
}

export type GitComparisonMode = 'direct' | 'merge-base';

export interface GitComparisonRevisionEndpoint {
  kind: 'revision';
  revision: string;
}

export interface GitComparisonWorkingTreeEndpoint {
  kind: 'working-tree';
}

export type GitComparisonFromEndpoint = GitComparisonRevisionEndpoint;
export type GitComparisonToEndpoint =
  GitComparisonRevisionEndpoint | GitComparisonWorkingTreeEndpoint;

export interface GitResolvedComparisonRevision {
  kind: 'revision';
  requestedRevision: string;
  label: string;
  hash: string;
  shortHash: string;
}

export interface GitResolvedComparisonWorkingTree {
  kind: 'working-tree';
  label: string;
  branch: string;
  headHash: string | null;
  fingerprint: string;
  shortFingerprint: string;
}

export type GitResolvedComparisonTo =
  GitResolvedComparisonRevision | GitResolvedComparisonWorkingTree;

export interface GitComparisonSnapshotReady {
  status: 'ready';
  project: string;
  repoRoot: string;
  documentId: string;
  mode: GitComparisonMode;
  from: GitResolvedComparisonRevision;
  to: GitResolvedComparisonTo;
  effectiveFromHash: string;
  mergeBaseHash?: string;
  files: GitCommitFileSummary[];
  limits: GitReviewDocumentLimits;
  collectionLimit?: GitReviewCollectionLimit;
  firstBodyCandidates: string[];
}

export interface GitComparisonSnapshotNotFound {
  status: 'not-found';
  project: string;
  endpoint: 'from' | 'to';
  revision: string;
  message: string;
}

export interface GitComparisonSnapshotNoMergeBase {
  status: 'no-merge-base';
  project: string;
  from: GitResolvedComparisonRevision;
  to: GitResolvedComparisonRevision;
  message: string;
}

export interface GitComparisonSnapshotWorkingTreeChanging {
  status: 'working-tree-changing';
  project: string;
  message: string;
}

export type GitComparisonSnapshotResponse =
  | GitComparisonSnapshotReady
  | GitComparisonSnapshotNotFound
  | GitComparisonSnapshotNoMergeBase
  | GitComparisonSnapshotWorkingTreeChanging;

export interface GitComparisonSnapshotOptions extends ProjectOptions {
  from: GitComparisonFromEndpoint;
  to: GitComparisonToEndpoint;
  mode: GitComparisonMode;
  context?: number;
  bodyCandidateCount?: number;
}

export type GitComparisonFileRequest = GitDiffFileRequest;

export interface GitComparisonRevisionBodyTarget {
  kind: 'revision';
  hash: string;
}

export interface GitComparisonWorkingTreeBodyTarget {
  kind: 'working-tree';
  fingerprint: string;
}

export type GitComparisonBodyTarget =
  GitComparisonRevisionBodyTarget | GitComparisonWorkingTreeBodyTarget;

export interface GitComparisonFileBodiesOptions extends ProjectOptions {
  documentId: string;
  effectiveFromHash: string;
  to: GitComparisonBodyTarget;
  context?: number;
  files: GitComparisonFileRequest[];
}

export interface GitComparisonFileBodiesReady extends GitReviewFileBodiesResponse {
  status: 'ready';
}

export interface GitComparisonFileBodiesStale {
  status: 'stale';
  documentId: string;
  expectedFingerprint: string;
  actualFingerprint: string | null;
  message: string;
}

export type GitComparisonFileBodiesResponse =
  GitComparisonFileBodiesReady | GitComparisonFileBodiesStale;

export interface GitWorkbenchSnapshotTarget {
  projectPath: string;
  repoRoot: string;
  worktreePath: string;
  label: string;
  branch: string;
  source: 'chat-project' | 'worktree';
}

export interface GitWorkbenchSnapshotReady {
  status: 'ready';
  project: string;
  target: GitWorkbenchSnapshotTarget;
  tree: ChangesTreeResult & { statsState: 'loaded' };
  reviewSummary: GitReviewDocumentSummary;
  selectedFile: string | null;
  firstBodyCandidates: string[];
  snapshotId: string;
  workbenchFingerprint: string;
}

export interface GitWorkbenchSnapshotNotRepository {
  status: 'not-git-repository';
  project: string;
  target: null;
  tree: null;
  reviewSummary: null;
  selectedFile: null;
  firstBodyCandidates: [];
  message: string;
}

export type GitWorkbenchSnapshotResponse =
  GitWorkbenchSnapshotReady | GitWorkbenchSnapshotNotRepository;

export interface GitWorkbenchSnapshotOptions extends ProjectOptions {
  mode: GitReviewMode;
  context: number;
  selectedFile?: string | null;
  bodyCandidateCount?: number;
}

export type GitWorkingTreeFingerprintResponse =
  | GitWorkingTreeFingerprintReady
  | GitWorkingTreeFingerprintNotRepository
  | GitWorkingTreeFingerprintUnknown;

export interface GitWorkingTreeFingerprintReady {
  status: 'ready';
  project: string;
  fingerprintVersion: typeof GIT_WORKING_TREE_FINGERPRINT_VERSION;
  fingerprint: string;
  changedPathCount: number;
}

export interface GitWorkingTreeFingerprintNotRepository {
  status: 'not-git-repository';
  project: string;
  fingerprintVersion: typeof GIT_WORKING_TREE_FINGERPRINT_VERSION;
  fingerprint: null;
  message: string;
}

export interface GitWorkingTreeFingerprintUnknown {
  status: 'unknown';
  project: string;
  fingerprintVersion: typeof GIT_WORKING_TREE_FINGERPRINT_VERSION;
  fingerprint: null;
  message: string;
}

export interface GitWorkingTreeFingerprintOptions extends ProjectOptions {
  trace?: GitCommandTrace[];
  signal?: AbortSignal;
}

export type GitQuickSummaryResponse =
  GitQuickSummaryReady | GitQuickSummaryNotRepository | GitQuickSummaryUnknown;

export interface GitQuickSummaryReady {
  status: 'ready';
  project: string;
  repoRoot: string;
  branch: string;
  hasCommits: boolean;
  changedFiles: number;
  trackedChangedFiles: number;
  untrackedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  additions: number;
  deletions: number;
  fingerprintVersion: typeof GIT_QUICK_SUMMARY_FINGERPRINT_VERSION;
  fingerprint: string;
}

export interface GitQuickSummaryNotRepository {
  status: 'not-git-repository';
  project: string;
  fingerprintVersion: typeof GIT_QUICK_SUMMARY_FINGERPRINT_VERSION;
  fingerprint: null;
  message: string;
}

export interface GitQuickSummaryUnknown {
  status: 'unknown';
  project: string;
  fingerprintVersion: typeof GIT_QUICK_SUMMARY_FINGERPRINT_VERSION;
  fingerprint: null;
  message: string;
}

export interface GitQuickSummaryOptions extends ProjectOptions {
  trace?: GitCommandTrace[];
  signal?: AbortSignal;
}

export interface StageSelectionOptions extends FileOptions {
  mode: GitStageMode;
  selection: { lineIndices: number[] };
  contextLines?: number;
}

export interface StageHunkOptions extends FileOptions {
  mode: GitStageMode;
  hunkIndex: number;
  contextLines?: number;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  name: string;
  isCurrent: boolean;
  isMain: boolean;
  isPathMissing: boolean;
  /** Reports the worktree root directory mtime as ISO-8601, or null when unavailable. */
  lastModifiedAt: string | null;
}

export interface RepoInfo {
  isGitRepository: boolean;
  repoRoot?: string;
  currentWorktreePath?: string;
}

export interface TargetCandidate {
  projectPath: string;
  repoRoot: string;
  worktreePath: string;
  label: string;
  branch: string;
  source: 'chat-project' | 'worktree';
  isCurrent: boolean;
  isMissing: boolean;
}

export type GitConflictStatus = 'UU' | 'AA' | 'DD' | 'AU' | 'UA' | 'DU' | 'UD';

export interface GitConflictFile {
  path: string;
  status: GitConflictStatus;
  baseAvailable: boolean;
  oursAvailable: boolean;
  theirsAvailable: boolean;
}

export type GitConflictContentLimitReason = 'content-too-large' | 'too-many-lines';

export interface GitConflictContent {
  content: string | null;
  truncated: boolean;
  byteLength: number;
  lineCount: number;
  limitReason?: GitConflictContentLimitReason;
}

export interface GitConflictDetails {
  path: string;
  base: GitConflictContent;
  ours: GitConflictContent;
  theirs: GitConflictContent;
  working: GitConflictContent;
  truncated: boolean;
}

export interface GitStashEntry {
  index: number;
  ref: string;
  hash: string;
  message: string;
  date: string;
}

export interface GitFileHistoryEntry {
  hash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export interface GitBlameLine {
  line: number;
  originalLine: number;
  finalLine: number;
  commit: string;
  author: string;
  authorMail: string;
  authorTime: string;
  summary: string;
  content: string;
}

export interface GitGraphCommit {
  graph: string;
  hash: string;
  parents: string[];
  decorations: string[];
  author: string;
  date: string;
  subject: string;
}

export interface ConflictDetailsOptions extends FileOptions {}
export interface ConflictAcceptOptions extends FileOptions {
  side: 'ours' | 'theirs';
}
export interface StashCreateOptions extends ProjectOptions {
  message?: string;
  includeUntracked?: boolean;
}
export interface StashRefOptions extends ProjectOptions {
  stashRef: string;
}
export interface FileHistoryOptions extends FileOptions {
  limit?: number;
}
export interface BlameOptions extends FileOptions {
  ref?: string;
  limit?: number;
}
export interface GraphOptions extends ProjectOptions {
  limit?: number;
}
export interface RemoteInfo {
  name: string;
  url: string;
}

export interface CreateWorktreeOptions extends ProjectOptions {
  baseRef?: string;
  worktreePath: string;
  branch?: string;
  detach?: boolean;
}

export interface RemoveWorktreeOptions extends ProjectOptions {
  worktreePath: string;
  force?: boolean;
}

export interface CommitIndexOptions extends ProjectOptions {
  message: string;
}

export interface StagePathsOptions extends ProjectOptions {
  paths: string[];
  mode: GitStageMode;
}

export interface RevertCommitOptions extends ProjectOptions {
  commit: string;
}

export interface GitService {
  getStatus(options: ProjectOptions): Promise<unknown>;
  getDiff(options: FileOptions): Promise<unknown>;
  getFileWithDiff(options: FileOptions): Promise<unknown>;
  initialCommit(options: ProjectOptions): Promise<unknown>;
  commit(options: CommitOptions): Promise<unknown>;
  getBranches(options: ProjectOptions): Promise<unknown>;
  getRefs(options: GitRefsOptions): Promise<GitRefsResponse>;
  checkout(options: CheckoutOptions): Promise<unknown>;
  createBranch(options: BranchOptions): Promise<unknown>;
  generateCommitMessageForFiles(
    options: CommitMessageFileOptions,
  ): Promise<CommitMessageGenerationResult>;
  getRemoteStatus(options: ProjectOptions): Promise<unknown>;
  getRemotes(options: ProjectOptions): Promise<unknown>;
  fetch(options: ProjectOptions): Promise<unknown>;
  pull(options: ProjectOptions): Promise<unknown>;
  push(options: PushOptions): Promise<unknown>;
  discard(options: FileOptions): Promise<unknown>;
  deleteUntracked(options: FileOptions): Promise<unknown>;
  getWorkbenchSnapshot(options: GitWorkbenchSnapshotOptions): Promise<GitWorkbenchSnapshotResponse>;
  getWorkingTreeFingerprint(
    options: GitWorkingTreeFingerprintOptions,
  ): Promise<GitWorkingTreeFingerprintResponse>;
  getQuickSummary(options: GitQuickSummaryOptions): Promise<GitQuickSummaryResponse>;
  getReviewFileBodies(options: ReviewFileBodiesOptions): Promise<GitReviewFileBodiesResponse>;
  getHistoryCommits(options: GitHistoryCommitListOptions): Promise<GitHistoryCommitListResponse>;
  getCommitSnapshot(options: GitCommitSnapshotOptions): Promise<GitCommitSnapshotResponse>;
  getCommitFileBodies(options: GitCommitFileBodiesOptions): Promise<GitCommitFileBodiesResponse>;
  getComparisonSnapshot(
    options: GitComparisonSnapshotOptions,
  ): Promise<GitComparisonSnapshotResponse>;
  getComparisonFileBodies(
    options: GitComparisonFileBodiesOptions,
  ): Promise<GitComparisonFileBodiesResponse>;
  stageSelection(options: StageSelectionOptions): Promise<unknown>;
  stageHunk(options: StageHunkOptions): Promise<unknown>;
  getConflicts(options: ProjectOptions): Promise<{ conflicts: GitConflictFile[] }>;
  getConflictDetails(options: ConflictDetailsOptions): Promise<GitConflictDetails>;
  acceptConflictSide(options: ConflictAcceptOptions): Promise<unknown>;
  markConflictResolved(options: FileOptions): Promise<unknown>;
  getStashes(options: ProjectOptions): Promise<{ stashes: GitStashEntry[] }>;
  createStash(options: StashCreateOptions): Promise<unknown>;
  applyStash(options: StashRefOptions): Promise<unknown>;
  popStash(options: StashRefOptions): Promise<unknown>;
  dropStash(options: StashRefOptions): Promise<unknown>;
  getFileHistory(options: FileHistoryOptions): Promise<{ commits: GitFileHistoryEntry[] }>;
  getBlame(options: BlameOptions): Promise<{ lines: GitBlameLine[]; truncated: boolean }>;
  getGraph(options: GraphOptions): Promise<{ commits: GitGraphCommit[] }>;
  getRepoInfo(options: ProjectOptions): Promise<RepoInfo>;
  getWorktrees(options: ProjectOptions): Promise<{ worktrees: WorktreeInfo[] }>;
  getTargetCandidates(options: ProjectOptions): Promise<{ targets: TargetCandidate[] }>;
  createWorktree(options: CreateWorktreeOptions): Promise<unknown>;
  removeWorktree(options: RemoveWorktreeOptions): Promise<unknown>;
  commitIndex(options: CommitIndexOptions): Promise<unknown>;
  stagePaths(options: StagePathsOptions): Promise<unknown>;
  revertCommit(options: RevertCommitOptions): Promise<unknown>;
  toHttpError(error: unknown): Response;
}
