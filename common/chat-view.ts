import { ErrorMessage, parseChatMessage } from './chat-types';
import type { ChatMessage } from './chat-types';

export interface TranscriptMessage {
  readonly ordinal: number;
  readonly message: ChatMessage;
}

export interface ResendCandidate {
  readonly ordinal: number;
  readonly content: string;
  readonly attachmentNames: readonly string[];
}

export interface TranscriptPage {
  readonly transcriptViewId: string;
  readonly messages: TranscriptMessage[];
  readonly lastOrdinal: number;
  readonly pageOldestOrdinal: number;
  readonly pageNewestOrdinal: number;
  readonly hasMore: boolean;
}

export type ChatHistoryState =
  | { readonly kind: 'complete' }
  | {
      readonly kind: 'degraded';
      readonly errorCode: string;
      readonly retryable: boolean;
    };

export interface CompleteChatHistoryResponse extends TranscriptPage {
  readonly historyState: Extract<ChatHistoryState, { readonly kind: 'complete' }>;
  readonly chatId: string;
  readonly resendCandidates: ResendCandidate[];
  readonly limit: number;
}

export interface UnavailableChatHistoryResponse {
  readonly historyState: Exclude<ChatHistoryState, { readonly kind: 'complete' }>;
  readonly chatId: string;
  readonly messages: readonly [];
  readonly transcriptViewId?: never;
  readonly lastOrdinal?: never;
  readonly pageOldestOrdinal?: never;
  readonly pageNewestOrdinal?: never;
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

export interface TranscriptAppend {
  readonly transcriptViewId: string;
  readonly firstOrdinal: number;
  readonly lastOrdinal: number;
  readonly messages: TranscriptMessage[];
}

export type TranscriptReplayResult = TranscriptAppend;

export type TranscriptApplyStatus = 'applied' | 'gap-detected';

export interface TranscriptApplyResult {
  messages: TranscriptMessage[];
  changed: boolean;
  lastOrdinal: number;
  status: TranscriptApplyStatus;
  expectedOrdinal?: number;
  receivedOrdinal?: number;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseTranscriptMessage(data: unknown): TranscriptMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;
  if (!isPositiveInt(raw.ordinal)) return null;
  const rawMessage = asRecord(raw.message);
  const message = parseChatMessage(rawMessage)
    ?? new ErrorMessage(
      typeof rawMessage.timestamp === 'string' ? rawMessage.timestamp : '',
      'This message type is not supported by this app version. Reload to update.',
    );
  return { ordinal: raw.ordinal, message };
}

// Rejects the whole batch if any envelope is malformed so callers never
// advance a cursor past an invalid row.
export function parseTranscriptMessages(data: unknown): TranscriptMessage[] | null {
  if (!Array.isArray(data)) return null;
  const messages: TranscriptMessage[] = [];
  let previousOrdinal = 0;
  for (const item of data) {
    const parsed = parseTranscriptMessage(item);
    if (!parsed || parsed.ordinal <= previousOrdinal) return null;
    messages.push(parsed);
    previousOrdinal = parsed.ordinal;
  }
  return messages;
}

export function parseResendCandidates(data: unknown): ResendCandidate[] | null {
  if (!Array.isArray(data)) return null;
  const candidates: ResendCandidate[] = [];
  let previousOrdinal = 0;
  for (const value of data) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (!isPositiveInt(raw.ordinal) || raw.ordinal <= previousOrdinal) return null;
    if (typeof raw.content !== 'string' || !Array.isArray(raw.attachmentNames)) return null;
    if (!raw.attachmentNames.every((name) => typeof name === 'string')) return null;
    candidates.push({
      ordinal: raw.ordinal,
      content: raw.content,
      attachmentNames: raw.attachmentNames as string[],
    });
    previousOrdinal = raw.ordinal;
  }
  return candidates;
}

export function applyTranscriptAppend(
  current: TranscriptMessage[],
  append: Pick<TranscriptAppend, 'firstOrdinal' | 'lastOrdinal' | 'messages'>,
  currentLastOrdinal: number,
): TranscriptApplyResult {
  let previousMessageOrdinal = 0;
  const invalidMessageOrdinal = append.messages.some((entry) => {
    const invalid = !isPositiveInt(entry.ordinal)
      || entry.ordinal <= previousMessageOrdinal
      || entry.ordinal < append.firstOrdinal
      || entry.ordinal > append.lastOrdinal;
    previousMessageOrdinal = entry.ordinal;
    return invalid;
  });
  if (
    !isPositiveInt(append.firstOrdinal)
    || !Number.isSafeInteger(append.lastOrdinal)
    || append.lastOrdinal < 0
    || append.lastOrdinal < append.firstOrdinal - 1
    || (append.lastOrdinal < append.firstOrdinal && append.messages.length > 0)
    || invalidMessageOrdinal
  ) {
    return {
      messages: current,
      changed: false,
      lastOrdinal: currentLastOrdinal,
      status: 'gap-detected',
      expectedOrdinal: currentLastOrdinal + 1,
      receivedOrdinal: append.firstOrdinal,
    };
  }
  if (append.lastOrdinal < append.firstOrdinal) {
    return { messages: current, changed: false, lastOrdinal: currentLastOrdinal, status: 'applied' };
  }
  if (append.lastOrdinal <= currentLastOrdinal) {
    return { messages: current, changed: false, lastOrdinal: currentLastOrdinal, status: 'applied' };
  }
  if (append.firstOrdinal > currentLastOrdinal + 1) {
    return {
      messages: current,
      changed: false,
      lastOrdinal: currentLastOrdinal,
      status: 'gap-detected',
      expectedOrdinal: currentLastOrdinal + 1,
      receivedOrdinal: append.firstOrdinal,
    };
  }
  const incoming = append.messages.filter((entry) => entry.ordinal > currentLastOrdinal);
  return {
    messages: incoming.length === 0 ? current : [...current, ...incoming],
    changed: incoming.length > 0,
    lastOrdinal: append.lastOrdinal,
    status: 'applied',
  };
}
