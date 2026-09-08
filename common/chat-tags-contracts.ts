import { isRecord } from './json.js';
import { normalizeTags } from './tags.js';

export interface SetChatTagsRequest {
  chatId: string;
  tags: string[];
}

export interface SetChatTagsResponse {
  success: true;
  chatId: string;
  tags: string[];
  changed: boolean;
}

const REQUEST_KEYS = new Set(['chatId', 'tags']);
const RESPONSE_KEYS = new Set(['success', 'chatId', 'tags', 'changed']);

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

export function parseSetChatTagsRequest(value: unknown): SetChatTagsRequest | null {
  if (!isRecord(value) || !hasOnlyKeys(value, REQUEST_KEYS)) return null;
  if (typeof value.chatId !== 'string' || !Array.isArray(value.tags)) return null;
  const chatId = value.chatId.trim();
  if (!chatId || value.tags.some((tag) => typeof tag !== 'string')) return null;
  return { chatId, tags: normalizeTags(value.tags) };
}

export function parseSetChatTagsResponse(value: unknown): SetChatTagsResponse | null {
  if (!isRecord(value) || !hasOnlyKeys(value, RESPONSE_KEYS)) return null;
  const rawTags = value.tags;
  if (
    value.success !== true
    || typeof value.chatId !== 'string'
    || !Array.isArray(rawTags)
    || rawTags.some((tag) => typeof tag !== 'string')
    || typeof value.changed !== 'boolean'
  ) {
    return null;
  }
  const chatId = value.chatId.trim();
  const tags = normalizeTags(rawTags);
  if (
    !chatId
    || chatId !== value.chatId
    || tags.length !== rawTags.length
    || tags.some((tag, index) => tag !== rawTags[index])
  ) {
    return null;
  }
  return { success: true, chatId, tags, changed: value.changed };
}
