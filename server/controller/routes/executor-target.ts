import { effectiveExecutorId, parseExecutorId } from '../../../common/executors.js';
import type { IChatRegistry } from '../chats/store.js';
import { DomainError, ValidationDomainError } from '../../common/domain-error.js';

export function executorIdFromUrl(url: URL, registry?: Pick<IChatRegistry, 'getChat'>): string {
  if (url.searchParams.getAll('executorId').length > 1) throw new ValidationDomainError('Invalid executor ID');
  const executorId = parseExecutorId(url.searchParams.get('executorId'));
  if (!executorId) throw new ValidationDomainError('Invalid executor ID');
  const chatId = url.searchParams.get('chatId');
  if (!chatId || !registry) return executorId;
  const chat = registry.getChat(chatId);
  if (!chat) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404);
  const current = effectiveExecutorId(chat.executorId);
  if (url.searchParams.has('executorId') && current !== executorId) {
    throw new DomainError('STALE_CHAT_OWNERSHIP', 'The chat executor changed', 409);
  }
  return current;
}

export function executorIdFromValue(value: unknown): string {
  const executorId = parseExecutorId(value);
  if (!executorId) throw new ValidationDomainError('Invalid executor ID');
  return executorId;
}
