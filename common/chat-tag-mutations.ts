import type { ChatBoardCatalog, ChatBoardColumnId, ChatBoardId } from './chat-boards.js';
import { normalizeTags } from './tags.js';

export interface ReplaceChatTagsRequest {
  readonly chatId: string;
  readonly expectedTags: readonly string[];
  readonly tags: readonly string[];
}

export interface ApplyChatTagDeltaRequest {
  readonly chatId: string;
  readonly addTags?: readonly string[];
  readonly removeTags?: readonly string[];
}

export interface TransitionChatTagsRequest {
  readonly chatId: string;
  readonly boardId: ChatBoardId;
  readonly sourceColumnId: ChatBoardColumnId;
  readonly targetColumnId: ChatBoardColumnId;
  readonly expectedCatalogRevision: number;
  readonly expectedTags: readonly string[];
  readonly selectedTargetTags?: readonly string[];
}

export interface ChatTagsMutationResponse {
  readonly success: true;
  readonly chatId: string;
  readonly tags: readonly string[];
  readonly addedTags: readonly string[];
  readonly removedTags: readonly string[];
}

export interface RecoverChatTagsResponse {
  readonly success: true;
  readonly chatId: string;
  readonly tags: readonly string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null;
  const normalized = normalizeTags(value);
  return normalized.length === value.length && normalized.every((tag, index) => tag === value[index])
    ? normalized
    : null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function normalizeChatTagsMutationResponse(value: unknown): ChatTagsMutationResponse | null {
  const raw = record(value);
  if (
    !raw
    || !hasOnlyKeys(raw, ['success', 'chatId', 'tags', 'addedTags', 'removedTags'])
    || raw.success !== true
    || typeof raw.chatId !== 'string'
  ) return null;
  const tags = stringArray(raw.tags);
  const addedTags = stringArray(raw.addedTags);
  const removedTags = stringArray(raw.removedTags);
  return tags && addedTags && removedTags
    ? { success: true, chatId: raw.chatId, tags, addedTags, removedTags }
    : null;
}

export function normalizeRecoverChatTagsResponse(value: unknown): RecoverChatTagsResponse | null {
  const raw = record(value);
  if (
    !raw
    || !hasOnlyKeys(raw, ['success', 'chatId', 'tags'])
    || raw.success !== true
    || typeof raw.chatId !== 'string'
  ) return null;
  const tags = stringArray(raw.tags);
  return tags ? { success: true, chatId: raw.chatId, tags } : null;
}

export interface ChatTagConflictResponse {
  readonly success: false;
  readonly error: string;
  readonly errorCode: 'CHAT_TAG_REVISION_CONFLICT';
  readonly retryable: true;
  readonly currentTags: readonly string[];
}

export function normalizeChatTagConflictResponse(value: unknown): ChatTagConflictResponse | null {
  const raw = record(value);
  if (
    !raw
    || !hasOnlyKeys(raw, ['success', 'error', 'errorCode', 'retryable', 'currentTags'])
    || raw.success !== false
    || typeof raw.error !== 'string'
    || raw.errorCode !== 'CHAT_TAG_REVISION_CONFLICT'
    || raw.retryable !== true
  ) return null;
  const currentTags = stringArray(raw.currentTags);
  if (!currentTags) return null;
  return {
    success: false,
    error: raw.error,
    errorCode: 'CHAT_TAG_REVISION_CONFLICT',
    retryable: true,
    currentTags,
  };
}

export interface ChatBoardTransitionConflictResponse {
  readonly success: false;
  readonly errorCode: 'CHAT_TAG_REVISION_CONFLICT' | 'CHAT_BOARD_REVISION_CONFLICT';
  readonly retryable: true;
  readonly currentTags: readonly string[];
  readonly catalog: ChatBoardCatalog;
}

export const CHAT_TAG_ERROR_CODES = {
  validationFailed: 'CHAT_TAG_VALIDATION_FAILED',
  revisionConflict: 'CHAT_TAG_REVISION_CONFLICT',
  saveFailed: 'CHAT_TAG_SAVE_FAILED',
  saveUnknown: 'CHAT_TAG_SAVE_UNKNOWN',
} as const;

export type CommandTagMutationOutcome =
  | { readonly status: 'applied'; readonly addedTags: readonly string[] }
  | { readonly status: 'not-applied'; readonly errorCode: 'CHAT_TAG_SAVE_FAILED'; readonly retryable: true }
  | { readonly status: 'unknown'; readonly errorCode: 'CHAT_TAG_SAVE_UNKNOWN'; readonly recoveryRequired: true };

export function normalizeCommandTagMutationOutcome(value: unknown): CommandTagMutationOutcome | null {
  const raw = record(value);
  if (!raw || typeof raw.status !== 'string') return null;
  if (raw.status === 'applied') {
    if (!hasOnlyKeys(raw, ['status', 'addedTags'])) return null;
    const addedTags = stringArray(raw.addedTags);
    return addedTags ? { status: 'applied', addedTags } : null;
  }
  if (raw.status === 'not-applied') {
    if (
      !hasOnlyKeys(raw, ['status', 'errorCode', 'retryable'])
      || raw.errorCode !== 'CHAT_TAG_SAVE_FAILED'
      || raw.retryable !== true
    ) return null;
    return { status: 'not-applied', errorCode: 'CHAT_TAG_SAVE_FAILED', retryable: true };
  }
  if (raw.status === 'unknown') {
    if (
      !hasOnlyKeys(raw, ['status', 'errorCode', 'recoveryRequired'])
      || raw.errorCode !== 'CHAT_TAG_SAVE_UNKNOWN'
      || raw.recoveryRequired !== true
    ) return null;
    return { status: 'unknown', errorCode: 'CHAT_TAG_SAVE_UNKNOWN', recoveryRequired: true };
  }
  return null;
}
