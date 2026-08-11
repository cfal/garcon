import { ErrorMessage, parseChatMessage } from './chat-types';
import type { ChatMessage } from './chat-types';
import type { PendingUserInput } from './pending-user-input';

export interface ChatViewMessage {
  seq: number;
  message: ChatMessage;
}

export interface ChatViewPage {
  generationId: string;
  messages: ChatViewMessage[];
  lastSeq: number;
  pageOldestSeq: number;
  hasMore: boolean;
}

// Deferred is a typed non-error wait state, not exhaustion: the projection
// store cannot serve a safe read yet, and cold selection retries once on the
// matching execution-to-idle transition.
export type ChatHistoryState =
  | { readonly kind: 'complete' }
  | { readonly kind: 'deferred'; readonly retry: 'execution-settled' }
  | {
      readonly kind: 'degraded';
      readonly errorCode: string;
      readonly retryable: boolean;
    };

export interface CompleteChatHistoryResponse extends ChatViewPage {
  readonly historyState: Extract<ChatHistoryState, { readonly kind: 'complete' }>;
  readonly chatId: string;
  readonly pendingUserInputs: PendingUserInput[];
  readonly limit: number;
}

export interface UnavailableChatHistoryResponse {
  readonly historyState: Exclude<ChatHistoryState, { readonly kind: 'complete' }>;
  readonly chatId: string;
  readonly messages: readonly [];
  readonly generationId?: never;
  readonly lastSeq?: never;
  readonly pageOldestSeq?: never;
  readonly pendingUserInputs?: never;
  readonly hasMore?: never;
  readonly limit?: never;
}

export type ChatHistoryResponse =
  | CompleteChatHistoryResponse
  | UnavailableChatHistoryResponse;

export function isUnavailableChatHistoryResponse(
  response: ChatHistoryResponse,
): response is UnavailableChatHistoryResponse {
  return response.historyState.kind !== 'complete';
}

const HISTORY_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function parseChatHistoryState(value: unknown): ChatHistoryState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'complete' && Object.keys(raw).length === 1) return { kind: 'complete' };
  if (
    raw.kind === 'deferred'
    && raw.retry === 'execution-settled'
    && Object.keys(raw).length === 2
  ) {
    return { kind: 'deferred', retry: 'execution-settled' };
  }
  if (
    raw.kind === 'degraded'
    && typeof raw.errorCode === 'string'
    && HISTORY_ERROR_CODE_PATTERN.test(raw.errorCode)
    && typeof raw.retryable === 'boolean'
    && Object.keys(raw).length === 3
  ) {
    return {
      kind: 'degraded',
      errorCode: raw.errorCode,
      retryable: raw.retryable,
    };
  }
  return null;
}

export type ChatReplayResult =
  | {
      mode: 'delta';
      generationId: string;
      messages: ChatViewMessage[];
      lastSeq: number;
    }
  | {
      mode: 'snapshot-required';
      generationId: string;
      messages: [];
      lastSeq: number;
    };

// 'idle-reconcile' is the server rebuilding a settled view from native history on its own, so
// clients refetch rather than keeping sequence numbers that no longer address the same messages.
export type ChatGenerationResetReason =
  | 'manual-reload'
  | 'process-error'
  | 'idle-reconcile'
  | 'agent-handoff';
export type ChatViewApplyStatus = 'applied' | 'gap-detected';

export interface ChatViewApplyResult {
  messages: ChatViewMessage[];
  changed: boolean;
  lastSeq: number;
  status: ChatViewApplyStatus;
  expectedSeq?: number;
  receivedSeq?: number;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseChatViewMessage(data: unknown): ChatViewMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;
  if (!isPositiveInt(raw.seq)) return null;
  const rawMessage = asRecord(raw.message);
  const message = parseChatMessage(rawMessage)
    ?? new ErrorMessage(
      typeof rawMessage.timestamp === 'string' ? rawMessage.timestamp : '',
      'This message type is not supported by this app version. Reload to update.',
    );
  return { seq: raw.seq, message };
}

// Rejects the whole batch if any envelope is malformed so callers never advance
// a cursor past a silent gap.
export function parseChatViewMessages(data: unknown): ChatViewMessage[] | null {
  if (!Array.isArray(data)) return null;
  const messages: ChatViewMessage[] = [];
  let previousSeq = 0;
  for (const item of data) {
    const parsed = parseChatViewMessage(item);
    if (!parsed || parsed.seq <= previousSeq) return null;
    messages.push(parsed);
    previousSeq = parsed.seq;
  }
  return messages;
}

export function applyChatViewMessages(
  current: ChatViewMessage[],
  incoming: ChatViewMessage[],
  lastSeq: number,
): ChatViewApplyResult {
  if (incoming.length === 0) return { messages: current, changed: false, lastSeq, status: 'applied' };
  const filtered = incoming.filter((message) => message.seq > lastSeq);
  if (filtered.length === 0) {
    return { messages: current, changed: false, lastSeq, status: 'applied' };
  }
  let expectedSeq = lastSeq + 1;
  for (const message of filtered) {
    if (message.seq !== expectedSeq) {
      return {
        messages: current,
        changed: false,
        lastSeq,
        status: 'gap-detected',
        expectedSeq,
        receivedSeq: message.seq,
      };
    }
    expectedSeq += 1;
  }
  return {
    messages: [...current, ...filtered],
    changed: true,
    lastSeq: filtered[filtered.length - 1].seq,
    status: 'applied',
  };
}
