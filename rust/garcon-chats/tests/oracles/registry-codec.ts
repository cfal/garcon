import { ChatIdAllocator } from '../../../../server/controller/chats/chat-id-allocator.ts';
import { isCarryOverSegmentId } from '../../../../server/controller/chats/carryover/segment-types.ts';
import { normalizeChatRegistryEntry, parseCarryOverSegmentRefs } from '../../../../server/controller/chats/registry-entry-codec.ts';

export const CHAT_ID = '1783725900000200';
export const OTHER_ID = '1783725900000201';

export function acceptsEntry(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function decodeEntry(raw: Record<string, unknown>) {
  return normalizeChatRegistryEntry(raw, CHAT_ID);
}

export function parseSegments(value: unknown) {
  return parseCarryOverSegmentRefs(value);
}

export function validSegmentId(value: unknown) {
  return isCarryOverSegmentId(value);
}

export function acceptsAllocation(times: unknown) {
  return Array.isArray(times) && times.length <= 20 && times.every((time) =>
    typeof time === 'number' && Number.isSafeInteger(time) && Math.abs(time) <= 9_007_199_254_740);
}

export function acceptsExisting(ids: unknown) {
  return Array.isArray(ids) && ids.every((id) => typeof id === 'string');
}

export function allocateIds(times: number[], ids: string[]) {
  const existing = new Set(ids);
  let index = 0;
  const allocator = new ChatIdAllocator({ hasChat: (id: string) => existing.has(id) }, () => times[index++]!);
  return times.map(() => allocator.allocate());
}
