import type { GitProcessError } from './types.js';

export function isExpectedMissingGitResult(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const processError = error as Partial<GitProcessError>;
  return processError.code === 1 && !processError.timedOut && !processError.aborted;
}

export function isUnresolvedRevision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const processError = error as Partial<GitProcessError>;
  if (processError.timedOut || processError.aborted) return false;
  if (processError.code === 1) return true;
  if (processError.code !== 128) return false;
  const stderr = processError.stderr?.trim() ?? '';
  return /^fatal: log for '.+' only has \d+ entries$/.test(stderr);
}

export function needsRevisionFailureDiagnostics(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const processError = error as Partial<GitProcessError>;
  return (
    processError.code === 128 &&
    !processError.timedOut &&
    !processError.aborted &&
    !processError.stdout?.trim() &&
    !processError.stderr?.trim()
  );
}
