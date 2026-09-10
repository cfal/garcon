import { GitDomainError } from '../git/git-types.js';
import { classifyGitError, type ClassifiedGitError } from '../git/git-error-classifier.js';
import type { CommitMessageErrorCode } from '../git/types.js';
import { isProjectBoundaryError, projectBoundaryErrorResponse } from '../lib/path-boundary.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('routes:git');
const COMMIT_MESSAGE_ERROR_MAP = Object.freeze({
  COMMIT_MESSAGE_NO_STAGED_FILES: { status: 400, errorCode: 'commit_message_no_staged_files' },
  COMMIT_MESSAGE_AGENT_AUTH_REQUIRED: { status: 401, errorCode: 'commit_message_agent_auth_required' },
  COMMIT_MESSAGE_RATE_LIMITED: { status: 429, errorCode: 'commit_message_rate_limited' },
  COMMIT_MESSAGE_AGENT_UNAVAILABLE: { status: 503, errorCode: 'commit_message_agent_unavailable' },
  COMMIT_MESSAGE_TIMEOUT: { status: 504, errorCode: 'commit_message_timeout' },
  COMMIT_MESSAGE_EMPTY_RESPONSE: { status: 502, errorCode: 'commit_message_empty_response' },
  COMMIT_MESSAGE_INVALID_RESPONSE: { status: 502, errorCode: 'commit_message_invalid_response' },
  COMMIT_MESSAGE_GENERATION_FAILED: { status: 500, errorCode: 'commit_message_generation_failed' },
} satisfies Record<CommitMessageErrorCode, { status: number; errorCode: string }>);

function isCommitMessageErrorCode(code: string): code is CommitMessageErrorCode {
  return Object.prototype.hasOwnProperty.call(COMMIT_MESSAGE_ERROR_MAP, code);
}

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

export function gitErrorResponse(error: unknown): Response {
  if (isProjectBoundaryError(error)) return projectBoundaryErrorResponse();
  logger.error('[git]', error);
  return error instanceof GitDomainError
    ? gitDomainErrorToResponse(error)
    : classifiedGitErrorToResponse(classifyGitError(error));
}
