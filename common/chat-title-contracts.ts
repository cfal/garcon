import type { HttpErrorResponse } from './http-error.js';
import { isRecord } from './json.js';

export interface UpdateChatTitleRequest {
  chatId: string;
  title: string;
}

export interface UpdateChatTitleResponse {
  success: true;
  chatId: string;
  title: string;
  changed: boolean;
}

const UPDATE_TITLE_REQUEST_KEYS = new Set(['chatId', 'title']);
const UPDATE_TITLE_RESPONSE_KEYS = new Set(['success', 'chatId', 'title', 'changed']);

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

export function parseUpdateChatTitleRequest(value: unknown): UpdateChatTitleRequest | null {
  if (!isRecord(value) || !hasOnlyKeys(value, UPDATE_TITLE_REQUEST_KEYS)) return null;
  if (typeof value.chatId !== 'string' || typeof value.title !== 'string') return null;
  const chatId = value.chatId.trim();
  const title = value.title.trim();
  return chatId && title ? { chatId, title } : null;
}

export function parseUpdateChatTitleResponse(value: unknown): UpdateChatTitleResponse | null {
  if (!isRecord(value) || !hasOnlyKeys(value, UPDATE_TITLE_RESPONSE_KEYS)) return null;
  if (
    value.success !== true
    || typeof value.chatId !== 'string'
    || typeof value.title !== 'string'
    || typeof value.changed !== 'boolean'
  ) {
    return null;
  }
  const chatId = value.chatId.trim();
  const title = value.title.trim();
  if (!chatId || !title || chatId !== value.chatId || title !== value.title) return null;
  return { success: true, chatId, title, changed: value.changed };
}

export interface GenerateChatTitleRequest {
  chatId: string;
  message: string;
  messageSeq?: number;
}

export interface GenerateChatTitleResponse {
  success: true;
  chatId: string;
  title: string;
}

export type GenerateChatTitleErrorCode =
  | 'VALIDATION_FAILED'
  | 'SESSION_NOT_FOUND'
  | 'TITLE_GENERATION_UNAVAILABLE'
  | 'TITLE_GENERATION_EMPTY'
  | 'TITLE_GENERATION_FAILED';

export interface GenerateChatTitleErrorResponse extends HttpErrorResponse {
  errorCode: GenerateChatTitleErrorCode;
}
