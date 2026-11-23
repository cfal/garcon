export const GIT_ERROR_MESSAGE_LIMIT = 2048;

export function redactGitDiagnostic(text: string): string {
  if (!text.includes('://')) return text;
  // Git quotes destinations without escaping spaces or embedded quotes. A clipped field may not close.
  const quotedUrl = /(['"])[a-z][a-z\d+.-]*:\/\/(?:[^\r\n]*\1|[\s\S]*?(?:\1|$))/gi;
  const redacted = text.replace(quotedUrl, '<remote>');
  if (!redacted.includes('://')) return redacted;

  // An unquoted destination has no reliable end delimiter before the next line.
  return redacted.replace(/[^\r\n]+/g, line => {
    const separator = line.indexOf('://');
    if (separator < 0) return line;
    const start = Math.max(line.lastIndexOf(' ', separator), line.lastIndexOf('\t', separator)) + 1;
    return line.slice(0, start) + '<remote>';
  });
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
