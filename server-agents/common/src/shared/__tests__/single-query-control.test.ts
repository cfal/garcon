import { describe, expect, it } from 'bun:test';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSingleQueryRequest } from '@garcon/server-agent-interface';
import {
  singleQueryRuntimeOptions,
  withSingleQueryControl,
  withSingleQueryDirectory,
} from '../single-query-control.js';

function request(overrides: Partial<AgentSingleQueryRequest> = {}): AgentSingleQueryRequest {
  return {
    prompt: 'prompt',
    model: 'model-a',
    thinkingMode: 'high',
    timeoutMs: 42_000,
    settings: {
      ownerId: 'test',
      schemaVersion: 1,
      values: { providerOption: true, thinkingMode: 'low', timeoutMs: 1 },
    },
    endpoint: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('single-query controls', () => {
  for (const outcome of ['success', 'failure', 'cancelled', 'timeout'] as const) {
    it(`cleans the provider-owned temporary directory after ${outcome}`, async () => {
      const controller = new AbortController();
      let directory = '';
      const operation = withSingleQueryDirectory(controller.signal, async (created) => {
        directory = created;
        expect(await readdir(created)).toEqual([]);
        await writeFile(join(created, 'synthetic-output'), 'synthetic data');
        if (outcome === 'cancelled') {
          controller.abort(new Error('cancelled'));
          controller.signal.throwIfAborted();
        }
        if (outcome === 'failure') throw new Error('provider failed');
        if (outcome === 'timeout') return withSingleQueryControl({ timeoutMs: 1 }, () => new Promise(() => {}));
        return 'answer';
      });
      if (outcome === 'success') await expect(operation).resolves.toBe('answer');
      else await expect(operation).rejects.toThrow();
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }

  it('places canonical controls after provider settings', () => {
    const input = request();

    expect(singleQueryRuntimeOptions(input)).toEqual({
      providerOption: true,
      thinkingMode: 'high',
      timeoutMs: 42_000,
      signal: input.signal,
    });
  });

  it('propagates caller cancellation to the running operation', async () => {
    const caller = new AbortController();
    const reason = new Error('cancelled');
    const running = withSingleQueryControl({ signal: caller.signal }, async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      signal.throwIfAborted();
      return 'unreachable';
    });

    caller.abort(reason);

    await expect(running).rejects.toBe(reason);
  });

  it('terminates the operation at the requested timeout', async () => {
    const running = withSingleQueryControl({ timeoutMs: 1 }, async () => (
      await new Promise<string>(() => {})
    ));

    await expect(running).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
