import { describe, expect, it } from 'bun:test';
import { buildDirectOpenAiConfig } from '../provider-adapters.ts';

function endpoint(overrides = {}) {
  return {
    id: 'example_openai',
    protocol: 'openai-chat-completions',
    baseUrl: 'https://api.example.test/v1',
    apiKey: '',
    exposeTo: ['direct-openai-compatible'],
    defaultModel: 'example-model',
    models: [{ value: 'example-model', label: 'Example Model' }],
    supportsImages: false,
    modelDiscovery: 'openai-models',
    ...overrides,
  };
}

describe('buildDirectOpenAiConfig', () => {
  it('omits Authorization for blank-key Direct endpoints', () => {
    const config = buildDirectOpenAiConfig({
      providerId: 'direct-openai-compatible',
      providerLabel: 'Example',
      endpoint: endpoint(),
    });

    expect(config.buildHeaders?.('')).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('preserves managed headers for OpenRouter-style endpoints', () => {
    const config = buildDirectOpenAiConfig({
      providerId: 'direct-openai-compatible',
      providerLabel: 'OpenRouter',
      endpoint: endpoint({
        apiKey: 'sk-openrouter',
        headers: {
          'HTTP-Referer': 'https://github.com/cfal/garcon',
          'X-OpenRouter-Title': 'Garcon',
        },
      }),
    });

    expect(config.buildHeaders?.('sk-openrouter')).toEqual({
      Authorization: 'Bearer sk-openrouter',
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/cfal/garcon',
      'X-OpenRouter-Title': 'Garcon',
    });
  });
});
