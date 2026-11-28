import { compileChatSearchQuery, type ChatSearchResultMode, type TranscriptSearchAllowedChat } from '../../../../common/chat-search.ts';
import { searchFrames } from '../../../../server-agents/common/src/search/query-frames.ts';
import type { HistoricalSearchMessageRow } from '../../../../server-agents/common/src/search/rows.ts';
import { isIndexerRequest, isReaderRequest, type TranscriptSearchOrder } from '../../../../server-agents/common/src/search/worker-protocol.ts';

const identity = { lifecycleEpoch: 'fixture-epoch', requestId: 9 };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const unsigned = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 64;

type Search = { text: string; order: TranscriptSearchOrder; mode: ChatSearchResultMode;
  offset: number; limit: number; snippetLimit: number };

export function acceptsSearch(value: unknown): value is Search {
  return record(value) && Object.keys(value).length === 6 && typeof value.text === 'string'
    && (value.order === 'relevance' || value.order === 'allowlist')
    && (value.mode === 'page' || value.mode === 'prefix')
    && unsigned(value.offset) && unsigned(value.limit) && unsigned(value.snippetLimit);
}

export function acceptsAllowed(value: unknown): value is TranscriptSearchAllowedChat[] {
  return Array.isArray(value) && value.every(entry => record(entry) && Object.keys(entry).length === 3
    && typeof entry.chatId === 'string' && typeof entry.transcriptViewId === 'string' && unsigned(entry.throughOrdinal));
}

type IndexRows = { frameIndex: number; rows: HistoricalSearchMessageRow[]; advanceTo: number };
export function acceptsIndexRows(value: unknown): value is IndexRows {
  return record(value) && Object.keys(value).length === 3 && unsigned(value.frameIndex) && unsigned(value.advanceTo)
    && Array.isArray(value.rows) && value.rows.every(row => record(row) && Object.keys(row).length === 4
      && unsigned(row.ordinal) && (row.timestamp === null || typeof row.timestamp === 'string')
      && typeof row.role === 'string' && ['user', 'assistant', 'tool', 'system'].includes(row.role)
      && typeof row.body === 'string');
}

export function buildReaderFrames(search: Search, allowed: TranscriptSearchAllowedChat[]) {
  return searchFrames(compileChatSearchQuery(search.text), allowed, search.order, search.mode,
    search.offset, search.limit, search.snippetLimit);
}

export function validateReaderStart(search: Search) {
  const { text, ...options } = search;
  return isReaderRequest({ type: 'search-start', ...identity, query: compileChatSearchQuery(text), ...options });
}

export function validateReaderChunk(allowedChats: TranscriptSearchAllowedChat[]) {
  return isReaderRequest({ type: 'search-allowlist-chunk', ...identity, chunkIndex: 0, allowedChats, done: true });
}

export function validateIndexerRows(rows: IndexRows) {
  return isIndexerRequest({ type: 'sync-rows', ...identity, ...rows });
}
