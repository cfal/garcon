import { GitServiceError, isGitServiceErrorCode } from '../../../common/git-error.js';
import { AgentCallError } from '@garcon/server-agent-interface';
import { isProjectBoundaryError } from '../../common/path-boundary.js';
import { GIT_ERROR_MESSAGE_LIMIT, GitDomainError } from './git-domain-error.js';
import { GhDomainError } from '../gh/gh-types.js';
import { classifyGitError } from './git-error-classifier.js';
import { classifyGhError } from '../gh/gh-error-classifier.js';
import { GitOutputLimitError } from './run.js';
import { GhOutputLimitError } from '../gh/run.js';
import { isGitCancellation } from './operation-context.js';
import { hasNodeErrorCode } from '../../common/errors.js';

type Domain = 'git' | 'gh';

function boundedServiceError(domain: Domain, { code, message }: { code: string; message: string }): GitServiceError {
  const candidate = code === 'GIT_LOCKED' || code === 'GH_MISSING' ? code : `${domain.toUpperCase()}_${code}`;
  const fallback = domain === 'git' ? 'GIT_OPERATION_FAILED' : 'GH_OPERATION_FAILED';
  const serviceCode = isGitServiceErrorCode(candidate) ? candidate : fallback;
  const redacted = message.includes('://') ? message.replace(/\S+/g, word => word.includes('://') ? '<remote>' : word) : message;
  return new GitServiceError(serviceCode, redacted.slice(0, GIT_ERROR_MESSAGE_LIMIT));
}

export function gitServiceError(error: unknown, domain: Domain = 'git'): Error {
  if (error instanceof GitServiceError || error instanceof AgentCallError) return error;
  if (error instanceof GitDomainError || error instanceof GhDomainError) return boundedServiceError(domain, error);
  if (domain === 'git' && error instanceof Error && /Executable not found.*git|command not found.*git/i.test(error.message)) return new GitServiceError('GIT_MISSING', 'Git is not installed on this executor');
  if (hasNodeErrorCode(error, 'ENOENT') || hasNodeErrorCode(error, 'ENOTDIR')) return new GitServiceError('GIT_INVALID_INPUT', 'Git path is unavailable');
  if (isProjectBoundaryError(error)) return new GitServiceError('GIT_OUTSIDE_BASE', error.message);
  if (error instanceof GitOutputLimitError || error instanceof GhOutputLimitError) return new GitServiceError('GIT_RESULT_TOO_LARGE', 'Git result exceeds the operation limit');
  if (isGitCancellation(error)) return new GitServiceError('GIT_TIMEOUT', 'Git operation expired or was cancelled');
  return boundedServiceError(domain, domain === 'git' ? classifyGitError(error) : classifyGhError(error));
}
