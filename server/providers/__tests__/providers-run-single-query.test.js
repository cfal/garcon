import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const claudeQuery = mock(async () => 'claude-response');
const codexQuery = mock(async () => 'codex-response');
const ampQuery = mock(async () => 'amp-response');
const factoryQuery = mock(async () => 'factory-response');
const originalFetch = globalThis.fetch;

mock.module('../claude-cli.js', () => ({
  runSingleQuery: claudeQuery,
  createClaudeNativePath: mock(() => Promise.resolve('/tmp/claude-session.jsonl')),
}));

mock.module('../codex.js', () => ({
  runSingleQuery: codexQuery,
}));

mock.module('../amp-cli.js', () => ({
  runSingleQuery: ampQuery,
}));

mock.module('../factory-cli.js', () => ({
  runSingleQuery: factoryQuery,
}));

mock.module('../loaders/claude-history-loader.js', () => ({
  getClaudePreviewFromNativePath: mock(() => Promise.resolve(null)),
  loadClaudeChatMessages: mock(() => Promise.resolve([])),
}));

mock.module('../loaders/codex-history-loader.js', () => ({
  getCodexPreviewFromNativePath: mock(() => Promise.resolve(null)),
  loadCodexChatMessages: mock(() => Promise.resolve([])),
}));

mock.module('../loaders/opencode-history-loader.js', () => ({
  getOpenCodePreviewFromSessionId: mock(() => Promise.resolve(null)),
  loadOpenCodeChatMessages: mock(() => Promise.resolve([])),
}));

mock.module('../loaders/factory-history-loader.js', () => ({
  getFactoryPreviewFromSessionId: mock(() => Promise.resolve(null)),
  loadFactoryChatMessagesBySessionId: mock(() => Promise.resolve([])),
}));

mock.module('../loaders/direct-compatible-history-loader.js', () => ({
  getDirectCompatiblePreviewFromSessionId: mock(() => Promise.resolve(null)),
  loadDirectCompatibleChatMessages: mock(() => Promise.resolve([])),
}));

import { ProviderRegistry } from '../index.js';
import {
  createAmpAdapter,
  createClaudeAdapter,
  createCodexAdapter,
  createFactoryAdapter,
  createOpenCodeAdapter,
} from '../provider-adapters.js';

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeEndpointResolver(endpointOptions = {}) {
  return {
    getModelOptions: mock((harnessId) => endpointOptions[harnessId] ?? []),
    resolveSelection: mock(({ model, apiProviderId = null, modelEndpointId = null }) => ({
      model: modelEndpointId ? model.replace(`${modelEndpointId}:`, '') : model,
      apiProviderId,
      endpointId: modelEndpointId,
      protocol: modelEndpointId ? 'openai-chat-completions' : null,
      isLocal: false,
      envOverrides: undefined,
    })),
    modelSupportsImages: mock(() => false),
  };
}

function makeApiProviderStore(apiProviders = []) {
  return {
    list: () => apiProviders,
    redactedList: () => apiProviders,
    getApiProvider: mock((apiProviderId) => apiProviders.find((apiProvider) => apiProvider.id === apiProviderId) ?? null),
    getEndpoint: mock((endpointId) => {
      for (const apiProvider of apiProviders) {
        const endpoint = apiProvider.endpoints?.find((entry) => entry.id === endpointId);
        if (endpoint) return { apiProvider, endpoint };
      }
      return null;
    }),
    createApiProvider: mock((input) => Promise.resolve({
      id: 'custom_acme',
      label: input.label,
      templateId: input.templateId,
      createdAt: '2026-05-04T00:00:00.000Z',
      updatedAt: '2026-05-04T00:00:00.000Z',
      endpoints: [{
        id: 'custom_acme_openai',
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey ?? '',
        exposeTo: input.exposeTo,
        defaultModel: input.defaultModel,
        models: input.models,
        supportsImages: input.supportsImages ?? false,
        modelDiscovery: input.modelDiscovery,
      }],
    })),
    updateApiProvider: mock(),
    deleteApiProvider: mock(),
  };
}

