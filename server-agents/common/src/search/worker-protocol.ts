import type {
  ChatSearchIndexStatus,
  ChatSearchQueryV1,
  ChatSearchResult,
  TranscriptSearchAllowedChat,
} from '@garcon/common/chat-search';
import {
  CHAT_SEARCH_MAX_TERMS,
  CHAT_SEARCH_MAX_WORDS,
  CHAT_SEARCH_MIN_PREFIX_CHARS,
} from '@garcon/common/chat-search';
import type { HistoricalSearchMessageRow } from './rows.js';

interface RequestBase {
  readonly requestId: number;
  readonly lifecycleEpoch: string;
}

export type IndexerRequest =
  | (RequestBase & { readonly type: 'open'; readonly dbPath: string })
  | (RequestBase & {
      readonly type: 'index-start';
      readonly mode: 'replace' | 'append';
      readonly chatId: string;
      readonly transcriptViewId: string;
      readonly expectedAfterOrdinal: number;
      readonly throughOrdinal: number;
    })
  | (RequestBase & {
      readonly type: 'index-chunk';
      readonly chunkIndex: number;
      readonly rows: readonly HistoricalSearchMessageRow[];
      readonly done: boolean;
    })
  | (RequestBase & { readonly type: 'delete-chat'; readonly chatId: string })
  | (RequestBase & {
      readonly type: 'mark-failed';
      readonly chatId: string;
      readonly transcriptViewId: string;
      readonly errorCode: string;
    })
  | (RequestBase & { readonly type: 'prune-chats'; readonly chatIds: readonly string[] })
  | (RequestBase & { readonly type: 'close' });

export type IndexerEvent =
  | (RequestBase & { readonly type: 'opened' | 'ack' | 'closed' })
  | (RequestBase & { readonly type: 'error'; readonly code: string; readonly retryable: boolean });

export type ReaderRequest =
  | (RequestBase & { readonly type: 'open'; readonly dbPath: string })
  | (RequestBase & {
      readonly type: 'search-start';
      readonly query: ChatSearchQueryV1;
      readonly limit: number;
    })
  | (RequestBase & {
      readonly type: 'search-allowlist-chunk';
      readonly chunkIndex: number;
      readonly allowedChats: readonly TranscriptSearchAllowedChat[];
      readonly done: boolean;
    })
  | (RequestBase & { readonly type: 'close' });

export type ReaderEvent =
  | (RequestBase & { readonly type: 'opened' | 'closed' })
  | (RequestBase & {
      readonly type: 'search-result';
      readonly results: readonly ChatSearchResult[];
      readonly index: ChatSearchIndexStatus;
    })
  | (RequestBase & { readonly type: 'error'; readonly code: string; readonly retryable: boolean });

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function requestBase(value: unknown): UnknownRecord | null {
  const candidate = record(value);
  return candidate
    && Number.isSafeInteger(candidate.requestId) && Number(candidate.requestId) > 0
    && typeof candidate.lifecycleEpoch === 'string' && candidate.lifecycleEpoch.length > 0
    && typeof candidate.type === 'string'
    ? candidate
    : null;
}

function failureCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
}

function jsonBytesWithin(value: unknown, maximum: number): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= maximum;
  } catch {
    return false;
  }
}

function indexStatus(value: unknown): boolean {
  const candidate = record(value);
  return Boolean(candidate)
    && ['indexedChatCount', 'pendingChatCount', 'failedChatCount', 'unsupportedChatCount']
      .every((key) => Number.isSafeInteger(candidate![key]) && Number(candidate![key]) >= 0);
}

function searchResult(value: unknown): boolean {
  const candidate = record(value);
  if (!candidate
      || typeof candidate.chatId !== 'string' || candidate.chatId.length === 0
      || typeof candidate.transcriptViewId !== 'string' || candidate.transcriptViewId.length === 0
      || typeof candidate.score !== 'number' || !Number.isFinite(candidate.score)
      || !Number.isSafeInteger(candidate.matchedMessageCount)
      || Number(candidate.matchedMessageCount) < 0
      || !Array.isArray(candidate.snippets) || candidate.snippets.length > 3) return false;
  return candidate.snippets.every((valueSnippet) => {
    const snippet = record(valueSnippet);
    return Boolean(snippet)
      && Number.isSafeInteger(snippet!.ordinal) && Number(snippet!.ordinal) > 0
      && ['user', 'assistant', 'tool', 'system'].includes(String(snippet!.role))
      && (snippet!.timestamp === null || typeof snippet!.timestamp === 'string')
      && typeof snippet!.text === 'string';
  });
}

function allowedChats(value: unknown): value is TranscriptSearchAllowedChat[] {
  return Array.isArray(value) && value.every((entry) => {
    const candidate = record(entry);
    return Boolean(candidate)
      && typeof candidate!.chatId === 'string' && candidate!.chatId.length > 0
      && typeof candidate!.transcriptViewId === 'string'
      && candidate!.transcriptViewId.length > 0
      && Number.isSafeInteger(candidate!.throughOrdinal)
      && Number(candidate!.throughOrdinal) >= 0;
  });
}

