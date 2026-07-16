import type {
  ChatSearchIndexStatus,
  ChatSearchResult,
  ChatSearchSnippetRole,
} from '../../../common/chat-search.js';
import type { TranscriptBuildSource } from './source-types.js';

export interface SearchMessageRowInput {
  role: ChatSearchSnippetRole;
  timestamp: string | null;
  body: string;
}

export interface HistoricalSearchMessageRow extends SearchMessageRowInput {
  messageOrdinal: number;
}

interface WorkerRequestBase {
  requestId: number;
  lifecycleEpoch: number;
}

export type TranscriptSearchWorkerRequest =
  | (WorkerRequestBase & { type: 'open'; dbPath: string })
  | (WorkerRequestBase & {
      type: 'rebuild-chat';
      chatId: string;
      generation: number;
      buildSource: TranscriptBuildSource;
    })
  | (WorkerRequestBase & {
      type: 'append';
      chatId: string;
      generation: number;
      rows: SearchMessageRowInput[];
    })
  | (WorkerRequestBase & {
      type: 'mark-dirty';
      chatId: string;
      generation: number;
    })
  | (WorkerRequestBase & {
      type: 'mark-unsupported';
      chatId: string;
      generation: number;
      reasonCode: string;
    })
  | (WorkerRequestBase & {
      type: 'mark-failed';
      chatId: string;
      generation: number;
      reasonCode: string;
    })
  | (WorkerRequestBase & { type: 'delete-chat'; chatId: string; generation: number })
  | (WorkerRequestBase & { type: 'prune-chats'; registeredChatIds: string[] })
  | (WorkerRequestBase & {
      type: 'search';
      query: string;
      textTokens?: string[];
      allowedChatIds: string[];
      limit?: number;
    })
  | (WorkerRequestBase & { type: 'close' });

export type TranscriptSearchWorkerErrorCode =
  | 'INVALID_REQUEST'
  | 'OPEN_FAILED'
  | 'SCHEMA_MISMATCH'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_CHANGED'
  | 'SQLITE_ERROR'
  | 'SEARCH_FAILED'
  | 'CANCELLED'
  | 'CLOSE_FAILED';

interface WorkerResponseBase {
  requestId: number;
  lifecycleEpoch: number;
}

export type TranscriptSearchWorkerResponse =
  | (WorkerResponseBase & { type: 'opened'; generationFloor: number })
  | (WorkerResponseBase & { type: 'ack' })
  | (WorkerResponseBase & {
      type: 'search-result';
      results: ChatSearchResult[];
      index: ChatSearchIndexStatus;
    })
  | (WorkerResponseBase & { type: 'closed' })
  | (WorkerResponseBase & {
      type: 'error';
      code: TranscriptSearchWorkerErrorCode;
      message: string;
      retryable: boolean;
    });

export interface TranscriptSearchProgressEvent {
  type: 'progress';
  lifecycleEpoch: number;
  phase: 'building' | 'ready' | 'degraded';
  indexedChatCount: number;
  pendingChatCount: number;
  failedChatCount: number;
  unsupportedChatCount: number;
  processedRowCount: number;
}

export type TranscriptSearchWorkerMessage =
  | TranscriptSearchWorkerResponse
  | TranscriptSearchProgressEvent;