function makeRegistry(args = {}) {
  const mockRegistry = {
    getChat: mock(() => null),
    getChatByProviderSessionId: mock(() => null),
    listAllChats: mock(() => ({})),
    updateChat: mock(() => undefined),
    onChatRemoved: mock(() => undefined),
    ...args.registry,
  };
  const opencode = {
    startSession: mock(() => Promise.resolve('opencode-session')),
    runTurn: mock(() => Promise.resolve()),
    isRunning: mock(() => false),
    abort: mock(() => false),
    getRunningSessions: mock(() => []),
    runSingleQuery: mock(async () => 'opencode-response'),
    getModels: mock(() => []),
    getClient: mock(() => null),
    getClientIfInitialized: mock(() => null),
    startPurgeTimer: mock(() => {}),
    onMessages: mock(() => {}),
    onProcessing: mock(() => {}),
    onSessionCreated: mock(() => {}),
    onFinished: mock(() => {}),
    onFailed: mock(() => {}),
  };
  const claude = {
    startClaudeCliSession: mock(() => Promise.resolve()),
    runClaudeTurn: mock(() => Promise.resolve()),
    isClaudeInternalSessionRunning: mock(() => false),
    abortClaudeInternalSession: mock(() => false),
    getRunningClaudeInternalSessions: mock(() => []),
    startPurgeTimer: mock(() => {}),
    onMessages: mock(() => {}),
    onProcessing: mock(() => {}),
    onSessionCreated: mock(() => {}),
    onFinished: mock(() => {}),
    onFailed: mock(() => {}),
  };
  const codex = {
    startSession: mock(() => Promise.resolve({ providerSessionId: 'codex-session', nativePath: null })),
    runTurn: mock(() => Promise.resolve()),
    isRunning: mock(() => false),
    abort: mock(() => false),
    getRunningSessions: mock(() => []),
    startPurgeTimer: mock(() => {}),
    onMessages: mock(() => {}),
    onProcessing: mock(() => {}),
    onSessionCreated: mock(() => {}),
    onFinished: mock(() => {}),
    onFailed: mock(() => {}),
  };
  const amp = {
    startSession: mock(() => Promise.resolve({ providerSessionId: 'amp-session', nativePath: 'amp:amp-session' })),
    runTurn: mock(() => Promise.resolve()),
    isRunning: mock(() => false),
    abort: mock(() => false),
    getRunningSessions: mock(() => []),
    startPurgeTimer: mock(() => {}),
    onMessages: mock(() => {}),
    onProcessing: mock(() => {}),
    onSessionCreated: mock(() => {}),
    onFinished: mock(() => {}),
    onFailed: mock(() => {}),
  };
  const factory = {
    startSession: mock(() => Promise.resolve({ providerSessionId: 'factory-session', nativePath: 'factory:factory-session' })),
    runTurn: mock(() => Promise.resolve()),
    getRunningSessions: mock(() => []),
    isRunning: mock(() => false),
    abort: mock(() => false),
    getModels: mock(() => []),
    startPurgeTimer: mock(() => {}),
    onMessages: mock(() => {}),
    onProcessing: mock(() => {}),
    onSessionCreated: mock(() => {}),
    onFinished: mock(() => {}),
    onFailed: mock(() => {}),
  };

  return {
    registry: new ProviderRegistry({
      registry: mockRegistry,
      adapters: [
        createClaudeAdapter(claude),
        createCodexAdapter(codex),
        createOpenCodeAdapter(opencode),
        createAmpAdapter(amp),
        createFactoryAdapter(factory),
        ...(args.adapters ?? []),
      ],
      endpointResolver: args.endpointResolver ?? makeEndpointResolver(),
      apiProviderStore: args.apiProviderStore ?? makeApiProviderStore(),
      opencodeInstance: opencode,
    }),
    mockRegistry,
    claude,
    codex,
    opencode,
    amp,
    factory,
  };
}

describe('ProviderRegistry.runSingleQuery', () => {
  beforeEach(() => {
    claudeQuery.mockClear();
    codexQuery.mockClear();
    ampQuery.mockClear();
    factoryQuery.mockClear();
  });

  it('routes one-shot prompts to native harness adapters', async () => {
    const { registry, opencode } = makeRegistry();

    expect(await registry.runSingleQuery('prompt', {})).toBe('claude-response');
    expect(await registry.runSingleQuery('prompt', { provider: 'codex' })).toBe('codex-response');
    expect(await registry.runSingleQuery('prompt', { provider: 'opencode' })).toBe('opencode-response');
    expect(await registry.runSingleQuery('prompt', { provider: 'amp' })).toBe('amp-response');
    expect(await registry.runSingleQuery('prompt', { provider: 'factory' })).toBe('factory-response');
    expect(opencode.runSingleQuery).toHaveBeenCalled();
  });

  it('resolves API-provider model selections before one-shot execution', async () => {
    const endpointResolver = makeEndpointResolver();
    const codexConfig = {
      config: {
        model_provider: 'garcon_acme_openai',
        model_providers: {
          garcon_acme_openai: {
            name: 'Acme',
            base_url: 'https://api.acme.test/v1',
            wire_api: 'responses',
            requires_openai_auth: false,
            supports_websockets: false,
          },
        },
      },
    };
    endpointResolver.resolveSelection.mockImplementation(({ model, apiProviderId = null, modelEndpointId = null }) => ({
      model: modelEndpointId ? model.replace(`${modelEndpointId}:`, '') : model,
      apiProviderId,
      endpointId: modelEndpointId,
      protocol: modelEndpointId ? 'openai-chat-completions' : null,
      isLocal: false,
      envOverrides: undefined,
      codexConfig,
    }));
    const { registry } = makeRegistry({ endpointResolver });

    await registry.runSingleQuery('hello', {
      provider: 'codex',
      model: 'acme_openai:acme-code',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
    });

    expect(endpointResolver.resolveSelection).toHaveBeenCalledWith({
      harnessId: 'codex',
      model: 'acme_openai:acme-code',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
    });
    expect(codexQuery).toHaveBeenCalledWith('hello', {
      model: 'acme-code',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
      modelProtocol: 'openai-chat-completions',
      codexConfig,
    });
  });
});

