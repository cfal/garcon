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

export class ChatRunningQueryRequest {
  readonly type = 'chats-running-query' as const;
  constructor(public clientRequestId: string | null = null) { }

  static fromJson(data: Record<string, unknown>): ChatRunningQueryRequest {
    return new ChatRunningQueryRequest(strOrNull(data.clientRequestId));
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

export type ClientWsMessage =
  | ChatRunningQueryRequest
  | ChatSubscribeRequest
  | ChatReloadRequest;

export function parseClientWsMessage(data: Record<string, unknown>): ClientWsMessage | null {
  switch (data.type) {
    case 'chats-running-query':
      return ChatRunningQueryRequest.fromJson(data);
    case 'chat-subscribe':
      return ChatSubscribeRequest.fromJson(data);
    case 'chat-reload':
      return ChatReloadRequest.fromJson(data);
    default:
      return null;
  }
}
