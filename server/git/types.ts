import type { AgentId } from '../../common/agents.ts';
import type { ApiProtocol } from '../../common/api-providers.js';

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
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
export type RevertStrategy = 'revert' | 'reset-soft';
export type GitFileReviewCategory = 'normal' | 'generated' | 'lockfile' | 'binary' | 'large';
export type GitReviewDataProfile = 'all-files-preview' | 'all-files-full';
export type GitDiffLimitReason =
  | 'patch-too-large'
  | 'too-many-rows'
  | 'line-too-long'
  | 'binary'
  | 'unsupported-file-kind';

export const GIT_DIFF_LIMITS = Object.freeze({
  maxBatchFiles: 64,
  maxContextLines: 50,
  maxPatchBytes: 1_000_000,
  maxRenderedRows: 20_000,
  maxLineBytes: 20_000,
});

export interface GitReviewProfileLimits {
  maxBatchFiles: number;
  maxPatchBytes: number;
  maxRenderedRows: number;
  maxLineBytes: number;
  keepRowsWhenTruncated: boolean;
}

export const GIT_REVIEW_PROFILE_LIMITS = Object.freeze<Record<GitReviewDataProfile, GitReviewProfileLimits>>({
  'all-files-preview': {
    maxBatchFiles: 8,
    maxPatchBytes: 256_000,
    maxRenderedRows: 600,
    maxLineBytes: 8_000,
    keepRowsWhenTruncated: true,
  },
  'all-files-full': {
    maxBatchFiles: GIT_DIFF_LIMITS.maxBatchFiles,
    maxPatchBytes: GIT_DIFF_LIMITS.maxPatchBytes,
    maxRenderedRows: 2_000,
    maxLineBytes: GIT_DIFF_LIMITS.maxLineBytes,
    keepRowsWhenTruncated: true,
  },
});

export interface DiffStats {
  additions: number;
  deletions: number;
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
}

export interface ProjectOptions {
  projectPath: string;
  trace?: GitCommandTrace[];
  signal?: AbortSignal;
}

export type GitTreeStatsState = 'pending' | 'loaded';

export interface ChangesTreeOptions extends ProjectOptions {
  includeStats?: boolean;
}

export interface ChangesStatsOptions extends ProjectOptions {
  skipRepositoryAssert?: boolean;
}

export interface ChangesTreeResult {
  root: TreeNode[];
  hasCommits: boolean;
  statsState: GitTreeStatsState;
}

export interface ChangesStatsResult {
  working: NumstatMap;
  staged: NumstatMap;
}

export interface FileOptions extends ProjectOptions {
  file: string;
}

export interface CommitOptions extends ProjectOptions {
  message: string;
  files: string[];
}

export interface BranchOptions extends ProjectOptions {
  branch: string;
}

export interface CommitListOptions extends ProjectOptions {
  limit: string | number;
}

export interface CommitDiffOptions extends ProjectOptions {
  commit: string;
}

export interface CommitMessageFileOptions extends ProjectOptions, CommitMessageOptions {
  files: string[];
  agentId: AgentId;
}

export interface PushOptions extends ProjectOptions {
  remote?: string;
  remoteBranch?: string;
}

export interface FileReviewOptions extends FileOptions {
  mode?: GitReviewMode;
  context?: number;
  profile?: GitReviewDataProfile;
  signal?: AbortSignal;
}

export interface BatchFileReviewOptions extends ProjectOptions {
  files: string[];
  mode?: GitReviewMode;
  context?: number;
  profile?: GitReviewDataProfile;
  signal?: AbortSignal;
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
  profile?: GitReviewDataProfile;
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

export interface BatchReviewResult {
  files: Record<string, GitFileReviewData>;
  errors: Record<string, string>;
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

export interface GitCompareFile {
  path: string;
  status: string;
  originalPath?: string;
  additions: number;
  deletions: number;
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
export interface CompareOptions extends ProjectOptions {
  base: string;
  head: string;
}

export interface CommitSummary {
  hash: string;
  author: string;
  email: string;
  date: string;
  message: string;
  stats?: string;
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

export interface StageFileOptions extends FileOptions {
  mode: GitStageMode;
}

export interface RevertLastCommitOptions extends ProjectOptions {
  strategy?: RevertStrategy;
}

export interface GitService {
  getStatus(options: ProjectOptions): Promise<unknown>;
  getDiff(options: FileOptions): Promise<unknown>;
  getFileWithDiff(options: FileOptions): Promise<unknown>;
  initialCommit(options: ProjectOptions): Promise<unknown>;
  commit(options: CommitOptions): Promise<unknown>;
  getBranches(options: ProjectOptions): Promise<unknown>;
  checkout(options: BranchOptions): Promise<unknown>;
  createBranch(options: BranchOptions): Promise<unknown>;
  getCommits(options: CommitListOptions): Promise<unknown>;
  getCommitDiff(options: CommitDiffOptions): Promise<unknown>;
  generateCommitMessageForFiles(options: CommitMessageFileOptions): Promise<unknown>;
  getRemoteStatus(options: ProjectOptions): Promise<unknown>;
  getRemotes(options: ProjectOptions): Promise<unknown>;
  fetch(options: ProjectOptions): Promise<unknown>;
  pull(options: ProjectOptions): Promise<unknown>;
  push(options: PushOptions): Promise<unknown>;
  discard(options: FileOptions): Promise<unknown>;
  deleteUntracked(options: FileOptions): Promise<unknown>;
  getFileReviewData(options: FileReviewOptions): Promise<GitFileReviewData>;
  getFileReviewDataBatch(options: BatchFileReviewOptions): Promise<BatchReviewResult>;
  getChangesTree(options: ChangesTreeOptions): Promise<unknown>;
  getChangesStats(options: ChangesStatsOptions): Promise<unknown>;
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
  getCompare(options: CompareOptions): Promise<{ files: GitCompareFile[] }>;
  getRepoInfo(options: ProjectOptions): Promise<RepoInfo>;
  getWorktrees(options: ProjectOptions): Promise<{ worktrees: WorktreeInfo[] }>;
  getTargetCandidates(options: ProjectOptions): Promise<{ targets: TargetCandidate[] }>;
  createWorktree(options: CreateWorktreeOptions): Promise<unknown>;
  removeWorktree(options: RemoveWorktreeOptions): Promise<unknown>;
  commitIndex(options: CommitIndexOptions): Promise<unknown>;
  stageFile(options: StageFileOptions): Promise<unknown>;
  revertLastCommit(options: RevertLastCommitOptions): Promise<unknown>;
  toHttpError(error: unknown): Response;
}
