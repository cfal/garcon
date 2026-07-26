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
        .rejects.toThrow('Claude CLI exited with code 1: authentication failed');
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('rejects oversized output instead of retaining it indefinitely', async () => {
    const originalSpawn = Bun.spawn;
    Bun.spawn = mock(() => ({
      stdout: outputStream('x'.repeat(MAX_SINGLE_QUERY_STDOUT_BYTES + 1)),
      stderr: outputStream(''),
      exited: Promise.resolve(0),
    }));

    try {
      await expect(runClaudeSingleQueryProcess(options()))
        .rejects.toThrow(`Claude one-shot stdout exceeded ${MAX_SINGLE_QUERY_STDOUT_BYTES} bytes`);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });
});
