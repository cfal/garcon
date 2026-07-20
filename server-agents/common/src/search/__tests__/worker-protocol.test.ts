import { describe, expect, it } from 'bun:test';
import {
  compareGeneration,
  isIndexerEvent,
  isIndexerRequest,
  isReaderEvent,
  isReaderRequest,
} from '../worker-protocol.js';

const base = { requestId: 1, lifecycleEpoch: 'worker-epoch' };

describe('transcript search Worker protocol', () => {
  it('rejects malformed and oversized framed requests', () => {
    expect(isIndexerRequest({
      ...base,
      type: 'catalog-chunk',
      generation: { epoch: 'operation', sequence: 1 },
      chunkIndex: 0,
      chats: Array.from({ length: 501 }, () => ({})),
      done: true,
    })).toBe(false);
    expect(isIndexerRequest({
      ...base,
      type: 'carry-over-chunk',
      chunkIndex: 0,
      revision: 'carry-v1:1',
      messages: Array.from({ length: 251 }, () => ({})),
      done: true,
    })).toBe(false);
    expect(isReaderRequest({
      ...base,
      type: 'search-allowlist-chunk',
      chunkIndex: 0,
      allowedChatIds: Array.from({ length: 2_001 }, (_, index) => String(index)),
      done: true,
    })).toBe(false);
    expect(isReaderRequest({
      ...base,
      type: 'search-start',
      query: { version: 1, clauses: [] },
      limit: 101,
    })).toBe(false);
    expect(isReaderEvent({
      ...base,
      type: 'search-result',
      results: [{ chatId: 'chat-1', score: Number.NaN, matchedMessageCount: 1, snippets: [] }],
      index: {
        indexedChatCount: 1,
        pendingChatCount: 0,
        failedChatCount: 0,
        unsupportedChatCount: 0,
      },
    })).toBe(false);
  });

  it('validates lifecycle events and operation generations independently', () => {
    expect(isIndexerEvent({
      type: 'job-state',
      lifecycleEpoch: 'worker-epoch',
      state: 'started',
      chatId: 'chat-1',
      sourceSignature: 'a'.repeat(64),
    })).toBe(true);
    expect(isIndexerEvent({
      type: 'job-state',
      lifecycleEpoch: 'worker-epoch',
      state: 'started',
      chatId: 'chat-1',
      sourceSignature: 'not-a-digest',
    })).toBe(false);
    expect(compareGeneration(
      { epoch: 'operation', sequence: 2 },
      { epoch: 'operation', sequence: 1 },
    )).toBeGreaterThan(0);
    expect(compareGeneration(
      { epoch: 'new-operation', sequence: 1 },
      { epoch: 'old-operation', sequence: 10 },
    )).toBeNull();
  });
});
