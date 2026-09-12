import type { Issue, IssueComment, IssueErrorCode } from '../../common/issues.js';
import { IssueValidationError } from '../../common/issue-validation.js';
import { DomainError } from '../lib/domain-error.js';

export const ISSUE_ERROR_POLICY: Readonly<Record<IssueErrorCode, { status: number; retryable: boolean }>> = {
  ISSUE_VALIDATION_FAILED: { status: 400, retryable: false },
  ISSUE_UNAUTHORIZED: { status: 401, retryable: false },
  ISSUE_FORBIDDEN: { status: 403, retryable: false },
  ISSUE_COMMANDS_DISABLED: { status: 403, retryable: false },
  ISSUE_NOT_FOUND: { status: 404, retryable: false },
  ISSUE_COMMENT_NOT_FOUND: { status: 404, retryable: false },
  ISSUE_CHAT_NOT_FOUND: { status: 404, retryable: false },
  ISSUE_STORE_CHANGED: { status: 409, retryable: false },
  ISSUE_REVISION_CONFLICT: { status: 409, retryable: false },
  ISSUE_COMMENT_REVISION_CONFLICT: { status: 409, retryable: false },
  ISSUE_ALREADY_CLAIMED: { status: 409, retryable: false },
  ISSUE_REQUEST_CONFLICT: { status: 409, retryable: false },
  ISSUE_COLLECTION_CHANGED: { status: 409, retryable: true },
  ISSUE_RELATIONSHIP_CYCLE: { status: 409, retryable: false },
  ISSUE_INVALID_TRANSITION: { status: 409, retryable: false },
  ISSUE_LIMIT_REACHED: { status: 409, retryable: false },
  ISSUE_SOURCE_UNAVAILABLE: { status: 409, retryable: false },
  ISSUE_REQUEST_TOO_LARGE: { status: 413, retryable: false },
  ISSUE_RESULT_TOO_LARGE: { status: 413, retryable: false },
  ISSUE_PROJECT_UNAVAILABLE: { status: 503, retryable: true },
  ISSUE_STORAGE_UNAVAILABLE: { status: 503, retryable: false },
  ISSUE_INTERNAL_ERROR: { status: 500, retryable: false },
};

export class IssueDomainError extends DomainError {
  override readonly code: IssueErrorCode;

  constructor(code: IssueErrorCode, message: string,
    readonly currentIssue?: Issue, readonly currentComment?: IssueComment) {
    const policy = ISSUE_ERROR_POLICY[code];
    super(code, message, policy.status, policy.retryable);
    this.code = code;
    this.name = 'IssueDomainError';
  }
}

export function validateIssueInput<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) {
    if (error instanceof IssueValidationError) throw new IssueDomainError('ISSUE_VALIDATION_FAILED', error.message);
    throw error;
  }
}

export function issueStorageUnavailable(): IssueDomainError {
  return new IssueDomainError('ISSUE_STORAGE_UNAVAILABLE', 'Issue storage is unavailable. Restart the server or restore a valid database.');
}

export function nextIssueCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER - 1) {
    throw new IssueDomainError('ISSUE_LIMIT_REACHED', 'The issue counter limit has been reached.');
  }
  return value + 1;
}
