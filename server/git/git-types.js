// Domain error type for git operations. Carries a machine-readable
// code for HTTP status mapping at the route boundary.
export class GitDomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitDomainError';
    this.code = code;
  }
}
