import { effectiveNodeId, parseNodeId } from '../../common/execution-nodes.js';
import type { IChatRegistry } from '../chats/store.js';
import { DomainError, ValidationDomainError } from '../lib/domain-error.js';

export function executionNodeIdFromUrl(url: URL, registry?: Pick<IChatRegistry, 'getChat'>): string {
  if (url.searchParams.getAll('nodeId').length > 1) throw new ValidationDomainError('Invalid execution node ID');
  const nodeId = parseNodeId(url.searchParams.get('nodeId'));
  if (!nodeId) throw new ValidationDomainError('Invalid execution node ID');
  const chatId = url.searchParams.get('chatId');
  if (!chatId || !registry) return nodeId;
  const chat = registry.getChat(chatId);
  if (!chat) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404);
  const current = effectiveNodeId(chat.nodeId);
  if (url.searchParams.has('nodeId') && current !== nodeId) {
    throw new DomainError('STALE_CHAT_OWNERSHIP', 'The chat execution node changed', 409);
  }
  return current;
}

export function executionNodeIdFromValue(value: unknown): string {
  const nodeId = parseNodeId(value);
  if (!nodeId) throw new ValidationDomainError('Invalid execution node ID');
  return nodeId;
}
