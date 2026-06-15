// Discriminated union of all WebSocket messages the server can emit.
// Shared between server and client to enforce a typed contract.

// Top-level server->client messages.
// Each interface matches exactly the object literal the server constructs.

import type { ChatMessageEvent } from './chat-events';
import { parseChatMessageEvents } from './chat-events';
import type { PendingUserInput, PendingUserInputClearReason } from './pending-user-input';
import { normalizePendingUserInput } from './pending-user-input';
import type { QueueState } from './queue-state';
import { normalizeQueueState } from './queue-state';
import type { RemoteSettingsSnapshot } from './settings';
import { normalizeRemoteSettingsSnapshot } from './settings';

export class ChatEventsMessage {
  readonly type = 'chat-events' as const;
  constructor(
    public chatId: string,
    public logId: string,
    public events: ChatMessageEvent[],
    public turnId?: string,
    public clientRequestId?: string,
    public upstreamRequestId?: string,
  ) { }
}

export type ChatSubscribeMode = 'delta' | 'snapshot-required';

export class ChatSubscribedMessage {
  readonly type = 'chat-subscribed' as const;
  constructor(
    public clientRequestId: string,
    public chatId: string,
    public logId: string,
    public mode: ChatSubscribeMode,
    public events: ChatMessageEvent[],
    public lastAppendSeq: number,
  ) { }
}

export class ChatGenerationResetMessage {
  readonly type = 'chat-generation-reset' as const;
  constructor(
    public chatId: string,
    public logId: string,
    public events: ChatMessageEvent[],
    public lastAppendSeq: number,
    public localNotice?: string,
  ) { }
}

export class ChatReloadedMessage {
  readonly type = 'chat-reloaded' as const;
  constructor(
    public clientRequestId: string,
    public chatId: string,
    public logId: string,
    public events: ChatMessageEvent[],
    public lastAppendSeq: number,
    public localNotice?: string,
  ) { }
}

export class AgentRunFinishedMessage {
  readonly type = 'agent-run-finished' as const;
  constructor(
    public chatId: string,
    public exitCode?: number,
    public turnId?: string,
    public clientRequestId?: string,
    public upstreamRequestId?: string,
  ) { }
}

export class AgentRunFailedMessage {
  readonly type = 'agent-run-failed' as const;
  constructor(
    public chatId: string,
    public error: string,
    public turnId?: string,
    public clientRequestId?: string,
    public upstreamRequestId?: string,
  ) { }
}

export class ChatSessionCreatedMessage {
  readonly type = 'chat-session-created' as const;
  constructor(public chatId: string) { }
}

