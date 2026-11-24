import { parseChatId } from './chat-id.js';
import { type DelegationParentChatRef, parseParentChatRef } from './chat-parentage.js';
import { isRecord } from './json.js';

export interface SetChatParentRequest {
  chatId: string;
  parentChatId: string | null;
}

export interface SetChatParentResponse {
  success: true;
  chatId: string;
  parentChat: DelegationParentChatRef | null;
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
  if (!isRecord(value) || !onlyKeys(value, ['success', 'chatId', 'parentChat', 'changed'])) return null;
  if (value.success !== true || typeof value.changed !== 'boolean') return null;
  let chatId: string;
  try {
    chatId = parseChatId(value.chatId);
  } catch {
    return null;
  }
  if (value.parentChat === null) {
    return { success: true, chatId, parentChat: null, changed: value.changed };
  }
  if (!isRecord(value.parentChat) || !onlyKeys(value.parentChat, ['chatId', 'relation'])) return null;
  const parentChat = parseParentChatRef(value.parentChat);
  if (parentChat?.relation !== 'delegation' || parentChat.chatId === chatId) return null;
  return { success: true, chatId, parentChat, changed: value.changed };
}
