import { describe, expect, it } from 'bun:test';
import {
  isTranscriptSearchWorkerMessage,
  isTranscriptSearchWorkerRequest,
} from '../worker-protocol.js';

describe('transcript search worker protocol', () => {
  it('accepts structurally valid requests and responses', () => {
    expect(isTranscriptSearchWorkerRequest({
      type: 'append',
      requestId: 1,
      lifecycleEpoch: 1,
      chatId: 'c1',
      generation: 2,
      rows: [{ role: 'user', timestamp: null, body: 'hello' }],
    })).toBe(true);
    expect(isTranscriptSearchWorkerMessage({
      type: 'error',
      requestId: 1,
      lifecycleEpoch: 1,
      code: 'SOURCE_UNAVAILABLE',
      message: 'unavailable',
      retryable: true,
    })).toBe(true);
    expect(isTranscriptSearchWorkerMessage({
      type: 'fatal',
      lifecycleEpoch: 1,
      code: 'SQLITE_ERROR',
      message: 'maintenance failed',
    })).toBe(true);
  });

  it('rejects malformed payloads instead of trusting the discriminant alone', () => {
    expect(isTranscriptSearchWorkerRequest({
      type: 'append',
      requestId: 1,
      lifecycleEpoch: 1,
      chatId: 'c1',
      generation: 'new',
      rows: [],
    })).toBe(false);
    expect(isTranscriptSearchWorkerMessage({
      type: 'opened',
      requestId: 1,
      lifecycleEpoch: 1,
    })).toBe(false);
    expect(isTranscriptSearchWorkerMessage({
      type: 'error',
      requestId: 1,
      lifecycleEpoch: 1,
      code: 'SOURCE_UNAVAILABLE',
      message: 'unavailable',
    })).toBe(false);
    expect(isTranscriptSearchWorkerMessage({
      type: 'fatal',
      lifecycleEpoch: 1,
      code: 'SOURCE_UNAVAILABLE',
      message: 'not fatal',
    })).toBe(false);
  });
});
