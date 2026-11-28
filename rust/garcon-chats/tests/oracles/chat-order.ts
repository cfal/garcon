import { isRecord } from '../../../../common/json.ts';
import { buildChatOrderComparator } from '../../../../server/controller/chats/chat-order-ranking.ts';
import type { ChatMetadata } from '../../../../server/controller/chats/metadata-store.ts';

export function sortChatIds(sortKey: 'created' | 'activity', ids: string[], metadata: Record<string, ChatMetadata>) {
  return [...ids].sort(buildChatOrderComparator(sortKey, new Map(Object.entries(metadata))));
}

export function acceptsSortKey(raw: unknown) { return raw === 'created' || raw === 'activity'; }
export function acceptsIds(raw: unknown) { return Array.isArray(raw) && raw.every(id => typeof id === 'string'); }
export function acceptsMetadata(raw: unknown) {
  return isRecord(raw) && Object.values(raw).every(entry => isRecord(entry)
    && [entry.createdAt, entry.lastActivity].every(value => value == null || typeof value === 'string'));
}
