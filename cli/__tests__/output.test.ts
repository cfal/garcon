import { describe, expect, test } from 'bun:test';
import { createCliOutput } from '../output.js';

function writer(): { chunks: string[]; write(chunk: string): void } {
  return {
    chunks: [],
    write(chunk) {
      this.chunks.push(chunk);
    },
  };
}

describe('createCliOutput', () => {
  test('prints the stable chat line followed by assistant messages', () => {
    const stdout = writer();
    const stderr = writer();
    const output = createCliOutput(stdout, stderr);

    output.accepted({ chatId: '1785337200123456', turnId: 'turn-1' });
    output.completed(['First', '  ', 'Second']);

    expect(stdout.chunks.join('')).toBe(
      'chat id: 1785337200123456\nturn id: turn-1\nFirst\n\nSecond\n',
    );
    expect(stderr.chunks).toEqual([]);
  });

  test('keeps diagnostics off stdout', () => {
    const stdout = writer();
    const stderr = writer();
    createCliOutput(stdout, stderr).diagnostic('submission: unavailable');
    expect(stdout.chunks).toEqual([]);
    expect(stderr.chunks.join('')).toBe('submission: unavailable\n');
  });

  test('prints nothing after the chat line for an empty assistant result', () => {
    const stdout = writer();
    const stderr = writer();
    const output = createCliOutput(stdout, stderr);

    output.accepted({ chatId: '1785337200123456', turnId: 'turn-1' });
    output.completed(['', '   ']);

    expect(stdout.chunks.join('')).toBe('chat id: 1785337200123456\nturn id: turn-1\n');
    expect(stderr.chunks).toEqual([]);
  });

  test('terminates structured results with exactly one newline', () => {
    const stdout = writer();
    const stderr = writer();
    const output = createCliOutput(stdout, stderr);

    output.result('AGENT\n------\n');

    expect(stdout.chunks).toEqual(['AGENT\n------\n']);
    expect(stderr.chunks).toEqual([]);
  });

  test('prints the stable async delivery block for new-turn and steer', () => {
    const stdout = writer();
    const stderr = writer();
    const output = createCliOutput(stdout, stderr);

    output.sent('1785337200123456', 'new-turn', 'turn-1');
    output.sent('1785337200123456', 'steer', 'turn-active');

    expect(stdout.chunks.join('')).toBe(
      'chat id: 1785337200123456\ndelivery: new-turn\nturn id: turn-1\n'
      + 'chat id: 1785337200123456\ndelivery: steer\nturn id: turn-active\n',
    );
    expect(stderr.chunks).toEqual([]);
  });

  test('prints the stable stop outcome block', () => {
    const stdout = writer();
    const stderr = writer();
    const output = createCliOutput(stdout, stderr);

    output.stopped('1785337200123456', 'interrupt-requested');
    output.stopped('1785337200123456', 'already-idle');

    expect(stdout.chunks.join('')).toBe(
      'chat id: 1785337200123456\nstop: interrupt-requested\n'
      + 'chat id: 1785337200123456\nstop: already-idle\n',
    );
    expect(stderr.chunks).toEqual([]);
  });
});
