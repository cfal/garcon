import { createDiffEngine } from '../git/diff-engine.js';
import { createCommitHistoryOperations } from '../git/commit-history.js';
import { createComparisonOperations } from '../git/comparison.js';
import { createPorcelainOperations } from '../git/porcelain.js';
import { createStatusOperations } from '../git/status.js';
import { createWorktreeOperations } from '../git/worktrees.js';
import { createQuickSummaryOperations } from '../git/quick-summary.js';
import { GitReviewDocumentRegistry } from '../git/review-document-registry.js';
import { createReviewDocumentOperations } from '../git/review-document-service.js';
import type { ProjectOptions } from '../git/types.js';
import type { WorkspaceGitService } from '../execution-nodes/workspace-git.js';

interface LocalWorkspaceGitOptions {
  readonly assertProjectPathAllowed: (projectPath: string) => Promise<string>;
  readonly networkTimeoutMs: number;
}

export function createLocalWorkspaceGitService({
  assertProjectPathAllowed,
  networkTimeoutMs,
}: LocalWorkspaceGitOptions): WorkspaceGitService {
  const status = createStatusOperations({ networkTimeoutMs });
  const reviewRegistry = new GitReviewDocumentRegistry();
  const diff = createDiffEngine(reviewRegistry);
  const commitHistory = createCommitHistoryOperations(reviewRegistry);
  const comparison = createComparisonOperations(reviewRegistry, assertProjectPathAllowed);
  const reviewDocuments = createReviewDocumentOperations(reviewRegistry);
  const porcelain = createPorcelainOperations();
  const worktrees = createWorktreeOperations();
  const quickSummary = createQuickSummaryOperations();

  async function project<O extends ProjectOptions>(options: O): Promise<O> {
    const captured = { ...options };
    captured.signal?.throwIfAborted();
    const projectPath = await assertProjectPathAllowed(captured.projectPath);
    captured.signal?.throwIfAborted();
    return { ...captured, projectPath };
  }

  async function worktree<O extends ProjectOptions & { worktreePath: string }>(options: O): Promise<O> {
    const captured = await project(options);
    const worktreePath = await assertProjectPathAllowed(captured.worktreePath);
    captured.signal?.throwIfAborted();
    return { ...captured, worktreePath };
  }

  return {
    getStatus: async (options) => status.getStatus(await project(options)),
    initialCommit: async (options) => status.initialCommit(await project(options)),
    commit: async (options) => status.commit(await project(options)),
    getBranches: async (options) => status.getBranches(await project(options)),
    getRefs: async (options) => status.getRefs(await project(options)),
    checkout: async (options) => status.checkout(await project(options)),
    createBranch: async (options) => status.createBranch(await project(options)),
    getRemoteStatus: async (options) => status.getRemoteStatus(await project(options)),
    getRemotes: async (options) => status.getRemotes(await project(options)),
    fetch: async (options) => status.fetch(await project(options)),
    pull: async (options) => status.pull(await project(options)),
    push: async (options) => status.push(await project(options)),
    discard: async (options) => status.discard(await project(options)),
    deleteUntracked: async (options) => status.deleteUntracked(await project(options)),
    commitIndex: async (options) => status.commitIndex(await project(options)),
    stagePaths: async (options) => status.stagePaths(await project(options)),
    revertCommit: async (options) => status.revertCommit(await project(options)),
    getWorkbenchSnapshot: async (options) => diff.getWorkbenchSnapshot(await project(options)),
    getWorkingTreeFingerprint: async (options) => diff.getWorkingTreeFingerprint(await project(options)),
    stageSelection: async (options) => diff.stageSelection(await project(options)),
    stageHunk: async (options) => diff.stageHunk(await project(options)),
    getHistoryCommits: async (options) => commitHistory.getHistoryCommits(await project(options)),
    getCommitSnapshot: async (options) => commitHistory.getCommitSnapshot(await project(options)),
    getComparisonSnapshot: async (options) => comparison.getComparisonSnapshot(await project(options)),
    getComparisonFreshness: async (options) => comparison.getComparisonFreshness(await project(options)),
    getReviewDocumentFileBodies: async (options) => reviewDocuments.getReviewDocumentFileBodies(await project(options)),
    getConflicts: async (options) => porcelain.getConflicts(await project(options)),
    getConflictDetails: async (options) => porcelain.getConflictDetails(await project(options)),
    acceptConflictSide: async (options) => porcelain.acceptConflictSide(await project(options)),
    markConflictResolved: async (options) => porcelain.markConflictResolved(await project(options)),
    getStashes: async (options) => porcelain.getStashes(await project(options)),
    createStash: async (options) => porcelain.createStash(await project(options)),
    applyStash: async (options) => porcelain.applyStash(await project(options)),
    popStash: async (options) => porcelain.popStash(await project(options)),
    dropStash: async (options) => porcelain.dropStash(await project(options)),
    getFileHistory: async (options) => porcelain.getFileHistory(await project(options)),
    getBlame: async (options) => porcelain.getBlame(await project(options)),
    getGraph: async (options) => porcelain.getGraph(await project(options)),
    getRepoInfo: async (options) => worktrees.getRepoInfo(await project(options)),
    getWorktrees: async (options) => worktrees.getWorktrees(await project(options)),
    getTargetCandidates: async (options) => worktrees.getTargetCandidates(await project(options)),
    createWorktree: async (options) => worktrees.createWorktree(await worktree(options)),
    removeWorktree: async (options) => worktrees.removeWorktree(await worktree(options)),
    getQuickSummary: async (options) => quickSummary.getQuickSummary(await project(options)),
    captureCommitMessageSource: async (options) => status.captureCommitMessageSource(
      await project({ ...options, files: Array.isArray(options.files) ? [...options.files] : options.files }),
    ),
  } satisfies WorkspaceGitService;
}
