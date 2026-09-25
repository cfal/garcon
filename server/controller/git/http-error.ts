import { GitDomainError } from '../../runtime/git/git-types.js';
import { COMMIT_MESSAGE_ERROR_MAP, isCommitMessageErrorCode } from './commit-message.js';
import type { ClassifiedGitError } from '../../runtime/git/types.js';
import { createLogger } from '../../common/log.js';

const logger = createLogger('git:git-service');

function gitDomainErrorToResponse(error: GitDomainError): Response {
  const code = error.code;
  if (isCommitMessageErrorCode(code)) {
    const entry = COMMIT_MESSAGE_ERROR_MAP[code];
    return Response.json(
      { error: error.message, errorCode: entry.errorCode },
      { status: entry.status },
    );
  }
  if (code === 'INVALID_INPUT') return Response.json({ error: error.message }, { status: 400 });
  if (code === 'NOT_REPO') return Response.json({ error: error.message }, { status: 400 });
  if (code === 'AUTH_FAILED') return Response.json({ error: error.message }, { status: 401 });
  if (code === 'SERVICE_BUSY') {
    return Response.json(
      { error: error.message, errorCode: code, retryable: true },
      { status: 503 },
    );
  }
  return Response.json({ error: error.message }, { status: 500 });
}

function classifiedGitErrorToResponse(classified: ClassifiedGitError): Response {
  const body: { error: string; details?: unknown } = {
    error: classified.message,
  };
  if (classified.details) body.details = classified.details;
  return Response.json(body, { status: classified.status });
}

export function gitHttpError(error: unknown, classifyGitError: (error: unknown) => ClassifiedGitError): Response {
  logger.error('[git]', { code: error instanceof GitDomainError ? error.code : 'GIT_OPERATION_FAILED' });
  if (error instanceof GitDomainError) return gitDomainErrorToResponse(error);
  return classifiedGitErrorToResponse(classifyGitError(error));
}
