import type { ChatGenerationResetReason, ChatViewMessage } from './chat-view';
import { parseChatViewMessages } from './chat-view';
import type {
  PendingUserInput,
  PendingUserInputClearReason,
} from './pending-user-input';
import { normalizePendingUserInput } from './pending-user-input';
import type { QueueState } from './queue-state';
import { parseQueueState } from './queue-state';
import type { RemoteSettingsSnapshot } from './settings';
import { normalizeRemoteSettingsSnapshot } from './settings';
import {
  isScheduledPromptsInvalidationReason,
  type ScheduledPromptsInvalidationReason,
} from './scheduled-prompts';
import {
  isSnippetsInvalidationReason,
  type SnippetsInvalidationReason,
} from './snippets';

export class ChatMessagesMessage {
  readonly type = 'chat-messages' as const;
  constructor(
    public chatId: string,
    public generationId: string,
    public messages: ChatViewMessage[],
    public turnId?: string,
    public clientRequestId?: string,
    public upstreamRequestId?: string,
  ) {}
}

export type ChatSubscribeMode = 'delta' | 'snapshot-required';

export class ChatSubscribedMessage {
  readonly type = 'chat-subscribed' as const;
  constructor(
    public clientRequestId: string,
    public chatId: string,
    public generationId: string | null,
    public mode: ChatSubscribeMode,
    public messages: ChatViewMessage[],
    public lastSeq: number,
  ) {}
}

export class ChatGenerationResetMessage {
  readonly type = 'chat-generation-reset' as const;
  constructor(
    public chatId: string,
    public generationId: string,
    public reason: ChatGenerationResetReason,
    public lastSeq: number,
  ) {}
}

export class ChatReloadedMessage {
  readonly type = 'chat-reloaded' as const;
  constructor(
    public clientRequestId: string,
    public chatId: string,
    public generationId: string,
    public messages: ChatViewMessage[],
    public lastSeq: number,
    public pageOldestSeq: number,
    public hasMore: boolean,
  ) {}
}

export class AgentRunFinishedMessage {
  readonly type = 'agent-run-finished' as const;
  constructor(
    public chatId: string,
    public exitCode?: number,
    public turnId?: string,
    public clientRequestId?: string,
    public upstreamRequestId?: string,
  ) {}
}

export class AgentRunFailedMessage {
  readonly type = 'agent-run-failed' as const;
  constructor(
    public chatId: string,
    public error: string,
    public turnId?: string,
    public clientRequestId?: string,
    public upstreamRequestId?: string,
  ) {}
}

export class ChatSessionCreatedMessage {
  readonly type = 'chat-session-created' as const;
  constructor(public chatId: string) {}
}

export class ChatProjectPathUpdatedMessage {
  readonly type = 'chat-project-path-updated' as const;
  constructor(
    public chatId: string,
    public projectPath: string,
    public effectiveProjectKey: string,
    public previousProjectPath: string,
    public previousEffectiveProjectKey: string | null,
  ) {}
}

export interface ChatProjectPathUpdatedPayload {
  chatId: string;
  projectPath: string;
  effectiveProjectKey: string;
  previousProjectPath: string;
  previousEffectiveProjectKey: string | null;
}

export class ChatSessionStoppedMessage {
  readonly type = 'chat-session-stopped' as const;
  constructor(
    public chatId: string,
    public success: boolean,
  ) {}
}

export class ChatProcessingUpdatedMessage {
  readonly type = 'chat-processing-updated' as const;
  constructor(
    public chatId: string,
    public isProcessing: boolean,
  ) {}
}

export class QueueStateUpdatedMessage {
  readonly type = 'queue-state-updated' as const;
  constructor(
    public chatId: string,
    public queue: QueueState,
  ) {}
}

export class QueueDispatchingMessage {
  readonly type = 'queue-dispatching' as const;
  constructor(
    public chatId: string,
    public entryId: string,
    public content: string,
  ) {}
}

export type ReconnectQueueResult =
  | { chatId: string; outcome: 'snapshot'; queue: QueueState }
  | { chatId: string; outcome: 'not-found' }
  | { chatId: string; outcome: 'unavailable' };

