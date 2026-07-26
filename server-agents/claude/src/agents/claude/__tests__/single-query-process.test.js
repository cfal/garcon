import { describe, expect, it, mock } from 'bun:test';

import {
  MAX_SINGLE_QUERY_STDOUT_BYTES,
  runClaudeSingleQueryProcess,
} from '../single-query-process.js';

const encoder = new TextEncoder();
const logger = {
  debug: mock(() => undefined),
  info: mock(() => undefined),
  warn: mock(() => undefined),
  error: mock(() => undefined),
};

function outputStream(output, onRead = () => undefined) {
  let emitted = false;
  return new ReadableStream({
    pull(controller) {
      if (emitted) return;
      emitted = true;
      onRead();
      controller.enqueue(encoder.encode(output));
      controller.close();
    },
  });
}

function options() {
  return {
    binary: 'claude',
    args: ['--print'],
    cwd: '/tmp',
    signal: new AbortController().signal,
    logger,
  };
}

describe('runClaudeSingleQueryProcess', () => {
  it('drains stdout and stderr concurrently and returns output after a clean exit', async () => {
    const originalSpawn = Bun.spawn;
    const reads = [];
    Bun.spawn = mock(() => ({
      stdout: outputStream('answer', () => reads.push('stdout')),
      stderr: outputStream('diagnostic', () => reads.push('stderr')),
      exited: Promise.resolve(0),
    }));

    try {
      await expect(runClaudeSingleQueryProcess(options())).resolves.toBe('answer');
      expect(reads.toSorted()).toEqual(['stderr', 'stdout']);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('makes a nonzero exit authoritative with bounded stderr diagnostics', async () => {
    const originalSpawn = Bun.spawn;
    Bun.spawn = mock(() => ({
      stdout: outputStream('misleading output'),
      stderr: outputStream('authentication failed'),
      exited: Promise.resolve(1),
    }));

    try {
      await expect(runClaudeSingleQueryProcess(options()))
        .rejects.toThrow(/Claude CLI exited with code 1 \(stderr digest [a-f0-9]{16}\)/);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('authentication failed');
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('kills and reaps a process after oversized output', async () => {
    const originalSpawn = Bun.spawn;
    let resolveExit;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const proc = {
      stdout: outputStream('x'.repeat(MAX_SINGLE_QUERY_STDOUT_BYTES + 1)),
      stderr: outputStream(''),
      exited,
      killed: false,
      kill: mock(() => {
        proc.killed = true;
        resolveExit(143);
      }),
    };
    Bun.spawn = mock(() => proc);

    try {
      await expect(runClaudeSingleQueryProcess(options()))
        .rejects.toThrow(`Claude one-shot stdout exceeded ${MAX_SINGLE_QUERY_STDOUT_BYTES} bytes`);
      expect(proc.kill).toHaveBeenCalledTimes(1);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });
});
