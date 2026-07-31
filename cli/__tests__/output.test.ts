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

    output.accepted('1785337200123456');
    output.completed(['First', '  ', 'Second']);

    expect(stdout.chunks.join('')).toBe(
      'chat id: 1785337200123456\nFirst\n\nSecond\n',
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
});
