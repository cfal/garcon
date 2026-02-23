// Discriminated union of all WebSocket messages the server can emit.
// Shared between server and client to enforce a typed contract.

// Top-level server->client messages.
// Each interface matches exactly the object literal the server constructs.

import type { ChatMessage } from './chat-types';
import { parseChatMessages } from './chat-types';
import type { QueueState } from './queue-state';
import { normalizeQueueState } from './queue-state';

export class AgentRunOutputMessage {
  readonly type = 'agent-run-output' as const;
  constructor(public chatId: string, public messages: ChatMessage[]) { }
}

export class AgentRunFinishedMessage {
  readonly type = 'agent-run-finished' as const;
  constructor(public chatId: string, public exitCode?: number) { }
}

export class AgentRunFailedMessage {
  readonly type = 'agent-run-failed' as const;
  constructor(public chatId: string, public error: string) { }
}

export class ChatSessionCreatedMessage {
  readonly type = 'chat-session-created' as const;
  constructor(public chatId: string) { }
}

export class ChatSessionStoppedMessage {
  readonly type = 'chat-session-stopped' as const;
  constructor(public chatId: string, public success: boolean) { }
}

export class ChatProcessingUpdatedMessage {
  readonly type = 'chat-processing-updated' as const;
  constructor(public chatId: string, public isProcessing: boolean) { }
}

export class QueueStateUpdatedMessage {
  readonly type = 'queue-state-updated' as const;
  constructor(public chatId: string, public queue: QueueState) { }
}

export class QueueDispatchingMessage {
  readonly type = 'queue-dispatching' as const;
  constructor(public chatId: string, public entryId: string, public content: string) { }
}

export class ChatSessionsRunningMessage {
  readonly type = 'chat-sessions-running' as const;
  constructor(public sessions: {
    claude: Array<{ id: string }>;
    codex: Array<{ id: string }>;
    opencode: Array<{ id: string }>;
  }) { }
}

export class WsFaultMessage {
  readonly type = 'ws-fault' as const;
  constructor(public error: string) { }
}

export class ChatTitleUpdatedMessage {
  readonly type = 'chat-title-updated' as const;
  constructor(public chatId: string, public title: string) { }
}

export class ChatSessionDeletedWsMessage {
  readonly type = 'chat-session-deleted' as const;
  constructor(public chatId: string) { }
}

// Sent back to the client when a client sends a mark read message (see postMarkRead, postMarkReadBatch)
// Mainly for multi-client syncing. Clients compute isUnread locally to
// avoid a race where server-side lastActivity advances during streaming.
export class ChatReadUpdatedV1Message {
  readonly type = 'chat-read-updated-v1' as const;
  constructor(
    public chatId: string,
    public lastReadAt: string,
  ) { }
}

export type ChatListInvalidationReason = 'pinned-toggled' | 'archive-toggled' | 'chats-reordered' | 'chats-reordered-quick';

// Broadcast when a sidebar list mutation (pin/archive/reorder) occurs.
// Receivers trigger a full chat list refresh for server-authoritative convergence.
export class ChatListRefreshRequestedMessage {
  readonly type = 'chat-list-refresh-requested' as const;
  constructor(
    public reason: ChatListInvalidationReason,
    public chatId: string,
  ) { }
}

export class ChatLogResponseMessage {
  readonly type = 'chat-log-response' as const;
  constructor(
    public clientRequestId: string,
    public chatId: string,
    public messages: ChatMessage[],
    public total: number,
    public hasMore: boolean,
    public offset: number,
    public limit: number,
  ) { }
}

export type ClientRequestErrorCode =
  | 'MISSING_CHAT_ID'
  | 'REQUEST_VALIDATION_FAILED'
  | 'SESSION_NOT_FOUND'
  | 'NATIVE_PATH_UNRESOLVED'
  | 'HISTORY_LOAD_FAILED'
  | 'REQUEST_TIMEOUT'
  | 'INTERNAL_ERROR';

export class ClientRequestErrorMessage {
  readonly type = 'client-request-error' as const;
  constructor(
    public clientRequestId: string,
    public requestType: string,
    public code: ClientRequestErrorCode,
    public message: string,
    public retryable: boolean,
    public chatId?: string,
  ) { }
}

