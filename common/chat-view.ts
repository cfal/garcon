import { ErrorMessage, parseChatMessage } from './chat-types';
import type { ChatMessage } from './chat-types';

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

export type ChatGenerationResetReason = 'manual-reload' | 'process-error';
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
