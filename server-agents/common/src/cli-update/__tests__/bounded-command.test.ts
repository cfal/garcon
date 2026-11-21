import { expect, test } from 'bun:test';
import { outputLines, runBoundedCommand } from '../bounded-command.js';

const env = { PATH: '/usr/bin:/bin' };

test('keeps the end of each stream within its byte budget', async () => {
  const result = await runBoundedCommand(['/bin/sh', '-c', 'seq 1 5000; echo tail-line'], {
    env, timeoutMs: 10_000, maxOutputBytes: 64,
  });
  expect(result.exitCode).toBe(0);
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64);
  expect(result.stdout.endsWith('tail-line\n')).toBe(true);
});

test('reports redrawn progress as separate lines', async () => {
  const lines: string[] = [];
  await runBoundedCommand(['/bin/sh', '-c', String.raw`printf 'one\r\033[32mtwo\033[0m\nthree'`], {
    env, timeoutMs: 10_000, maxOutputBytes: 1024, onLine: (line) => lines.push(line),
  });
  expect(lines).toEqual(['one', 'two', 'three']);
  expect(outputLines('a\r\n\x1b[1G b  c \n\n')).toEqual(['a', 'b c']);
});

test('stops a command at its deadline', async () => {
  const result = await runBoundedCommand(['/bin/sh', '-c', 'sleep 10'], { env, timeoutMs: 50, maxOutputBytes: 1024 });
  expect(result).toMatchObject({ exitCode: null, timedOut: true });
});
