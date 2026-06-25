import { describe, it, expect } from 'bun:test';
import { toClientQueueState } from '../../../common/queue-state.js';

function entry(id, status) {
  return { id, content: `c-${id}`, status, createdAt: '2026-02-27T00:00:00.000Z' };
}

describe('toClientQueueState', () => {
  it('strips sending entries that already live in the transcript', () => {
    const result = toClientQueueState({
      entries: [entry('s1', 'sending'), entry('q1', 'queued')],
      paused: false,
      version: 4,
    });

    expect(result.entries.map((e) => e.id)).toEqual(['q1']);
    expect(result.version).toBe(4);
  });

  it('collapses to an empty queue while the only entry is sending', () => {
    const result = toClientQueueState({
      entries: [entry('s1', 'sending')],
      paused: false,
      version: 2,
    });

    expect(result.entries).toEqual([]);
  });

  it('returns the same reference when there is nothing to strip', () => {
    const queue = { entries: [entry('q1', 'queued')], paused: true, version: 1 };
    expect(toClientQueueState(queue)).toBe(queue);
  });

  it('forces paused false when stripping leaves no entries', () => {
    const result = toClientQueueState({
      entries: [entry('s1', 'sending')],
      paused: true,
      version: 3,
    });

    expect(result.entries).toEqual([]);
    expect(result.paused).toBe(false);
  });
});
