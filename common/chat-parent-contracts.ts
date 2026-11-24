import { parseChatId } from './chat-id.js';
import { isRecord } from './json.js';

export interface SetChatParentRequest {
  chatId: string;
  parentChatId: string | null;
}

export interface SetChatParentResponse {
  success: true;
  chatId: string;
  parentChatId: string | null;
  changed: boolean;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function parseSetChatParentRequest(value: unknown): SetChatParentRequest | null {
  if (!isRecord(value) || !onlyKeys(value, ['chatId', 'parentChatId'])) return null;
  try {
    return {
      chatId: parseChatId(value.chatId),
      parentChatId: value.parentChatId === null ? null : parseChatId(value.parentChatId),
    };
  } catch {
    return null;
  }
}

export function parseSetChatParentResponse(value: unknown): SetChatParentResponse | null {
  if (!isRecord(value) || !onlyKeys(value, ['success', 'chatId', 'parentChatId', 'changed'])) return null;
  if (value.success !== true || typeof value.changed !== 'boolean') return null;
  try {
    const chatId = parseChatId(value.chatId);
    const parentChatId = value.parentChatId === null ? null : parseChatId(value.parentChatId);
    if (parentChatId === chatId) return null;
    return { success: true, chatId, parentChatId, changed: value.changed };
  } catch {
    return null;
  }
}
