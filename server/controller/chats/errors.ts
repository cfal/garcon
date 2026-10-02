import type { ChatHistoryState } from '../../../common/chat-view.js';
import { DomainError } from '../../common/domain-error.js';

export class TranscriptHistoryUnavailableError extends DomainError {
  readonly historyState: Exclude<ChatHistoryState, { readonly kind: 'complete' }>;

  constructor(
    historyState: Exclude<ChatHistoryState, { readonly kind: 'complete' }>,
    options?: ErrorOptions,
  ) {
    super(
      'TRANSCRIPT_UNAVAILABLE',
      'The transcript ledger is unavailable',
      422,
      historyState.retryable,
      options,
    );
    this.historyState = historyState;
  }
}
