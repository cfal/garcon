import type { ApiProtocol } from './api-providers.js';
import {
  parseChatExecutionControlState,
  type ChatExecutionControlState,
} from './chat-execution-control.js';
import { parseChatId } from './chat-id.js';
import {
  isPermissionMode,
  isThinkingMode,
  type PermissionMode,
  type ThinkingMode,
} from './chat-modes.js';
import type { ChatProcessingPhase, ChatTurnRetryStatus } from './chat-types.js';
import {
  isRelationallyValidBoundedTranscriptPage,
  isRelationallyValidNewestTranscriptPage,
  parseTranscriptMessages,
  type TranscriptMessage,
} from './chat-view.js';
import {
  parseChatTransientFeedSnapshot,
  type ChatTransientFeedSnapshot,
} from './chat-transient-feed.js';
import { normalizeTags } from './tags.js';

export const CHAT_SNAPSHOT_DEFAULT_MESSAGE_LIMIT = 10;
export const CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT = 200;

export interface ChatSnapshotChat {
  id: string;
  title: string;
  agentId: string;
  agentOwnershipEpoch: string;
  carryOverRevision: string;
  model: string | null;
  apiProviderId: string | null;
  modelEndpointId: string | null;
  modelProtocol: ApiProtocol | null;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  projectPath: string;
  tags: string[];
  canReloadFromNativeHistory: boolean;
  activity: {
    createdAt: string | null;
    lastActivityAt: string | null;
  };
}

export interface AvailableChatSnapshotTranscript {
  availability: 'available';
  transcriptViewId: string;
  messages: TranscriptMessage[];
  lastOrdinal: number;
  pageOldestOrdinal: number;
  pageNewestOrdinal: number;
  nextBeforeOrdinal: number | null;
  hasMore: boolean;
}

// Carries a typed ledger read failure without making the rest of the snapshot unusable.
export interface UnavailableChatSnapshotTranscript {
  availability: 'unavailable';
  errorCode: string;
  retryable: boolean;
  message: string;
}

const SNAPSHOT_TRANSCRIPT_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface NotRequestedChatSnapshotTranscript {
  availability: 'not-requested';
}

export type ChatSnapshotTranscript =
  | AvailableChatSnapshotTranscript
  | UnavailableChatSnapshotTranscript
  | NotRequestedChatSnapshotTranscript;

export interface ChatSnapshotResponse {
  observedAt: string;
  messageLimit: number;
  chat: ChatSnapshotChat;
  processingPhase: ChatProcessingPhase | null;
  processingRetry: ChatTurnRetryStatus | null;
  control: ChatExecutionControlState;
  transientFeed: ChatTransientFeedSnapshot;
  transcript: ChatSnapshotTranscript;
}

export class ChatSnapshotContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatSnapshotContractError';
  }
}

export function parseChatSnapshotResponse(value: unknown): ChatSnapshotResponse {
  const raw = record(value, 'chat snapshot');
  const observedAt = canonicalTimestamp(raw.observedAt, 'observedAt');
  const messageLimit = boundedInteger(raw.messageLimit, 'messageLimit');
  const chat = parseChat(raw.chat);
  const processingPhase = raw.processingPhase === null
    ? null
    : raw.processingPhase === 'running' || raw.processingPhase === 'stopping'
      ? raw.processingPhase
      : fail('processingPhase is invalid');
  const processingRetry = parseProcessingRetry(raw.processingRetry);
  const control = parseChatExecutionControlState(raw.control);
  if (!control) fail('control is invalid');
  const transientFeed = parseChatTransientFeedSnapshot(raw.transientFeed);
  if (!transientFeed) fail('transientFeed is invalid');
  if (transientFeed.chatId !== chat.id) fail('transientFeed belongs to another chat');
  const transcript = parseTranscript(raw.transcript, messageLimit);
  if (transcript.availability === 'available'
      && transcript.transcriptViewId !== transientFeed.transcriptViewId) {
    fail('transientFeed and transcript views differ');
  }

  return {
    observedAt,
    messageLimit,
    chat,
    processingPhase,
    processingRetry,
    control,
    transientFeed,
    transcript,
  };
}

function parseProcessingRetry(value: unknown): ChatTurnRetryStatus | null {
  if (value === undefined || value === null) return null;
  const raw = record(value, 'processingRetry');
  if (typeof raw.attempt !== 'number' || !Number.isFinite(raw.attempt)) {
    fail('processingRetry.attempt is invalid');
  }
  if (typeof raw.message !== 'string' || !raw.message) {
    fail('processingRetry.message is invalid');
  }
  if (raw.nextAttemptAt !== null && typeof raw.nextAttemptAt !== 'string') {
    fail('processingRetry.nextAttemptAt is invalid');
  }
  return { attempt: raw.attempt, message: raw.message, nextAttemptAt: raw.nextAttemptAt };
}