function searchQuery(value: unknown): boolean {
  const candidate = record(value);
  if (!candidate || candidate.version !== 1
      || !Array.isArray(candidate.clauses)
      || candidate.clauses.length > CHAT_SEARCH_MAX_TERMS
      || !jsonBytesWithin(candidate, 64 * 1024)) return false;
  let tokenCount = 0;
  for (const valueClause of candidate.clauses) {
    const clause = record(valueClause);
    if (!clause || (clause.kind !== 'phrase' && clause.kind !== 'all-words')
        || !Array.isArray(clause.tokens) || clause.tokens.length === 0) return false;
    tokenCount += clause.tokens.length;
    if (tokenCount > CHAT_SEARCH_MAX_WORDS) return false;
    for (const valueToken of clause.tokens) {
      const token = record(valueToken);
      if (!token || typeof token.text !== 'string' || typeof token.normalized !== 'string'
          || (token.match !== 'exact' && token.match !== 'prefix')
          || (clause.kind === 'phrase' && token.match !== 'exact')
          || (token.match === 'prefix'
            && [...token.text].length < CHAT_SEARCH_MIN_PREFIX_CHARS)) return false;
    }
  }
  return true;
}

function searchRow(value: unknown): boolean {
  const row = record(value);
  return Boolean(row)
    && Number.isSafeInteger(row!.ordinal) && Number(row!.ordinal) > 0
    && ['user', 'assistant', 'tool', 'system'].includes(String(row!.role))
    && (row!.timestamp === null || typeof row!.timestamp === 'string')
    && typeof row!.body === 'string';
}

export function workerRequestIdentity(
  value: unknown,
): { readonly requestId: number; readonly lifecycleEpoch: string } | null {
  const candidate = requestBase(value);
  return candidate
    ? { requestId: Number(candidate.requestId), lifecycleEpoch: String(candidate.lifecycleEpoch) }
    : null;
}

export function isIndexerRequest(value: unknown): value is IndexerRequest {
  const candidate = requestBase(value);
  if (!candidate) return false;
  switch (candidate.type) {
    case 'open':
      return typeof candidate.dbPath === 'string' && candidate.dbPath.length > 0;
    case 'index-start':
      return (candidate.mode === 'replace' || candidate.mode === 'append')
        && typeof candidate.chatId === 'string' && candidate.chatId.length > 0
        && typeof candidate.transcriptViewId === 'string' && candidate.transcriptViewId.length > 0
        && Number.isSafeInteger(candidate.expectedAfterOrdinal)
        && Number(candidate.expectedAfterOrdinal) >= 0
        && Number.isSafeInteger(candidate.throughOrdinal)
        && Number(candidate.throughOrdinal) >= Number(candidate.expectedAfterOrdinal);
    case 'index-chunk':
      return Number.isSafeInteger(candidate.chunkIndex) && Number(candidate.chunkIndex) >= 0
        && Array.isArray(candidate.rows) && candidate.rows.length <= 250
        && candidate.rows.every(searchRow)
        && jsonBytesWithin(candidate.rows, 8 * 1024 * 1024)
        && typeof candidate.done === 'boolean';
    case 'delete-chat':
      return typeof candidate.chatId === 'string' && candidate.chatId.length > 0;
    case 'mark-failed':
      return typeof candidate.chatId === 'string' && candidate.chatId.length > 0
        && typeof candidate.transcriptViewId === 'string'
        && candidate.transcriptViewId.length > 0
        && failureCode(candidate.errorCode);
    case 'prune-chats':
      return Array.isArray(candidate.chatIds) && candidate.chatIds.length <= 10_000
        && candidate.chatIds.every((chatId) => typeof chatId === 'string' && chatId.length > 0)
        && jsonBytesWithin(candidate.chatIds, 8 * 1024 * 1024);
    case 'close':
      return true;
    default:
      return false;
  }
}

export function isReaderRequest(value: unknown): value is ReaderRequest {
  const candidate = requestBase(value);
  if (!candidate) return false;
  switch (candidate.type) {
    case 'open':
      return typeof candidate.dbPath === 'string' && candidate.dbPath.length > 0;
    case 'search-start':
      return searchQuery(candidate.query)
        && Number.isSafeInteger(candidate.limit)
        && Number(candidate.limit) >= 1 && Number(candidate.limit) <= 100;
    case 'search-allowlist-chunk':
      return Number.isSafeInteger(candidate.chunkIndex) && Number(candidate.chunkIndex) >= 0
        && allowedChats(candidate.allowedChats) && candidate.allowedChats.length <= 2_000
        && jsonBytesWithin(candidate.allowedChats, 8 * 1024 * 1024)
        && typeof candidate.done === 'boolean';
    case 'close':
      return true;
    default:
      return false;
  }
}

export function isIndexerEvent(value: unknown): value is IndexerEvent {
  const candidate = requestBase(value);
  if (!candidate) return false;
  if (candidate.type === 'opened' || candidate.type === 'ack' || candidate.type === 'closed') {
    return true;
  }
  return candidate.type === 'error'
    && failureCode(candidate.code)
    && typeof candidate.retryable === 'boolean';
}

export function isReaderEvent(value: unknown): value is ReaderEvent {
  const candidate = requestBase(value);
  if (!candidate) return false;
  switch (candidate.type) {
    case 'opened':
    case 'closed':
      return true;
    case 'error':
      return failureCode(candidate.code) && typeof candidate.retryable === 'boolean';
    case 'search-result':
      return Array.isArray(candidate.results) && candidate.results.length <= 100
        && candidate.results.every(searchResult) && indexStatus(candidate.index);
    default:
      return false;
  }
}
