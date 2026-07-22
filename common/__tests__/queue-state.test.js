import { describe, expect, it } from 'bun:test';
import {
  emptyChatQueueState,
  parseChatQueueState,
} from '../queue-state.ts';

const BASE_QUEUE = {
  entries: [],
  dispatchingEntryId: null,
  recentlyDispatched: [],
  pause: null,
  reorderRevision: 0,
};

describe('queue state', () => {
  it('initializes a zero reorder revision', () => {
    expect(emptyChatQueueState().reorderRevision).toBe(0);
  });

  it('parses non-negative safe reorder revisions', () => {
    expect(parseChatQueueState(BASE_QUEUE)?.reorderRevision).toBe(0);
    expect(parseChatQueueState({ ...BASE_QUEUE, reorderRevision: 42 })?.reorderRevision).toBe(42);
  });

  it('rejects missing and malformed reorder revisions', () => {
    const { reorderRevision: _omitted, ...missing } = BASE_QUEUE;
    expect(parseChatQueueState(missing)).toBeNull();
    expect(parseChatQueueState({ ...BASE_QUEUE, reorderRevision: -1 })).toBeNull();
    expect(parseChatQueueState({ ...BASE_QUEUE, reorderRevision: 1.5 })).toBeNull();
    expect(parseChatQueueState({
      ...BASE_QUEUE,
      reorderRevision: Number.MAX_SAFE_INTEGER + 1,
    })).toBeNull();
  });

  it('requires dispatched markers to retain the dispatched content revision', () => {
    const dispatchedAt = '2026-07-22T00:00:00.000Z';
    expect(parseChatQueueState({
      ...BASE_QUEUE,
      recentlyDispatched: [{ entryId: 'entry-1', revision: 3, dispatchedAt }],
    })?.recentlyDispatched).toEqual([{ entryId: 'entry-1', revision: 3, dispatchedAt }]);
    expect(parseChatQueueState({
      ...BASE_QUEUE,
      recentlyDispatched: [{ entryId: 'entry-1', dispatchedAt }],
    })).toBeNull();
  });
});
