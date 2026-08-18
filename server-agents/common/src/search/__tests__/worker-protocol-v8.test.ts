import { describe, expect, it } from 'bun:test';
import {
  INDEXER_RECORDABLE_BUILD_ERROR_CODES,
  INDEXER_WAL_AUTHORITATIVE_ERROR_CODES,
  SEARCH_INDEXER_CACHE_SIZE_PAGES,
  SEARCH_MAX_DIRTY_FRAMES,
  SEARCH_TERM_STEP_MAX_ROWS,
  SEARCH_WAL_HIGH_WATER_FRAMES,
  SEARCH_WORKER_MAX_ENVELOPE_BYTES,
  isIndexerEvent,
  isIndexerRecordableBuildErrorCode,
  isIndexerWalAuthoritativeErrorCode,
  isIndexerRequest,
  isNewerWalObservation,
  isReaderEvent,
  isReaderRequest,
  isWalObservation,
  physicalStepResultRequiresContinuation,
  physicalStepResultRequiresSecureBarrier,
  workerEnvelopeBytes,
  type PhysicalStepResult,
  type SearchChatState,
} from '../worker-protocol.js';

const identity = { requestId: 1, lifecycleEpoch: 'synthetic-lifecycle' };
const state: SearchChatState = {
  chatId: 'chat-1',
  transcriptViewId: 'view-1',
  status: 'pending',
  phase: 'replacement-build',
  targetThrough: 2,
  processedThrough: 0,
  activeChunkId: null,
  slotDocumentCount: 0,
  slotTokenCount: 0,
  lastErrorCode: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const wal = {
  walEpoch: 1,
  walObservationSequence: 1,
  logFrames: 4,
  checkpointedFrames: 2,
};

describe('transcript search v8 Worker protocol', () => {
  it('locks physical grant identities, constants, and exact request shapes', () => {
    expect({
      K: SEARCH_TERM_STEP_MAX_ROWS,
      F: SEARCH_MAX_DIRTY_FRAMES,
      H: SEARCH_WAL_HIGH_WATER_FRAMES,
      cache: SEARCH_INDEXER_CACHE_SIZE_PAGES,
    }).toEqual({ K: 32, F: 49_829, H: 199_316, cache: 49_893 });
    expect(isIndexerRequest({
      ...identity,
      type: 'physical-step-grant',
      grantId: 7,
      walEpoch: 1,
      step: {
        kind: 'stage-raw',
        expectedState: state,
        rows: [{
          ordinal: 1,
          role: 'user',
          timestamp: null,
          body: 'synthetic protocol body',
        }],
      },
    })).toBe(true);
    expect(isIndexerRequest({
      ...identity,
      type: 'physical-step-grant',
      grantId: 7,
      walEpoch: 1,
      step: { kind: 'activate', expectedState: state },
      unexpected: true,
    })).toBe(false);
    expect(isIndexerRequest({
      ...identity,
      type: 'physical-step-grant',
      grantId: 7,
      walEpoch: 1,
      step: {
        kind: 'stage-raw',
        expectedState: state,
        rows: Array.from({ length: 17 }, (_, index) => ({
          ordinal: index + 1,
          role: 'user',
          timestamp: null,
          body: 'synthetic',
        })),
      },
    })).toBe(false);
    expect(isIndexerRequest({
      ...identity,
      type: 'physical-step-grant',
      grantId: 7,
      walEpoch: 1,
      step: { kind: 'start-removal', chatId: 'x'.repeat(257) },
    })).toBe(false);
  });

  it('validates optional WAL observations as part of the complete event', () => {
    expect(isWalObservation(wal)).toBe(true);
    expect(isWalObservation({ ...wal, walEpoch: 0 })).toBe(false);
    expect(isWalObservation({ ...wal, walObservationSequence: 0 })).toBe(false);
    expect(isWalObservation({ ...wal, checkpointedFrames: 5 })).toBe(false);
    expect(isWalObservation({ ...wal, extra: 1 })).toBe(false);
    expect(isNewerWalObservation(wal, null)).toBe(true);
    expect(isNewerWalObservation(
      { ...wal, walObservationSequence: 2 },
      wal,
    )).toBe(true);
    expect(isNewerWalObservation(wal, { ...wal, walObservationSequence: 2 })).toBe(false);

    const result: PhysicalStepResult = {
      kind: 'frontier-progress',
      completion: 'continue',
      state: { ...state, processedThrough: 1 },
    };
    expect(isIndexerEvent({
      ...identity,
      type: 'physical-step-complete',
      grantId: 7,
      result,
      wal,
    })).toBe(true);
    expect(isIndexerEvent({
      ...identity,
      type: 'physical-step-complete',
      grantId: 7,
      result,
      wal: { ...wal, checkpointedFrames: 5 },
    })).toBe(false);

    const knownError = {
      ...identity,
      type: 'error',
      grantId: 7,
      code: 'SEARCH_POSTING_INVALID',
      retryable: false,
    } as const;
    expect(INDEXER_WAL_AUTHORITATIVE_ERROR_CODES).toContain(knownError.code);
    expect(INDEXER_RECORDABLE_BUILD_ERROR_CODES).toContain(knownError.code);
    expect(isIndexerWalAuthoritativeErrorCode(knownError.code)).toBe(true);
    expect(isIndexerRecordableBuildErrorCode(knownError.code)).toBe(true);
    expect(isIndexerEvent(knownError)).toBe(true);
    expect(isIndexerEvent({ ...knownError, wal })).toBe(true);
    expect(isIndexerEvent({
      ...knownError,
      wal: { ...wal, walObservationSequence: 0 },
    })).toBe(false);

    const unknownError = { ...knownError, code: 'INDEXER_INTERNAL', retryable: true } as const;
    expect(isIndexerWalAuthoritativeErrorCode(unknownError.code)).toBe(false);
    expect(isIndexerEvent(unknownError)).toBe(true);
    expect(isIndexerEvent({ ...unknownError, wal })).toBe(false);
    expect(isReaderEvent({ ...knownError, wal })).toBe(false);
    expect(isIndexerWalAuthoritativeErrorCode('SEARCH_INDEX_CORRUPT')).toBe(true);
    expect(isIndexerRecordableBuildErrorCode('SEARCH_INDEX_CORRUPT')).toBe(false);
    expect(isIndexerRecordableBuildErrorCode('SEARCH_STATE_INVARIANT')).toBe(false);

    const checkpoint = {
      ...identity,
      type: 'checkpoint-complete',
      busy: 0,
      logFrames: 0,
      checkpointedFrames: 0,
      wal: { ...wal, logFrames: 0, checkpointedFrames: 0 },
    } as const;
    expect(isIndexerEvent(checkpoint)).toBe(true);
    expect(isIndexerEvent({ ...checkpoint, busy: 1 })).toBe(false);
    expect(isIndexerEvent({ ...checkpoint, logFrames: 1 })).toBe(false);
    expect(isIndexerEvent({
      ...checkpoint,
      wal: { ...checkpoint.wal, logFrames: 1 },
    })).toBe(false);
  });

  it('makes continuation and secure-barrier semantics explicit', () => {
    const progress: PhysicalStepResult = {
      kind: 'cleanup-progress',
      completion: 'continue',
      state: { ...state, phase: 'replacement-cleanup' },
      deletedTerms: 1,
      deletedRows: 0,
      deletedBodyBytes: 0,
    };
    const checkpoint: PhysicalStepResult = {
      kind: 'replacement-checkpoint',
      completion: 'terminal',
      state: {
        ...state,
        phase: 'replacement-checkpoint',
        activeChunkId: null,
        slotDocumentCount: 0,
        slotTokenCount: 0,
      },
    };
    const deleted: PhysicalStepResult = {
      kind: 'chat-deleted',
      completion: 'terminal',
      chatId: 'chat-1',
    };
    expect(physicalStepResultRequiresContinuation(progress)).toBe(true);
    expect(physicalStepResultRequiresSecureBarrier(progress)).toBe(false);
    expect(physicalStepResultRequiresContinuation(checkpoint)).toBe(false);
    expect(physicalStepResultRequiresSecureBarrier(checkpoint)).toBe(true);
    expect(physicalStepResultRequiresSecureBarrier(deleted)).toBe(true);
  });

  it('locks reader input, slice, quiesce, and terminal-result contracts', () => {
    expect(isReaderRequest({
      ...identity,
      type: 'search-start',
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'synthetic', normalized: 'synthetic', match: 'exact' }],
        }],
      },
      limit: 10,
    })).toBe(true);
    expect(isReaderRequest({
      ...identity,
      type: 'reader-step-grant',
      grantId: 3,
    })).toBe(true);
    expect(isReaderEvent({
      ...identity,
      type: 'reader-step-complete',
      grantId: 3,
      result: { kind: 'continue' },
    })).toBe(true);
    expect(isReaderEvent({ ...identity, type: 'reader-quiesced' })).toBe(true);
    expect(isReaderEvent({
      ...identity,
      type: 'reader-step-complete',
      grantId: 4,
      result: {
        kind: 'result-chunk',
        chunkIndex: 0,
        results: [],
        index: {
          indexedChatCount: 0,
          pendingChatCount: 0,
          failedChatCount: 0,
          unsupportedChatCount: 0,
        },
        done: true,
      },
    })).toBe(true);
  });

  it('enforces the exact full-envelope UTF-8 byte ceiling', () => {
    const event = {
      ...identity,
      type: 'reader-step-complete',
      grantId: 9,
      result: {
        kind: 'result-chunk',
        chunkIndex: 0,
        results: [{
          chatId: 'chat-1',
          transcriptViewId: 'view-1',
          score: 1,
          matchedMessageCount: 1,
          snippets: [{ ordinal: 1, role: 'user', timestamp: null, text: '' }],
        }],
        index: {
          indexedChatCount: 1,
          pendingChatCount: 0,
          failedChatCount: 0,
          unsupportedChatCount: 0,
        },
        done: true,
      },
    } as const;
    const exactText = 'x'.repeat(SEARCH_WORKER_MAX_ENVELOPE_BYTES - workerEnvelopeBytes(event));
    const exact = {
      ...event,
      result: {
        ...event.result,
        results: [{
          ...event.result.results[0],
          snippets: [{ ...event.result.results[0].snippets[0], text: exactText }],
        }],
      },
    };
    expect(workerEnvelopeBytes(exact)).toBe(SEARCH_WORKER_MAX_ENVELOPE_BYTES);
    expect(isReaderEvent(exact)).toBe(true);
    const oversized = {
      ...exact,
      result: {
        ...exact.result,
        results: [{
          ...exact.result.results[0],
          snippets: [{ ...exact.result.results[0].snippets[0], text: `${exactText}x` }],
        }],
      },
    };
    expect(workerEnvelopeBytes(oversized)).toBe(SEARCH_WORKER_MAX_ENVELOPE_BYTES + 1);
    expect(isReaderEvent(oversized)).toBe(false);
  });
});
