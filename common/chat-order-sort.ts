import { CHAT_ID_LENGTH, chatIdCreatedAt } from './chat-id.js';

export const CHAT_ORDER_SORT_KEYS = ['created', 'activity'] as const;
export type ChatOrderSortKey = (typeof CHAT_ORDER_SORT_KEYS)[number];

const CHAT_ORDER_SORT_KEY_SET = new Set<string>(CHAT_ORDER_SORT_KEYS);

export function isChatOrderSortKey(value: unknown): value is ChatOrderSortKey {
  return typeof value === 'string' && CHAT_ORDER_SORT_KEY_SET.has(value);
}

export interface ChatOrderTimestamps {
  id: string;
  createdAt: string | null;
  lastActivityAt: string | null;
}

export type ChatOrderIdComparator = (leftChatId: string, rightChatId: string) => number;

const CANONICAL_CHAT_ID_PATTERN = new RegExp(`^\\d{${CHAT_ID_LENGTH}}$`);

function validTimeMs(value: string | null): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function chatIdTimeMs(chatId: string): number | null {
  if (!CANONICAL_CHAT_ID_PATTERN.test(chatId)) return null;
  try {
    const time = chatIdCreatedAt(chatId).getTime();
    return Number.isFinite(time) ? time : null;
  } catch {
    return null;
  }
}

export function chatCreationTimeMs(chat: ChatOrderTimestamps): number {
  return validTimeMs(chat.createdAt) ?? chatIdTimeMs(chat.id) ?? 0;
}

/**
 * Uses the newest activity, creation, or ID time so clock skew and null
 * metadata cannot rank a chat below its own browser-created ID.
 */
export function chatActivityTimeMs(chat: ChatOrderTimestamps): number {
  return Math.max(
    validTimeMs(chat.lastActivityAt) ?? 0,
    validTimeMs(chat.createdAt) ?? 0,
    chatIdTimeMs(chat.id) ?? 0,
  );
}

export function compareChatOrderNewestFirst(
  sortKey: ChatOrderSortKey,
): (left: ChatOrderTimestamps, right: ChatOrderTimestamps) => number {
  const timeFor = sortKey === 'created' ? chatCreationTimeMs : chatActivityTimeMs;
  return (left, right) => timeFor(right) - timeFor(left);
}
