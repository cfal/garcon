import { describe, expect, it } from 'bun:test';
import { TerminalReplayBuffer } from '../terminal-replay-buffer.ts';

describe('TerminalReplayBuffer', () => {
  it('evicts whole UTF-8 chunks and preserves sequence numbers', () => {
    const replay = new TerminalReplayBuffer(5);
    replay.append({ sequence: 1, data: 'ab' });
    replay.append({ sequence: 2, data: '\u00e9' });
    replay.append({ sequence: 3, data: 'cd' });

    expect(replay.byteLength).toBe(4);
    expect(replay.firstRetainedSequence).toBe(2);
    expect(replay.after(0)).toEqual([
      { sequence: 2, data: '\u00e9' },
      { sequence: 3, data: 'cd' },
    ]);
    expect(replay.after(2)).toEqual([{ sequence: 3, data: 'cd' }]);
  });

  it('does not retain an oversized live chunk', () => {
    const replay = new TerminalReplayBuffer(4);
    replay.append({ sequence: 1, data: 'oversized' });

    expect(replay.byteLength).toBe(0);
    expect(replay.firstRetainedSequence).toBe(2);
    expect(replay.after(0)).toEqual([]);
  });
});
