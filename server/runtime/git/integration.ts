import type { IntegrateCommitsResult } from '../../../common/git-delivery.js';
import { GitServiceError } from '../../../common/git-error.js';
import { createDeliveryOperations } from './delivery.js';
import { createManagedWorktreeOperations } from './managed-worktrees.js';
import { runExactGit } from './exact-objects.js';
import { isGitCancellation } from './operation-context.js';
import { readOnlyGitOptions } from './run.js';
import type { GitOperationOptions } from './types.js';

export function createIntegrationOperations() {
  const { inspectManagedWorktree } = createManagedWorktreeOperations();
  const { inspectCommit } = createDeliveryOperations();

  async function integrateCommits(input: GitOperationOptions<'integrateCommits'>): Promise<IntegrateCommitsResult> {
    if (input.expectedBranch.includes('=')) throw new GitServiceError('GIT_INVALID_INPUT', 'Integration requires a branch name without config delimiters.');
    const before = (await inspectManagedWorktree(input).catch(error => {
      if (error instanceof GitServiceError && error.code === 'GIT_MUTATION_OUTCOME_UNKNOWN') {
        throw new GitServiceError('GIT_INVALID_INPUT', 'Integration requires confirmed managed ownership.');
      }
      throw error;
    })).managed;
    if (!before || before.repositoryIdentity !== input.expectedRepositoryIdentity || before.worktreeIdentity !== input.expectedWorktreeIdentity
      || before.branch !== input.expectedBranch || before.head !== input.expectedHead || before.dirty) {
      throw new GitServiceError('GIT_INVALID_INPUT', 'Integration requires the exact clean managed worktree.');
    }
    for (const commit of input.commits) await inspectCommit({ projectPath: input.worktreePath, commit, ancestor: null });
    let dispatched = false;
    try {
      for (const commit of input.commits) {
        input.signal?.throwIfAborted();
        dispatched = true;
        try {
          await runExactGit(input.worktreePath, ['-c', 'rerere.enabled=false', '-c', 'merge.default=', '-c', `branch.${input.expectedBranch}.mergeOptions=`,
            'merge', '--strategy=ort', '--ff', '--no-verify-signatures',
            '--no-edit', '--no-gpg-sign', '--no-autostash', '--no-overwrite-ignore', '--', commit]);
        } catch (error) {
          if (isGitCancellation(error)) throw error;
          const conflicts = (await runExactGit(input.worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z'],
            readOnlyGitOptions({ maxStdoutBytes: 64 * 1024 }))).stdout.split('\0').filter(Boolean);
          if (!conflicts.length || conflicts.length > 1024) throw error;
          const managed = (await inspectManagedWorktree(input)).managed;
          if (!managed) throw error;
          return { kind: 'conflicts', managed, paths: conflicts };
        }
      }
      const managed = (await inspectManagedWorktree(input)).managed;
      if (!managed || managed.dirty) throw new Error('Integrated worktree is not clean.');
      for (const commit of [input.expectedHead, ...input.commits]) {
        if (!(await inspectCommit({ projectPath: input.worktreePath, commit: managed.head, ancestor: commit })).containsAncestor) {
          throw new Error('Integration lineage changed.');
        }
      }
      return { kind: 'integrated', managed };
    } catch (error) {
      if (!dispatched) throw error;
      return { kind: 'unknown', reason: 'Integration could not be confirmed. Retain the worktree and reconcile without repeating the merge.' };
    }
  }

  return { integrateCommits };
}
