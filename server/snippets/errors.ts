export type SnippetDomainErrorCode =
  | 'SNIPPET_VALIDATION_FAILED'
  | 'SNIPPET_NOT_FOUND'
  | 'SNIPPET_NAME_CONFLICT'
  | 'SNIPPET_REVISION_CONFLICT'
  | 'SNIPPET_LIMIT_REACHED'
  | 'SNIPPET_EXPANSION_TOO_LONG'
  | 'SNIPPET_CHAT_NOT_FOUND'
  | 'SNIPPET_PROJECT_PATH_REQUIRED'
  | 'SNIPPET_PROJECT_PATH_OUTSIDE_BASE'
  | 'SNIPPET_PROJECT_PATH_NOT_FOUND'
  | 'SNIPPET_PROJECT_PATH_INACCESSIBLE'
  | 'SNIPPET_PROJECT_PATH_NOT_DIRECTORY';

export class SnippetDomainError extends Error {
  constructor(
    readonly code: SnippetDomainErrorCode,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SnippetDomainError';
  }
}
