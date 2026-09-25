import { expect, mock, test } from 'bun:test';
import { remoteFixture } from './integration-fixture.js';
import type { ApiProviderDiscoveryRequest } from '@garcon/server-agent-interface';

test.each(['controller', 'worker'] as const)('dispatches endpoint discovery on the worker when %s dials', async (dialer) => {
  const fixture = await remoteFixture(dialer);
  const request: ApiProviderDiscoveryRequest = {
    protocol: 'openai-compatible', baseUrl: 'http://localhost:11434/v1',
    apiKey: 'synthetic-credential', modelDiscovery: 'openai-models',
  };
  const models = [{ value: 'worker-model', label: 'Worker Model' }];
  const discover = mock(async () => ({ success: true, models }));
  fixture.generations[0]!.executor.discoverApiProviderModels = discover;
  try {
    expect(await fixture.executor.discoverApiProviderModels(request)).toEqual({ success: true, models });
    expect(discover).toHaveBeenCalledWith(request, { signal: expect.any(AbortSignal) });
    await fixture.executor.dispose();
    const failure = await fixture.executor.discoverApiProviderModels(request).catch((error) => error);
    expect(failure).toMatchObject({ outcome: 'not-dispatched' });
    expect(discover).toHaveBeenCalledTimes(1);
  } finally { await fixture.dispose(); }
});
