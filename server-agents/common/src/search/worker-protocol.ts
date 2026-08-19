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
import {
  SEARCH_INGEST_ROW_MAX_BYTES,
  SEARCH_TIMESTAMP_MAX_BYTES,
  type SearchChatState,
  type SearchStatusCounts,
} from './schema.js';

export const MAX_ROWS_PER_FRAME = 250;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_ALLOWLIST_PER_FRAME = 2_000;

interface RequestBase {
  readonly requestId: number;
  readonly lifecycleEpoch: string;
}

export type IndexerRequest =
  | (RequestBase & { readonly type: 'open'; readonly dbPath: string })
  | (RequestBase & { readonly type: 'chat-states' })
  | (RequestBase & {
      readonly type: 'sync-begin';
      readonly mode: 'replace' | 'append';
      readonly chatId: string;
      readonly transcriptViewId: string;
      readonly expectedAfterOrdinal: number;
      readonly targetThrough: number;
    })
  | (RequestBase & { readonly type: 'sync-cleanup' })
  | (RequestBase & {
      readonly type: 'sync-rows';
      readonly frameIndex: number;
      readonly rows: readonly HistoricalSearchMessageRow[];
      readonly advanceTo: number;
    })
  | (RequestBase & { readonly type: 'sync-finish' })
  | (RequestBase & {
      readonly type: 'mark-failed';
      readonly chatId: string;
      readonly transcriptViewId: string;
      readonly errorCode: string;
    })
  | (RequestBase & { readonly type: 'delete-chat'; readonly chatId: string })
  | (RequestBase & { readonly type: 'maintenance' })
  | (RequestBase & { readonly type: 'status-snapshot' })
  | (RequestBase & { readonly type: 'checkpoint' })
  | (RequestBase & { readonly type: 'close' });

export type IndexerEvent =
  | (RequestBase & { readonly type: 'opened'; readonly recreated: boolean })
  | (RequestBase & {
      readonly type: 'chat-states-result';
      readonly states: readonly SearchChatState[];
    })
  | (RequestBase & {
      readonly type: 'sync-accepted';
      readonly indexedThrough: number;
      readonly current: boolean;
      readonly staleRows: boolean;
    })
  | (RequestBase & {
      readonly type: 'cleanup-progress';
      readonly deletedRows: number;
      readonly remaining: boolean;
    })
  | (RequestBase & {
      readonly type: 'sync-progress';
      readonly frameIndex: number;
      readonly indexedThrough: number;
    })
  | (RequestBase & { readonly type: 'sync-complete'; readonly state: SearchChatState })
  | (RequestBase & { readonly type: 'delete-progress'; readonly deletedRows: number })
  | (RequestBase & { readonly type: 'status-result'; readonly counts: SearchStatusCounts })
  | (RequestBase & { readonly type: 'checkpoint-complete'; readonly busy: number })
  | (RequestBase & { readonly type: 'ack' | 'closed' })
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

const BASE_KEYS = ['lifecycleEpoch', 'requestId', 'type'] as const;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function exactKeys(candidate: UnknownRecord, ...keys: readonly string[]): boolean {
  const expected = new Set([...BASE_KEYS, ...keys]);
  return Object.keys(candidate).length === expected.size
    && Object.keys(candidate).every((key) => expected.has(key));
}

