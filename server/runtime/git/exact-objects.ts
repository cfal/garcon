import { devNull } from 'node:os';
import { GitServiceError } from '../../../common/git-error.js';
import { readOnlyGitOptions, runGit, runGitWithStdin } from './run.js';
import { isGitCancellation } from './operation-context.js';
import type { GitCommandOptions } from './types.js';

// Exact delivery observes and transfers the same objects, independent of local history overlays.
function exactGitOptions(options: GitCommandOptions): GitCommandOptions {
  return { ...options, retryLocks: false,
    env: { ...options.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull, GIT_NO_LAZY_FETCH: '1' } };
}

export function runExactGit(projectPath: string, args: string[], options: GitCommandOptions = {}) {
  return runGit(projectPath, args, exactGitOptions(options));
}

export function runExactGitWithStdin(projectPath: string, args: string[], input: string, options: GitCommandOptions = {}) {
  return runGitWithStdin(projectPath, args, input, exactGitOptions(options));
}

export async function requireCompleteGitHistory(projectPath: string): Promise<void> {
  const result = await runExactGit(projectPath, ['rev-parse', '--is-shallow-repository'], readOnlyGitOptions());
  if (result.stdout.trim() !== 'false') {
    throw new GitServiceError('GIT_INVALID_INPUT', 'Exact delivery requires a non-shallow repository.');
  }
  try {
    await runExactGit(projectPath, ['config', '--name-only', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'],
      readOnlyGitOptions({ maxStdoutBytes: 64 * 1024 }));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1 && !isGitCancellation(error)) return;
    throw error;
  }
  throw new GitServiceError('GIT_INVALID_INPUT', 'Exact delivery requires a repository without partial-clone or promisor configuration.');
}

export async function requireExactCommit(projectPath: string, commit: string): Promise<void> {
  let observed: string;
  try {
    observed = (await runExactGit(projectPath, ['rev-parse', '--verify', `${commit}^{commit}`], readOnlyGitOptions())).stdout.trim();
  } catch (error) {
    if (isGitCancellation(error) || !(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') throw error;
    throw new GitServiceError('GIT_INVALID_INPUT', 'An exact commit object is required.');
  }
  if (observed !== commit) throw new GitServiceError('GIT_INVALID_INPUT', 'An exact commit object is required.');
}
