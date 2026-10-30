// Discriminated union of WebSocket request messages the client can emit.
// Mutating chat commands use the HTTP command ledger; WS is read/resume only.

import type { TranscriptReadPurpose } from './chat-view';
import { CHAT_ID_LENGTH, parseChatId } from './chat-id';

export interface AgentCommandImage {
  data: string;
  name?: string;
  mimeType?: string;
}

// Narrows an unknown value to string | null for chatId fields.
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

const MAX_RECONNECT_CONTROL_CHAT_IDS = 256;

function reconnectControlChatIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const chatId = item.trim();
    if (!chatId || seen.has(chatId)) continue;
    seen.add(chatId);
    result.push(chatId);
    if (result.length >= MAX_RECONNECT_CONTROL_CHAT_IDS) break;
  }
  return result;
}

export class ReconnectStateQueryRequest {
  readonly type = 'reconnect-state-query' as const;
  constructor(
    public clientRequestId: string | null,
    public controlChatIds: string[],
  ) { }

  static fromJson(data: Record<string, unknown>): ReconnectStateQueryRequest {
    return new ReconnectStateQueryRequest(
      strOrNull(data.clientRequestId),
      reconnectControlChatIds(data.controlChatIds),
    );
  }
}

// An activation purpose marks the first page of a cached-window catch-up for the
// selected chat. Like an activation newest-history read, it schedules the advisory
// native drift probe; continuations carry a watermark and never schedule it.
export class ChatSubscribeRequest {
  readonly type = 'chat-subscribe' as const;
  constructor(
    public clientRequestId: string | null,
    public chatId: string | null,
    public transcriptViewId: string,
    public afterOrdinal: number,
    public throughOrdinal?: number,
    public purpose?: TranscriptReadPurpose,
  ) { }

  static fromJson(data: Record<string, unknown>): ChatSubscribeRequest | null {
    const purpose: TranscriptReadPurpose | undefined = data.purpose === 'activation' ? 'activation' : undefined;
    if (data.purpose !== undefined && (purpose === undefined || data.throughOrdinal !== undefined)) {
      return null;
    }
    if (
      typeof data.afterOrdinal !== 'number'
      || !Number.isSafeInteger(data.afterOrdinal)
      || data.afterOrdinal < 0
      || typeof data.transcriptViewId !== 'string'
      || data.transcriptViewId.length === 0
    ) return null;
    const throughOrdinal = data.throughOrdinal === undefined
      ? undefined
      : data.throughOrdinal;
    if (
      throughOrdinal !== undefined
      && (
        typeof throughOrdinal !== 'number'
        || !Number.isSafeInteger(throughOrdinal)
        || throughOrdinal < data.afterOrdinal
      )
    ) return null;
    return new ChatSubscribeRequest(
      strOrNull(data.clientRequestId),
      strOrNull(data.chatId),
      data.transcriptViewId,
      data.afterOrdinal,
      throughOrdinal,
      purpose,
    );
  }
}

export const MAX_TRANSCRIPT_INTEREST_CHAT_IDS = 64;

// Replaces the complete set of chats whose transcript bodies this socket
// displays. Each declaration supersedes the previous one on the same socket, so
// repeating a declaration is a no-op and only the latest one matters.
export class ChatTranscriptInterestRequest {
  readonly type = 'chat-transcript-interest' as const;
  constructor(public chatIds: string[]) { }

  static fromJson(data: Record<string, unknown>): ChatTranscriptInterestRequest | null {
    if (!Array.isArray(data.chatIds) || data.chatIds.length > MAX_TRANSCRIPT_INTEREST_CHAT_IDS) return null;
    const chatIds = new Set<string>();
    for (const item of data.chatIds) {
      if (typeof item !== 'string' || item.length !== CHAT_ID_LENGTH) return null;
      try {
        chatIds.add(parseChatId(item));
      } catch {
        return null;
      }
    }
    return new ChatTranscriptInterestRequest([...chatIds]);
  }
}

export class ChatReloadRequest {
  readonly type = 'chat-reload' as const;
  constructor(
    public clientRequestId: string | null,
    public chatId: string | null,
  ) { }

  static fromJson(data: Record<string, unknown>): ChatReloadRequest {
    return new ChatReloadRequest(strOrNull(data.clientRequestId), strOrNull(data.chatId));
  }
}

// Cancels this socket's reload with the given request ID. Cancellation stops
// reading native history; a reload already saving still completes.
export class ChatReloadCancelRequest {
  readonly type = 'chat-reload-cancel' as const;
  constructor(
    public chatId: string | null,
    public reloadRequestId: string | null,
  ) { }

  static fromJson(data: Record<string, unknown>): ChatReloadCancelRequest {
    return new ChatReloadCancelRequest(strOrNull(data.chatId), strOrNull(data.reloadRequestId));
  }
}

export class WsPingRequest {
  readonly type = 'ws-ping' as const;
  constructor(
    public clientRequestId: string | null,
    public sentAt: number,
  ) { }

  static fromJson(data: Record<string, unknown>): WsPingRequest {
    const sentAt = typeof data.sentAt === 'number' && Number.isFinite(data.sentAt)
      ? data.sentAt
      : 0;
    return new WsPingRequest(strOrNull(data.clientRequestId), sentAt);
  }
}

export type ClientWsMessage =
  | ReconnectStateQueryRequest
  | ChatSubscribeRequest
  | ChatTranscriptInterestRequest
  | ChatReloadRequest
  | ChatReloadCancelRequest
  | WsPingRequest;

export function parseClientWsMessage(data: Record<string, unknown>): ClientWsMessage | null {
  switch (data.type) {
    case 'reconnect-state-query':
      return ReconnectStateQueryRequest.fromJson(data);
    case 'chat-subscribe':
      return ChatSubscribeRequest.fromJson(data);
    case 'chat-transcript-interest':
      return ChatTranscriptInterestRequest.fromJson(data);
    case 'chat-reload':
      return ChatReloadRequest.fromJson(data);
    case 'chat-reload-cancel':
      return ChatReloadCancelRequest.fromJson(data);
    case 'ws-ping':
      return WsPingRequest.fromJson(data);
    default:
      return null;
  }
}