const ERROR_CODES = new Set<TranscriptSearchWorkerErrorCode>([
  'INVALID_REQUEST',
  'OPEN_FAILED',
  'SCHEMA_MISMATCH',
  'SOURCE_UNAVAILABLE',
  'SOURCE_CHANGED',
  'SQLITE_ERROR',
  'SEARCH_FAILED',
  'CANCELLED',
  'CLOSE_FAILED',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function hasRequestBase(value: Record<string, unknown>): boolean {
  return isSafeInteger(value.requestId)
    && value.requestId > 0
    && isSafeInteger(value.lifecycleEpoch)
    && value.lifecycleEpoch > 0;
}

function isSearchRow(value: unknown): value is SearchMessageRowInput {
  if (!isRecord(value)) return false;
  return (value.role === 'user'
      || value.role === 'assistant'
      || value.role === 'tool'
      || value.role === 'system')
    && (value.timestamp === null || typeof value.timestamp === 'string')
    && typeof value.body === 'string';
}

function isBuildSource(value: unknown): value is TranscriptBuildSource {
  if (!isRecord(value) || !isRecord(value.source)) return false;
  const source = value.source;
  const validSource = source.kind === 'opencode-api'
    ? typeof source.baseUrl === 'string'
      && typeof source.sessionId === 'string'
      && typeof source.directory === 'string'
    : source.kind === 'cursor-acp'
      ? typeof source.sessionId === 'string' && typeof source.projectPath === 'string'
      : (source.kind === 'claude-jsonl'
          || source.kind === 'codex-jsonl'
          || source.kind === 'direct-jsonl'
          || source.kind === 'factory-jsonl'
          || source.kind === 'pi-jsonl')
        && typeof source.nativePath === 'string';
  if (!validSource) return false;
  if (value.carryOver !== undefined) {
    if (!isRecord(value.carryOver)
        || typeof value.carryOver.filePath !== 'string'
        || !isNonNegativeInteger(value.carryOver.chatRevision)) return false;
  }
  return typeof value.currentAgentId === 'string' && typeof value.currentModel === 'string';
}

export function isTranscriptSearchWorkerRequest(
  value: unknown,
): value is TranscriptSearchWorkerRequest {
  if (!isRecord(value) || !hasRequestBase(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'open':
      return typeof value.dbPath === 'string';
    case 'rebuild-chat':
      return typeof value.chatId === 'string'
        && isNonNegativeInteger(value.generation)
        && isBuildSource(value.buildSource);
    case 'append':
      return typeof value.chatId === 'string'
        && isNonNegativeInteger(value.generation)
        && Array.isArray(value.rows)
        && value.rows.every(isSearchRow);
    case 'mark-dirty':
    case 'delete-chat':
      return typeof value.chatId === 'string' && isNonNegativeInteger(value.generation);
    case 'mark-unsupported':
    case 'mark-failed':
      return typeof value.chatId === 'string'
        && isNonNegativeInteger(value.generation)
        && typeof value.reasonCode === 'string';
    case 'prune-chats':
      return isStringArray(value.registeredChatIds);
    case 'search':
      return typeof value.query === 'string'
        && (value.textTokens === undefined || isStringArray(value.textTokens))
        && isStringArray(value.allowedChatIds)
        && (value.limit === undefined || isSafeInteger(value.limit));
    case 'close':
      return true;
    default:
      return false;
  }
}

function isIndexStatus(value: unknown): boolean {
  return isRecord(value)
    && isNonNegativeInteger(value.indexedChatCount)
    && isNonNegativeInteger(value.pendingChatCount)
    && isNonNegativeInteger(value.failedChatCount)
    && isNonNegativeInteger(value.unsupportedChatCount);
}

function isSearchResult(value: unknown): boolean {
  if (!isRecord(value)
      || typeof value.chatId !== 'string'
      || typeof value.score !== 'number'
      || !Number.isFinite(value.score)
      || !isNonNegativeInteger(value.matchedMessageCount)
      || !Array.isArray(value.snippets)) return false;
  return value.snippets.every((snippet) => isRecord(snippet)
    && isNonNegativeInteger(snippet.messageOrdinal)
    && (snippet.role === 'user'
      || snippet.role === 'assistant'
      || snippet.role === 'tool'
      || snippet.role === 'system')
    && (snippet.timestamp === null || typeof snippet.timestamp === 'string')
    && typeof snippet.text === 'string');
}

export function isTranscriptSearchWorkerMessage(
  value: unknown,
): value is TranscriptSearchWorkerMessage {
  if (!isRecord(value)
      || typeof value.type !== 'string'
      || !isSafeInteger(value.lifecycleEpoch)
      || value.lifecycleEpoch <= 0) return false;
  if (value.type === 'progress') {
    return (value.phase === 'building' || value.phase === 'ready' || value.phase === 'degraded')
      && isNonNegativeInteger(value.indexedChatCount)
      && isNonNegativeInteger(value.pendingChatCount)
      && isNonNegativeInteger(value.failedChatCount)
      && isNonNegativeInteger(value.unsupportedChatCount)
      && isNonNegativeInteger(value.processedRowCount);
  }
  if (!hasRequestBase(value)) return false;
  switch (value.type) {
    case 'opened':
      return isNonNegativeInteger(value.generationFloor);
    case 'ack':
    case 'closed':
      return true;
    case 'error':
      return typeof value.code === 'string'
        && ERROR_CODES.has(value.code as TranscriptSearchWorkerErrorCode)
        && typeof value.message === 'string'
        && typeof value.retryable === 'boolean';
    case 'search-result':
      return Array.isArray(value.results)
        && value.results.every(isSearchResult)
        && isIndexStatus(value.index);
    default:
      return false;
  }
}
