import type { SnippetErrorCode } from '../../common/snippets.js';

export type SnippetDomainErrorCode = SnippetErrorCode;

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
