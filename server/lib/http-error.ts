import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type { HttpErrorResponse } from '../../common/http-error.ts';
import { isDomainError, transcriptUnavailableMessage } from './domain-error.js';
import { createLogger } from './log.js';

const logger = createLogger('http:error');

export const DEFAULT_VALIDATION_ERROR_CODE = 'VALIDATION_FAILED';
export const DEFAULT_INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';
const DEFAULT_INTERNAL_ERROR_MESSAGE = 'Internal server error';

export function defaultErrorCodeForStatus(status: number): string {
  return status >= 500 ? DEFAULT_INTERNAL_ERROR_CODE : DEFAULT_VALIDATION_ERROR_CODE;
}

export function defaultRetryableForStatus(status: number): boolean {
  return status >= 500;
}

export function jsonError(
  error: string,
  status: number,
  errorCode = defaultErrorCodeForStatus(status),
  retryable = defaultRetryableForStatus(status),
  details?: string,
): Response {
  const payload: HttpErrorResponse = {
    success: false,
    error,
    errorCode,
    retryable,
  };
  if (details !== undefined) payload.details = details;
  return Response.json(payload, { status });
}

export function jsonErrorFromUnknown(
  error: unknown,
  status = 500,
  errorCode = defaultErrorCodeForStatus(status),
  retryable = defaultRetryableForStatus(status),
): Response {
  if (error instanceof AgentIntegrationError && error.code === 'TRANSCRIPT_UNAVAILABLE') {
    return jsonError(
      transcriptUnavailableMessage(error.retryable),
      503,
      error.code,
      error.retryable,
    );
  }
  if (isDomainError(error)) {
    return jsonError(error.message, error.status, error.code, error.retryable);
  }
  // An untyped failure answered with an opaque 500 would otherwise leave no
  // server-side trace at all.
  if (status >= 500) {
    logger.error('Unhandled route error:', error as Error);
  }
  const message = status >= 500
    ? DEFAULT_INTERNAL_ERROR_MESSAGE
    : error instanceof Error ? error.message : String(error);
  return jsonError(message, status, errorCode, retryable);
}