function requestBase(value: unknown): UnknownRecord | null {
  const candidate = record(value);
  return candidate
    && Number.isSafeInteger(candidate.requestId)
    && Number(candidate.requestId) > 0
    && typeof candidate.lifecycleEpoch === 'string'
    && candidate.lifecycleEpoch.length > 0
    && typeof candidate.type === 'string'
    ? candidate
    : null;
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 256;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
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

function searchRow(value: unknown): value is HistoricalSearchMessageRow {
  const row = record(value);
  return Boolean(row)
    && Object.keys(row!).length === 4
    && ['ordinal', 'role', 'timestamp', 'body'].every((key) => Object.hasOwn(row!, key))
    && positiveInteger(row!.ordinal)
    && ['user', 'assistant', 'tool', 'system'].includes(String(row!.role))
    && (row!.timestamp === null || (
      typeof row!.timestamp === 'string'
      && Buffer.byteLength(row!.timestamp, 'utf8') <= SEARCH_TIMESTAMP_MAX_BYTES
    ))
    && typeof row!.body === 'string';
}

function searchRowsValid(value: unknown): value is HistoricalSearchMessageRow[] {
  return Array.isArray(value) && value.every(searchRow);
}

function chatStateValid(value: unknown): value is SearchChatState {
  const candidate = record(value);
  if (!candidate
      || Object.keys(candidate).length !== 6
      || !['chatId', 'transcriptViewId', 'status', 'indexedThrough', 'targetThrough', 'lastErrorCode']
        .every((key) => Object.hasOwn(candidate, key))
      || !boundedIdentifier(candidate.chatId)
      || !boundedIdentifier(candidate.transcriptViewId)
      || !['pending', 'indexed', 'failed'].includes(String(candidate.status))
      || !nonNegativeInteger(candidate.indexedThrough)
      || !nonNegativeInteger(candidate.targetThrough)
      || (candidate.lastErrorCode !== null && !failureCode(candidate.lastErrorCode))) {
    return false;
  }
  if (candidate.status === 'indexed') return candidate.indexedThrough === candidate.targetThrough;
  if (candidate.status === 'pending') return candidate.indexedThrough <= candidate.targetThrough;
  return true;
}

function statusCountsValid(value: unknown): value is SearchStatusCounts {
  const candidate = record(value);
  return Boolean(candidate)
    && Object.keys(candidate!).length === 4
    && ['indexed', 'pending', 'failed', 'backlogRows'].every(
      (key) => Object.hasOwn(candidate!, key) && nonNegativeInteger(candidate![key]),
    );
}

function syncRowsValid(candidate: UnknownRecord): boolean {
  return exactKeys(candidate, 'frameIndex', 'rows', 'advanceTo')
    && nonNegativeInteger(candidate.frameIndex)
    && searchRowsValid(candidate.rows)
    && candidate.rows.length <= MAX_ROWS_PER_FRAME
    && jsonBytesWithin(candidate.rows, MAX_FRAME_BYTES)
    && candidate.rows.every(
      (row) => Buffer.byteLength(row.body, 'utf8') <= SEARCH_INGEST_ROW_MAX_BYTES,
    )
    && positiveInteger(candidate.advanceTo);
}

function allowedChatsValid(value: unknown): value is TranscriptSearchAllowedChat[] {
  return Array.isArray(value) && value.every((entry) => {
    const candidate = record(entry);
    return Boolean(candidate)
      && Object.keys(candidate!).length === 3
      && ['chatId', 'transcriptViewId', 'throughOrdinal'].every(
        (key) => Object.hasOwn(candidate!, key),
      )
      && boundedIdentifier(candidate!.chatId)
      && boundedIdentifier(candidate!.transcriptViewId)
      && nonNegativeInteger(candidate!.throughOrdinal);
  });
}

function searchQuery(value: unknown): boolean {
  const candidate = record(value);
  if (!candidate
      || Object.keys(candidate).length !== 2
      || candidate.version !== 1
      || !Array.isArray(candidate.clauses)
      || candidate.clauses.length > CHAT_SEARCH_MAX_TERMS
      || !jsonBytesWithin(candidate, 64 * 1024)) return false;
  let tokenCount = 0;
  for (const valueClause of candidate.clauses) {
    const clause = record(valueClause);
    if (!clause
        || Object.keys(clause).length !== 2
        || (clause.kind !== 'phrase' && clause.kind !== 'all-words')
        || !Array.isArray(clause.tokens)
        || clause.tokens.length === 0) return false;
    tokenCount += clause.tokens.length;
    if (tokenCount > CHAT_SEARCH_MAX_WORDS) return false;
    for (const valueToken of clause.tokens) {
      const token = record(valueToken);
      if (!token
          || Object.keys(token).length !== 3
          || typeof token.text !== 'string'
          || typeof token.normalized !== 'string'
          || (token.match !== 'exact' && token.match !== 'prefix')
          || (clause.kind === 'phrase' && token.match !== 'exact')
          || (token.match === 'prefix'
            && [...token.text].length < CHAT_SEARCH_MIN_PREFIX_CHARS)) return false;
    }
  }
  return true;
}

function indexStatus(value: unknown): value is ChatSearchIndexStatus {
  const candidate = record(value);
  return Boolean(candidate)
    && Object.keys(candidate!).length === 4
    && ['indexedChatCount', 'pendingChatCount', 'failedChatCount', 'unsupportedChatCount']
      .every((key) => Object.hasOwn(candidate!, key) && nonNegativeInteger(candidate![key]));
}

function searchResult(value: unknown): value is ChatSearchResult {
  const candidate = record(value);
  if (!candidate
      || Object.keys(candidate).length !== 5
      || !['chatId', 'transcriptViewId', 'score', 'matchedMessageCount', 'snippets']
        .every((key) => Object.hasOwn(candidate, key))
      || !boundedIdentifier(candidate.chatId)
      || !boundedIdentifier(candidate.transcriptViewId)
      || typeof candidate.score !== 'number'
      || !Number.isFinite(candidate.score)
      || !nonNegativeInteger(candidate.matchedMessageCount)
      || !Array.isArray(candidate.snippets)
      || candidate.snippets.length > 3) return false;
  return candidate.snippets.every((valueSnippet) => {
    const snippet = record(valueSnippet);
    return Boolean(snippet)
      && Object.keys(snippet!).length === 4
      && ['ordinal', 'role', 'timestamp', 'text'].every((key) => Object.hasOwn(snippet!, key))
      && positiveInteger(snippet!.ordinal)
      && ['user', 'assistant', 'tool', 'system'].includes(String(snippet!.role))
      && (snippet!.timestamp === null || typeof snippet!.timestamp === 'string')
      && typeof snippet!.text === 'string';
  });
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
      return exactKeys(candidate, 'dbPath')
        && typeof candidate.dbPath === 'string'
        && candidate.dbPath.length > 0;
    case 'chat-states':
    case 'sync-cleanup':
    case 'sync-finish':
    case 'maintenance':
    case 'status-snapshot':
    case 'checkpoint':
    case 'close':
      return exactKeys(candidate);
    case 'sync-begin':
      return exactKeys(
        candidate,
        'mode',
        'chatId',
        'transcriptViewId',
        'expectedAfterOrdinal',
        'targetThrough',
      )
        && (candidate.mode === 'replace' || candidate.mode === 'append')
        && boundedIdentifier(candidate.chatId)
        && boundedIdentifier(candidate.transcriptViewId)
        && nonNegativeInteger(candidate.expectedAfterOrdinal)
        && nonNegativeInteger(candidate.targetThrough)
        && candidate.targetThrough >= candidate.expectedAfterOrdinal;
    case 'sync-rows':
      return syncRowsValid(candidate);
    case 'mark-failed':
      return exactKeys(candidate, 'chatId', 'transcriptViewId', 'errorCode')
        && boundedIdentifier(candidate.chatId)
        && boundedIdentifier(candidate.transcriptViewId)
        && failureCode(candidate.errorCode);
    case 'delete-chat':
      return exactKeys(candidate, 'chatId') && boundedIdentifier(candidate.chatId);
    default:
      return false;
  }
}