function parseChat(value: unknown): ChatSnapshotChat {
  const raw = record(value, 'chat');
  let id: string;
  try {
    id = parseChatId(raw.id);
  } catch {
    return fail('chat.id is invalid');
  }
  if (!isPermissionMode(raw.permissionMode)) fail('chat.permissionMode is invalid');
  if (!isThinkingMode(raw.thinkingMode)) fail('chat.thinkingMode is invalid');
  if (!Array.isArray(raw.tags) || !raw.tags.every((tag) => typeof tag === 'string')) {
    fail('chat.tags must be a string array');
  }
  const tags = raw.tags as string[];
  const normalizedTags = normalizeTags(tags);
  if (
    normalizedTags.length !== tags.length
    || normalizedTags.some((tag, index) => tag !== tags[index])
  ) {
    fail('chat.tags must be normalized, unique, and sorted');
  }

  const activity = record(raw.activity, 'chat.activity');
  return {
    id,
    title: requiredString(raw.title, 'chat.title'),
    agentId: requiredString(raw.agentId, 'chat.agentId'),
    agentOwnershipEpoch: requiredString(
      raw.agentOwnershipEpoch,
      'chat.agentOwnershipEpoch',
    ),
    carryOverRevision: requiredString(raw.carryOverRevision, 'chat.carryOverRevision'),
    model: nullableString(raw.model, 'chat.model'),
    apiProviderId: nullableString(raw.apiProviderId, 'chat.apiProviderId'),
    modelEndpointId: nullableString(raw.modelEndpointId, 'chat.modelEndpointId'),
    modelProtocol: nullableApiProtocol(raw.modelProtocol, 'chat.modelProtocol'),
    permissionMode: raw.permissionMode,
    thinkingMode: raw.thinkingMode,
    projectPath: requiredString(raw.projectPath, 'chat.projectPath'),
    tags: [...tags],
    canReloadFromNativeHistory: requiredBoolean(
      raw.canReloadFromNativeHistory,
      'chat.canReloadFromNativeHistory',
    ),
    activity: {
      createdAt: nullableTimestamp(activity.createdAt, 'chat.activity.createdAt'),
      lastActivityAt: nullableTimestamp(
        activity.lastActivityAt,
        'chat.activity.lastActivityAt',
      ),
    },
  };
}

function parseTranscript(value: unknown, messageLimit: number): ChatSnapshotTranscript {
  const raw = record(value, 'transcript');
  if (messageLimit === 0) {
    if (raw.availability !== 'not-requested') {
      fail('transcript must be not-requested when messageLimit is zero');
    }
    return { availability: 'not-requested' };
  }
  if (raw.availability === 'not-requested') {
    fail('transcript cannot be not-requested when messages were requested');
  }
  if (raw.availability === 'unavailable') {
    if (typeof raw.errorCode !== 'string'
        || !SNAPSHOT_TRANSCRIPT_ERROR_CODE_PATTERN.test(raw.errorCode)) {
      fail('transcript.errorCode is invalid');
    }
    if (typeof raw.retryable !== 'boolean') fail('transcript.retryable is invalid');
    return {
      availability: 'unavailable',
      errorCode: raw.errorCode,
      retryable: raw.retryable,
      message: requiredString(raw.message, 'transcript.message'),
    };
  }
  if (raw.availability !== 'available') fail('transcript.availability is invalid');
  const messages = parseTranscriptMessages(raw.messages);
  if (!messages || messages.length > messageLimit) fail('transcript.messages is invalid');
  const lastOrdinal = nonNegativeInteger(raw.lastOrdinal, 'transcript.lastOrdinal');
  const pageOldestOrdinal = nonNegativeInteger(
    raw.pageOldestOrdinal,
    'transcript.pageOldestOrdinal',
  );
  const pageNewestOrdinal = nonNegativeInteger(
    raw.pageNewestOrdinal,
    'transcript.pageNewestOrdinal',
  );
  const nextBeforeOrdinal = nullableEarlierPageCursor(
    raw.nextBeforeOrdinal,
    'transcript.nextBeforeOrdinal',
  );
  if (typeof raw.hasMore !== 'boolean') fail('transcript.hasMore is invalid');
  const page = {
    messages,
    lastOrdinal,
    pageOldestOrdinal,
    pageNewestOrdinal,
    nextBeforeOrdinal,
    hasMore: raw.hasMore,
  };
  if (
    !isRelationallyValidNewestTranscriptPage(page)
    || !isRelationallyValidBoundedTranscriptPage(page, messageLimit)
  ) {
    fail('transcript ordinal metadata is inconsistent');
  }
  return {
    availability: 'available',
    transcriptViewId: requiredString(
      raw.transcriptViewId,
      'transcript.transcriptViewId',
    ),
    messages,
    lastOrdinal,
    pageOldestOrdinal,
    pageNewestOrdinal,
    nextBeforeOrdinal,
    hasMore: raw.hasMore,
  };
}

function boundedInteger(value: unknown, field: string): number {
  const parsed = nonNegativeInteger(value, field);
  if (parsed > CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT) fail(`${field} exceeds its maximum`);
  return parsed;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${field} must be a non-negative integer`);
  }
  return value;
}

function nullableEarlierPageCursor(value: unknown, field: string): number | null {
  if (value === null) return null;
  const parsed = nonNegativeInteger(value, field);
  if (parsed <= 1) fail(`${field} must be greater than one`);
  return parsed;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : requiredString(value, field);
}

function nullableApiProtocol(value: unknown, field: string): ApiProtocol | null {
  if (value === null) return null;
  if (value === 'openai-compatible' || value === 'anthropic-messages') return value;
  return fail(`${field} is invalid`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} is invalid`);
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(`${field} is invalid`);
  return value;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : canonicalTimestamp(value, field);
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(`${field} is invalid`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${field} is invalid`);
  }
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function fail(message: string): never {
  throw new ChatSnapshotContractError(message);
}
