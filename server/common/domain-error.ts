import type { ErrorCode } from '../../common/error-codes.ts';
import type { ProjectUnavailableReason } from '../../common/project-resolution.ts';
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, status = 400, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class ValidationDomainError extends DomainError {
  constructor(message: string) {
    super('VALIDATION_FAILED', message, 400);
    this.name = 'ValidationDomainError';
  }
}

export class ProjectUnavailableError extends DomainError {
  constructor(
    readonly projectPath: string,
    readonly reason: ProjectUnavailableReason,
  ) {
    super(
      'PROJECT_UNAVAILABLE',
      `Project folder unavailable (${reason}): ${projectPath}`,
      409,
      false,
    );
    this.name = 'ProjectUnavailableError';
  }
}
export const TRANSCRIPT_UNAVAILABLE_MESSAGE = 'Chat transcript is unavailable.';
export const TRANSCRIPT_TEMPORARILY_UNAVAILABLE_MESSAGE =
  'Chat transcript is temporarily unavailable. Retry the request.';

export function transcriptUnavailableMessage(retryable: boolean): string {
  return retryable
    ? TRANSCRIPT_TEMPORARILY_UNAVAILABLE_MESSAGE
    : TRANSCRIPT_UNAVAILABLE_MESSAGE;
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
