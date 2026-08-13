import type { ChatMessage } from '../../common/chat-types.js';
import type { LegacyChatViewMessage } from './chat-view-contracts.js';

export function lowerBoundBySeq(messages: LegacyChatViewMessage[], seq: number): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function assertValidChatMessage(message: ChatMessage): void {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    throw new Error('Invalid chat message');
  }
}

export function revisionsMatch(
  previous: string | undefined,
  current: string | undefined,
): boolean {
  return previous === current;
}
