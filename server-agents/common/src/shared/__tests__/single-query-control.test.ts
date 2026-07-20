import { describe, expect, it } from 'bun:test';
import type { AgentSingleQueryRequest } from '@garcon/server-agent-interface';
import {
  singleQueryRuntimeOptions,
  withSingleQueryControl,
} from '../single-query-control.js';

function request(overrides: Partial<AgentSingleQueryRequest> = {}): AgentSingleQueryRequest {
  return {
    prompt: 'prompt',
    projectPath: '/repo',
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
