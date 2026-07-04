import { GitDomainError } from './git-types.js';
import { readOnlyGitOptions, runGit } from './run.js';

export function assertSafeRef(ref: string, label: string): void {
  if (
    !ref ||
    ref.startsWith('-') ||
    ref.includes('..') ||
    ref.includes(':') ||
    /[\s\0-\x1f\x7f]/.test(ref) ||
    !/^[A-Za-z0-9._/@{}~^+-]+$/.test(ref)
  ) {
    throw new GitDomainError('INVALID_INPUT', `Invalid ${label} ref.`);
  }
}

export async function assertExistingCommitRef(
  projectPath: string,
  ref: string,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  assertSafeRef(ref, label);
  try {
    await runGit(
      projectPath,
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      readOnlyGitOptions({ signal }),
    );
  } catch {
    throw new GitDomainError('INVALID_INPUT', `Invalid ${label} ref.`);
  }
}

export async function assertSafeBranchName(
  projectPath: string,
  branch: string,
  label = 'branch name',
  signal?: AbortSignal,
): Promise<void> {
  if (
    !branch ||
    branch !== branch.trim() ||
    branch.startsWith('-') ||
    branch.includes('..') ||
    branch.includes(':') ||
    /[\s\0-\x1f\x7f]/.test(branch)
  ) {
    throw new GitDomainError('INVALID_INPUT', `Invalid ${label}.`);
  }

  try {
    await runGit(
      projectPath,
      ['check-ref-format', '--branch', branch],
      readOnlyGitOptions({ signal }),
    );
  } catch {
    throw new GitDomainError('INVALID_INPUT', `Invalid ${label}.`);
  }
}
