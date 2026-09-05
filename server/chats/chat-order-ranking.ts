import {
  compareChatOrderNewestFirst,
  type ChatOrderIdComparator,
  type ChatOrderSortKey,
  type ChatOrderTimestamps,
} from '../../common/chat-order-sort.js';
import type { ChatMetadata } from './metadata-store.js';

/** Reads from a caller-owned metadata snapshot that remains stable while sorting. */
export function buildChatOrderComparator(
  sortKey: ChatOrderSortKey,
  metadataByChatId: ReadonlyMap<string, ChatMetadata>,
): ChatOrderIdComparator {
  const compare = compareChatOrderNewestFirst(sortKey);
  const timestampsByChatId = new Map<string, ChatOrderTimestamps>();

  const timestampsFor = (chatId: string): ChatOrderTimestamps => {
    const cached = timestampsByChatId.get(chatId);
    if (cached) return cached;
    const metadata = metadataByChatId.get(chatId);
    const timestamps = {
      id: chatId,
      createdAt: metadata?.createdAt ?? null,
      lastActivityAt: metadata?.lastActivity ?? null,
    };
    timestampsByChatId.set(chatId, timestamps);
    return timestamps;
  };

  return (leftChatId, rightChatId) => compare(
    timestampsFor(leftChatId),
    timestampsFor(rightChatId),
  );
}