describe('ProviderRegistry catalog and API provider mutations', () => {
  it('returns harness and API provider catalog entries', async () => {
    const endpointOption = {
      value: 'acme_openai:acme-code',
      label: 'Acme: Acme Code',
      apiProviderId: 'acme',
      endpointId: 'acme_openai',
      rawModel: 'acme-code',
      protocol: 'openai-chat-completions',
    };
    const anthropicEndpointOption = {
      value: 'acme_anthropic:acme-sonnet',
      label: 'Acme: Acme Sonnet',
      apiProviderId: 'acme',
      endpointId: 'acme_anthropic',
      rawModel: 'acme-sonnet',
      protocol: 'anthropic-messages',
    };
    const apiProvider = {
      id: 'acme',
      label: 'Acme',
      templateId: 'custom',
      createdAt: '2026-05-04T00:00:00.000Z',
      updatedAt: '2026-05-04T00:00:00.000Z',
      endpoints: [],
    };
    const { registry } = makeRegistry({
      endpointResolver: makeEndpointResolver({
        codex: [endpointOption],
        'direct-openai-compatible': [endpointOption],
        'direct-anthropic-compatible': [anthropicEndpointOption],
      }),
      apiProviderStore: makeApiProviderStore([apiProvider]),
      adapters: [
        {
          id: 'direct-openai-compatible',
          label: 'Direct Chat (OpenAI)',
          startSession: mock(),
          runTurn: mock(),
          abort: mock(),
          isRunning: mock(() => false),
          getRunningSessions: mock(() => []),
          getModels: mock(() => [{ value: 'raw-openai', label: 'Raw OpenAI' }]),
          onMessages: mock(),
          onProcessing: mock(),
          onSessionCreated: mock(),
          onFinished: mock(),
          onFailed: mock(),
        },
        {
          id: 'direct-anthropic-compatible',
          label: 'Direct Chat (Anthropic)',
          startSession: mock(),
          runTurn: mock(),
          abort: mock(),
          isRunning: mock(() => false),
          getRunningSessions: mock(() => []),
          getModels: mock(() => [{ value: 'raw-anthropic', label: 'Raw Anthropic' }]),
          onMessages: mock(),
          onProcessing: mock(),
          onSessionCreated: mock(),
          onFinished: mock(),
          onFailed: mock(),
        },
      ],
    });

    const catalog = await registry.getHarnessCatalog();
    expect(catalog.harnesses.find((entry) => entry.id === 'codex')?.models).toContainEqual(endpointOption);
    expect(catalog.harnesses.find((entry) => entry.id === 'direct-openai-compatible')?.models).toEqual([endpointOption]);
    expect(catalog.harnesses.find((entry) => entry.id === 'direct-anthropic-compatible')?.models).toEqual([anthropicEndpointOption]);
    expect(catalog.apiProviders).toEqual([apiProvider]);
  });

  it('normalizes API provider payloads before storing them', async () => {
    const apiProviderStore = makeApiProviderStore();
    const { registry } = makeRegistry({ apiProviderStore });

    const created = await registry.createApiProvider({
      templateId: 'custom',
      label: ' Acme ',
      endpoint: {
        protocol: 'openai-chat-completions',
        baseUrl: 'api.acme.test/v1/',
        apiKey: 'sk-test',
        exposeTo: ['codex'],
        defaultModel: 'acme-code',
        models: [{ value: ' acme-code ', label: ' Acme Code ', supportsImages: false }],
        supportsImages: false,
      },
    });

    expect(apiProviderStore.createApiProvider).toHaveBeenCalledWith({
      templateId: 'custom',
      label: 'Acme',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://api.acme.test/v1',
      apiKey: 'sk-test',
      exposeTo: ['codex'],
      defaultModel: 'acme-code',
      models: [{ value: 'acme-code', label: 'Acme Code', supportsImages: false }],
      supportsImages: false,
      modelDiscovery: 'openai-models',
    });
    expect(created.endpoints[0].hasApiKey).toBe(true);
    expect('apiKey' in created.endpoints[0]).toBe(false);
  });

  it('rejects API provider payloads with incompatible exposure targets', async () => {
    const apiProviderStore = makeApiProviderStore();
    const { registry } = makeRegistry({ apiProviderStore });

    await expect(registry.createApiProvider({
      templateId: 'custom',
      label: 'Acme',
      endpoint: {
        protocol: 'openai-chat-completions',
        baseUrl: 'https://api.acme.test/v1',
        exposeTo: ['codex', 'claude'],
        defaultModel: 'acme-code',
        models: [],
        supportsImages: false,
      },
    })).rejects.toThrow('OpenAI-compatible harnesses');
    expect(apiProviderStore.createApiProvider).not.toHaveBeenCalled();
  });

  it('discovers OpenAI-compatible models from the configured API base path', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      data: [{ id: 'glm-5.1', name: 'GLM-5.1' }],
    })));
    const { registry } = makeRegistry();

    const result = await registry.discoverApiProviderModels({
      protocol: 'openai-chat-completions',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'sk-zai',
      modelDiscovery: 'openai-models',
    });

    expect(result).toEqual({
      success: true,
      models: [{ value: 'glm-5.1', label: 'GLM-5.1' }],
    });
    const [url, options] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.z.ai/api/coding/paas/v4/models');
    expect(options.headers).toEqual({ Authorization: 'Bearer sk-zai' });
  });

  it('discovers Anthropic-compatible models with Anthropic headers', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      data: [{ id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' }],
      has_more: false,
      last_id: 'claude-sonnet-4-20250514',
    })));
    const { registry } = makeRegistry();

    const result = await registry.discoverApiProviderModels({
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant',
      modelDiscovery: 'anthropic-models',
    });

    expect(result).toEqual({
      success: true,
      models: [{ value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' }],
    });
    const [url, options] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(options.headers).toEqual({
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
    });
  });

  it('uses the stored endpoint key when editing and no replacement key is provided', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      data: [{ id: 'acme-code' }],
    })));
    const apiProviderStore = makeApiProviderStore([{
      id: 'acme',
      label: 'Acme',
      templateId: 'custom',
      createdAt: '2026-05-04T00:00:00.000Z',
      updatedAt: '2026-05-04T00:00:00.000Z',
      endpoints: [{
        id: 'acme_openai',
        protocol: 'openai-chat-completions',
        baseUrl: 'https://api.acme.test/v1',
        apiKey: 'sk-stored',
        exposeTo: ['codex'],
        defaultModel: 'acme-code',
        models: [{ value: 'acme-code', label: 'Acme Code' }],
        supportsImages: false,
        modelDiscovery: 'openai-models',
      }],
    }]);
    const { registry } = makeRegistry({ apiProviderStore });

    await registry.discoverApiProviderModels({
      protocol: 'openai-chat-completions',
      baseUrl: 'https://api.acme.test/v1',
      endpointId: 'acme_openai',
      modelDiscovery: 'openai-models',
    });

    const [, options] = globalThis.fetch.mock.calls[0];
    expect(options.headers).toEqual({ Authorization: 'Bearer sk-stored' });
  });
});

