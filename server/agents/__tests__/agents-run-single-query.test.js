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

mock.module('../claude/history-loader.js', () => ({
  getClaudePreviewFromNativePath: mock(() => Promise.resolve(null)),
  loadClaudeChatMessages: mock(() => Promise.resolve([])),
}));

mock.module('../codex/history-loader.js', () => ({
  getCodexPreviewFromNativePath: mock(() => Promise.resolve(null)),
  loadCodexChatMessages: mock(() => Promise.resolve([])),
}));

mock.module('../opencode/history-loader.js', () => ({
  getOpenCodePreviewFromSessionId: mock(() => Promise.resolve(null)),
  loadOpenCodeChatMessages: mock(() => Promise.resolve([])),
}));

mock.module('../factory/history-loader.js', () => ({
  getFactoryPreviewFromSessionId: mock(() => Promise.resolve(null)),
  loadFactoryChatMessagesBySessionId: mock(() => Promise.resolve([])),
}));

mock.module('../direct/history-loader.js', () => ({
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
    })),
    resolveEndpointReference: mock(() => null),
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
    startSession: mock(() => Promise.resolve({ agentSessionId: 'session', nativePath: null })),
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

function agentFromRuntime(id, label, runtime, capabilities, runSingleQuery, prepareEndpointRuntime) {
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
    ...(prepareEndpointRuntime ? { prepareEndpointRuntime } : {}),
    ...(runSingleQuery ? { runSingleQuery } : {}),
  };
}

function makeRegistry(args = {}) {
  const mockRegistry = {
    getChat: mock(() => null),
    getChatByAgentSessionId: mock(() => null),
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
    startSession: mock(() => Promise.resolve({ agentSessionId: 'codex-session', nativePath: null })),
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
    startSession: mock(() => Promise.resolve({ agentSessionId: 'amp-session', nativePath: 'amp:amp-session' })),
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
    startSession: mock(() => Promise.resolve({ agentSessionId: 'cursor-session', nativePath: '!cursor:cursor-session' })),
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
    startSession: mock(() => Promise.resolve({ agentSessionId: 'factory-session', nativePath: 'factory:factory-session' })),
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
    startSession: mock(() => Promise.resolve({ agentSessionId: 'pi-session', nativePath: '/tmp/pi-session.jsonl' })),
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
        }, claudeQuery, args.prepareEndpointRuntimeByAgentId?.claude),
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
        }, codexQuery, args.prepareEndpointRuntimeByAgentId?.codex),
        agentFromRuntime('opencode', 'OpenCode', baseRuntime({
          async startSession(request) {
            const agentSessionId = await opencode.startSession(request);
            return { agentSessionId, nativePath: `opencode:${agentSessionId}` };
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
        }, opencode.runSingleQuery, args.prepareEndpointRuntimeByAgentId?.opencode),
        agentFromRuntime('amp', 'Amp', amp, {
          supportsFork: false,
          supportsImages: false,
          acceptsApiProviderEndpoints: false,
          supportedProtocols: [],
          authLoginSupported: false,
        }, ampQuery, args.prepareEndpointRuntimeByAgentId?.amp),
        agentFromRuntime('cursor', 'Cursor', cursor, {
          supportsFork: false,
          supportsImages: false,
          acceptsApiProviderEndpoints: false,
          supportedProtocols: [],
          authLoginSupported: false,
        }, cursorQuery, args.prepareEndpointRuntimeByAgentId?.cursor),
        agentFromRuntime('factory', 'Factory', factory, {
          supportsFork: false,
          supportsImages: false,
          acceptsApiProviderEndpoints: false,
          supportedProtocols: [],
          authLoginSupported: false,
        }, factoryQuery, args.prepareEndpointRuntimeByAgentId?.factory),
        agentFromRuntime('pi', 'Pi', pi, {
          supportsFork: false,
          supportsImages: false,
          acceptsApiProviderEndpoints: false,
          supportedProtocols: [],
          authLoginSupported: false,
        }, piQuery, args.prepareEndpointRuntimeByAgentId?.pi),
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
    expect(await registry.runSingleQuery('prompt', { agentId: 'codex' })).toBe('codex-response');
    expect(await registry.runSingleQuery('prompt', { agentId: 'opencode' })).toBe('opencode-response');
    expect(await registry.runSingleQuery('prompt', { agentId: 'amp' })).toBe('amp-response');
    expect(await registry.runSingleQuery('prompt', { agentId: 'cursor' })).toBe('cursor-response');
    expect(await registry.runSingleQuery('prompt', { agentId: 'factory' })).toBe('factory-response');
    expect(await registry.runSingleQuery('prompt', { agentId: 'pi' })).toBe('pi-response');
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
    }));
    endpointResolver.resolveEndpointReference.mockReturnValue({
      apiProvider: { id: 'acme', label: 'Acme', endpoints: [] },
      endpoint: { id: 'acme_openai', protocol: 'openai-compatible' },
    });
    const prepareEndpointRuntime = mock(() => ({ codexConfig }));
    const { registry } = makeRegistry({
      endpointResolver,
      prepareEndpointRuntimeByAgentId: { codex: prepareEndpointRuntime },
    });

    await registry.runSingleQuery('hello', {
      agentId: 'codex',
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
    expect(prepareEndpointRuntime).toHaveBeenCalled();
  });
});

describe('AgentRegistry catalog', () => {
  it('returns agent catalog entries', async () => {
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
    const { registry } = makeRegistry({
      endpointResolver: makeEndpointResolver({
        codex: [endpointOption],
        'direct-openai-compatible': [endpointOption],
        'direct-openai-responses-compatible': [endpointOption],
        'direct-anthropic-compatible': [anthropicEndpointOption],
      }),
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

    const catalog = await registry.getAgentCatalogEntries();
    expect(catalog.find((entry) => entry.id === 'codex')?.models).toContainEqual(endpointOption);
    expect(catalog.find((entry) => entry.id === 'direct-openai-compatible')?.models).toEqual([endpointOption]);
    expect(catalog.find((entry) => entry.id === 'direct-openai-responses-compatible')?.models).toEqual([endpointOption]);
    expect(catalog.find((entry) => entry.id === 'direct-anthropic-compatible')?.models).toEqual([anthropicEndpointOption]);
  });

  it('uses Cursor discovered models without static fallbacks', async () => {
    const { registry, cursor } = makeRegistry();
    cursor.getModels.mockReturnValueOnce([{ value: 'auto', label: 'Auto', supportsImages: false }]);

    const catalog = await registry.getAgentCatalogEntries();
    const cursorEntry = catalog.find((entry) => entry.id === 'cursor');

    expect(cursorEntry?.models).toEqual([{ value: 'auto', label: 'Auto', supportsImages: false }]);
    expect(cursorEntry?.defaultModel).toBe('auto');
  });

});

describe('AgentRegistry session option hydration', () => {
  it('hydrates execution modes from the registry on new-session startup', async () => {
    const { registry, opencode } = makeRegistry({
      registry: {
        getChat: mock(() => ({
          agentId: 'opencode',
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
          agentId: 'codex',
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
      agentSessionId: 'codex-session',
      nativePath: null,
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
      modelProtocol: 'openai-compatible',
    });
  });
});
