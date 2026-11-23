export const GIT_ERROR_MESSAGE_LIMIT = 2048;

export function redactGitDiagnostic(text: string): string {
  const separator = text.indexOf('://');
  if (separator < 0) return text;

  // Git prints destinations verbatim: even a quote followed by a newline may still be URL data.
  const start = Math.max(...[' ', '\t', '\r', '\n'].map(char => text.lastIndexOf(char, separator))) + 1;
  const prefix = text.slice(0, start);
  const redacted = prefix + '<remote>';
  if (!/(?:^|: |\n)fatal: unable to access $/.test(prefix)) return redacted;

  // Git's terminal HTTP access error puts the curl reason after a separately quoted URL.
  const http = /^'https?:\/\/[^'\s]+': ([^\r\n]+)$/i.exec(text.slice(start));
  if (!http || http[1].includes('://') || http[1].includes("': ")) return redacted;
  return redacted + ': ' + http[1];
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
