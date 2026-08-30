import type { ResendCandidate, TranscriptMessage } from './chat-view';
import {
  isRelationallyValidNewestTranscriptPage,
  parseResendCandidates,
  parseTranscriptMessages,
} from './chat-view';
import {
  parseChatTransientFeedMutation,
  parseChatTransientFeedSnapshot,
  type ChatTransientFeedMutation,
  type ChatTransientFeedSnapshot,
} from './chat-transient-feed';
import {
  CHAT_STOP_OUTCOMES,
  CHAT_PROCESSING_PHASES,
  type ChatProcessingEntry,
  type ChatProcessingPhase,
  type ChatStopIntent,
  type ChatStopOutcome,
} from './chat-types';
import type { ChatExecutionControlState } from './chat-execution-control';
import {
  parseChatExecutionControlState,
  parseExecutionControlServerInstanceId,
} from './chat-execution-control';
import type { RemoteSettingsSnapshot } from './settings';
import type { ErrorCode } from './error-codes';
import { normalizeRemoteSettingsSnapshot } from './settings';
import {
  isScheduledPromptsInvalidationReason,
  type ScheduledPromptsInvalidationReason,
} from './scheduled-prompts';
import {
  isSnippetsInvalidationReason,
  type SnippetsInvalidationReason,
} from './snippets';
import {
  isTranscriptSearchStatusV1,
  type TranscriptSearchStatusV1,
} from './chat-search';

export class ChatMessagesMessage {
  readonly type = 'chat-messages' as const;
  constructor(
    public chatId: string,
    public transcriptViewId: string,
    public messages: TranscriptMessage[],
    public firstOrdinal: number,
    public lastOrdinal: number,
    public resendCandidates: ResendCandidate[],
    public turnId?: string,
    public clientRequestId?: string,
    public upstreamRequestId?: string,
  ) {}
}

export class ChatSubscribedMessage {
  readonly type = 'chat-subscribed' as const;
  constructor(
    public clientRequestId: string,
    public chatId: string,
    public transcriptViewId: string,
    public messages: TranscriptMessage[],
    public firstOrdinal: number,
    public lastOrdinal: number,
    public nextAfterOrdinal: number,
    public throughOrdinal: number,
    public hasMore: boolean,
    public resendCandidates: ResendCandidate[],
    public transientFeed: ChatTransientFeedSnapshot,
  ) {}
}

export class ChatTranscriptReplacedMessage {
  readonly type = 'chat-transcript-replaced' as const;
  constructor(
    public chatId: string,
    public previousTranscriptViewId: string,
    public transcriptViewId: string,
    public lastOrdinal: number,
  ) {}
}

export class ChatTransientFeedMutationMessage implements ChatTransientFeedMutation {
  readonly type = 'chat-transient-feed-mutation' as const;
  constructor(
    public serverInstanceId: string,
    public chatId: string,
    public transcriptViewId: string,
    public transientRevision: number,
    public mutation: ChatTransientFeedMutation['mutation'],
  ) {}
}

export class ChatReloadedMessage {
  readonly type = 'chat-reloaded' as const;
  constructor(
    public clientRequestId: string,
    public chatId: string,
    public transcriptViewId: string,
    public messages: TranscriptMessage[],
    public lastOrdinal: number,
    public pageOldestOrdinal: number,
    public pageNewestOrdinal: number,
    public nextBeforeOrdinal: number | null,
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
    public outcome: ChatStopOutcome,
    public intent: ChatStopIntent,
  ) {}
}

export class ChatProcessingUpdatedMessage {
  readonly type = 'chat-processing-updated' as const;
  constructor(
    public chatId: string,
    public phase: ChatProcessingPhase | null,
  ) {}
}

export class ChatExecutionControlUpdatedMessage {
  readonly type = 'chat-execution-control-updated' as const;
  constructor(
    public chatId: string,
    public control: ChatExecutionControlState,
  ) {}
}

const CHAT_OPERATIONAL_NOTICE_TYPES = ['info', 'warning', 'error'] as const;
export type ChatOperationalNoticeType = (typeof CHAT_OPERATIONAL_NOTICE_TYPES)[number];

function isChatOperationalNoticeType(value: unknown): value is ChatOperationalNoticeType {
  return typeof value === 'string'
    && (CHAT_OPERATIONAL_NOTICE_TYPES as readonly string[]).includes(value);
}

