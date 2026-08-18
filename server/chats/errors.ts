import type { ChatHistoryState } from '../../common/chat-view.js';
import { DomainError } from '../lib/domain-error.js';

export class ChatRunningError extends DomainError {
  constructor(chatId: string) {
    super('CHAT_RUNNING', `Cannot reload running chat: ${chatId}`, 409, true);
  }
}

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

export class HistoryLoadFailedError extends DomainError {
  constructor(message = 'Failed to load chat history') {
    super('HISTORY_LOAD_FAILED', message, 500, true);
  }
}
