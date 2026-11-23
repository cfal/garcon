export const GIT_ERROR_MESSAGE_LIMIT = 2048;

export function redactGitDiagnostic(text: string): string {
  if (!text.includes('://')) return text;
  return text.replace(/\S+/g, word => word.includes('://') ? '<remote>' : word);
}

// Domain error type for git operations. Carries a machine-readable
// code for HTTP status mapping at the route boundary.
export class GitDomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GitDomainError';
    this.code = code;
  }
}
