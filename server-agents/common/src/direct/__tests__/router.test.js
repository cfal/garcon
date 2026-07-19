import { describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import {
  buildDirectAnthropicConfig,
  buildDirectOpenAiConfig,
  buildDirectOpenAiResponsesConfig,
  createDirectOpenAiChatRuntime,
  createDirectOpenAiResponsesRuntime,
  DirectEndpointRouterRuntime,
} from '../router.ts';
import { createDirectSessionPaths } from '../session-paths.ts';

const WORKSPACE_DIR = '/tmp/garcon-direct-router';

function sessionPaths(agentId) {
  return createDirectSessionPaths(WORKSPACE_DIR, agentId);
}

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
      runtimeId: 'direct-openai-compatible',
      runtimeLabel: 'Example',
      endpoint: endpoint(),
      sessionPaths: sessionPaths('direct-openai-compatible'),
    });

    expect(config.buildHeaders?.('')).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('preserves managed headers for OpenRouter-style endpoints', () => {
    const config = buildDirectOpenAiConfig({
      runtimeId: 'direct-openai-compatible',
      runtimeLabel: 'OpenRouter',
      endpoint: endpoint({
        apiKey: 'sk-openrouter',
        headers: {
          'HTTP-Referer': 'https://github.com/cfal/garcon',
          'X-OpenRouter-Title': 'Garcon',
        },
      }),
      sessionPaths: sessionPaths('direct-openai-compatible'),
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
      runtimeId: 'direct-openai-responses-compatible',
      runtimeLabel: 'Example',
      endpoint: endpoint({
        capabilities: { chatCompletions: false, responses: true },
      }),
      sessionPaths: sessionPaths('direct-openai-responses-compatible'),
    });

    expect(config.getBaseUrl()).toBe('https://api.example.test/v1');
    expect(config.defaultModel).toBe('example-model');
    expect(config.getSessionFilePath('session-1')).toBe(path.resolve(
      WORKSPACE_DIR,
      'openai-compatible-responses-sessions/example_openai/session-1.jsonl',
    ));
  });
});

describe('Direct OpenAI router runtimes', () => {
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

    const chatAdapter = createDirectOpenAiChatRuntime(
      apiProviderStore,
      sessionPaths('direct-openai-compatible'),
    );
    const responsesAdapter = createDirectOpenAiResponsesRuntime(
      apiProviderStore,
      sessionPaths('direct-openai-responses-compatible'),
    );

    expect(await chatAdapter.getModels?.()).toEqual([
      { value: 'chat-model', label: 'Acme: Chat Model', supportsImages: false },
    ]);
    expect(await responsesAdapter.getModels?.()).toEqual([
      { value: 'responses-model', label: 'Acme: Responses Model', supportsImages: false },
    ]);
  });

  it('starts purge timers for existing and newly created endpoint runtimes', async () => {
    const provider = {
      id: 'acme',
      label: 'Acme',
      endpoints: [
        endpoint({ id: 'chat_endpoint_a' }),
        endpoint({ id: 'chat_endpoint_b' }),
      ],
    };
    const runtimes = new Map();
    const createRuntime = mock((runtimeEndpoint) => {
      const runtime = {
        startSession: mock(async () => ({
          agentSessionId: `${runtimeEndpoint.id}_session`,
          nativePath: null,
        })),
        runTurn: mock(async () => {}),
        abort: mock(() => false),
        isRunning: mock(() => false),
        getRunningSessions: mock(() => []),
        getModels: mock(async () => []),
        startPurgeTimer: mock(() => {}),
        shutdown: mock(() => {}),
        onMessages: mock(() => {}),
        onProcessing: mock(() => {}),
        onSessionCreated: mock(() => {}),
        onFinished: mock(() => {}),
        onFailed: mock(() => {}),
      };
      runtimes.set(runtimeEndpoint.id, runtime);
      return runtime;
    });
    const router = new DirectEndpointRouterRuntime({
      agentId: 'direct-openai-compatible',
      label: 'Direct OpenAI',
      protocol: 'openai-compatible',
      noEndpointMessage: 'No endpoint',
      apiProviders: {
        list: () => [provider],
        getEndpoint: (endpointId) => {
          const runtimeEndpoint = provider.endpoints.find((entry) => entry.id === endpointId);
          return runtimeEndpoint ? { apiProvider: provider, endpoint: runtimeEndpoint } : null;
        },
      },
      createRuntime,
      runSingleQuery: mock(async () => ''),
    });

    router.startPurgeTimer();
    await router.startSession({
      chatId: 'chat-a',
      command: 'hello',
      projectPath: '/tmp',
      modelEndpointId: 'chat_endpoint_a',
    });
    router.startPurgeTimer();
    await router.startSession({
      chatId: 'chat-b',
      command: 'hello',
      projectPath: '/tmp',
      modelEndpointId: 'chat_endpoint_b',
    });
    router.shutdown();

    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(runtimes.get('chat_endpoint_a').startPurgeTimer).toHaveBeenCalledTimes(1);
    expect(runtimes.get('chat_endpoint_b').startPurgeTimer).toHaveBeenCalledTimes(1);
    expect(runtimes.get('chat_endpoint_a').shutdown).toHaveBeenCalledTimes(1);
    expect(runtimes.get('chat_endpoint_b').shutdown).toHaveBeenCalledTimes(1);
  });
});

describe('buildDirectAnthropicConfig', () => {
  it('uses stored endpoint credentials and session paths', () => {
    const config = buildDirectAnthropicConfig({
      runtimeId: 'direct-anthropic-compatible',
      runtimeLabel: 'Example',
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
      sessionPaths: sessionPaths('direct-anthropic-compatible'),
    });

    expect(config.getApiKey()).toBe('sk-ant');
    expect(config.getBaseUrl()).toBe('https://api.example.test');
    expect(config.defaultModel).toBe('example-model');
    expect(config.getSessionFilePath('session-1')).toBe(path.resolve(
      WORKSPACE_DIR,
      'anthropic-compatible-sessions/example_anthropic/session-1.jsonl',
    ));
  });
});
