import { describe, expect, it } from 'bun:test';
import {
  MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES,
  normalizeStoredChatExecutionControlState,
  parseStoredChatExecutionControlState,
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

function storedControl(entries, overrides = {}) {
  return {
    entries,
    recentlyDispatched: [],
    appliedCommands: [],
    pause: null,
    recoveredInputContinuation: null,
    version: 4,
    updatedAt: '2026-02-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('stored chat execution-control projection', () => {
  it('projects editable entries and continuation in one versioned snapshot', () => {
    const queued = {
      ...entry('q1', 'queued', 3),
      delivery: {
        clientRequestId: 'request-1',
        clientMessageId: 'message-1',
        turnId: 'turn-1',
      },
    };
    const continuation = {
      id: 'ad6cf0fd-f9cc-48a3-b484-92f150c0ae45',
      installedAt: '2026-07-18T00:00:00.000Z',
    };
    const result = toClientChatExecutionControlState(
      storedControl([entry('s1', 'sending'), queued], { recoveredInputContinuation: continuation }),
    );

    expect(result.queue.entries).toEqual([expect.objectContaining({ id: 'q1', revision: 3 })]);
    expect(result.queue.entries[0]).not.toHaveProperty('status');
    expect(result.queue.entries[0]).not.toHaveProperty('delivery');
    expect(result.queue.dispatchingEntryId).toBe('s1');
    expect(result.recoveredInputContinuation).toEqual(continuation);
    expect(result.recoveredInputContinuation).not.toBe(continuation);
    expect(result.version).toBe(4);
  });

  it('rejects persisted entries with a malformed delivery identity', () => {
    expect(() => parseStoredChatExecutionControlState(storedControl([{
      ...entry('q1', 'queued'),
      delivery: { clientRequestId: 'request-1' },
    }]))).toThrow('invalid delivery identity');
  });

  it('rejects malformed persisted continuation instead of treating it as absence', () => {
    expect(() => parseStoredChatExecutionControlState(storedControl([], {
      recoveredInputContinuation: {
        id: 'not-a-uuid',
        installedAt: '2026-07-18T00:00:00.000Z',
      },
    }))).toThrow('recoveredInputContinuation is invalid');
  });

  it('rejects persisted metadata that the client cannot parse', () => {
    for (const version of [1.5, Number.MAX_SAFE_INTEGER + 1, -1]) {
      expect(() => parseStoredChatExecutionControlState(storedControl([], { version })))
        .toThrow('version must be a nonnegative safe integer');
    }
    expect(() => parseStoredChatExecutionControlState(storedControl([], {
      updatedAt: 'not-a-timestamp',
    }))).toThrow('updatedAt must be a canonical timestamp or null');
  });

  it('retains bounded recently-dispatched markers after the sending entry leaves', () => {
    const markers = Array.from({ length: MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES + 3 }, (_, index) => ({
      entryId: `q${index}`,
      dispatchedAt: `2026-02-27T00:00:${String(index).padStart(2, '0')}.000Z`,
    }));
    const result = toClientChatExecutionControlState(
      storedControl([], { recentlyDispatched: markers }),
    );

    expect(result.queue.recentlyDispatched).toHaveLength(MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES);
    expect(result.queue.recentlyDispatched[0].entryId).toBe('q3');
    expect(result.queue.dispatchingEntryId).toBeNull();
  });

  it('migrates persisted entries that predate revisions', () => {
    const result = normalizeStoredChatExecutionControlState({
      entries: [
        {
          id: 'q1',
          content: 'legacy',
          status: 'queued',
          createdAt: '2026-02-27T00:00:00.000Z',
        },
      ],
      paused: true,
    });

    expect(result.entries[0]).toMatchObject({
      revision: 1,
      updatedAt: '2026-02-27T00:00:00.000Z',
    });
    expect(result.recentlyDispatched).toEqual([]);
    expect(result.version).toBe(0);
    expect(result.appliedCommands).toEqual([]);
    expect(result.pause).toMatchObject({ kind: 'unknown', entryId: 'q1' });
    expect(result.recoveredInputContinuation).toBeNull();
  });

  it('removes legacy recovered-input pauses and promotes real pause history', () => {
    const result = normalizeStoredChatExecutionControlState(storedControl([entry('q1', 'queued')], {
      pause: {
        id: 'legacy-recovery',
        kind: 'recovered-unconfirmed-input',
        pausedAt: '2026-02-27T00:00:01.000Z',
      },
      resumePauses: [{
        id: 'manual-pause',
        kind: 'manual',
        pausedAt: '2026-02-27T00:00:00.000Z',
      }],
    }));

    expect(result.pause).toMatchObject({ id: 'manual-pause', kind: 'manual' });
    expect(result).not.toHaveProperty('resumePauses');
    expect(result.recoveredInputContinuation).toBeNull();
  });

  it('keeps durable command receipts and pause history server-only', () => {
    const result = toClientChatExecutionControlState(
      storedControl([entry('q1', 'queued')], {
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
      }),
    );

    expect(result.queue.pause).toMatchObject({ id: 'automatic-pause' });
    expect(result).not.toHaveProperty('appliedCommands');
    expect(result).not.toHaveProperty('resumePauses');
  });
});
