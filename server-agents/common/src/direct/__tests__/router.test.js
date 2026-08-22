import { describe, expect, it, mock } from 'bun:test';
import {
  buildDirectAnthropicConfig,
  buildDirectOpenAiConfig,
  buildDirectOpenAiResponsesConfig,
  createDirectOpenAiChatRuntime,
  createDirectOpenAiResponsesRuntime,
  DirectEndpointRouterRuntime,
} from '../router.ts';

function endpoint(overrides = {}) {
  const { credential = '', ...selection } = overrides;
  return {
    selection: {
      apiProviderId: 'example',
      endpointId: 'example_openai',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      model: 'example-model',
      isLocal: false,
      credential: null,
      ...selection,
    },
    credential,
  };
}

describe('buildDirectOpenAiConfig', () => {
  it('omits Authorization for blank-key Direct endpoints', () => {
    const config = buildDirectOpenAiConfig({
      runtimeLabel: 'Example',
      endpoint: endpoint(),
    });

    expect(config.buildHeaders?.('')).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('uses the resolved endpoint credential without retaining provider records', () => {
    const config = buildDirectOpenAiConfig({
      runtimeLabel: 'OpenRouter',
      endpoint: endpoint({
        credential: 'sk-openrouter',
      }),
    });

    expect(config.getApiKey()).toBe('sk-openrouter');
    expect(config.buildHeaders?.('sk-openrouter')).toEqual({
      Authorization: 'Bearer sk-openrouter',
      'Content-Type': 'application/json',
    });
  });
});

describe('buildDirectOpenAiResponsesConfig', () => {
  it('uses the selected Direct Responses endpoint', () => {
    const config = buildDirectOpenAiResponsesConfig({
      runtimeLabel: 'Example',
      endpoint: endpoint({
        endpointId: 'example_openai',
      }),
    });

    expect(config.getBaseUrl()).toBe('https://api.example.test/v1');
    expect(config.defaultModel).toBe('example-model');
  });
});

describe('Direct OpenAI router runtimes', () => {
  it('starts purge timers for existing and newly created endpoint runtimes', async () => {
    const endpointA = endpoint({ endpointId: 'chat_endpoint_a' });
    const endpointB = endpoint({ endpointId: 'chat_endpoint_b' });
    const runtimes = new Map();
    const createRuntime = mock((runtimeEndpoint) => {
      const runtime = {
        startSession: mock(async () => ({
          agentSessionId: `${runtimeEndpoint.selection.endpointId}_session`,
        })),
        runTurn: mock(async () => {}),
        abort: mock(() => false),
        isRunning: mock(() => false),
        forgetSession: mock(() => {}),
        getRunningSessions: mock(() => []),
        startPurgeTimer: mock(() => {}),
        shutdown: mock(() => {}),
      };
      runtimes.set(runtimeEndpoint.selection.endpointId, runtime);
      return runtime;
    });
    const router = new DirectEndpointRouterRuntime({
      label: 'Direct OpenAI',
      protocol: 'openai-compatible',
      createRuntime,
      runSingleQuery: mock(async () => ''),
    });

    router.startPurgeTimer();
    await router.startSession({
      chatId: 'chat-a',
      command: 'hello',
      projectPath: '/tmp',
      endpoint: endpointA,
    });
    router.startPurgeTimer();
    await router.startSession({
      chatId: 'chat-b',
      command: 'hello',
      projectPath: '/tmp',
      endpoint: endpointB,
    });
    router.shutdown();

    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(runtimes.get('chat_endpoint_a').startPurgeTimer).toHaveBeenCalledTimes(1);
    expect(runtimes.get('chat_endpoint_b').startPurgeTimer).toHaveBeenCalledTimes(1);
    expect(runtimes.get('chat_endpoint_a').shutdown).toHaveBeenCalledTimes(1);
    expect(runtimes.get('chat_endpoint_b').shutdown).toHaveBeenCalledTimes(1);
  });

  it('rehydrates a session whenever its endpoint route or credential changes', async () => {
    const created = [];
    const router = new DirectEndpointRouterRuntime({
      label: 'Direct OpenAI',
      protocol: 'openai-compatible',
      createRuntime: mock(() => {
        const runtime = {
          startSession: mock(async () => ({
            agentSessionId: '10000000-0000-4000-8000-000000000001',
            nativeSession: null,
          })),
          runTurn: mock(async () => {}),
          abort: mock(() => false),
          isRunning: mock(() => false),
          forgetSession: mock(() => {}),
          getRunningSessions: mock(() => []),
          startPurgeTimer: mock(() => {}),
          shutdown: mock(() => {}),
        };
        created.push(runtime);
        return runtime;
      }),
      runSingleQuery: mock(async () => ''),
    });
    const firstEndpoint = endpoint({ credential: 'first-secret' });
    const changedEndpoint = endpoint({
      credential: 'second-secret',
      baseUrl: 'https://other.example.test/v1',
    });
    const request = {
      chatId: 'chat-a',
      command: 'hello',
      projectPath: '/workspace',
      endpoint: firstEndpoint,
    };
    const started = await router.startSession(request);

    await router.runTurn({
      ...request,
      endpoint: changedEndpoint,
      agentSessionId: started.agentSessionId,
      nativeSession: null,
    });
    await router.runTurn({
      ...request,
      agentSessionId: started.agentSessionId,
      nativeSession: null,
    });

    expect(created).toHaveLength(2);
    expect(created[0].forgetSession).toHaveBeenCalledWith(started.agentSessionId);
    expect(created[1].forgetSession).toHaveBeenCalledWith(started.agentSessionId);
    expect(created[0].runTurn).toHaveBeenCalledTimes(1);
    expect(created[1].runTurn).toHaveBeenCalledTimes(1);
  });
});

describe('buildDirectAnthropicConfig', () => {
  it('uses the selected endpoint credentials', () => {
    const config = buildDirectAnthropicConfig({
      runtimeLabel: 'Example',
      endpoint: {
        selection: {
          apiProviderId: 'example',
          endpointId: 'example_anthropic',
          protocol: 'anthropic-messages',
          baseUrl: 'https://api.example.test',
          model: 'example-model',
          isLocal: false,
          credential: null,
        },
        credential: 'sk-ant',
      },
    });

    expect(config.getApiKey()).toBe('sk-ant');
    expect(config.getBaseUrl()).toBe('https://api.example.test');
    expect(config.defaultModel).toBe('example-model');
  });
});