export type ReconnectProcessingResult =
  | { outcome: 'snapshot'; runningChatIds: string[] }
  | { outcome: 'unavailable' };

export class ReconnectStateMessage {
  readonly type = 'reconnect-state' as const;
  constructor(
    public processing: ReconnectProcessingResult,
    public queueResults: ReconnectQueueResult[],
    public clientRequestId?: string,
  ) {}
}

export class PendingUserInputUpdatedMessage {
  readonly type = 'pending-user-input-updated' as const;
  constructor(public input: PendingUserInput) {}
}

export class PendingUserInputClearedMessage {
  readonly type = 'pending-user-input-cleared' as const;
  constructor(
    public chatId: string,
    public clientRequestId: string,
    public reason: PendingUserInputClearReason,
  ) {}
}

export class WsFaultMessage {
  readonly type = 'ws-fault' as const;
  constructor(public error: string) {}
}

export class WsPongMessage {
  readonly type = 'ws-pong' as const;
  constructor(
    public clientRequestId: string,
    public sentAt: number,
    public serverTime: string,
  ) {}
}

export class ChatTitleUpdatedMessage {
  readonly type = 'chat-title-updated' as const;
  constructor(
    public chatId: string,
    public title: string,
  ) {}
}

export class ChatSessionDeletedWsMessage {
  readonly type = 'chat-session-deleted' as const;
  constructor(public chatId: string) {}
}

export class ChatReadUpdatedV1Message {
  readonly type = 'chat-read-updated-v1' as const;
  constructor(
    public chatId: string,
    public lastReadAt: string,
  ) {}
}

export const CHAT_LIST_INVALIDATION_REASONS = [
  'chat-added',
  'pinned-toggled',
  'archive-toggled',
  'chats-reordered',
  'chats-reordered-quick',
] as const;

export type ChatListInvalidationReason =
  (typeof CHAT_LIST_INVALIDATION_REASONS)[number];

export function isChatListInvalidationReason(
  value: unknown,
): value is ChatListInvalidationReason {
  return (
    typeof value === 'string' &&
    (CHAT_LIST_INVALIDATION_REASONS as readonly string[]).includes(value)
  );
}

export class ChatListRefreshRequestedMessage {
  readonly type = 'chat-list-refresh-requested' as const;
  constructor(
    public reason: ChatListInvalidationReason,
    public chatId: string,
  ) {}
}

export class SettingsChangedMessage {
  readonly type = 'settings-changed' as const;
  constructor(public settings: RemoteSettingsSnapshot) {}
}

export class ScheduledPromptsInvalidatedMessage {
  readonly type = 'scheduled-prompts-invalidated' as const;
  constructor(public reason: ScheduledPromptsInvalidationReason) {}
}

