import { describe, expect, it } from 'bun:test';
import { buildDirectAnthropicConfig, buildDirectOpenAiConfig } from '../provider-adapters.ts';

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

describe('buildDirectAnthropicConfig', () => {
  it('uses stored endpoint credentials and session paths', () => {
    const config = buildDirectAnthropicConfig({
      providerId: 'direct-anthropic-compatible',
      providerLabel: 'Example',
      endpoint: {
        id: 'example_anthropic',
        protocol: 'anthropic-messages',
        baseUrl: 'https://api.example.test',
        apiKey: 'sk-ant',
        exposeTo: ['direct-anthropic-compatible'],
        defaultModel: 'example-model',
        models: [{ value: 'example-model', label: 'Example Model' }],
        supportsImages: true,
        modelDiscovery: 'anthropic-models',
      },
    });

    expect(config.getApiKey()).toBe('sk-ant');
    expect(config.getBaseUrl()).toBe('https://api.example.test');
    expect(config.defaultModel).toBe('example-model');
    expect(config.getSessionFilePath('session-1')).toContain('/anthropic-compatible-sessions/example_anthropic/session-1.jsonl');
  });
});
