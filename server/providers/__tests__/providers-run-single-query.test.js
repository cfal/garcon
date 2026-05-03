import { beforeEach, describe, expect, it, mock } from 'bun:test';

const claudeQuery = mock(async () => 'claude-response');
const codexQuery = mock(async () => 'codex-response');
const ampQuery = mock(async () => 'amp-response');
const factoryQuery = mock(async () => 'factory-response');

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

mock.module('../loaders/openai-compatible-history-loader.js', () => ({
  getOpenAiCompatiblePreviewFromSessionId: mock(() => Promise.resolve(null)),
  loadOpenAiCompatibleChatMessages: mock(() => Promise.resolve([])),
}));

import { ProviderRegistry } from '../index.js';
import {
  createAmpAdapter,
  createClaudeAdapter,
  createCodexAdapter,
  createFactoryAdapter,
  createOpenCodeAdapter,
} from '../provider-adapters.js';

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
    const apiProvider = {
      id: 'acme',
      label: 'Acme',
      templateId: 'custom',
      createdAt: '2026-05-04T00:00:00.000Z',
      updatedAt: '2026-05-04T00:00:00.000Z',
      endpoints: [],
    };
    const { registry } = makeRegistry({
      endpointResolver: makeEndpointResolver({ codex: [endpointOption], 'direct-openai-compatible': [endpointOption] }),
      apiProviderStore: makeApiProviderStore([apiProvider]),
      adapters: [{
        id: 'direct-openai-compatible',
        label: 'Direct',
        startSession: mock(),
        runTurn: mock(),
        abort: mock(),
        isRunning: mock(() => false),
        getRunningSessions: mock(() => []),
        getModels: mock(() => [{ value: 'raw', label: 'Raw' }]),
        onMessages: mock(),
        onProcessing: mock(),
        onSessionCreated: mock(),
        onFinished: mock(),
        onFailed: mock(),
      }],
    });

    const catalog = await registry.getHarnessCatalog();
    expect(catalog.harnesses.find((entry) => entry.id === 'codex')?.models).toContainEqual(endpointOption);
    expect(catalog.harnesses.find((entry) => entry.id === 'direct-openai-compatible')?.models).toEqual([endpointOption]);
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