describe('ProviderRegistry session option hydration', () => {
  it('hydrates execution modes from the registry on new-session startup', async () => {
    const { registry, opencode } = makeRegistry({
      registry: {
        getChat: mock(() => ({
          provider: 'opencode',
          projectPath: '/proj',
          model: 'openai/gpt-5',
          permissionMode: 'bypassPermissions',
          thinkingMode: 'think-hard',
        })),
      },
    });

    await registry.startSession('123', 'hello', {});

    expect(opencode.startSession).toHaveBeenCalledWith({
      command: 'hello',
      projectPath: '/proj',
      model: 'openai/gpt-5',
      permissionMode: 'bypassPermissions',
      thinkingMode: 'think-hard',
      claudeThinkingMode: 'auto',
      images: undefined,
      chatId: '123',
    });
  });

  it('stores API provider selection metadata after session startup', async () => {
    const endpointResolver = makeEndpointResolver();
    const { registry, mockRegistry } = makeRegistry({
      endpointResolver,
      registry: {
        getChat: mock(() => ({
          provider: 'codex',
          projectPath: '/proj',
          model: 'acme_openai:acme-code',
          apiProviderId: 'acme',
          modelEndpointId: 'acme_openai',
          permissionMode: 'default',
          thinkingMode: 'none',
        })),
      },
    });

    await registry.startSession('123', 'hello', {});

    expect(mockRegistry.updateChat).toHaveBeenCalledWith('123', {
      providerSessionId: 'codex-session',
      nativePath: null,
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
      modelProtocol: 'openai-chat-completions',
    });
  });
});
