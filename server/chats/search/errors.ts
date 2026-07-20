import type { ErrorCode } from '../../../common/error-codes.js';
import { DomainError } from '../../lib/domain-error.js';

export type TranscriptSearchUnavailableCode = Extract<
  ErrorCode,
  'TRANSCRIPT_SEARCH_DISABLED' | 'SEARCH_INDEX_UNAVAILABLE' | 'SEARCH_INDEX_BUSY'
>;

export class TranscriptSearchUnavailableError extends DomainError {
  constructor(code: TranscriptSearchUnavailableCode, message: string, retryable: boolean) {
    super(code, message, code === 'TRANSCRIPT_SEARCH_DISABLED' ? 409 : 503, retryable);
    this.name = 'TranscriptSearchUnavailableError';
  }
}
