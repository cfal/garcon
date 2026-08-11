import type { ChatHistoryState } from '../../common/chat-view.js';
import { DomainError } from '../lib/domain-error.js';

export class ChatRunningError extends DomainError {
  constructor(chatId: string) {
    super('CHAT_RUNNING', `Cannot reload running chat: ${chatId}`, 409, true);
  }
}

// A projection read that is not ready surfaces as this typed state instead of
// empty history: deferred waits for execution to settle, degraded carries the
// store's own failure code.
export class TranscriptHistoryUnavailableError extends DomainError {
  readonly historyState: Exclude<ChatHistoryState, { readonly kind: 'complete' }>;

  constructor(historyState: Exclude<ChatHistoryState, { readonly kind: 'complete' }>) {
    if (historyState.kind === 'deferred') {
      super('TRANSCRIPT_DEFERRED', 'The transcript projection defers reads until execution settles', 409, true);
    } else {
      super('TRANSCRIPT_UNAVAILABLE', 'The transcript projection is degraded', 422, historyState.retryable);
    }
    this.historyState = historyState;
  }
}

export class HistoryLoadFailedError extends DomainError {
  constructor(message = 'Failed to load chat history') {
    super('HISTORY_LOAD_FAILED', message, 500, true);
  }
}
