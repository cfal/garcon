import type { GitProcessError } from './types.js';

export function isExpectedMissingGitResult(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const processError = error as Partial<GitProcessError>;
  return processError.code === 1 && !processError.timedOut && !processError.aborted;
}
