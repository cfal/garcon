import { describe, expect, test } from 'bun:test';
import { SEARCH_INGEST_ROW_MAX_BYTES, SEARCH_TIMESTAMP_MAX_BYTES } from '../schema.js';
import {
  MAX_FRAME_BYTES,
  MAX_ALLOWLIST_PER_FRAME,
  MAX_ROWS_PER_FRAME,
  isIndexerEvent,
  isIndexerRequest,
  isReaderEvent,
  isReaderRequest,
  workerRequestIdentity,
} from '../worker-protocol.js';
import { syntheticRows } from './fixtures.js';

const envelope = { requestId: 1, lifecycleEpoch: 'epoch-0001' };

function extra<T extends object>(value: T): T & { extra: true } {
  return { ...value, extra: true };
}

describe('worker protocol v9', () => {
  test('[TLV5-SEARCH.09-PROTO-01] accepts exact indexer requests and rejects extras', () => {
    const requests = [
      { ...envelope, type: 'open', dbPath: '/tmp/index.sqlite' },
      { ...envelope, type: 'chat-states' },
      {
        ...envelope,
        type: 'sync-begin',
        mode: 'replace',
        chatId: 'chat-0001',
        transcriptViewId: 'view-0001',
        expectedAfterOrdinal: 0,
        targetThrough: 2,
      },
      { ...envelope, type: 'sync-cleanup' },
      {
        ...envelope,
        type: 'sync-rows',
        frameIndex: 0,
        rows: syntheticRows({ seed: 3, count: 2 }),
        advanceTo: 2,
      },
      { ...envelope, type: 'sync-finish' },
      {
        ...envelope,
        type: 'mark-failed',
        chatId: 'chat-0001',
        transcriptViewId: 'view-0001',
        errorCode: 'SEARCH_ROW_INVALID',
      },
      { ...envelope, type: 'delete-chat', chatId: 'chat-0001' },
      { ...envelope, type: 'maintenance' },
      { ...envelope, type: 'status-snapshot' },
      { ...envelope, type: 'checkpoint' },
      { ...envelope, type: 'close' },
    ] as const;
    for (const request of requests) {
      expect(isIndexerRequest(request)).toBe(true);
      expect(isIndexerRequest(extra(request))).toBe(false);
    }
    expect(isIndexerRequest({ ...requests[2], mode: 'merge' })).toBe(false);
    expect(isIndexerRequest({ ...requests[2], targetThrough: -1 })).toBe(false);
    expect(isIndexerRequest({ ...requests[6], errorCode: 'invalid' })).toBe(false);
  });

  test('[TLV5-SEARCH.09-PROTO-02] sync rows enforce framing and byte caps', () => {
    const valid = {
      ...envelope,
      type: 'sync-rows',
      frameIndex: 0,
      rows: syntheticRows({ seed: 3, count: 2 }),
      advanceTo: 2,
    };
    expect(isIndexerRequest(valid)).toBe(true);
    expect(isIndexerRequest({ ...valid, advanceTo: 0 })).toBe(false);
    expect(isIndexerRequest({
      ...valid,
      rows: syntheticRows({ seed: 3, count: MAX_ROWS_PER_FRAME + 1 }),
    })).toBe(false);
    expect(isIndexerRequest({
      ...valid,
      rows: [{
        ...syntheticRows({ seed: 3, count: 1 })[0]!,
        body: 'a'.repeat(SEARCH_INGEST_ROW_MAX_BYTES + 1),
      }],
    })).toBe(false);
    expect(isIndexerRequest({
      ...valid,
      rows: [{
        ...syntheticRows({ seed: 3, count: 1 })[0]!,
        timestamp: 'é'.repeat(SEARCH_TIMESTAMP_MAX_BYTES / 2 + 1),
      }],
    })).toBe(false);
    expect(isIndexerRequest({ ...valid, done: false })).toBe(false);
  });

  test('[TLV5-SEARCH.09-PROTO-03] validates every indexer event tuple', () => {
    const state = {
      chatId: 'chat-0001',
      transcriptViewId: 'view-0001',
      status: 'indexed',
      indexedThrough: 4,
      targetThrough: 4,
      lastErrorCode: null,
    };
    const events = [
      { ...envelope, type: 'opened', recreated: false },
      { ...envelope, type: 'chat-states-result', states: [state] },
      {
        ...envelope,
        type: 'sync-accepted',
        indexedThrough: 0,
        current: false,
        staleRows: true,
      },
      { ...envelope, type: 'cleanup-progress', deletedRows: 8, remaining: true },
      { ...envelope, type: 'sync-progress', frameIndex: 0, indexedThrough: 4 },
      { ...envelope, type: 'sync-complete', state },
      { ...envelope, type: 'delete-progress', deletedRows: 8 },
      {
        ...envelope,
        type: 'status-result',
        counts: { indexed: 1, pending: 0, failed: 0, backlogRows: 0 },
      },
      { ...envelope, type: 'checkpoint-complete', busy: 0 },
      { ...envelope, type: 'ack' },
      { ...envelope, type: 'closed' },
      { ...envelope, type: 'error', code: 'SEARCH_ROW_INVALID', retryable: false },
    ] as const;
    for (const event of events) {
      expect(isIndexerEvent(event)).toBe(true);
      expect(isIndexerEvent(extra(event))).toBe(false);
    }
    expect(isIndexerEvent({
      ...events[1],
      states: [{ ...state, status: 'draining' }],
    })).toBe(false);
    expect(isIndexerEvent({ ...events[2], current: true, staleRows: true })).toBe(false);
    expect(isIndexerEvent({ ...events[6], deletedRows: 0 })).toBe(false);
    expect(isIndexerEvent({ ...events[8], busy: 2 })).toBe(false);
  });

  test('[TLV5-SEARCH.08-PROTO-01] reader protocol has no cancellation message', () => {
    const query = {
      version: 1 as const,
      clauses: [{
        kind: 'all-words' as const,
        tokens: [{ text: 'alpha', normalized: 'alpha', match: 'exact' as const }],
      }],
    };
    const requests = [
      { ...envelope, type: 'open', dbPath: '/tmp/index.sqlite' },
      {
        ...envelope,
        type: 'search-start',
        query,
        order: 'relevance',
        mode: 'page',
        offset: 0,
        limit: 20,
        snippetLimit: 3,
      },
      {
        ...envelope,
        type: 'search-allowlist-chunk',
        chunkIndex: 0,
        allowedChats: [{
          chatId: 'chat-0001',
          transcriptViewId: 'view-0001',
          throughOrdinal: 4,
        }],
        done: true,
      },
      { ...envelope, type: 'close' },
    ] as const;
    for (const request of requests) {
      expect(isReaderRequest(request)).toBe(true);
      expect(isReaderRequest(extra(request))).toBe(false);
    }
    const searchStart = requests[1];
    expect(isReaderRequest({ ...searchStart, order: 'activity' })).toBe(false);
    expect(isReaderRequest({ ...searchStart, offset: -1 })).toBe(false);
    expect(isReaderRequest({ ...searchStart, offset: 10_000 })).toBe(false);
    expect(isReaderRequest({ ...searchStart, limit: 0 })).toBe(false);
    expect(isReaderRequest({ ...searchStart, limit: 101 })).toBe(false);
    expect(isReaderRequest({
      ...searchStart,
      mode: 'prefix',
      limit: 500,
      snippetLimit: 1,
    })).toBe(true);
    expect(isReaderRequest({
      ...searchStart,
      mode: 'prefix',
      offset: 1,
      snippetLimit: 1,
    })).toBe(false);
    expect(isReaderRequest({
      ...searchStart,
      mode: 'prefix',
      limit: 501,
      snippetLimit: 1,
    })).toBe(false);
    expect(isReaderRequest({ ...searchStart, mode: 'prefix', snippetLimit: 2 })).toBe(false);
    expect(isReaderRequest({ ...searchStart, snippetLimit: 0 })).toBe(false);
    expect(isReaderRequest({ ...searchStart, snippetLimit: 4 })).toBe(false);
    expect(isReaderRequest({ ...searchStart, mode: 'batch' })).toBe(false);
    const missingOffset: Record<string, unknown> = { ...searchStart };
    Reflect.deleteProperty(missingOffset, 'offset');
    expect(isReaderRequest(missingOffset)).toBe(false);
    expect(isReaderRequest({ ...envelope, type: 'search-cancel' })).toBe(false);
    expect(isReaderRequest({
      ...requests[2],
      allowedChats: Array.from({ length: MAX_ALLOWLIST_PER_FRAME + 1 }, (_, index) => ({
        chatId: `chat-${index}`,
        transcriptViewId: 'view-0001',
        throughOrdinal: 4,
      })),
    })).toBe(false);
  });

  test('[TLV5-SEARCH.09-PROTO-04] validates exact reader events and identities', () => {
    const result = {
      chatId: 'chat-0001',
      transcriptViewId: 'view-0001',
      score: 1,
      matchedMessageCount: 1,
      snippets: [{
        ordinal: 1,
        role: 'user',
        timestamp: null,
        text: 'alpha',
      }],
    };
    const events = [
      { ...envelope, type: 'opened' },
      { ...envelope, type: 'closed' },
      {
        ...envelope,
        type: 'search-result',
        mode: 'page',
        snippetLimit: 3,
        results: [result],
        page: { offset: 0, limit: 20, total: 1, hasMore: false, nextOffset: null },
        index: {
          indexedChatCount: 1,
          pendingChatCount: 0,
          failedChatCount: 0,
          unindexedChatCount: 0,
          unsupportedChatCount: 0,
          resultsTruncated: false,
        },
      },
      { ...envelope, type: 'error', code: 'READER_INTERNAL', retryable: true },
    ] as const;
    for (const event of events) {
      expect(isReaderEvent(event)).toBe(true);
      expect(isReaderEvent(extra(event))).toBe(false);
    }
    const searchResult = events[2];
    expect(isReaderEvent({
      ...searchResult,
      page: { offset: 0, limit: 20, total: 2, hasMore: true, nextOffset: 1 },
    })).toBe(true);
    expect(isReaderEvent({
      ...searchResult,
      page: { offset: 0, limit: 20, total: 2, hasMore: true, nextOffset: 2 },
    })).toBe(false);
    expect(isReaderEvent({
      ...searchResult,
      page: { offset: 0, limit: 0, total: 1, hasMore: false, nextOffset: null },
    })).toBe(false);
    expect(isReaderEvent({
      ...searchResult,
      page: { offset: 9_999, limit: 1, total: 10_001, hasMore: true, nextOffset: 10_000 },
    })).toBe(false);
    expect(isReaderEvent({
      ...searchResult,
      results: [],
      page: { offset: 2, limit: 20, total: 1, hasMore: false, nextOffset: null },
    })).toBe(true);
    expect(isReaderEvent({
      ...searchResult,
      results: [result, result],
      page: { offset: 0, limit: 1, total: 2, hasMore: true, nextOffset: 1 },
    })).toBe(false);
    expect(isReaderEvent({
      ...searchResult,
      index: { ...searchResult.index, resultsTruncated: 1 },
    })).toBe(false);
    const missingCoverage: Record<string, unknown> = { ...searchResult.index };
    Reflect.deleteProperty(missingCoverage, 'unindexedChatCount');
    expect(isReaderEvent({ ...searchResult, index: missingCoverage })).toBe(false);
    const maximumSnippet = {
      ordinal: Number.MAX_SAFE_INTEGER,
      role: 'assistant' as const,
      timestamp: 't'.repeat(SEARCH_TIMESTAMP_MAX_BYTES),
      text: '\u0000'.repeat(520),
    };
    const maximumResult = {
      chatId: 'c'.repeat(256),
      transcriptViewId: 'v'.repeat(256),
      score: -Number.MAX_VALUE,
      matchedMessageCount: Number.MAX_SAFE_INTEGER,
      snippets: [maximumSnippet],
    };
    const prefixEvent = {
      ...envelope,
      type: 'search-result',
      mode: 'prefix',
      snippetLimit: 1,
      results: Array.from({ length: 500 }, () => maximumResult),
      page: {
        offset: 0,
        limit: 500,
        total: 501,
        hasMore: true,
        nextOffset: 500,
      },
      index: searchResult.index,
    } as const;
    expect(Buffer.byteLength(JSON.stringify(prefixEvent))).toBeLessThan(MAX_FRAME_BYTES);
    expect(isReaderEvent(prefixEvent)).toBe(true);
    expect(isReaderEvent({
      ...prefixEvent,
      results: [{
        ...maximumResult,
        snippets: [{
          ...maximumSnippet,
          timestamp: 't'.repeat(SEARCH_TIMESTAMP_MAX_BYTES + 1),
        }],
      }],
      page: {
        offset: 0,
        limit: 500,
        total: 1,
        hasMore: false,
        nextOffset: null,
      },
    })).toBe(false);
    expect(isReaderEvent({
      ...prefixEvent,
      results: [{
        ...maximumResult,
        snippets: [{ ...maximumSnippet, text: 'x'.repeat(521) }],
      }],
      page: {
        offset: 0,
        limit: 500,
        total: 1,
        hasMore: false,
        nextOffset: null,
      },
    })).toBe(false);
    expect(workerRequestIdentity({ ...envelope, type: 'invalid' })).toEqual(envelope);
    expect(workerRequestIdentity({ requestId: 0, lifecycleEpoch: 'epoch-0001' })).toBeNull();
  });
});
