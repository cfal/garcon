import { GitServiceError, isGitServiceErrorCode } from '../../common/git-error.js';
import { AgentCallError } from '@garcon/server-agent-interface';
import { isProjectBoundaryError } from '../lib/path-boundary.js';
import { GitDomainError } from './git-types.js';
import { GhDomainError } from '../gh/gh-types.js';
import { classifyGitError } from './git-error-classifier.js';
import { classifyGhError } from '../gh/gh-error-classifier.js';
import { GitOutputLimitError } from './run.js';
import { GhOutputLimitError } from '../gh/run.js';

export function gitServiceError(error: unknown, domain: 'git' | 'gh' = 'git'): Error {
  if (error instanceof GitServiceError || error instanceof AgentCallError) return error;
  if (domain === 'git' && error instanceof Error && /Executable not found.*git|command not found.*git/i.test(error.message)) return new GitServiceError('GIT_MISSING', 'Git is not installed on this execution node');
  if (isProjectBoundaryError(error)) return new GitServiceError('GIT_OUTSIDE_BASE', error.message);
  if (error instanceof GitOutputLimitError || error instanceof GhOutputLimitError) return new GitServiceError('GIT_RESULT_TOO_LARGE', 'Git result exceeds the operation limit');
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return new GitServiceError('GIT_TIMEOUT', 'Git operation expired or was cancelled');
  const classified = domain === 'git' ? classifyGitError(error) : classifyGhError(error);
  const originalCode = error instanceof GitDomainError || error instanceof GhDomainError ? error.code : classified.code;
  const candidate = originalCode === 'GIT_LOCKED' || originalCode === 'GH_MISSING' ? originalCode : `${domain.toUpperCase()}_${originalCode}`;
  const code = isGitServiceErrorCode(candidate) ? candidate : domain === 'git' ? 'GIT_OPERATION_FAILED' : 'GH_OPERATION_FAILED';
  const message = error instanceof GitDomainError || error instanceof GhDomainError ? error.message : classified.message;
  return new GitServiceError(code, message.replace(/(?:https?|ssh):\/\/\S+/g, '<remote>').slice(0, 2048));
}
