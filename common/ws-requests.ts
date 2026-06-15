// Discriminated union of WebSocket request messages the client can emit.
// Mutating chat commands use the HTTP command ledger; WS is read/resume only.

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

export class ChatLogQueryRequest {
  readonly type = 'chat-log-query' as const;
  constructor(
    public clientRequestId: string | null,
    public chatId: string | null,
    public limit?: number,
    public beforeSeq?: number,
  ) { }

  static fromJson(data: Record<string, unknown>): ChatLogQueryRequest {
    return new ChatLogQueryRequest(
      strOrNull(data.clientRequestId),
      strOrNull(data.chatId),
      data.limit as number | undefined,
      data.beforeSeq as number | undefined,
    );
  }
}

export class ChatSubscribeRequest {
  readonly type = 'chat-subscribe' as const;
  constructor(
    public clientRequestId: string | null,
    public chatId: string | null,
    public logId: string,
    public afterAppendSeq: number,
  ) { }

  static fromJson(data: Record<string, unknown>): ChatSubscribeRequest {
    const afterAppendSeq = typeof data.afterAppendSeq === 'number'
      && Number.isInteger(data.afterAppendSeq)
      && data.afterAppendSeq >= 0
      ? data.afterAppendSeq
      : 0;
    const logId = typeof data.logId === 'string' ? data.logId : '';
    return new ChatSubscribeRequest(
      strOrNull(data.clientRequestId),
      strOrNull(data.chatId),
      logId,
      afterAppendSeq,
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
  | ChatLogQueryRequest
  | ChatSubscribeRequest
  | ChatReloadRequest;

export function parseClientWsMessage(data: Record<string, unknown>): ClientWsMessage | null {
  switch (data.type) {
    case 'chats-running-query':
      return ChatRunningQueryRequest.fromJson(data);
    case 'chat-log-query':
      return ChatLogQueryRequest.fromJson(data);
    case 'chat-subscribe':
      return ChatSubscribeRequest.fromJson(data);
    case 'chat-reload':
      return ChatReloadRequest.fromJson(data);
    default:
      return null;
  }
}
