import { createDiffEngine } from './diff-engine.js';
import { createCommitHistoryOperations } from './commit-history.js';
import { createComparisonOperations } from './comparison.js';
import { createPorcelainOperations } from './porcelain.js';
import { createStatusOperations } from './status.js';
import { createWorktreeOperations } from './worktrees.js';
import { createQuickSummaryOperations } from './quick-summary.js';
import { GitReviewDocumentRegistry } from './review-document-registry.js';
import { createReviewDocumentOperations } from './review-document-service.js';
import type { GitOperations } from './types.js';


export function createGitOperations({ assertProjectPathAllowed, reviewRegistry = new GitReviewDocumentRegistry() }: {
  assertProjectPathAllowed?(projectPath: string): Promise<string>;
  reviewRegistry?: GitReviewDocumentRegistry;
} = {}): GitOperations {
  const status = createStatusOperations();
  const diff = createDiffEngine(reviewRegistry);
  const commitHistory = createCommitHistoryOperations(reviewRegistry);
  const comparison = createComparisonOperations(reviewRegistry, assertProjectPathAllowed);
  const reviewDocuments = createReviewDocumentOperations(reviewRegistry);
  const porcelain = createPorcelainOperations();
  const worktrees = createWorktreeOperations({ assertProjectPathAllowed });
  const quickSummary = createQuickSummaryOperations();

  return {
    ...status,
    ...diff,
    ...commitHistory,
    ...comparison,
    ...reviewDocuments,
    ...porcelain,
    ...worktrees,
    ...quickSummary,
  };
}
