import { isToolUseMessage, type ChatMessage } from './chat-types.js';
import type { TranscriptMessage } from './chat-view.js';
import { displayInteger, displayRecord, displayString } from './transcript-display-contract.js';
import { parseDisplayPreparationStatus, type DisplayPreparationStatus } from './transcript-display-open.js';

export const RESPONSE_CLASSES = ['assistant', 'command-output', 'command-result', 'thinking', 'error', 'permission', 'tool'] as const;
export type ResponseClass = typeof RESPONSE_CLASSES[number];
export type ResponseClassOrdinals = Readonly<Record<ResponseClass, number>>;
export interface TranscriptPreview { readonly ordinal: number; readonly text: string; readonly timestamp: string }

export function emptyResponseClassOrdinals(): Record<ResponseClass, number> {
  return { assistant: 0, 'command-output': 0, 'command-result': 0, thinking: 0, error: 0, permission: 0, tool: 0 };
}

export function responseClass(message: ChatMessage): ResponseClass | null {
  switch (message.type) {
    case 'assistant-message': return 'assistant';
    case 'command-output': return 'command-output';
    case 'command-result': return 'command-result';
    case 'thinking': return 'thinking';
    case 'error': return 'error';
    case 'permission-request': return 'permission';
    default: return isToolUseMessage(message) ? 'tool' : null;
  }
}

export function transcriptActivity(entries: readonly TranscriptMessage[]): {
  presentedActivityAt: string | null; preview: TranscriptPreview | null; responseClassOrdinals: ResponseClassOrdinals;
} {
  let presentedActivityAt: string | null = null, preview: TranscriptPreview | null = null;
  const ordinals = emptyResponseClassOrdinals();
  for (const { ordinal, message } of entries) {
    if (message.timestamp && (!presentedActivityAt || message.timestamp > presentedActivityAt)) presentedActivityAt = message.timestamp;
    if (message.type === 'assistant-message' || message.type === 'user-message' || message.type === 'command-output') {
      const text = String(message.content ?? '');
      const newline = text.indexOf('\n');
      preview = { ordinal, text: (newline < 0 ? text : text.slice(0, newline)).trim().slice(0, 200), timestamp: message.timestamp };
    }
    const kind = responseClass(message);
    if (kind) ordinals[kind] = Math.max(ordinals[kind], ordinal);
  }
  return { presentedActivityAt, preview, responseClassOrdinals: ordinals };
}

export class ChatTranscriptHeadUpdatedMessage {
  readonly type = 'chat-transcript-head-updated' as const;
  constructor(
    public readonly serverInstanceId: string, public readonly chatId: string, public readonly transcriptViewId: string,
    public readonly sourceHead: number, public readonly presentedActivityAt: string | null,
    public readonly preview: TranscriptPreview | null, public readonly responseClassOrdinals: ResponseClassOrdinals,
    public readonly planRevision: number, public readonly auxiliaryRevision: number,
  ) {}
}

export class ChatInputCommittedMessage {
  readonly type = 'chat-input-committed' as const;
  constructor(public readonly serverInstanceId: string, public readonly chatId: string, public readonly transcriptViewId: string,
    public readonly clientMessageId: string, public readonly ordinal: number) {}
}

export class ChatDisplayStateUpdatedMessage implements DisplayPreparationStatus {
  readonly type = 'chat-display-state-updated' as const;
  constructor(public readonly serverInstanceId: string, public readonly chatId: string, public readonly transcriptViewId: string,
    public readonly policyRevision: number, public readonly bashRevision: string, public readonly preparedThrough: number,
    public readonly phase: DisplayPreparationStatus['phase'], public readonly errorCode: string | null,
    public readonly auxiliaryRevision = 0) {}
}

export type TranscriptDisplayEvent = ChatTranscriptHeadUpdatedMessage | ChatInputCommittedMessage | ChatDisplayStateUpdatedMessage;

export function parseTranscriptDisplayEvent(value: unknown): TranscriptDisplayEvent | null {
  try {
    const raw = displayRecord(value);
    const server = displayString(raw.serverInstanceId), chat = displayString(raw.chatId, 128), view = displayString(raw.transcriptViewId, 256);
    switch (raw.type) {
      case 'chat-input-committed': return new ChatInputCommittedMessage(server, chat, view, displayString(raw.clientMessageId, 256), displayInteger(raw.ordinal, 1));
      case 'chat-display-state-updated': {
        const status = parseDisplayPreparationStatus(raw);
        return new ChatDisplayStateUpdatedMessage(server, chat, view, status.policyRevision, status.bashRevision, status.preparedThrough, status.phase, status.errorCode,
          displayInteger(raw.auxiliaryRevision));
      }
      case 'chat-transcript-head-updated': {
        const head = displayInteger(raw.sourceHead), source = displayRecord(raw.responseClassOrdinals), ordinals = emptyResponseClassOrdinals();
        for (const key of RESPONSE_CLASSES) ordinals[key] = displayInteger(source[key], 0, head);
        const activity = raw.presentedActivityAt === null ? null : displayString(raw.presentedActivityAt, 64);
        const p = raw.preview === null ? null : displayRecord(raw.preview);
        if (p && (typeof p.text !== 'string' || p.text.length > 200)) return null;
        const preview = p ? { ordinal: displayInteger(p.ordinal, 1, head), text: p.text as string, timestamp: displayString(p.timestamp, 64) } : null;
        return new ChatTranscriptHeadUpdatedMessage(server, chat, view, head, activity, preview, ordinals,
          displayInteger(raw.planRevision), displayInteger(raw.auxiliaryRevision));
      }
      default: return null;
    }
  } catch { return null; }
}