// Discriminated union of all server->client WS messages
export type ServerWsMessage =
  | AgentRunOutputMessage
  | AgentRunFinishedMessage
  | AgentRunFailedMessage
  | ChatSessionCreatedMessage
  | ChatSessionStoppedMessage
  | ChatProcessingUpdatedMessage
  | QueueStateUpdatedMessage
  | QueueDispatchingMessage
  | ChatSessionsRunningMessage
  | WsFaultMessage
  | ChatTitleUpdatedMessage
  | ChatSessionDeletedWsMessage
  | ChatReadUpdatedV1Message
  | ChatListRefreshRequestedMessage
  | ChatLogResponseMessage
  | ClientRequestErrorMessage;

// Dispatch key used by the client event router. One entry per server
// message type -- no provider suffixes.
export type EventKey =
  | 'agent-run-output'
  | 'agent-run-finished'
  | 'agent-run-failed'
  | 'chat-session-created'
  | 'chat-session-stopped'
  | 'chat-processing-updated'
  | 'queue-state-updated'
  | 'queue-dispatching'
  | 'chat-sessions-running'
  | 'ws-fault'
  | 'chat-title-updated'
  | 'chat-session-deleted'
  | 'chat-read-updated-v1'
  | 'chat-list-refresh-requested'
  | 'chat-log-response'
  | 'client-request-error';

// Narrows an unknown value to string, defaulting to ''.
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Constructs a typed ServerWsMessage class instance from raw data.
// Returns null for unrecognized message types.
export function parseServerWsMessage(data: Record<string, unknown>): ServerWsMessage | null {
  switch (data.type) {
    case 'agent-run-output':
      return new AgentRunOutputMessage(str(data.chatId), parseChatMessages(data.messages));
    case 'agent-run-finished':
      return new AgentRunFinishedMessage(str(data.chatId), data.exitCode as number | undefined);
    case 'agent-run-failed':
      return new AgentRunFailedMessage(str(data.chatId), str(data.error));
    case 'chat-session-created':
      return new ChatSessionCreatedMessage(str(data.chatId));
    case 'chat-session-stopped':
      return new ChatSessionStoppedMessage(str(data.chatId), Boolean(data.success));
    case 'chat-processing-updated':
      return new ChatProcessingUpdatedMessage(str(data.chatId), Boolean(data.isProcessing));
    case 'queue-state-updated':
      return new QueueStateUpdatedMessage(str(data.chatId), normalizeQueueState(data.queue));
    case 'queue-dispatching':
      return new QueueDispatchingMessage(str(data.chatId), str(data.entryId), String(data.content ?? ''));
    case 'chat-sessions-running':
      return new ChatSessionsRunningMessage(data.sessions as ChatSessionsRunningMessage['sessions']);
    case 'ws-fault':
      return new WsFaultMessage(str(data.error));
    case 'chat-title-updated':
      return new ChatTitleUpdatedMessage(str(data.chatId), str(data.title));
    case 'chat-session-deleted':
      return new ChatSessionDeletedWsMessage(str(data.chatId));
    case 'chat-read-updated-v1':
      return new ChatReadUpdatedV1Message(str(data.chatId), str(data.lastReadAt));
    case 'chat-list-refresh-requested':
      return new ChatListRefreshRequestedMessage(data.reason as ChatListInvalidationReason, str(data.chatId));
    case 'chat-log-response':
      return new ChatLogResponseMessage(
        str(data.clientRequestId), str(data.chatId), parseChatMessages(data.messages),
        Number(data.total), Boolean(data.hasMore), Number(data.offset), Number(data.limit),
      );
    case 'client-request-error':
      return new ClientRequestErrorMessage(
        str(data.clientRequestId),
        str(data.requestType),
        data.code as ClientRequestErrorCode,
        str(data.message),
        Boolean(data.retryable),
        data.chatId as string | undefined,
      );
    default:
      return null;
  }
}

// Client->server request types are defined in shared/ws-requests.ts.
