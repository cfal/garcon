export const GIT_ERROR_STATUS = {
  GIT_INVALID_INPUT: 400, GIT_NOT_REPO: 400, GIT_OUTSIDE_BASE: 403,
  GIT_AUTH_FAILED: 401, GIT_HOST_KEY: 502, GIT_NETWORK: 502,
  GIT_UNCOMMITTED_CHANGES: 409, GIT_DIVERGED: 409, GIT_CONFLICT: 409,
  GIT_NOTHING_TO_COMMIT: 400, GIT_REJECTED: 409, GIT_NO_UPSTREAM: 400,
  GIT_LOCKED: 409, GIT_SSH_MISSING: 502, GIT_NO_REMOTE: 400,
  GIT_STALE_DOCUMENT: 409, GIT_SERVICE_BUSY: 503, GIT_RESULT_TOO_LARGE: 413,
  GIT_INVALID_RESULT: 502, GIT_UNAVAILABLE: 503, GIT_TIMEOUT: 504,
  GIT_MUTATION_OUTCOME_UNKNOWN: 503, GIT_OPERATION_FAILED: 500, GIT_MISSING: 501,
  GH_MISSING: 501, GH_AUTH_FAILED: 401, GH_NO_GITHUB_REMOTE: 400, GH_NOT_REPO: 400,
  GH_NOT_FOUND: 404, GH_NETWORK: 502, GH_RATE_LIMITED: 429, GH_OPERATION_FAILED: 500,
} as const;

export type GitServiceErrorCode = keyof typeof GIT_ERROR_STATUS;

export function isGitServiceErrorCode(value: unknown): value is GitServiceErrorCode {
  return typeof value === 'string' && Object.hasOwn(GIT_ERROR_STATUS, value);
}

export class GitServiceError extends Error {
  readonly status: number;
  constructor(readonly code: GitServiceErrorCode, message: string) {
    super(message);
    this.name = 'GitServiceError';
    this.status = GIT_ERROR_STATUS[code];
  }
}
