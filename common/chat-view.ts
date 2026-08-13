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

export interface ChatViewPageRequest {
  readonly limit: number;
  readonly beforeSeq?: number;
}

export interface ChatViewWindow {
  readonly messages: readonly ChatViewMessage[];
  readonly lastSeq: number;
  readonly pageOldestSeq: number;
  readonly hasMore: boolean;
}

export type ChatHistoryState =
  | { readonly kind: 'complete' }
  | {
      readonly kind: 'degraded';
      readonly errorCode: 'CARRYOVER_HISTORY_UNAVAILABLE';
      readonly retryable: false;
    };

export interface CompleteChatHistoryResponse extends ChatViewPage {
  readonly historyState: Extract<ChatHistoryState, { readonly kind: 'complete' }>;
  readonly chatId: string;
  readonly pendingUserInputs: PendingUserInput[];
  readonly limit: number;
}

export interface DegradedChatHistoryResponse {
  readonly historyState: Extract<ChatHistoryState, { readonly kind: 'degraded' }>;
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
  | DegradedChatHistoryResponse;

export function isDegradedChatHistoryResponse(
  response: ChatHistoryResponse,
): response is DegradedChatHistoryResponse {
  return response.historyState.kind === 'degraded';
}

export function parseChatHistoryState(value: unknown): ChatHistoryState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'complete' && Object.keys(raw).length === 1) return { kind: 'complete' };
  if (
    raw.kind === 'degraded'
    && raw.errorCode === 'CARRYOVER_HISTORY_UNAVAILABLE'
    && raw.retryable === false
    && Object.keys(raw).length === 3
  ) {
    return {
      kind: 'degraded',
      errorCode: 'CARRYOVER_HISTORY_UNAVAILABLE',
      retryable: false,
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

export function isContiguousChatViewWindow(page: ChatViewWindow): boolean {
  if (!isNonNegativeSafeInteger(page.lastSeq)) return false;
  if (!isNonNegativeSafeInteger(page.pageOldestSeq)) return false;
  if (page.messages.length === 0) return page.pageOldestSeq === 0 && !page.hasMore;
  if (
    page.pageOldestSeq < 1
    || page.messages[0]?.seq !== page.pageOldestSeq
    || page.messages.at(-1)!.seq > page.lastSeq
    || page.hasMore !== (page.pageOldestSeq > 1)
  ) return false;
  return page.messages.every(
    (message, index) => index === 0 || message.seq === page.messages[index - 1].seq + 1,
  );
}

export function isRequestedChatViewPage(
  request: ChatViewPageRequest,
  page: ChatViewWindow & { readonly limit: number },
): boolean {
  if (
    !isContiguousChatViewWindow(page)
    || !isPositiveSafeInteger(request.limit)
    || page.limit !== request.limit
  ) return false;
  if (
    request.beforeSeq !== undefined
    && !isPositiveSafeInteger(request.beforeSeq)
  ) return false;

  const requestedEndSeq = request.beforeSeq === undefined
    ? page.lastSeq
    : Math.min(page.lastSeq, request.beforeSeq - 1);
  if (requestedEndSeq === 0) return page.messages.length === 0;
  const requestedStartSeq = Math.max(1, requestedEndSeq - request.limit + 1);
  return page.pageOldestSeq === requestedStartSeq
    && page.messages.length === requestedEndSeq - requestedStartSeq + 1
    && page.messages.at(-1)?.seq === requestedEndSeq;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
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
