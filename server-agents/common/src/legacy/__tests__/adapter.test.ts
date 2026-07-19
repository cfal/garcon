import { describe, expect, mock, test } from 'bun:test';
import type {
  AgentHost,
  AgentTranscriptSearch,
} from '@garcon/server-agent-interface';
import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { Agent } from '../types.js';
import { createLegacyAgentIntegration } from '../adapter.js';

const endpoint: AgentEndpointSelection = {
  apiProviderId: 'provider-1',
  endpointId: 'endpoint-1',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.test/v1',
  model: 'model-1',
  isLocal: false,
  credential: {
    kind: 'api-provider-endpoint',
    apiProviderId: 'provider-1',
    endpointId: 'endpoint-1',
  },
};

function createHost(): AgentHost {
  const noop = () => {};
  return {
    agentId: 'test-agent',
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    storage: {
      rootDirectory: '/tmp/test-agent',
      async directory(namespace) { return `/tmp/test-agent/${namespace}`; },
    },
    environment: { get: () => undefined },
    apiProviders: {
      async resolveCredential() { return { kind: 'api-key', value: 'secret-key' }; },
    },
    carryOver: {
      async load(request) { return { revision: request.expectedRevision, messages: [] }; },
    },
  };
}

function createSearch(): AgentTranscriptSearch {
  const status = {
    indexedChatCount: 0,
    pendingChatCount: 0,
    failedChatCount: 0,
    unsupportedChatCount: 0,
  };
  return {
    async reconcile() {},
    async search() { return { hits: [], index: status }; },
    async status() { return status; },
    async disableAndDelete() {},
  };
}

function createAgent(overrides: Partial<Agent> = {}): Agent {
  const noop = () => {};
  return {
    id: 'test-agent',
    label: 'Test Agent',
    runtime: {
      async startSession() { return { agentSessionId: 'session-1', nativePath: '/tmp/session-1.jsonl' }; },
      async runTurn() {},
      abort: () => false,
      isRunning: () => false,
      getRunningSessions: () => [],
      onMessages: noop,
      onProcessing: noop,
      onSessionCreated: noop,
      onFinished: noop,
      onFailed: noop,
    },
    transcript: { async loadMessages() { return []; } },
    auth: { async getAuthStatus() { return {}; } },
    capabilities: {
      supportsFork: false,
      supportsForkAtMessage: false,
      supportsForkWhileRunning: false,
      supportsUpdateProjectPath: false,
      requiresNativePathForProjectPathUpdate: false,
      supportsImages: false,
      acceptsApiProviderEndpoints: true,
      supportedProtocols: ['openai-compatible'],
      authLoginSupported: false,
      requiresStrictModelDiscovery: false,
    },
    ...overrides,
  };
}

function createIntegration(agent: Agent, onEndpointSelection = mock(() => {})) {
  return {
    integration: createLegacyAgentIntegration({
      host: createHost(),
      descriptor: {
        id: 'test-agent',
        label: 'Test Agent',
        icon: null,
        supportedPermissionModes: ['default'],
        supportedThinkingModes: ['none'],
        supportsImages: false,
        supportsProjectPathUpdate: false,
        requiresNativePathForProjectPathUpdate: false,
        supportedEndpointProtocols: ['openai-compatible'],
        configuration: [],
      },
      agent,
      transcriptSearch: createSearch(),
      defaultModel: 'model-1',
      onEndpointSelection,
    }),
    onEndpointSelection,
  };
}

describe('legacy integration adapter endpoint ownership', () => {
  test('prepares endpoint-backed single queries through the integration boundary', async () => {
    const runSingleQuery = mock(async () => 'result');
    const { integration, onEndpointSelection } = createIntegration(createAgent({ runSingleQuery }));

    await expect(integration.singleQuery!.run({
      prompt: 'generate',
      projectPath: '/tmp/project',
      model: 'model-1',
      settings: integration.settings.defaults(),
      endpoint,
      signal: new AbortController().signal,
    })).resolves.toBe('result');

    expect(onEndpointSelection).toHaveBeenCalledWith(endpoint, 'secret-key');
    expect(runSingleQuery).toHaveBeenCalledWith('generate', expect.objectContaining({
      apiProviderId: 'provider-1',
      modelEndpointId: 'endpoint-1',
      modelProtocol: 'openai-compatible',
    }));
  });

  test('rehydrates transcript endpoint identity from the opaque native session', async () => {
    const loadMessages = mock(async () => []);
    const { integration } = createIntegration(createAgent({
      transcript: { loadMessages },
    }));
    const signal = new AbortController().signal;
    const started = await integration.execution.start({
      chatId: 'chat-1',
      projectPath: '/tmp/project',
      model: 'model-1',
      permissionMode: 'default',
      thinkingMode: 'none',
      settings: integration.settings.defaults(),
      endpoint,
      operation: {
        commandType: 'chat-start',
        clientRequestId: 'request-1',
        clientMessageId: 'message-1',
        turnId: 'turn-1',
      },
      admission: { signal, markStarted() {}, markAbortable() {} },
      prompt: 'hello',
      attachments: [],
      carryOver: [],
    });

    expect(started.nativeSession?.value).toEqual({
      path: '/tmp/session-1.jsonl',
      agentSessionId: 'session-1',
      modelEndpointId: 'endpoint-1',
    });
    await integration.transcript.load({
      chat: {
        chatId: 'chat-1',
        agentId: 'test-agent',
        agentSessionId: 'session-1',
        projectPath: '/tmp/project',
        model: 'model-1',
        nativeSession: started.nativeSession,
        carryOverRevision: 'carry-over-1',
        settings: integration.settings.defaults(),
      },
      signal,
    });
    expect(loadMessages).toHaveBeenCalledWith(expect.objectContaining({
      modelEndpointId: 'endpoint-1',
      nativePath: '/tmp/session-1.jsonl',
    }), { chatId: 'chat-1' });
  });

  test('migrates the legacy endpoint identity into integration-owned state', async () => {
    const { integration } = createIntegration(createAgent());

    await expect(integration.migration.translateLegacyNativeSession({
      chatId: 'chat-1',
      projectPath: '/tmp/project',
      model: 'model-1',
      agentSessionId: 'session-1',
      legacyNativePath: '/tmp/session-1.jsonl',
      legacyValues: { modelEndpointId: 'endpoint-1' },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      ownerId: 'test-agent',
      schemaVersion: 1,
      value: {
        path: '/tmp/session-1.jsonl',
        agentSessionId: 'session-1',
        modelEndpointId: 'endpoint-1',
      },
    });
  });
});