// Process-only advisory overlay for the chat feed. Notices never enter the
// transcript sequence space, pages, replay, search, or shares.
export class ChatOperationalNoticeMessage {
  readonly type = 'chat-operational-notice' as const;
  constructor(
    public chatId: string,
    public noticeType: ChatOperationalNoticeType,
    public content: string,
    public timestamp: string,
  ) {}
}

export type ReconnectControlResult =
  | { chatId: string; outcome: 'snapshot'; control: ChatExecutionControlState }
  | { chatId: string; outcome: 'not-found' }
  | { chatId: string; outcome: 'unavailable' };

export type ChatProcessingSnapshotResult =
  | { outcome: 'snapshot'; chats: ChatProcessingEntry[] }
  | { outcome: 'unavailable' };

export class ReconnectStateMessage {
  readonly type = 'reconnect-state' as const;
  constructor(
    public processing: ChatProcessingSnapshotResult,
    public controlResults: ReconnectControlResult[],
    public serverInstanceId: string,
    public clientRequestId?: string,
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
    public processing: ChatProcessingSnapshotResult,
    public serverInstanceId: string,
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
  'tags-updated',
  'chats-reordered',
  'agent-handoff',
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

export class TranscriptSearchStatusMessage {
  readonly type = 'transcript-search-status' as const;
  constructor(public status: TranscriptSearchStatusV1) {}
}

export class ScheduledPromptsInvalidatedMessage {
  readonly type = 'scheduled-prompts-invalidated' as const;
  constructor(public reason: ScheduledPromptsInvalidationReason) {}
}

export class SnippetsInvalidatedMessage {
  readonly type = 'snippets-invalidated' as const;
  constructor(public reason: SnippetsInvalidationReason) {}
}

export type ClientRequestErrorCode = Extract<
  ErrorCode,
  | 'MISSING_CHAT_ID'
  | 'REQUEST_VALIDATION_FAILED'
  | 'SESSION_NOT_FOUND'
  | 'CHAT_RUNNING'
  | 'NATIVE_PATH_UNRESOLVED'
  | 'HISTORY_LOAD_FAILED'
  | 'STALE_TRANSCRIPT_VIEW'
  | 'REQUEST_TIMEOUT'
  | 'INTERNAL_ERROR'
>;

const CLIENT_REQUEST_ERROR_CODES: readonly ClientRequestErrorCode[] = [
  'MISSING_CHAT_ID',
  'REQUEST_VALIDATION_FAILED',
  'SESSION_NOT_FOUND',
  'CHAT_RUNNING',
  'NATIVE_PATH_UNRESOLVED',
  'HISTORY_LOAD_FAILED',
  'STALE_TRANSCRIPT_VIEW',
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
  | ChatTranscriptReplacedMessage
  | ChatTransientFeedMutationMessage
  | ChatReloadedMessage
  | AgentRunFinishedMessage
  | AgentRunFailedMessage
  | ChatSessionCreatedMessage
  | ChatProjectPathUpdatedMessage
  | ChatSessionStoppedMessage
  | ChatProcessingUpdatedMessage
  | ChatExecutionControlUpdatedMessage
  | ChatOperationalNoticeMessage
  | ReconnectStateMessage
  | WsFaultMessage
  | WsPongMessage
  | ChatTitleUpdatedMessage
  | ChatSessionDeletedWsMessage
  | ChatReadUpdatedV1Message
  | ChatListRefreshRequestedMessage
  | SettingsChangedMessage
  | TranscriptSearchStatusMessage
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
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function isValidTranscriptSpan(
  firstOrdinal: number,
  lastOrdinal: number,
  messages: readonly TranscriptMessage[],
): boolean {
  if (firstOrdinal < 1 || lastOrdinal < firstOrdinal - 1) return false;
  if (lastOrdinal < firstOrdinal && messages.length > 0) return false;
  return messages.every((entry) => (
    entry.ordinal >= firstOrdinal && entry.ordinal <= lastOrdinal
  ));
}

function reconnectControlResults(value: unknown): ReconnectControlResult[] | null {
  if (!Array.isArray(value)) return null;
  const results: ReconnectControlResult[] = [];
  const seen = new Set<string>();
  for (const valueResult of value) {
    if (!valueResult || typeof valueResult !== 'object') return null;
    const result = valueResult as Record<string, unknown>;
    const chatId = requiredStr(result.chatId);
    if (!chatId || seen.has(chatId)) return null;
    seen.add(chatId);
    if (result.outcome === 'snapshot') {
      const control = parseChatExecutionControlState(result.control);
      if (!control) return null;
      results.push({ chatId, outcome: 'snapshot', control });
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

function chatProcessingSnapshotResult(value: unknown): ChatProcessingSnapshotResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const result = value as Record<string, unknown>;
  if (result.outcome === 'unavailable') return { outcome: 'unavailable' };
  if (result.outcome !== 'snapshot' || !Array.isArray(result.chats)) return null;

  const chats: ChatProcessingEntry[] = [];
  const seen = new Set<string>();
  for (const valueEntry of result.chats) {
    if (!valueEntry || typeof valueEntry !== 'object' || Array.isArray(valueEntry)) return null;
    const entry = valueEntry as Record<string, unknown>;
    const chatId = requiredStr(entry.chatId);
    const phase = CHAT_PROCESSING_PHASES.find((valuePhase) => valuePhase === entry.phase);
    if (!chatId || !phase || seen.has(chatId)) return null;
    seen.add(chatId);
    chats.push({ chatId, phase });
  }

  return { outcome: 'snapshot', chats };
}

function parseChatListInvalidationReason(
  v: unknown,
): ChatListInvalidationReason | null {
  return isChatListInvalidationReason(v) ? v : null;
}

export function parseServerWsMessage(
  data: Record<string, unknown>,
): ServerWsMessage | null {
  switch (data.type) {
    case 'chat-messages': {
      const chatId = requiredStr(data.chatId);
      const transcriptViewId = requiredStr(data.transcriptViewId);
      const firstOrdinal = nonNegativeInt(data.firstOrdinal);
      const lastOrdinal = nonNegativeInt(data.lastOrdinal);
      if (!chatId || !transcriptViewId || firstOrdinal === null || lastOrdinal === null) return null;
      const messages = parseTranscriptMessages(data.messages);
      const resendCandidates = parseResendCandidates(data.resendCandidates);
      if (messages === null || resendCandidates === null
          || !isValidTranscriptSpan(firstOrdinal, lastOrdinal, messages)) {
        return null;
      }
      return new ChatMessagesMessage(
        chatId,
        transcriptViewId,
        messages,
        firstOrdinal,
        lastOrdinal,
        resendCandidates,
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
      const transcriptViewId = requiredStr(data.transcriptViewId);
      const firstOrdinal = nonNegativeInt(data.firstOrdinal);
      const lastOrdinal = nonNegativeInt(data.lastOrdinal);
      const nextAfterOrdinal = nonNegativeInt(data.nextAfterOrdinal);
      const throughOrdinal = nonNegativeInt(data.throughOrdinal);
      if (
        !clientRequestId ||
        !chatId ||
        !transcriptViewId ||
        firstOrdinal === null ||
        lastOrdinal === null ||
        nextAfterOrdinal === null ||
        throughOrdinal === null ||
        typeof data.hasMore !== 'boolean'
      )
        return null;
      const messages = parseTranscriptMessages(data.messages);
      const resendCandidates = parseResendCandidates(data.resendCandidates);
      const transientFeed = parseChatTransientFeedSnapshot(data.transientFeed);
      if (messages === null || resendCandidates === null
          || !transientFeed) return null;
      if (
        !isValidTranscriptSpan(firstOrdinal, lastOrdinal, messages)
        || nextAfterOrdinal !== lastOrdinal
        || nextAfterOrdinal > throughOrdinal
        || data.hasMore !== (nextAfterOrdinal < throughOrdinal)
        || (data.hasMore && lastOrdinal < firstOrdinal)
      ) return null;
      if (transientFeed.chatId !== chatId
          || transientFeed.transcriptViewId !== transcriptViewId) return null;
      return new ChatSubscribedMessage(
        clientRequestId,
        chatId,
        transcriptViewId,
        messages,
        firstOrdinal,
        lastOrdinal,
        nextAfterOrdinal,
        throughOrdinal,
        data.hasMore,
        resendCandidates,
        transientFeed,
      );
    }
    case 'chat-transcript-replaced': {
      const chatId = requiredStr(data.chatId);
      const previousTranscriptViewId = requiredStr(data.previousTranscriptViewId);
      const transcriptViewId = requiredStr(data.transcriptViewId);
      const lastOrdinal = nonNegativeInt(data.lastOrdinal);
      if (!chatId || !previousTranscriptViewId || !transcriptViewId || lastOrdinal === null) return null;
      return new ChatTranscriptReplacedMessage(
        chatId,
        previousTranscriptViewId,
        transcriptViewId,
        lastOrdinal,
      );
    }
    case 'chat-transient-feed-mutation': {
      const parsed = parseChatTransientFeedMutation(data);
      return parsed
        ? new ChatTransientFeedMutationMessage(
            parsed.serverInstanceId,
            parsed.chatId,
            parsed.transcriptViewId,
            parsed.transientRevision,
            parsed.mutation,
          )
        : null;
    }
    case 'chat-reloaded': {
      const clientRequestId = requiredStr(data.clientRequestId);
      const chatId = requiredStr(data.chatId);
      const transcriptViewId = requiredStr(data.transcriptViewId);
      const lastOrdinal = nonNegativeInt(data.lastOrdinal);
      const pageOldestOrdinal = nonNegativeInt(data.pageOldestOrdinal);
      const pageNewestOrdinal = nonNegativeInt(data.pageNewestOrdinal);
      const rawNextBeforeOrdinal = data.nextBeforeOrdinal;
      const nextBeforeOrdinal = rawNextBeforeOrdinal === null
        ? null
        : nonNegativeInt(rawNextBeforeOrdinal);
      if (
        !clientRequestId ||
        !chatId ||
        !transcriptViewId ||
        lastOrdinal === null ||
        pageOldestOrdinal === null ||
        pageNewestOrdinal === null ||
        (rawNextBeforeOrdinal !== null && (nextBeforeOrdinal === null || nextBeforeOrdinal <= 1)) ||
        typeof data.hasMore !== 'boolean'
      )
        return null;
      const messages = parseTranscriptMessages(data.messages);
      if (messages === null) return null;
      const page = {
        messages,
        lastOrdinal,
        pageOldestOrdinal,
        pageNewestOrdinal,
        nextBeforeOrdinal,
        hasMore: data.hasMore,
      };
      if (!isRelationallyValidNewestTranscriptPage(page)) return null;
      return new ChatReloadedMessage(
        clientRequestId,
        chatId,
        transcriptViewId,
        messages,
        lastOrdinal,
        pageOldestOrdinal,
        pageNewestOrdinal,
        nextBeforeOrdinal,
        data.hasMore,
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
      const intent = data.intent;
      const outcome = CHAT_STOP_OUTCOMES.find((entry) => entry === data.outcome);
      return chatId && (
        intent === 'stop'
        || intent === 'interrupt-and-send'
        || intent === 'chat-deletion'
      ) && outcome
        ? new ChatSessionStoppedMessage(chatId, outcome, intent)
        : null;
    }
    case 'chat-processing-updated': {
      const chatId = requiredStr(data.chatId);
      const phase = data.phase === null
        ? null
        : CHAT_PROCESSING_PHASES.find((entry) => entry === data.phase);
      return chatId && phase !== undefined
        ? new ChatProcessingUpdatedMessage(chatId, phase)
        : null;
    }
    case 'chat-execution-control-updated': {
      const chatId = requiredStr(data.chatId);
      const control = parseChatExecutionControlState(data.control);
      return chatId && control
        ? new ChatExecutionControlUpdatedMessage(chatId, control)
        : null;
    }
    case 'chat-operational-notice': {
      const chatId = requiredStr(data.chatId);
      const content = requiredStr(data.content);
      const noticeType = data.noticeType;
      return chatId && content && isChatOperationalNoticeType(noticeType)
        ? new ChatOperationalNoticeMessage(chatId, noticeType, content, str(data.timestamp))
        : null;
    }
    case 'reconnect-state': {
      const processing = chatProcessingSnapshotResult(data.processing);
      const controlResults = reconnectControlResults(data.controlResults);
      const serverInstanceId = parseExecutionControlServerInstanceId(data.serverInstanceId);
      if (
        !processing ||
        !controlResults ||
        !serverInstanceId ||
        controlResults.some(
          (result) =>
            result.outcome === 'snapshot' &&
            result.control.serverInstanceId !== serverInstanceId,
        )
      ) {
        return null;
      }
      return new ReconnectStateMessage(
        processing,
        controlResults,
        serverInstanceId,
        typeof data.clientRequestId === 'string'
          ? data.clientRequestId
          : undefined,
      );
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
      const processing = chatProcessingSnapshotResult(data.processing);
      const serverInstanceId = parseExecutionControlServerInstanceId(data.serverInstanceId);
      return clientRequestId && sentAt !== null && serverTime && processing && serverInstanceId
        ? new WsPongMessage(
            clientRequestId,
            sentAt,
            serverTime,
            processing,
            serverInstanceId,
          )
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
    case 'transcript-search-status':
      return isTranscriptSearchStatusV1(data.status)
        ? new TranscriptSearchStatusMessage(data.status)
        : null;
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
        chatId ?? undefined,
      );
    }
    default:
      return null;
  }
}
