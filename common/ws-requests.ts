// Discriminated union of WebSocket request messages the client can emit.
// Mutating chat commands use the HTTP command ledger; WS is read/resume only.

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

export class ChatSubscribeRequest {
  readonly type = 'chat-subscribe' as const;
  constructor(
    public clientRequestId: string | null,
    public chatId: string | null,
    public generationId: string,
    public afterSeq: number,
  ) { }

  static fromJson(data: Record<string, unknown>): ChatSubscribeRequest {
    const afterSeq = typeof data.afterSeq === 'number'
      && Number.isInteger(data.afterSeq)
      && data.afterSeq >= 0
      ? data.afterSeq
      : 0;
    const generationId = typeof data.generationId === 'string' ? data.generationId : '';
    return new ChatSubscribeRequest(
      strOrNull(data.clientRequestId),
      strOrNull(data.chatId),
      generationId,
      afterSeq,
    );
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
  | ChatReloadRequest
  | WsPingRequest;

export function parseClientWsMessage(data: Record<string, unknown>): ClientWsMessage | null {
  switch (data.type) {
    case 'reconnect-state-query':
      return ReconnectStateQueryRequest.fromJson(data);
    case 'chat-subscribe':
      return ChatSubscribeRequest.fromJson(data);
    case 'chat-reload':
      return ChatReloadRequest.fromJson(data);
    case 'ws-ping':
      return WsPingRequest.fromJson(data);
    default:
      return null;
  }
}
