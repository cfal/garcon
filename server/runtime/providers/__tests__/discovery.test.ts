import { afterEach, expect, mock, test } from 'bun:test';
import { discoverApiProviderModels } from '../discovery.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('uses one deadline and credential across bounded Anthropic model pages', async () => {
  const fetchModel = mock(async (_url: RequestInfo | URL, _options?: RequestInit) => Response.json({
    data: [{ id: 'synthetic-model', display_name: 'Synthetic Model' }],
    has_more: true, last_id: `page-${fetchModel.mock.calls.length}`,
  }));
  globalThis.fetch = Object.assign(fetchModel, { preconnect: originalFetch.preconnect });
  const result = await discoverApiProviderModels({
    protocol: 'anthropic-messages', baseUrl: 'http://localhost:11434',
    apiKey: 'synthetic-credential', modelDiscovery: 'anthropic-models',
  });
  expect(result).toEqual({ success: true, models: [{ value: 'synthetic-model', label: 'Synthetic Model' }] });
  expect(fetchModel).toHaveBeenCalledTimes(5);
  const signal = fetchModel.mock.calls[0]![1]!.signal;
  for (const [, options] of fetchModel.mock.calls) {
    expect(options!.signal).toBe(signal);
    expect(options!.headers).toMatchObject({ 'x-api-key': 'synthetic-credential' });
  }
  expect(String(fetchModel.mock.calls[1]![0])).toContain('after_id=page-1');
});

test('cancels outstanding discovery at the node call deadline', async () => {
  const fetchModel = mock(async (_url: RequestInfo | URL, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
  }));
  globalThis.fetch = Object.assign(fetchModel, { preconnect: originalFetch.preconnect });
  const result = await discoverApiProviderModels({
    protocol: 'openai-compatible', baseUrl: 'http://localhost:11434', modelDiscovery: 'openai-models',
  }, { timeoutMs: 5 });
  expect(result.success).toBe(false);
  expect(fetchModel.mock.calls[0]![1]!.signal!.aborted).toBe(true);
});
