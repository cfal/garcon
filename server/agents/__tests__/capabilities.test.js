import { describe, expect, test } from 'bun:test';
import { createAgentCapabilities } from '../capabilities.js';

describe('createAgentCapabilities', () => {
  test('defaults optional flags to false and protocol lists to empty', () => {
    expect(createAgentCapabilities()).toEqual({
      supportsFork: false,
      supportsForkAtMessage: false,
      supportsForkWhileRunning: false,
      supportsUpdateProjectPath: false,
      requiresNativePathForProjectPathUpdate: false,
      supportsImages: false,
      acceptsApiProviderEndpoints: false,
      supportedProtocols: [],
      authLoginSupported: false,
      requiresStrictModelDiscovery: false,
    });
  });

  test('preserves model discovery when provided', async () => {
    const capabilities = createAgentCapabilities({
      supportsImages: true,
      supportedProtocols: ['openai-compatible'],
      getModels: async () => [{ value: 'model', label: 'Model' }],
    });

    expect(capabilities.supportsImages).toBe(true);
    expect(capabilities.supportedProtocols).toEqual(['openai-compatible']);
    expect(await capabilities.getModels?.()).toEqual([{ value: 'model', label: 'Model' }]);
  });

  test('preserves the project path update capability when provided', () => {
    expect(createAgentCapabilities({ supportsUpdateProjectPath: true }).supportsUpdateProjectPath).toBe(true);
  });

  test('preserves the message-point fork capability when provided', () => {
    expect(createAgentCapabilities({ supportsForkAtMessage: true }).supportsForkAtMessage).toBe(true);
  });
});
