import type { AgentId } from '../../common/agents.ts';
import type { ApiProtocol } from '../../common/api-providers.js';

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitProcessError extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}

export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
export type GitReviewMode = 'working' | 'staged';
export type GitStageMode = 'stage' | 'unstage';
export type RevertStrategy = 'revert' | 'reset-soft';

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
}

export type TreeMap = Map<string, TreeNode>;

export interface DiffOp {
  type: 'delete' | 'insert' | 'equal';
  before: [number, number];
  after: [number, number];
}

export interface DiffHunkMetadata {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lineStartIndex: number;
  lineEndIndex: number;
}

export interface ParsedUnifiedPatch {
  diffOps: DiffOp[];
  hunks: DiffHunkMetadata[];
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

export interface ReviewTruncation {
  truncated: boolean;
  truncatedReason?: string;
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
}

export interface BatchFileReviewOptions extends ProjectOptions {
  files: string[];
  mode?: GitReviewMode;
  context?: number;
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
  files: Record<string, unknown>;
  errors: Record<string, string>;
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
  getFileReviewData(options: FileReviewOptions): Promise<unknown>;
  getFileReviewDataBatch(options: BatchFileReviewOptions): Promise<unknown>;
  getChangesTree(options: ProjectOptions): Promise<unknown>;
  stageSelection(options: StageSelectionOptions): Promise<unknown>;
  stageHunk(options: StageHunkOptions): Promise<unknown>;
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

