// Classifies raw gh CLI errors into structured objects with HTTP-appropriate
// status codes and user-facing messages. Used by the route layer when an error
// is not already a GhDomainError.

export type ClassifiedGhErrorCode =
  | 'GH_MISSING'
  | 'AUTH_FAILED'
  | 'NO_GITHUB_REMOTE'
  | 'NOT_REPO'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'UNKNOWN';

export interface ClassifiedGhError {
  code: ClassifiedGhErrorCode;
  status: number;
  message: string;
  details?: string;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'GitHub CLI operation failed.';
}

export function classifyGhError(error: unknown): ClassifiedGhError {
  const message = errorMessage(error);
  const text = message.toLowerCase();

  if (text.includes('gh) is not installed') || text.includes('command not found')) {
    return {
      code: 'GH_MISSING',
      status: 500,
      message: 'GitHub CLI (gh) is not installed.',
      details: 'Install gh and run "gh auth login" to view pull requests.',
    };
  }

  if (
    text.includes('gh auth login') ||
    text.includes('not logged') ||
    text.includes('authentication') ||
    text.includes('requires authentication') ||
    text.includes('bad credentials')
  ) {
    return {
      code: 'AUTH_FAILED',
      status: 401,
      message: 'GitHub CLI is not authenticated.',
      details: 'Run: gh auth login',
    };
  }

  if (
    text.includes('none of the git remotes') ||
    text.includes('no git remotes') ||
    text.includes('not a github repository')
  ) {
    return {
      code: 'NO_GITHUB_REMOTE',
      status: 400,
      message: 'This repository has no GitHub remote.',
      details: 'Add a GitHub remote to view pull requests.',
    };
  }

  if (text.includes('not a git repository') || text.includes('git is not initialized')) {
    return { code: 'NOT_REPO', status: 400, message: 'Path is not a Git repository.' };
  }

  if (
    text.includes('could not resolve to a pullrequest') ||
    text.includes('no pull requests found') ||
    text.includes('not found')
  ) {
    return { code: 'NOT_FOUND', status: 404, message: 'Pull request not found.' };
  }

  if (text.includes('api rate limit') || text.includes('rate limit exceeded')) {
    return {
      code: 'RATE_LIMITED',
      status: 429,
      message: 'GitHub API rate limit exceeded.',
      details: 'Wait a few minutes and try again.',
    };
  }

  if (
    text.includes('could not resolve host') ||
    text.includes('network is unreachable') ||
    text.includes('timed out')
  ) {
    return {
      code: 'NETWORK',
      status: 502,
      message: 'Could not reach GitHub.',
      details: 'Verify network access and try again.',
    };
  }

  return { code: 'UNKNOWN', status: 500, message };
}
