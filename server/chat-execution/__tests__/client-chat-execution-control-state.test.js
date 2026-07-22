import { describe, expect, it } from 'bun:test';
import {
  MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES,
  toClientChatExecutionControlState,
} from '../control-state.js';

function entry(id, status, revision = 1) {
  return {
    id,
    content: `c-${id}`,
    status,
    revision,
    createdAt: '2026-02-27T00:00:00.000Z',
    updatedAt: '2026-02-27T00:00:00.000Z',
  };
}

function control(entries, overrides = {}) {
  return {
    entries,
    recentlyDispatched: [],
    appliedCommands: [],
    pause: null,
    reorderRevision: 2,
    version: 4,
    updatedAt: '2026-02-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('chat execution-control projection', () => {
  it('projects editable entries in one versioned snapshot', () => {
    const queued = {
      ...entry('q1', 'queued', 3),
      delivery: {
        clientRequestId: 'request-1',
        clientMessageId: 'message-1',
        turnId: 'turn-1',
      },
    };
    const result = toClientChatExecutionControlState(control([entry('s1', 'sending'), queued]));

    expect(result.queue.entries).toEqual([expect.objectContaining({ id: 'q1', revision: 3 })]);
    expect(result.queue.entries[0]).not.toHaveProperty('status');
    expect(result.queue.entries[0]).not.toHaveProperty('delivery');
    expect(result.queue.dispatchingEntryId).toBe('s1');
    expect(result.queue.reorderRevision).toBe(2);
    expect(result.version).toBe(4);
  });

  it('retains bounded recently-dispatched markers after the sending entry leaves', () => {
    const markers = Array.from({ length: MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES + 3 }, (_, index) => ({
      entryId: `q${index}`,
      revision: index + 1,
      dispatchedAt: `2026-02-27T00:00:${String(index).padStart(2, '0')}.000Z`,
    }));
    const result = toClientChatExecutionControlState(control([], { recentlyDispatched: markers }));

    expect(result.queue.recentlyDispatched).toHaveLength(MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES);
    expect(result.queue.recentlyDispatched[0].entryId).toBe('q3');
    expect(result.queue.dispatchingEntryId).toBeNull();
  });

  it('keeps command receipts and pause history server-only', () => {
    const result = toClientChatExecutionControlState(control([entry('q1', 'queued')], {
      pause: {
        id: 'automatic-pause',
        kind: 'queued-turn-failed',
        entryId: 'q1',
        pausedAt: '2026-02-27T00:00:01.000Z',
      },
      resumePauses: [{
        id: 'manual-pause',
        kind: 'manual',
        pausedAt: '2026-02-27T00:00:00.000Z',
      }],
      appliedCommands: [{
        key: 'queue-entry-create:chat:req',
        operation: 'create',
        entryId: 'q1',
        appliedAt: '2026-07-16T00:00:00.000Z',
      }],
    }));

    expect(result.queue.pause).toMatchObject({ id: 'automatic-pause' });
    expect(result).not.toHaveProperty('appliedCommands');
    expect(result).not.toHaveProperty('resumePauses');
  });
});
