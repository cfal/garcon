import { describe, expect, test } from 'bun:test';
import { createHarnessCapabilities } from '../capabilities.js';

describe('createHarnessCapabilities', () => {
  test('defaults optional flags to false and protocol lists to empty', () => {
    expect(createHarnessCapabilities()).toEqual({
      supportsFork: false,
      supportsImages: false,
      acceptsApiProviderEndpoints: false,
      supportedProtocols: [],
      authLoginSupported: false,
    });
  });

  test('preserves model discovery when provided', async () => {
    const capabilities = createHarnessCapabilities({
      supportsImages: true,
      supportedProtocols: ['openai-compatible'],
      getModels: async () => [{ value: 'model', label: 'Model' }],
    });

    expect(capabilities.supportsImages).toBe(true);
    expect(capabilities.supportedProtocols).toEqual(['openai-compatible']);
    expect(await capabilities.getModels?.()).toEqual([{ value: 'model', label: 'Model' }]);
  });
});
