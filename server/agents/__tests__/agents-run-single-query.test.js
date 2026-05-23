import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const claudeQuery = mock(async () => 'claude-response');
const codexQuery = mock(async () => 'codex-response');
const ampQuery = mock(async () => 'amp-response');
const cursorQuery = mock(async () => 'cursor-response');
const factoryQuery = mock(async () => 'factory-response');
const piQuery = mock(async () => 'pi-response');
const originalFetch = globalThis.fetch;

mock.module('../claude/claude-cli.js', () => ({
  runSingleQuery: claudeQuery,
  createClaudeNativePath: mock(() => Promise.resolve('/tmp/claude-session.jsonl')),
}));

mock.module('../codex/app-server/run-single-query.js', () => ({
  runSingleQuery: codexQuery,
}));

mock.module('../amp/amp-cli.js', () => ({
  runSingleQuery: ampQuery,
}));

mock.module('../cursor/cursor-cli.js', () => ({
  runSingleQuery: cursorQuery,
}));

mock.module('../factory/factory-cli.js', () => ({
  runSingleQuery: factoryQuery,
}));

mock.module('../pi/pi-cli.js', () => ({
  runSingleQuery: piQuery,
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

import { AgentRegistry } from '../registry.js';
import { createAgentCapabilities } from '../../agents/capabilities.js';

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeEndpointResolver(endpointOptions = {}) {
  return {
    getModelOptions: mock((agentId) => endpointOptions[agentId] ?? []),
    resolveSelection: mock(({ model, apiProviderId = null, modelEndpointId = null }) => ({
      model: modelEndpointId ? model.replace(`${modelEndpointId}:`, '') : model,
      apiProviderId,
      endpointId: modelEndpointId,
      protocol: modelEndpointId ? 'openai-compatible' : null,
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
        capabilities: input.capabilities,
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

function baseRuntime(overrides = {}) {
  return {
    startSession: mock(() => Promise.resolve({ providerSessionId: 'session', nativePath: null })),
    runTurn: mock(() => Promise.resolve()),
    abort: mock(() => false),
    isRunning: mock(() => false),
    getRunningSessions: mock(() => []),
    startPurgeTimer: mock(() => {}),
    onMessages: mock(() => {}),
    onProcessing: mock(() => {}),
    onSessionCreated: mock(() => {}),
    onFinished: mock(() => {}),
    onFailed: mock(() => {}),
    ...overrides,
  };
}

function agentFromRuntime(id, label, runtime, capabilities, runSingleQuery) {
  return {
    id,
    label,
    runtime,
    transcript: {
      async loadMessages() { return []; },
      async getPreview() { return null; },
    },
    auth: {
      getAuthStatus: async () => ({
        authenticated: false,
        canReauth: false,
        label: '',
        source: 'none',
      }),
    },
    capabilities: createAgentCapabilities({
      ...capabilities,
      ...(runtime.getModels ? { getModels: () => runtime.getModels() } : {}),
    }),
    ...(runSingleQuery ? { runSingleQuery } : {}),
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
  const cursor = {
    startSession: mock(() => Promise.resolve({ providerSessionId: 'cursor-session', nativePath: '!cursor:cursor-session' })),
    runTurn: mock(() => Promise.resolve()),
    isRunning: mock(() => false),
    abort: mock(() => false),
    getRunningSessions: mock(() => []),
    getModels: mock(() => []),
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
  const pi = {
    startSession: mock(() => Promise.resolve({ providerSessionId: 'pi-session', nativePath: '/tmp/pi-session.jsonl' })),
    runTurn: mock(() => Promise.resolve()),
    getRunningSessions: mock(() => []),
    isRunning: mock(() => false),
    abort: mock(() => false),
    getModels: mock(() => [{ value: 'github-copilot/gpt-5.4', label: 'github-copilot: gpt-5.4', supportsImages: true }]),
    startPurgeTimer: mock(() => {}),
    onMessages: mock(() => {}),
    onProcessing: mock(() => {}),
    onSessionCreated: mock(() => {}),
    onFinished: mock(() => {}),
    onFailed: mock(() => {}),
  };

  return {
    registry: new AgentRegistry({
      registry: mockRegistry,
      agents: [
        agentFromRuntime('claude', 'Claude', baseRuntime(), {
          supportsFork: true,
          supportsImages: true,
          acceptsApiProviderEndpoints: true,
          supportedProtocols: ['anthropic-messages'],
          authLoginSupported: true,
        }, claudeQuery),
        agentFromRuntime('codex', 'Codex', baseRuntime({
          startSession: codex.startSession,
          runTurn: codex.runTurn,
          abort: codex.abort,
          isRunning: codex.isRunning,
          getRunningSessions: codex.getRunningSessions,
        }), {
          supportsFork: true,
          supportsImages: true,
          acceptsApiProviderEndpoints: true,
          supportedProtocols: ['openai-compatible'],
          authLoginSupported: true,
        }, codexQuery),
        agentFromRuntime('opencode', 'OpenCode', baseRuntime({
          async startSession(request) {
            const providerSessionId = await opencode.startSession(request);
            return { providerSessionId, nativePath: `opencode:${providerSessionId}` };
          },
          runTurn: opencode.runTurn,
          abort: opencode.abort,
          isRunning: opencode.isRunning,
          getRunningSessions: opencode.getRunningSessions,
          getModels: opencode.getModels,
        }), {
          supportsFork: false,
          supportsImages: false,
          acceptsApiProviderEndpoints: false,
          supportedProtocols: [],
          authLoginSupported: false,
        }, opencode.runSingleQuery),
        agentFromRuntime('amp', 'Amp', amp, {
          supportsFork: false,
          supportsImages: false,
          acceptsApiProviderEndpoints: false,
          supportedProtocols: [],
          authLoginSupported: false,
        }, ampQuery),
        agentFromRuntime('cursor', 'Cursor', cursor, {
          supportsFork: false,
          supportsImages: false,
          acceptsApiProviderEndpoints: false,
          supportedProtocols: [],
          authLoginSupported: false,
        }, cursorQuery),
        agentFromRuntime('factory', 'Factory', factory, {
          supportsFork: false,
          supportsImages: false,
          acceptsApiProviderEndpoints: false,
          supportedProtocols: [],
          authLoginSupported: false,
        }, factoryQuery),
        agentFromRuntime('pi', 'Pi', pi, {
          supportsFork: false,
          supportsImages: false,
          acceptsApiProviderEndpoints: false,
          supportedProtocols: [],
          authLoginSupported: false,
        }, piQuery),
        ...(args.agents ?? []),
      ],
      endpointResolver: args.endpointResolver ?? makeEndpointResolver(),
      apiProviderStore: args.apiProviderStore ?? makeApiProviderStore(),
    }),
    mockRegistry,
    claude,
    codex,
    opencode,
    amp,
    cursor,
    factory,
    pi,
  };
}

describe('AgentRegistry.runSingleQuery', () => {
  beforeEach(() => {
    claudeQuery.mockClear();
    codexQuery.mockClear();
    ampQuery.mockClear();
    cursorQuery.mockClear();
    factoryQuery.mockClear();
    piQuery.mockClear();
  });

  it('routes one-shot prompts to native agents', async () => {
    const { registry, opencode } = makeRegistry();

    expect(await registry.runSingleQuery('prompt', {})).toBe('claude-response');
    expect(await registry.runSingleQuery('prompt', { provider: 'codex' })).toBe('codex-response');
    expect(await registry.runSingleQuery('prompt', { provider: 'opencode' })).toBe('opencode-response');
    expect(await registry.runSingleQuery('prompt', { provider: 'amp' })).toBe('amp-response');
    expect(await registry.runSingleQuery('prompt', { provider: 'cursor' })).toBe('cursor-response');
    expect(await registry.runSingleQuery('prompt', { provider: 'factory' })).toBe('factory-response');
    expect(await registry.runSingleQuery('prompt', { provider: 'pi' })).toBe('pi-response');
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
      protocol: modelEndpointId ? 'openai-compatible' : null,
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
      agentId: 'codex',
      model: 'acme_openai:acme-code',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
    });
    expect(codexQuery).toHaveBeenCalledWith('hello', {
      model: 'acme-code',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
      modelProtocol: 'openai-compatible',
      codexConfig,
    });
  });
});

describe('AgentRegistry catalog and API provider mutations', () => {
  it('returns agent and API provider catalog entries', async () => {
    const endpointOption = {
      value: 'acme_openai:acme-code',
      label: 'Acme: Acme Code',
      apiProviderId: 'acme',
      endpointId: 'acme_openai',
      rawModel: 'acme-code',
      protocol: 'openai-compatible',
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
        'direct-openai-responses-compatible': [endpointOption],
        'direct-anthropic-compatible': [anthropicEndpointOption],
      }),
      apiProviderStore: makeApiProviderStore([apiProvider]),
      agents: [
        agentFromRuntime('direct-openai-compatible', 'Direct (Chat Completions)', baseRuntime({
          getModels: mock(() => [{ value: 'raw-openai', label: 'Raw OpenAI' }]),
        }), {
          supportsFork: false,
          supportsImages: true,
          acceptsApiProviderEndpoints: true,
          supportedProtocols: ['openai-compatible'],
          authLoginSupported: false,
        }),
        agentFromRuntime('direct-openai-responses-compatible', 'Direct (Responses)', baseRuntime({
          getModels: mock(() => [{ value: 'raw-openai-response', label: 'Raw OpenAI Response' }]),
        }), {
          supportsFork: false,
          supportsImages: true,
          acceptsApiProviderEndpoints: true,
          supportedProtocols: ['openai-compatible'],
          authLoginSupported: false,
        }),
        agentFromRuntime('direct-anthropic-compatible', 'Direct (Anthropic)', baseRuntime({
          getModels: mock(() => [{ value: 'raw-anthropic', label: 'Raw Anthropic' }]),
        }), {
          supportsFork: false,
          supportsImages: true,
          acceptsApiProviderEndpoints: true,
          supportedProtocols: ['anthropic-messages'],
          authLoginSupported: false,
        }),
      ],
    });

    const catalog = await registry.getAgentCatalog();
    expect(catalog.agents.find((entry) => entry.id === 'codex')?.models).toContainEqual(endpointOption);
    expect(catalog.agents.find((entry) => entry.id === 'direct-openai-compatible')?.models).toEqual([endpointOption]);
    expect(catalog.agents.find((entry) => entry.id === 'direct-openai-responses-compatible')?.models).toEqual([endpointOption]);
    expect(catalog.agents.find((entry) => entry.id === 'direct-anthropic-compatible')?.models).toEqual([anthropicEndpointOption]);
    expect(catalog.apiProviders).toEqual([apiProvider]);
  });

  it('uses Cursor discovered models without static fallbacks', async () => {
    const { registry, cursor } = makeRegistry();
    cursor.getModels.mockReturnValueOnce([{ value: 'auto', label: 'Auto', supportsImages: false }]);

    const catalog = await registry.getAgentCatalog();
    const cursorEntry = catalog.agents.find((entry) => entry.id === 'cursor');

    expect(cursorEntry?.models).toEqual([{ value: 'auto', label: 'Auto', supportsImages: false }]);
    expect(cursorEntry?.defaultModel).toBe('auto');
  });

  it('normalizes API provider payloads before storing them', async () => {
    const apiProviderStore = makeApiProviderStore();
    const { registry } = makeRegistry({ apiProviderStore });

    const created = await registry.createApiProvider({
      templateId: 'custom',
      label: ' Acme ',
      endpoint: {
        protocol: 'openai-compatible',
        baseUrl: 'api.acme.test/v1/',
        apiKey: 'sk-test',
        capabilities: { chatCompletions: false, responses: true },
        defaultModel: 'acme-code',
        models: [{ value: ' acme-code ', label: ' Acme Code ', supportsImages: false }],
        supportsImages: false,
      },
    });

    expect(apiProviderStore.createApiProvider).toHaveBeenCalledWith({
      templateId: 'custom',
      label: 'Acme',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.acme.test/v1',
      apiKey: 'sk-test',
      capabilities: { chatCompletions: false, responses: true },
      defaultModel: 'acme-code',
      models: [{ value: 'acme-code', label: 'Acme Code', supportsImages: false }],
      supportsImages: false,
      modelDiscovery: 'openai-models',
    });
    expect(created.endpoints[0].hasApiKey).toBe(true);
    expect('apiKey' in created.endpoints[0]).toBe(false);
  });

  it('stores Anthropic API providers without OpenAI capabilities', async () => {
    const apiProviderStore = makeApiProviderStore();
    const { registry } = makeRegistry({ apiProviderStore });

    await registry.createApiProvider({
      templateId: 'custom',
      label: 'Acme Anthropic',
      endpoint: {
        protocol: 'anthropic-messages',
        baseUrl: 'https://api.acme.test',
        apiKey: 'sk-test',
        defaultModel: 'acme-sonnet',
        models: [{ value: 'acme-sonnet', label: 'Acme Sonnet' }],
        supportsImages: false,
      },
    });

    expect(apiProviderStore.createApiProvider).toHaveBeenCalledWith({
      templateId: 'custom',
      label: 'Acme Anthropic',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.acme.test',
      apiKey: 'sk-test',
      defaultModel: 'acme-sonnet',
      models: [{ value: 'acme-sonnet', label: 'Acme Sonnet' }],
      supportsImages: false,
      modelDiscovery: 'none',
    });
  });

  it('rejects OpenAI-compatible API provider payloads with no supported API surface', async () => {
    const apiProviderStore = makeApiProviderStore();
    const { registry } = makeRegistry({ apiProviderStore });

    await expect(registry.createApiProvider({
      templateId: 'custom',
      label: 'Acme',
      endpoint: {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.acme.test/v1',
        capabilities: { chatCompletions: false, responses: false },
        defaultModel: 'acme-code',
        models: [],
        supportsImages: false,
      },
    })).rejects.toThrow('OpenAI-compatible endpoints must support Chat Completions or Responses.');
    expect(apiProviderStore.createApiProvider).not.toHaveBeenCalled();
  });

  it('discovers OpenAI-compatible models from the configured API base path', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      data: [{ id: 'glm-5.1', name: 'GLM-5.1' }],
    })));
    const { registry } = makeRegistry();

    const result = await registry.discoverApiProviderModels({
      protocol: 'openai-compatible',
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
        protocol: 'openai-compatible',
        baseUrl: 'https://api.acme.test/v1',
        apiKey: 'sk-stored',
        capabilities: { chatCompletions: false, responses: true },
        defaultModel: 'acme-code',
        models: [{ value: 'acme-code', label: 'Acme Code' }],
        supportsImages: false,
        modelDiscovery: 'openai-models',
      }],
    }]);
    const { registry } = makeRegistry({ apiProviderStore });

    await registry.discoverApiProviderModels({
      protocol: 'openai-compatible',
      baseUrl: 'https://api.acme.test/v1',
      endpointId: 'acme_openai',
      modelDiscovery: 'openai-models',
    });

    const [, options] = globalThis.fetch.mock.calls[0];
    expect(options.headers).toEqual({ Authorization: 'Bearer sk-stored' });
  });
});

describe('AgentRegistry session option hydration', () => {
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
      modelProtocol: 'openai-compatible',
    });
  });
});
