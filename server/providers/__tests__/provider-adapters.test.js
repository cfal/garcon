import { describe, expect, it } from 'bun:test';
import {
  buildDirectAnthropicConfig,
  buildDirectOpenAiConfig,
  buildDirectOpenAiResponsesConfig,
  createDirectOpenAiCompatibleRouterAdapter,
  createDirectOpenAiResponsesCompatibleRouterAdapter,
} from '../provider-adapters.ts';

function endpoint(overrides = {}) {
  return {
    id: 'example_openai',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.example.test/v1',
    apiKey: '',
    capabilities: { chatCompletions: true, responses: false },
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

describe('buildDirectOpenAiResponsesConfig', () => {
  it('uses separate Direct Responses session paths', () => {
    const config = buildDirectOpenAiResponsesConfig({
      providerId: 'direct-openai-responses-compatible',
      providerLabel: 'Example',
      endpoint: endpoint({
        capabilities: { chatCompletions: false, responses: true },
      }),
    });

    expect(config.getBaseUrl()).toBe('https://api.example.test/v1');
    expect(config.defaultModel).toBe('example-model');
    expect(config.getSessionFilePath('session-1')).toContain('/openai-compatible-responses-sessions/example_openai/session-1.jsonl');
  });
});

describe('Direct OpenAI router adapters', () => {
  it('routes models by Chat Completions and Responses capabilities', async () => {
    const apiProviderStore = {
      list: () => [{
        id: 'acme',
        label: 'Acme',
        endpoints: [
          endpoint({
            id: 'chat_endpoint',
            capabilities: { chatCompletions: true, responses: false },
            defaultModel: 'chat-model',
            models: [{ value: 'chat-model', label: 'Chat Model' }],
          }),
          endpoint({
            id: 'responses_endpoint',
            capabilities: { chatCompletions: false, responses: true },
            defaultModel: 'responses-model',
            models: [{ value: 'responses-model', label: 'Responses Model' }],
          }),
        ],
      }],
    };

    const chatAdapter = createDirectOpenAiCompatibleRouterAdapter(apiProviderStore);
    const responsesAdapter = createDirectOpenAiResponsesCompatibleRouterAdapter(apiProviderStore);

    expect(await chatAdapter.getModels?.()).toEqual([
      { value: 'chat-model', label: 'Acme: Chat Model', supportsImages: false },
    ]);
    expect(await responsesAdapter.getModels?.()).toEqual([
      { value: 'responses-model', label: 'Acme: Responses Model', supportsImages: false },
    ]);
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