export class ChatForkCreatedMessage {
  readonly type = 'chat-fork-created' as const;
  constructor(public sourceChatId: string, public chatId: string) { }
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

export class PendingUserInputUpdatedMessage {
  readonly type = 'pending-user-input-updated' as const;
  constructor(public input: PendingUserInput) { }
}

export class PendingUserInputClearedMessage {
  readonly type = 'pending-user-input-cleared' as const;
  constructor(
    public chatId: string,
    public clientRequestId: string,
    public reason: PendingUserInputClearReason,
  ) { }
}

export class ChatSessionsRunningMessage {
  readonly type = 'chat-sessions-running' as const;
  constructor(
    public sessions: Record<string, Array<{ id: string }>>,
    public clientRequestId?: string,
  ) { }
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

export const CHAT_LIST_INVALIDATION_REASONS = [
  'chat-added',
  'pinned-toggled',
  'archive-toggled',
  'chats-reordered',
  'chats-reordered-quick',
] as const;

export type ChatListInvalidationReason = typeof CHAT_LIST_INVALIDATION_REASONS[number];

export function isChatListInvalidationReason(value: unknown): value is ChatListInvalidationReason {
  return typeof value === 'string'
    && (CHAT_LIST_INVALIDATION_REASONS as readonly string[]).includes(value);
}

// Broadcast when a sidebar list mutation (add/pin/archive/reorder) occurs.
// Receivers trigger a full chat list refresh for server-authoritative convergence.
export class ChatListRefreshRequestedMessage {
  readonly type = 'chat-list-refresh-requested' as const;
  constructor(
    public reason: ChatListInvalidationReason,
    public chatId: string,
  ) { }
}

export class SettingsChangedMessage {
  readonly type = 'settings-changed' as const;
  constructor(public settings: RemoteSettingsSnapshot) { }
}

export class ChatLogResponseMessage {
  readonly type = 'chat-log-response' as const;
  constructor(
    public clientRequestId: string,
    public chatId: string,
    public logId: string,
    public events: ChatMessageEvent[],
    public pendingUserInputs: PendingUserInput[],
    public lastAppendSeq: number,
    public pageOldestSeq: number,
    public hasMore: boolean,
    public limit: number,
    public localNotice?: string,
  ) { }
}

export type ClientRequestErrorCode =
  | 'MISSING_CHAT_ID'
  | 'REQUEST_VALIDATION_FAILED'
  | 'SESSION_NOT_FOUND'
  | 'CHAT_RUNNING'
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
  | ChatEventsMessage
  | ChatSubscribedMessage
  | ChatGenerationResetMessage
  | ChatReloadedMessage
  | AgentRunFinishedMessage
  | AgentRunFailedMessage
  | ChatSessionCreatedMessage
  | ChatForkCreatedMessage
  | ChatSessionStoppedMessage
  | ChatProcessingUpdatedMessage
  | QueueStateUpdatedMessage
  | QueueDispatchingMessage
  | PendingUserInputUpdatedMessage
  | PendingUserInputClearedMessage
  | ChatSessionsRunningMessage
  | WsFaultMessage
  | ChatTitleUpdatedMessage
  | ChatSessionDeletedWsMessage
  | ChatReadUpdatedV1Message
  | ChatListRefreshRequestedMessage
  | SettingsChangedMessage
  | ChatLogResponseMessage
  | ClientRequestErrorMessage;

// Uses the message union as the single source of truth for dispatch keys.
export type EventKey = ServerWsMessage['type'];

// Narrows an unknown value to string, defaulting to ''.
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Validates a required non-empty string field. Returns null when the
// value is not a non-empty string so the caller can reject the message.
function requiredStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseChatListInvalidationReason(v: unknown): ChatListInvalidationReason | null {
  return isChatListInvalidationReason(v) ? v : null;
}

// Constructs a typed ServerWsMessage class instance from raw data.
// Returns null for unrecognized message types.
export function parseServerWsMessage(data: Record<string, unknown>): ServerWsMessage | null {
  switch (data.type) {
    case 'chat-events': {
      const chatId = requiredStr(data.chatId);
      const logId = requiredStr(data.logId);
      if (!chatId || !logId) return null;
      const events = parseChatMessageEvents(data.events);
      if (events === null) return null;
      return new ChatEventsMessage(
        chatId,
        logId,
        events,
        typeof data.turnId === 'string' ? data.turnId : undefined,
        typeof data.clientRequestId === 'string' ? data.clientRequestId : undefined,
        typeof data.upstreamRequestId === 'string' ? data.upstreamRequestId : undefined,
      );
    }
    case 'chat-subscribed': {
      const clientRequestId = requiredStr(data.clientRequestId);
      const chatId = requiredStr(data.chatId);
      const logId = requiredStr(data.logId);
      const mode = data.mode === 'delta' || data.mode === 'snapshot-required' ? data.mode : null;
      if (!clientRequestId || !chatId || !logId || !mode) return null;
      const events = parseChatMessageEvents(data.events);
      if (events === null) return null;
      return new ChatSubscribedMessage(
        clientRequestId,
        chatId,
        logId,
        mode,
        events,
        Number(data.lastAppendSeq) || 0,
      );
    }
    case 'chat-generation-reset': {
      const chatId = requiredStr(data.chatId);
      const logId = requiredStr(data.logId);
      if (!chatId || !logId) return null;
      const events = parseChatMessageEvents(data.events);
      if (events === null) return null;
      return new ChatGenerationResetMessage(
        chatId,
        logId,
        events,
        Number(data.lastAppendSeq) || 0,
        typeof data.localNotice === 'string' ? data.localNotice : undefined,
      );
    }
    case 'chat-reloaded': {
      const clientRequestId = requiredStr(data.clientRequestId);
      const chatId = requiredStr(data.chatId);
      const logId = requiredStr(data.logId);
      if (!clientRequestId || !chatId || !logId) return null;
      const events = parseChatMessageEvents(data.events);
      if (events === null) return null;
      return new ChatReloadedMessage(
        clientRequestId,
        chatId,
        logId,
        events,
        Number(data.lastAppendSeq) || 0,
        typeof data.localNotice === 'string' ? data.localNotice : undefined,
      );
    }
    case 'agent-run-finished': {
      const chatId = requiredStr(data.chatId);
      if (!chatId) return null;
      return new AgentRunFinishedMessage(
        chatId,
        data.exitCode as number | undefined,
        typeof data.turnId === 'string' ? data.turnId : undefined,
        typeof data.clientRequestId === 'string' ? data.clientRequestId : undefined,
        typeof data.upstreamRequestId === 'string' ? data.upstreamRequestId : undefined,
      );
    }
    case 'agent-run-failed': {
      const chatId = requiredStr(data.chatId);
      const error = requiredStr(data.error);
      if (!chatId || !error) return null;
      return new AgentRunFailedMessage(
        chatId,
        error,
        typeof data.turnId === 'string' ? data.turnId : undefined,
        typeof data.clientRequestId === 'string' ? data.clientRequestId : undefined,
        typeof data.upstreamRequestId === 'string' ? data.upstreamRequestId : undefined,
      );
    }
    case 'chat-session-created': {
      const chatId = requiredStr(data.chatId);
      if (!chatId) return null;
      return new ChatSessionCreatedMessage(chatId);
    }
    case 'chat-fork-created': {
      const sourceChatId = requiredStr(data.sourceChatId);
      const chatId = requiredStr(data.chatId);
      if (!sourceChatId || !chatId) return null;
      return new ChatForkCreatedMessage(sourceChatId, chatId);
    }
    case 'chat-session-stopped': {
      const chatId = requiredStr(data.chatId);
      if (!chatId) return null;
      return new ChatSessionStoppedMessage(chatId, Boolean(data.success));
    }
    case 'chat-processing-updated': {
      const chatId = requiredStr(data.chatId);
      if (!chatId) return null;
      return new ChatProcessingUpdatedMessage(chatId, Boolean(data.isProcessing));
    }
    case 'queue-state-updated': {
      const chatId = requiredStr(data.chatId);
      if (!chatId) return null;
      return new QueueStateUpdatedMessage(chatId, normalizeQueueState(data.queue));
    }
    case 'queue-dispatching': {
      const chatId = requiredStr(data.chatId);
      const entryId = requiredStr(data.entryId);
      if (!chatId || !entryId) return null;
      return new QueueDispatchingMessage(chatId, entryId, String(data.content ?? ''));
    }
    case 'pending-user-input-updated': {
      const input = normalizePendingUserInput(data.input);
      return input ? new PendingUserInputUpdatedMessage(input) : null;
    }
    case 'pending-user-input-cleared': {
      const chatId = requiredStr(data.chatId);
      const clientRequestId = requiredStr(data.clientRequestId);
      const reason = data.reason === 'chat-removed' ? data.reason : null;
      if (!chatId || !clientRequestId || !reason) return null;
      return new PendingUserInputClearedMessage(chatId, clientRequestId, reason);
    }
    case 'chat-sessions-running':
      return new ChatSessionsRunningMessage(
        data.sessions as ChatSessionsRunningMessage['sessions'],
        typeof data.clientRequestId === 'string' ? data.clientRequestId : undefined,
      );
    case 'ws-fault':
      return new WsFaultMessage(str(data.error));
    case 'chat-title-updated': {
      const chatId = requiredStr(data.chatId);
      if (!chatId) return null;
      return new ChatTitleUpdatedMessage(chatId, str(data.title));
    }
    case 'chat-session-deleted': {
      const chatId = requiredStr(data.chatId);
      if (!chatId) return null;
      return new ChatSessionDeletedWsMessage(chatId);
    }
    case 'chat-read-updated-v1': {
      const chatId = requiredStr(data.chatId);
      const lastReadAt = requiredStr(data.lastReadAt);
      if (!chatId || !lastReadAt) return null;
      return new ChatReadUpdatedV1Message(chatId, lastReadAt);
    }
    case 'chat-list-refresh-requested': {
      const reason = parseChatListInvalidationReason(data.reason);
      const chatId = requiredStr(data.chatId);
      if (!reason || !chatId) return null;
      return new ChatListRefreshRequestedMessage(reason, chatId);
    }
    case 'settings-changed': {
      const settings = normalizeRemoteSettingsSnapshot(data.settings);
      if (!settings) return null;
      return new SettingsChangedMessage(settings);
    }
    case 'chat-log-response': {
      const clientRequestId = requiredStr(data.clientRequestId);
      const chatId = requiredStr(data.chatId);
      const logId = requiredStr(data.logId);
      if (!clientRequestId || !chatId || !logId) return null;
      const events = parseChatMessageEvents(data.events);
      if (events === null) return null;
      const pendingUserInputs = Array.isArray(data.pendingUserInputs)
        ? data.pendingUserInputs
          .map(normalizePendingUserInput)
          .filter((input): input is PendingUserInput => Boolean(input))
        : [];
      return new ChatLogResponseMessage(
        clientRequestId,
        chatId,
        logId,
        events,
        pendingUserInputs,
        Number(data.lastAppendSeq) || 0,
        Number(data.pageOldestSeq) || 0,
        Boolean(data.hasMore),
        Number(data.limit),
        typeof data.localNotice === 'string' ? data.localNotice : undefined,
      );
    }
    case 'client-request-error': {
      const clientRequestId = requiredStr(data.clientRequestId);
      const requestType = requiredStr(data.requestType);
      if (!clientRequestId || !requestType) return null;
      return new ClientRequestErrorMessage(
        clientRequestId,
        requestType,
        data.code as ClientRequestErrorCode,
        str(data.message),
        Boolean(data.retryable),
        data.chatId as string | undefined,
      );
    }
    default:
      return null;
  }
}

// Client->server request types are defined in shared/ws-requests.ts.
