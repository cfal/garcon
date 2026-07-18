import { describe, expect, it } from 'bun:test';
import {
  MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES,
  normalizeStoredQueueState,
  parseStoredQueueState,
  toClientQueueState,
} from '../../queue-state.js';

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

function storedQueue(entries, overrides = {}) {
  return {
    entries,
    recentlyDispatched: [],
    appliedCommands: [],
    pause: null,
    version: 4,
    updatedAt: '2026-02-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('stored queue projection', () => {
  it('projects only editable entries and reports the dispatching ID', () => {
    const queued = {
      ...entry('q1', 'queued', 3),
      delivery: {
        clientRequestId: 'request-1',
        clientMessageId: 'message-1',
        turnId: 'turn-1',
      },
    };
    const result = toClientQueueState(storedQueue([entry('s1', 'sending'), queued]));

    expect(result.entries).toEqual([expect.objectContaining({ id: 'q1', revision: 3 })]);
    expect(result.entries[0]).not.toHaveProperty('status');
    expect(result.entries[0]).not.toHaveProperty('delivery');
    expect(result.dispatchingEntryId).toBe('s1');
    expect(result.version).toBe(4);
  });

  it('rejects persisted entries with a malformed delivery identity', () => {
    expect(() => parseStoredQueueState(storedQueue([{
      ...entry('q1', 'queued'),
      delivery: { clientRequestId: 'request-1' },
    }]))).toThrow('invalid delivery identity');
  });

  it('retains bounded recently-dispatched markers after the sending entry leaves', () => {
    const markers = Array.from({ length: MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES + 3 }, (_, index) => ({
      entryId: `q${index}`,
      dispatchedAt: `2026-02-27T00:00:${String(index).padStart(2, '0')}.000Z`,
    }));
    const result = toClientQueueState(storedQueue([], { recentlyDispatched: markers }));

    expect(result.recentlyDispatched).toHaveLength(MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES);
    expect(result.recentlyDispatched[0].entryId).toBe('q3');
    expect(result.dispatchingEntryId).toBeNull();
  });

  it('migrates persisted entries that predate revisions', () => {
    const result = normalizeStoredQueueState({
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
  });

  it('clones the complete pause record into the client projection', () => {
    const pause = {
      id: 'pause-1',
      kind: 'queued-turn-failed',
      entryId: 'q1',
      pausedAt: '2026-02-27T00:00:00.000Z',
    };
    const result = toClientQueueState(storedQueue([entry('q1', 'queued')], { pause }));

    expect(result.pause).toEqual(pause);
    expect(result.pause).not.toBe(pause);
  });

  it('keeps durable command receipts server-only', () => {
    const result = toClientQueueState(
      storedQueue([entry('q1', 'queued')], {
        appliedCommands: [
          {
            key: 'queue-entry-create:chat:req',
            operation: 'create',
            entryId: 'q1',
            appliedAt: '2026-07-16T00:00:00.000Z',
          },
        ],
      }),
    );

    expect(result).not.toHaveProperty('appliedCommands');
  });

  it('keeps superseded pause history server-only', () => {
    const result = toClientQueueState(
      storedQueue([entry('q1', 'queued')], {
        pause: {
          id: 'recovery-pause',
          kind: 'recovered-unconfirmed-input',
          pausedAt: '2026-02-27T00:00:01.000Z',
        },
        resumePauses: [{
          id: 'manual-pause',
          kind: 'manual',
          pausedAt: '2026-02-27T00:00:00.000Z',
        }],
      }),
    );

    expect(result.pause).toMatchObject({ id: 'recovery-pause' });
    expect(result).not.toHaveProperty('resumePauses');
  });
});
