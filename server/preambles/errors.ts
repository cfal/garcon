import type { PreambleErrorCode } from '../../common/preambles.js';

export class PreambleDomainError extends Error {
  constructor(
    readonly code: PreambleErrorCode,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'PreambleDomainError';
  }
}