export class SnippetsInvalidatedMessage {
  readonly type = 'snippets-invalidated' as const;
  constructor(public reason: SnippetsInvalidationReason) {}
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

const CLIENT_REQUEST_ERROR_CODES: readonly ClientRequestErrorCode[] = [
  'MISSING_CHAT_ID',
  'REQUEST_VALIDATION_FAILED',
  'SESSION_NOT_FOUND',
  'CHAT_RUNNING',
  'NATIVE_PATH_UNRESOLVED',
  'HISTORY_LOAD_FAILED',
  'REQUEST_TIMEOUT',
  'INTERNAL_ERROR',
];

function isClientRequestErrorCode(value: unknown): value is ClientRequestErrorCode {
  return typeof value === 'string'
    && (CLIENT_REQUEST_ERROR_CODES as readonly string[]).includes(value);
}

export class ClientRequestErrorMessage {
  readonly type = 'client-request-error' as const;
  constructor(
    public clientRequestId: string,
    public requestType: string,
    public code: ClientRequestErrorCode,
    public message: string,
    public retryable: boolean,
    public chatId?: string,
  ) {}
}

export type ServerWsMessage =
  | ChatMessagesMessage
  | ChatSubscribedMessage
  | ChatGenerationResetMessage
  | ChatReloadedMessage
  | AgentRunFinishedMessage
  | AgentRunFailedMessage
  | ChatSessionCreatedMessage
  | ChatProjectPathUpdatedMessage
  | ChatSessionStoppedMessage
  | ChatProcessingUpdatedMessage
  | QueueStateUpdatedMessage
  | QueueDispatchingMessage
  | ReconnectStateMessage
  | PendingUserInputUpdatedMessage
  | PendingUserInputClearedMessage
  | WsFaultMessage
  | WsPongMessage
  | ChatTitleUpdatedMessage
  | ChatSessionDeletedWsMessage
  | ChatReadUpdatedV1Message
  | ChatListRefreshRequestedMessage
  | SettingsChangedMessage
  | ScheduledPromptsInvalidatedMessage
  | SnippetsInvalidatedMessage
  | ClientRequestErrorMessage;

export type EventKey = ServerWsMessage['type'];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function requiredStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nonNegativeInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function reconnectQueueResults(value: unknown): ReconnectQueueResult[] | null {
  if (!Array.isArray(value)) return null;
  const results: ReconnectQueueResult[] = [];
  const seen = new Set<string>();
  for (const valueResult of value) {
    if (!valueResult || typeof valueResult !== 'object') return null;
    const result = valueResult as Record<string, unknown>;
    const chatId = requiredStr(result.chatId);
    if (!chatId || seen.has(chatId)) return null;
    seen.add(chatId);
    if (result.outcome === 'snapshot' && result.queue && typeof result.queue === 'object') {
      const queue = parseQueueState(result.queue);
      if (!queue) return null;
      results.push({ chatId, outcome: 'snapshot', queue });
      continue;
    }
    if (result.outcome === 'not-found' || result.outcome === 'unavailable') {
      results.push({ chatId, outcome: result.outcome });
      continue;
    }
    return null;
  }
  return results;
}

function reconnectProcessingResult(value: unknown): ReconnectProcessingResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const result = value as Record<string, unknown>;
  if (result.outcome === 'unavailable') return { outcome: 'unavailable' };
  if (result.outcome !== 'snapshot' || !Array.isArray(result.runningChatIds)) return null;

  const runningChatIds: string[] = [];
  const seen = new Set<string>();
  for (const valueChatId of result.runningChatIds) {
    const chatId = requiredStr(valueChatId);
    if (!chatId) return null;
    if (seen.has(chatId)) continue;
    seen.add(chatId);
    runningChatIds.push(chatId);
  }

  return { outcome: 'snapshot', runningChatIds };
}

function hasField(data: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(data, key);
}

function nullableGenerationId(
  data: Record<string, unknown>,
): string | null | undefined {
  if (!hasField(data, 'generationId')) return undefined;
  if (data.generationId === null) return null;
  return requiredStr(data.generationId) ?? undefined;
}

function parseChatListInvalidationReason(
  v: unknown,
): ChatListInvalidationReason | null {
  return isChatListInvalidationReason(v) ? v : null;
}

function parseResetReason(value: unknown): ChatGenerationResetReason | null {
  return value === 'manual-reload' || value === 'process-error' ? value : null;
}

