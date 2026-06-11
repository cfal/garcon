import type { HttpErrorResponse } from '../../common/http-error.ts';

export const DEFAULT_VALIDATION_ERROR_CODE = 'VALIDATION_FAILED';
export const DEFAULT_INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';

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
  const message = error instanceof Error ? error.message : String(error);
  return jsonError(message, status, errorCode, retryable);
}

