import { describe, expect, it } from 'bun:test';
import {
  isIndexerEvent,
  isIndexerRequest,
  isReaderEvent,
  isReaderRequest,
} from '../worker-protocol.js';

const base = { requestId: 1, lifecycleEpoch: 'worker-epoch' };

describe('transcript search Worker protocol', () => {
  it('accepts bounded ledger index frames', () => {
    expect(isIndexerRequest({
      ...base,
      type: 'index-start',
      mode: 'append',
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      expectedAfterOrdinal: 2,
      throughOrdinal: 3,
    })).toBe(true);
    expect(isIndexerRequest({
      ...base,
      type: 'index-chunk',
      chunkIndex: 0,
      rows: [{ ordinal: 3, role: 'assistant', timestamp: null, body: 'hello' }],
      done: true,
    })).toBe(true);
  });

  it('rejects malformed and oversized requests', () => {
    expect(isIndexerRequest({
      ...base,
      type: 'index-chunk',
      chunkIndex: 0,
      rows: Array.from({ length: 251 }, (_, index) => ({
        ordinal: index + 1,
        role: 'assistant',
        timestamp: null,
        body: 'hello',
      })),
      done: true,
    })).toBe(false);
    expect(isReaderRequest({
      ...base,
      type: 'search-allowlist-chunk',
      chunkIndex: 0,
      allowedChats: Array.from({ length: 2_001 }, (_, index) => ({
        chatId: String(index),
        transcriptViewId: 'view-1',
      })),
      done: true,
    })).toBe(false);
    expect(isReaderRequest({
      ...base,
      type: 'search-start',
      query: { version: 1, clauses: [] },
      limit: 101,
    })).toBe(false);
  });

  it('validates result identities and event envelopes', () => {
    expect(isIndexerEvent({ ...base, type: 'ack' })).toBe(true);
    expect(isReaderEvent({
      ...base,
      type: 'search-result',
      results: [{
        chatId: 'chat-1',
        transcriptViewId: 'view-1',
        score: 1,
        matchedMessageCount: 1,
        snippets: [{ ordinal: 2, role: 'assistant', timestamp: null, text: 'hello' }],
      }],
      index: {
        indexedChatCount: 1,
        pendingChatCount: 0,
        failedChatCount: 0,
        unsupportedChatCount: 0,
      },
    })).toBe(true);
  });
});
