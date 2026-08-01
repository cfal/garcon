import type { ErrorCode } from './error-codes.js';
import type { HttpErrorResponse } from './http-error.js';
import { isRecord } from './json.js';

export const PERSISTED_CHAT_ORDER_GROUPS = ['pinned', 'normal', 'archived'] as const;
export type PersistedChatOrderGroup = (typeof PERSISTED_CHAT_ORDER_GROUPS)[number];

export const CHAT_ORDER_BOUNDARIES = ['top', 'bottom'] as const;
export type ChatOrderBoundary = (typeof CHAT_ORDER_BOUNDARIES)[number];

export const CHAT_RELATIVE_POSITIONS = ['before', 'after'] as const;
export type ChatRelativePosition = (typeof CHAT_RELATIVE_POSITIONS)[number];

export type ChatOrderPlacement =
  | {
      kind: 'relative';
      referenceChatId: string;
      position: ChatRelativePosition;
    }
  | {
      kind: 'boundary';
      boundary: ChatOrderBoundary;
    };

export type RelativeChatOrderPlacement = Extract<ChatOrderPlacement, { kind: 'relative' }>;

export interface ReorderChatRequest {
  chatId: string;
  placement: ChatOrderPlacement;
}

export interface ReorderChatResponse {
  success: true;
  chatId: string;
  orderGroup: PersistedChatOrderGroup;
  changed: boolean;
}

export type ReorderChatErrorCode = Extract<
  ErrorCode,
  'VALIDATION_FAILED' | 'SESSION_NOT_FOUND' | 'ORDER_CROSS_GROUP' | 'INTERNAL_ERROR'
>;

export interface ReorderChatErrorResponse extends HttpErrorResponse {
  errorCode: ReorderChatErrorCode;
}

const REQUEST_KEYS = new Set(['chatId', 'placement']);
const RELATIVE_KEYS = new Set(['kind', 'referenceChatId', 'position']);
const BOUNDARY_KEYS = new Set(['kind', 'boundary']);

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function nonemptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

export function parseReorderChatRequest(value: unknown): ReorderChatRequest | null {
  if (!isRecord(value) || !hasOnlyKeys(value, REQUEST_KEYS)) return null;
  const chatId = nonemptyString(value.chatId);
  const placement = value.placement;
  if (!chatId || !isRecord(placement)) return null;

  if (placement.kind === 'boundary') {
    if (!hasOnlyKeys(placement, BOUNDARY_KEYS)) return null;
    if (!CHAT_ORDER_BOUNDARIES.includes(placement.boundary as ChatOrderBoundary)) return null;
    return {
      chatId,
      placement: {
        kind: 'boundary',
        boundary: placement.boundary as ChatOrderBoundary,
      },
    };
  }

  if (placement.kind === 'relative') {
    if (!hasOnlyKeys(placement, RELATIVE_KEYS)) return null;
    const referenceChatId = nonemptyString(placement.referenceChatId);
    if (!referenceChatId || referenceChatId === chatId) return null;
    if (!CHAT_RELATIVE_POSITIONS.includes(placement.position as ChatRelativePosition)) return null;
    return {
      chatId,
      placement: {
        kind: 'relative',
        referenceChatId,
        position: placement.position as ChatRelativePosition,
      },
    };
  }

  return null;
}

export function parseReorderChatResponse(value: unknown): ReorderChatResponse | null {
  if (!isRecord(value) || value.success !== true || typeof value.changed !== 'boolean') return null;
  const chatId = nonemptyString(value.chatId);
  if (!chatId) return null;
  if (!PERSISTED_CHAT_ORDER_GROUPS.includes(value.orderGroup as PersistedChatOrderGroup)) {
    return null;
  }
  return {
    success: true,
    chatId,
    orderGroup: value.orderGroup as PersistedChatOrderGroup,
    changed: value.changed,
  };
}
