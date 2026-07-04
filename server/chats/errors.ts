import { DomainError } from '../lib/domain-error.js';

export class ChatRunningError extends DomainError {
  constructor(chatId: string) {
    super('CHAT_RUNNING', `Cannot reload running chat: ${chatId}`, 409, true);
  }
}

export class HistoryLoadFailedError extends DomainError {
  constructor(message = 'Failed to load chat history') {
    super('HISTORY_LOAD_FAILED', message, 500, true);
  }
}