export function parseServerWsMessage(
  data: Record<string, unknown>,
): ServerWsMessage | null {
  switch (data.type) {
    case 'chat-messages': {
      const chatId = requiredStr(data.chatId);
      const generationId = requiredStr(data.generationId);
      if (!chatId || !generationId) return null;
      const messages = parseChatViewMessages(data.messages);
      if (messages === null) return null;
      return new ChatMessagesMessage(
        chatId,
        generationId,
        messages,
        typeof data.turnId === 'string' ? data.turnId : undefined,
        typeof data.clientRequestId === 'string'
          ? data.clientRequestId
          : undefined,
        typeof data.upstreamRequestId === 'string'
          ? data.upstreamRequestId
          : undefined,
      );
    }
    case 'chat-subscribed': {
      const clientRequestId = requiredStr(data.clientRequestId);
      const chatId = requiredStr(data.chatId);
      const mode =
        data.mode === 'delta' || data.mode === 'snapshot-required'
          ? data.mode
          : null;
      const generationId = nullableGenerationId(data);
      const lastSeq = nonNegativeInt(data.lastSeq);
      if (
        !clientRequestId ||
        !chatId ||
        !mode ||
        generationId === undefined ||
        lastSeq === null
      )
        return null;
      if (mode === 'delta' && generationId === null) return null;
      const messages = parseChatViewMessages(data.messages);
      if (messages === null) return null;
      return new ChatSubscribedMessage(
        clientRequestId,
        chatId,
        generationId,
        mode,
        messages,
        lastSeq,
      );
    }
    case 'chat-generation-reset': {
      const chatId = requiredStr(data.chatId);
      const generationId = requiredStr(data.generationId);
      const reason = parseResetReason(data.reason);
      const lastSeq = nonNegativeInt(data.lastSeq);
      if (!chatId || !generationId || !reason || lastSeq === null) return null;
      return new ChatGenerationResetMessage(
        chatId,
        generationId,
        reason,
        lastSeq,
      );
    }
    case 'chat-reloaded': {
      const clientRequestId = requiredStr(data.clientRequestId);
      const chatId = requiredStr(data.chatId);
      const generationId = requiredStr(data.generationId);
      const lastSeq = nonNegativeInt(data.lastSeq);
      const pageOldestSeq = nonNegativeInt(data.pageOldestSeq);
      if (
        !clientRequestId ||
        !chatId ||
        !generationId ||
        lastSeq === null ||
        pageOldestSeq === null
      )
        return null;
      const messages = parseChatViewMessages(data.messages);
      if (messages === null) return null;
      return new ChatReloadedMessage(
        clientRequestId,
        chatId,
        generationId,
        messages,
        lastSeq,
        pageOldestSeq,
        Boolean(data.hasMore),
      );
    }
    case 'agent-run-finished': {
      const chatId = requiredStr(data.chatId);
      const exitCode = data.exitCode;
      if (
        !chatId
        || (exitCode !== undefined && (typeof exitCode !== 'number' || !Number.isInteger(exitCode)))
      ) return null;
      return new AgentRunFinishedMessage(
        chatId,
        exitCode,
        typeof data.turnId === 'string' ? data.turnId : undefined,
        typeof data.clientRequestId === 'string'
          ? data.clientRequestId
          : undefined,
        typeof data.upstreamRequestId === 'string'
          ? data.upstreamRequestId
          : undefined,
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
        typeof data.clientRequestId === 'string'
          ? data.clientRequestId
          : undefined,
        typeof data.upstreamRequestId === 'string'
          ? data.upstreamRequestId
          : undefined,
      );
    }
    case 'chat-session-created': {
      const chatId = requiredStr(data.chatId);
      return chatId ? new ChatSessionCreatedMessage(chatId) : null;
    }
    case 'chat-project-path-updated': {
      const chatId = requiredStr(data.chatId);
      const projectPath = requiredStr(data.projectPath);
      const effectiveProjectKey = requiredStr(data.effectiveProjectKey);
      const previousProjectPath = requiredStr(data.previousProjectPath);
      const previousEffectiveProjectKey = data.previousEffectiveProjectKey;
      if (
        previousEffectiveProjectKey !== null &&
        typeof previousEffectiveProjectKey !== 'string'
      )
        return null;
      return chatId && projectPath && effectiveProjectKey && previousProjectPath
        ? new ChatProjectPathUpdatedMessage(
            chatId,
            projectPath,
            effectiveProjectKey,
            previousProjectPath,
            previousEffectiveProjectKey,
          )
        : null;
    }
    case 'chat-session-stopped': {
      const chatId = requiredStr(data.chatId);
      return chatId
        ? new ChatSessionStoppedMessage(chatId, Boolean(data.success))
        : null;
    }
    case 'chat-processing-updated': {
      const chatId = requiredStr(data.chatId);
      return chatId
        ? new ChatProcessingUpdatedMessage(chatId, Boolean(data.isProcessing))
        : null;
    }
    case 'queue-state-updated': {
      const chatId = requiredStr(data.chatId);
      const queue = parseQueueState(data.queue);
      return chatId && queue
        ? new QueueStateUpdatedMessage(chatId, queue)
        : null;
    }
    case 'queue-dispatching': {
      const chatId = requiredStr(data.chatId);
      const entryId = requiredStr(data.entryId);
      return chatId && entryId
        ? new QueueDispatchingMessage(
            chatId,
            entryId,
            String(data.content ?? ''),
          )
        : null;
    }
    case 'reconnect-state': {
      const processing = reconnectProcessingResult(data.processing);
      const queueResults = reconnectQueueResults(data.queueResults);
      if (!processing || !queueResults) return null;
      return new ReconnectStateMessage(
        processing,
        queueResults,
        typeof data.clientRequestId === 'string'
          ? data.clientRequestId
          : undefined,
      );
    }
    case 'pending-user-input-updated': {
      const input = normalizePendingUserInput(data.input);
      return input ? new PendingUserInputUpdatedMessage(input) : null;
    }
    case 'pending-user-input-cleared': {
      const chatId = requiredStr(data.chatId);
      const clientRequestId = requiredStr(data.clientRequestId);
      const reason = data.reason === 'chat-removed' ? data.reason : null;
      return chatId && clientRequestId && reason
        ? new PendingUserInputClearedMessage(chatId, clientRequestId, reason)
        : null;
    }
    case 'ws-fault':
      return new WsFaultMessage(str(data.error));
    case 'ws-pong': {
      const clientRequestId = requiredStr(data.clientRequestId);
      const sentAt =
        typeof data.sentAt === 'number' && Number.isFinite(data.sentAt)
          ? data.sentAt
          : null;
      const serverTime = requiredStr(data.serverTime);
      return clientRequestId && sentAt !== null && serverTime
        ? new WsPongMessage(clientRequestId, sentAt, serverTime)
        : null;
    }
    case 'chat-title-updated': {
      const chatId = requiredStr(data.chatId);
      return chatId
        ? new ChatTitleUpdatedMessage(chatId, str(data.title))
        : null;
    }
    case 'chat-session-deleted': {
      const chatId = requiredStr(data.chatId);
      return chatId ? new ChatSessionDeletedWsMessage(chatId) : null;
    }
    case 'chat-read-updated-v1': {
      const chatId = requiredStr(data.chatId);
      const lastReadAt = requiredStr(data.lastReadAt);
      return chatId && lastReadAt
        ? new ChatReadUpdatedV1Message(chatId, lastReadAt)
        : null;
    }
    case 'chat-list-refresh-requested': {
      const reason = parseChatListInvalidationReason(data.reason);
      const chatId = requiredStr(data.chatId);
      return reason && chatId
        ? new ChatListRefreshRequestedMessage(reason, chatId)
        : null;
    }
    case 'settings-changed': {
      const settings = normalizeRemoteSettingsSnapshot(data.settings);
      return settings ? new SettingsChangedMessage(settings) : null;
    }
    case 'scheduled-prompts-invalidated': {
      return isScheduledPromptsInvalidationReason(data.reason)
        ? new ScheduledPromptsInvalidatedMessage(data.reason)
        : null;
    }
    case 'snippets-invalidated': {
      return isSnippetsInvalidationReason(data.reason)
        ? new SnippetsInvalidatedMessage(data.reason)
        : null;
    }
    case 'client-request-error': {
      const clientRequestId = requiredStr(data.clientRequestId);
      const requestType = requiredStr(data.requestType);
      const code = data.code;
      const message = data.message;
      const retryable = data.retryable;
      const chatId = data.chatId === undefined ? undefined : requiredStr(data.chatId);
      if (
        !clientRequestId
        || !requestType
        || !isClientRequestErrorCode(code)
        || typeof message !== 'string'
        || typeof retryable !== 'boolean'
        || (data.chatId !== undefined && !chatId)
      ) return null;
      return new ClientRequestErrorMessage(
        clientRequestId,
        requestType,
        code,
        message,
        retryable,
        chatId,
      );
    }
    default:
      return null;
  }
}
