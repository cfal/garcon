// Server-assigned identity and ordering envelope for chat messages.
// One event is one revision of one message; rev 1 creates the message,
// higher revs replace its content snapshot.

import { ErrorMessage, parseChatMessage } from './chat-types';
import type { ChatMessage } from './chat-types';

export interface ChatMessageEvent {
  // Monotonic per persisted line; bumped by creations and revisions.
  // The resume cursor space.
  appendSeq: number;
  // Creation seq = timeline position; stable across revisions.
  // The pagination and display ordering space.
  seq: number;
  messageId: string;
  rev: number;
  message: ChatMessage;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseChatMessageEvent(data: unknown): ChatMessageEvent | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const appendSeq = asPositiveInt(raw.appendSeq);
  const seq = asPositiveInt(raw.seq);
  const rev = asPositiveInt(raw.rev);
  const messageId = typeof raw.messageId === 'string' && raw.messageId ? raw.messageId : null;
  if (!appendSeq || !seq || !rev || !messageId) return null;
  if (appendSeq < seq) return null;

  // Unknown inner message types degrade to a visible placeholder instead of
  // invalidating the whole envelope. The envelope still holds the stable
  // identity slot, so cursors and future revisions remain correct.
  const rawMessage = asRecord(raw.message);
  const message = parseChatMessage(rawMessage)
    ?? new ErrorMessage(
      typeof rawMessage.timestamp === 'string' ? rawMessage.timestamp : '',
      'This message type is not supported by this app version. Reload to update.',
    );
  return { appendSeq, seq, messageId, rev, message };
}

// Envelope-strict batch parsing: one malformed envelope rejects the whole
// batch so clients never advance a resume cursor past a silent gap.
export function parseChatMessageEvents(data: unknown): ChatMessageEvent[] | null {
  if (!Array.isArray(data)) return null;
  const events: ChatMessageEvent[] = [];
  for (const item of data) {
    const event = parseChatMessageEvent(item);
    if (!event) return null;
    events.push(event);
  }
  return events;
}

export interface ChatEventApplyResult {
  entries: ChatMessageEvent[];
  changed: boolean;
  lastAppendSeq: number;
}

export function applyChatMessageEvents(
  entries: ChatMessageEvent[],
  incoming: ChatMessageEvent[],
  lastAppendSeq: number,
  index?: Map<string, number>,
): ChatEventApplyResult {
  if (incoming.length === 0) return { entries, lastAppendSeq, changed: false };
  const byMessageId = index ?? buildEventIndex(entries);
  let next: ChatMessageEvent[] | null = null;
  const anchorAppendSeq = lastAppendSeq;
  let nextLastAppendSeq = lastAppendSeq;

  for (const event of incoming) {
    if (event.appendSeq <= anchorAppendSeq) continue;
    nextLastAppendSeq = Math.max(nextLastAppendSeq, event.appendSeq);
    const list = next ?? entries;
    const existingIndex = byMessageId.get(event.messageId);
    if (existingIndex !== undefined) {
      if (list[existingIndex].rev >= event.rev) continue;
      next = next ?? [...entries];
      next[existingIndex] = { ...event, seq: list[existingIndex].seq };
      continue;
    }

    // Revisions for messages older than the loaded window should not create
    // stray rows above the window, but they still advance the cursor.
    const windowOldestSeq = list.length > 0 ? list[0].seq : 0;
    if (event.rev > 1 && windowOldestSeq > 0 && event.seq < windowOldestSeq) continue;

    next = next ?? [...entries];
    insertBySeqIndexed(next, event, byMessageId);
  }

  return next
    ? { entries: next, lastAppendSeq: nextLastAppendSeq, changed: true }
    : { entries, lastAppendSeq: nextLastAppendSeq, changed: nextLastAppendSeq !== lastAppendSeq };
}

export function buildEventIndex(entries: ChatMessageEvent[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) index.set(entries[i].messageId, i);
  return index;
}

function insertBySeqIndexed(
  list: ChatMessageEvent[],
  event: ChatMessageEvent,
  index: Map<string, number>,
): void {
  if (list.length === 0 || list[list.length - 1].seq < event.seq) {
    index.set(event.messageId, list.length);
    list.push(event);
    return;
  }
  insertBySeq(list, event);
  index.clear();
  for (let i = 0; i < list.length; i++) index.set(list[i].messageId, i);
}

function insertBySeq(list: ChatMessageEvent[], event: ChatMessageEvent): void {
  if (list.length === 0 || list[list.length - 1].seq < event.seq) {
    list.push(event);
    return;
  }
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].seq < event.seq) lo = mid + 1;
    else hi = mid;
  }
  if (list[lo]?.seq === event.seq && list[lo].messageId === event.messageId) return;
  list.splice(lo, 0, event);
}
