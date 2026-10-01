import { GitDomainError } from '../../runtime/git/git-domain-error.js';
import { COMMIT_MESSAGE_ERROR_MAP, isCommitMessageErrorCode } from './commit-message.js';
import type { ClassifiedGitError } from '../../runtime/git/git-error-classifier.js';
import { createLogger } from '../../common/log.js';
import { jsonError } from '../../common/http-error.js';

const logger = createLogger('git:git-service');

function gitDomainErrorToResponse(error: GitDomainError): Response {
  const code = error.code;
  if (isCommitMessageErrorCode(code)) {
    const entry = COMMIT_MESSAGE_ERROR_MAP[code];
    return jsonError(error.message, entry.status, entry.errorCode);
  }
  if (code === 'INVALID_INPUT' || code === 'NOT_REPO') return jsonError(error.message, 400);
  if (code === 'AUTH_FAILED') return jsonError(error.message, 401);
  if (code === 'SERVICE_BUSY') return jsonError(error.message, 503, code, true);
  return jsonError(error.message, 500);
}

function classifiedGitErrorToResponse(classified: ClassifiedGitError): Response {
  return jsonError(classified.message, classified.status, undefined, undefined, classified.details || undefined);
}

export function gitHttpError(error: unknown, classifyGitError: (error: unknown) => ClassifiedGitError): Response {
  logger.error('[git]', { code: error instanceof GitDomainError ? error.code : 'GIT_OPERATION_FAILED' });
  if (error instanceof GitDomainError) return gitDomainErrorToResponse(error);
  return classifiedGitErrorToResponse(classifyGitError(error));
}