export function isIndexerEvent(value: unknown): value is IndexerEvent {
  const candidate = requestBase(value);
  if (!candidate) return false;
  switch (candidate.type) {
    case 'opened':
      return exactKeys(candidate, 'recreated') && typeof candidate.recreated === 'boolean';
    case 'chat-states-result':
      return exactKeys(candidate, 'states')
        && Array.isArray(candidate.states)
        && candidate.states.every(chatStateValid)
        && jsonBytesWithin(candidate.states, MAX_FRAME_BYTES);
    case 'sync-accepted':
      return exactKeys(candidate, 'indexedThrough', 'current', 'staleRows')
        && nonNegativeInteger(candidate.indexedThrough)
        && typeof candidate.current === 'boolean'
        && typeof candidate.staleRows === 'boolean'
        && (!candidate.current || !candidate.staleRows);
    case 'cleanup-progress':
      return exactKeys(candidate, 'deletedRows', 'remaining')
        && nonNegativeInteger(candidate.deletedRows)
        && typeof candidate.remaining === 'boolean';
    case 'sync-progress':
      return exactKeys(candidate, 'frameIndex', 'indexedThrough')
        && nonNegativeInteger(candidate.frameIndex)
        && nonNegativeInteger(candidate.indexedThrough);
    case 'sync-complete':
      return exactKeys(candidate, 'state') && chatStateValid(candidate.state);
    case 'delete-progress':
      return exactKeys(candidate, 'deletedRows') && positiveInteger(candidate.deletedRows);
    case 'status-result':
      return exactKeys(candidate, 'counts') && statusCountsValid(candidate.counts);
    case 'checkpoint-complete':
      return exactKeys(candidate, 'busy')
        && nonNegativeInteger(candidate.busy)
        && candidate.busy <= 1;
    case 'ack':
    case 'closed':
      return exactKeys(candidate);
    case 'error':
      return exactKeys(candidate, 'code', 'retryable')
        && failureCode(candidate.code)
        && typeof candidate.retryable === 'boolean';
    default:
      return false;
  }
}

export function isReaderRequest(value: unknown): value is ReaderRequest {
  const candidate = requestBase(value);
  if (!candidate) return false;
  switch (candidate.type) {
    case 'open':
      return exactKeys(candidate, 'dbPath')
        && typeof candidate.dbPath === 'string'
        && candidate.dbPath.length > 0;
    case 'search-start':
      return exactKeys(candidate, 'query', 'limit')
        && searchQuery(candidate.query)
        && Number.isSafeInteger(candidate.limit)
        && Number(candidate.limit) >= 1
        && Number(candidate.limit) <= 100;
    case 'search-allowlist-chunk':
      return exactKeys(candidate, 'chunkIndex', 'allowedChats', 'done')
        && nonNegativeInteger(candidate.chunkIndex)
        && allowedChatsValid(candidate.allowedChats)
        && candidate.allowedChats.length <= MAX_ALLOWLIST_PER_FRAME
        && jsonBytesWithin(candidate.allowedChats, MAX_FRAME_BYTES)
        && typeof candidate.done === 'boolean';
    case 'close':
      return exactKeys(candidate);
    default:
      return false;
  }
}

export function isReaderEvent(value: unknown): value is ReaderEvent {
  const candidate = requestBase(value);
  if (!candidate) return false;
  switch (candidate.type) {
    case 'opened':
    case 'closed':
      return exactKeys(candidate);
    case 'error':
      return exactKeys(candidate, 'code', 'retryable')
        && failureCode(candidate.code)
        && typeof candidate.retryable === 'boolean';
    case 'search-result':
      return exactKeys(candidate, 'results', 'index')
        && Array.isArray(candidate.results)
        && candidate.results.length <= 100
        && candidate.results.every(searchResult)
        && indexStatus(candidate.index);
    default:
      return false;
  }
}
