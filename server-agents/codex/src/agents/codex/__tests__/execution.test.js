import { describe, expect, it, mock } from 'bun:test';
import { AssistantMessage, UserMessage } from '@garcon/common/chat-types';
import { renderCarriedContext } from '@garcon/common/transcript-seed';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { CodexExecution } from '../execution.ts';

// Stands in for the app-server runtime, which captures the publisher on the operation that issued
// the call and routes each event by the name Codex gives it. The emit helpers drive those routes,
// so a test names the operation an event came from rather than the chat it landed in.
function createRuntime(host = createHost()) {
  const runtime = {};
  const routes = new Map();
  const capture = (request) => {
    const operation = request.operation;
    if (operation.runId) routes.set(operation.runId, operation);
  };
  const deliver = (chatId, operationId, eventType, build) => {
    const route = routes.get(operationId);
    if (!route || route.chatId !== chatId) {
      host.logger.warn('Dropped a Codex provider event with no owning operation', {
        chatId,
        runId: operationId,
        eventType,
      });
      return;
    }
    try {
      route.publish(build(route.runId));
    } catch (error) {
      host.logger.warn('Dropped a Codex provider event at an unavailable sink', {
        chatId,
        runId: route.runId,
        eventType,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };
  runtime.captureOperation = capture;
  runtime.emitRows = (chatId, operationId, messages) => deliver(chatId, operationId, 'rows', () => ({
    type: 'rows',
    rows: messages.map((message) => ({ message })),
  }));
  runtime.emitFinished = (chatId, operationId) => deliver(chatId, operationId, 'run-ended', (runId) => ({
    type: 'run-ended',
    runId,
    outcome: 'finished',
  }));
  runtime.emitFailed = (chatId, operationId, message) => deliver(chatId, operationId, 'run-ended', (runId) => ({
    type: 'run-ended',
    runId,
    outcome: 'failed',
    error: { code: 'PROVIDER_FAILURE', message },
  }));
  runtime.startSession = mock(async (request) => {
    capture(request);
    request.executionAdmission?.markStarted();
    return { agentSessionId: 'thread-1', nativePath: '/tmp/thread-1.jsonl' };
  });
  runtime.runTurn = mock(async (request) => { capture(request); });
  runtime.compact = mock(async (request) => { capture(request); });
  runtime.abort = mock(async () => false);
  runtime.isRunning = mock(() => false);
  runtime.hasSource = mock(() => false);
  runtime.getRunningSessions = mock(() => []);
  runtime.updateSessionSettings = mock(() => undefined);
  runtime.resolvePermission = mock(async () => undefined);
  return runtime;
}

function createHost() {
  return {
    agentId: 'codex',
    logger: {
      debug: mock(() => undefined),
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    },
    apiProviders: {
      resolveCredential: mock(async () => ({ kind: 'api-key', value: 'secret' })),
    },
  };
}

function createConfig() {
  return {
    codexApiKey: () => null,
    openAiApiKey: () => null,
    openAiBaseUrl: () => null,
    home: () => '/tmp/codex-home',
    packageVersion: () => '1.0.0',
  };
}

function createTestCodexExecution(host, runtime, nativeSessions, config) {
  return new CodexExecution(
    host,
    runtime,
    nativeSessions,
    config,
    async () => ({ authenticated: false, canReauth: true, label: '', kind: 'none' }),
  );
}

function startRequest(overrides = {}) {
  return {
    chatId: 'chat-1',
    projectPath: '/repo',
    model: 'gpt-5.4',
    permissionMode: 'default',
    thinkingMode: 'high',
    settings: { ownerId: 'codex', schemaVersion: 1, values: {} },
    endpoint: null,
    runId: 'run-1',
    admission: {
      signal: new AbortController().signal,
      markStarted: mock(() => undefined),
    },
    prompt: 'hello',
    attachments: [],
    carriedContext: null,
    ...overrides,
  };
}

function resumeRequest(runId) {
  return startRequest({
    agentSessionId: 'thread-1',
    nativeSession: {
      ownerId: 'codex',
      schemaVersion: 1,
      value: { path: '/tmp/thread-1.jsonl', agentSessionId: 'thread-1' },
    },
    runId,
    carriedContext: undefined,
  });
}

describe('CodexExecution', () => {
  it('preserves admission, endpoint configuration, session identity, and run correlation', async () => {
    const runtime = createRuntime();
    const execution = createTestCodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const events = [];
    const publish = (event) => events.push(event);
    const request = startRequest({
      endpoint: {
        apiProviderId: 'provider-1',
        endpointId: 'endpoint-1',
        providerLabel: 'Provider One',
        protocol: 'openai-compatible',
        baseUrl: 'https://example.test/v1',
        model: 'gpt-5.4',
        isLocal: false,
        capabilities: { chatCompletions: false, responses: true },
        headers: { 'X-Test': 'value' },
        credential: {
          kind: 'api-provider-endpoint',
          apiProviderId: 'provider-1',
          endpointId: 'endpoint-1',
        },
      },
    });

    await expect(execution.start(request, publish)).resolves.toEqual({
      agentSessionId: 'thread-1',
      nativeSession: {
        ownerId: 'codex',
        schemaVersion: 1,
        value: {
          path: '/tmp/thread-1.jsonl',
          agentSessionId: 'thread-1',
          modelEndpointId: 'endpoint-1',
        },
      },
      nativeSeedReceipt: null,
    });
    expect(request.admission.markStarted).toHaveBeenCalledTimes(1);
    expect(runtime.startSession).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({
        chatId: 'chat-1',
        runId: 'run-1',
        publish: expect.any(Function),
      }),
      envOverrides: { CODEX_HOME: '/tmp/codex-home' },
      codexConfig: expect.objectContaining({
        env: { GARCON_CODEX_PROVIDER_API_KEY_ENDPOINT_1: 'secret' },
      }),
    }));

    runtime.emitRows('chat-1', 'run-1', [
      new AssistantMessage('2026-07-19T00:00:00.000Z', 'done'),
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'rows',
      rows: [expect.objectContaining({
        message: expect.objectContaining({ content: 'done' }),
      })],
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'session',
      session: expect.objectContaining({ agentSessionId: 'thread-1' }),
    }));
  });

  it('prefixes ordinary input with carried context and records its seed receipt', async () => {
    const runtime = createRuntime();
    const execution = createTestCodexExecution(
      createHost(), runtime, createPathNativeSessionCodec('codex'), createConfig(),
    );
    const carriedContext = renderCarriedContext([
      new UserMessage('2026-07-19T00:00:00.000Z', 'Synthetic prior context'),
    ]);
    const session = await execution.start(startRequest({ carriedContext }), () => {});

    expect(runtime.startSession.mock.calls[0][0].command).toBe(`${carriedContext.prefix}hello`);
    expect(session.nativeSeedReceipt).toMatchObject({
      agentSessionId: 'thread-1', placement: 'user-prefix', codeUnitLength: carriedContext.prefix.length,
    });
  });

  it.each(['/goal Synthetic objective', '/goal status', '/goal pause'])(
    'passes %s through as ordinary prompt text', async (prompt) => {
      const runtime = createRuntime();
      const execution = createTestCodexExecution(
        createHost(), runtime, createPathNativeSessionCodec('codex'), createConfig(),
      );
      await execution.start(startRequest({ prompt }), () => {});
      await execution.resume({ ...resumeRequest('run-2'), prompt }, () => {});

      expect(runtime.startSession.mock.calls[0][0]).toMatchObject({ command: prompt });
      expect(runtime.runTurn.mock.calls[0][0]).toMatchObject({ command: prompt });
      expect(runtime.startSession.mock.calls[0][0]).not.toHaveProperty('codexGoalCommand');
      expect(runtime.runTurn.mock.calls[0][0]).not.toHaveProperty('codexGoalCommand');
    },
  );

  it('does not emit a pathless session when transcript materialization fails', async () => {
    const runtime = createRuntime();
    runtime.startSession.mockImplementation(async () => {
      throw new Error('Codex thread did not materialize transcript');
    });
    const execution = createTestCodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const events = [];
    const publish = (event) => events.push(event);

    await expect(execution.start(startRequest(), publish)).rejects.toThrow('did not materialize');
    expect(events.some((event) => event.type === 'session')).toBe(false);
  });

  it('[TLV5-L07.07-CODEX-UNIT-01] keeps the prior source route when a replacement start fails before activation', async () => {
    const host = createHost();
    const runtime = createRuntime(host);
    const execution = createTestCodexExecution(
      host,
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const priorEvents = [];
    const replacementEvents = [];
    await execution.start(startRequest(), (event) => priorEvents.push(event));
    runtime.emitFinished('chat-1', 'run-1');
    host.apiProviders.resolveCredential.mockImplementation(async () => {
      throw new Error('credential lookup failed before session activation');
    });

    await expect(execution.start(startRequest({
      runId: 'run-2',
      endpoint: {
        apiProviderId: 'provider-1',
        endpointId: 'endpoint-1',
        providerLabel: 'Provider One',
        protocol: 'openai-compatible',
        baseUrl: 'https://example.test/v1',
        model: 'gpt-5.4',
        isLocal: false,
        capabilities: { chatCompletions: false, responses: true },
        headers: {},
        credential: {
          kind: 'api-provider-endpoint',
          apiProviderId: 'provider-1',
          endpointId: 'endpoint-1',
        },
      },
    }), (event) => replacementEvents.push(event))).rejects.toThrow(
      'credential lookup failed before session activation',
    );

    runtime.emitRows('chat-1', 'run-1', [
      new AssistantMessage('2026-08-15T00:00:00.000Z', 'late prior output'),
    ]);

    expect(priorEvents).toContainEqual(expect.objectContaining({
      type: 'rows',
      rows: [expect.objectContaining({
        message: expect.objectContaining({ content: 'late prior output' }),
      })],
    }));
    expect(replacementEvents).toEqual([]);
  });

  it('[TLV5-L07.08-CODEX-UNIT-01] drops a delayed provider event at its closed originating sink after view replacement', async () => {
    const host = createHost();
    const runtime = createRuntime(host);
    const execution = createTestCodexExecution(
      host,
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const originatingEvents = [];
    const replacementEvents = [];
    let originatingSinkClosed = false;
    const originatingPublisher = (event) => {
      if (originatingSinkClosed) throw new Error('originating sink closed');
      originatingEvents.push(event);
    };
    await execution.start(startRequest(), originatingPublisher);
    originatingSinkClosed = true;
    await execution.resume(resumeRequest('run-2'), (event) => replacementEvents.push(event));
    const delayedContent = 'delayed output from the replaced view';

    expect(() => runtime.emitRows(
      'chat-1',
      'run-1',
      [new AssistantMessage('2026-08-15T00:00:00.000Z', delayedContent)],
    )).not.toThrow();

    expect(originatingEvents.filter((event) => event.type === 'rows')).toEqual([]);
    expect(replacementEvents).toEqual([]);
    expect(host.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/drop.*Codex.*event/i),
      expect.objectContaining({
        chatId: 'chat-1',
        runId: 'run-1',
        eventType: 'rows',
      }),
    );
    expect(JSON.stringify(host.logger.warn.mock.calls)).not.toContain(delayedContent);
  });

  it('forwards supported configuration changes while the provider source is live', async () => {
    const runtime = createRuntime();
    const execution = createTestCodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const previous = {
      model: 'gpt-5.4-codex',
      permissionMode: 'default',
      thinkingMode: 'medium',
      settings: { ownerId: 'codex', schemaVersion: 1, values: {} },
      endpoint: null,
    };
    const next = {
      ...previous,
      model: 'gpt-5.4-mini',
      permissionMode: 'manualBypass',
      thinkingMode: 'high',
    };

    await execution.applySessionConfiguration('thread-1', next, previous);
    expect(runtime.updateSessionSettings).not.toHaveBeenCalled();

    runtime.hasSource.mockReturnValue(true);
    await execution.applySessionConfiguration('thread-1', next, previous);
    expect(runtime.updateSessionSettings).toHaveBeenCalledWith('thread-1', {
      model: 'gpt-5.4-mini',
      permissionMode: 'manualBypass',
      thinkingMode: 'high',
    });
  });

  it('rejects clearing an explicit effort during an active turn', async () => {
    const runtime = createRuntime();
    runtime.hasSource.mockReturnValue(true);
    runtime.isRunning.mockReturnValue(true);
    const execution = createTestCodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const previous = {
      model: 'gpt-6-astra',
      permissionMode: 'default',
      thinkingMode: 'high',
      settings: { ownerId: 'codex', schemaVersion: 1, values: {} },
      endpoint: null,
    };

    await expect(execution.applySessionConfiguration('thread-1', {
      ...previous,
      thinkingMode: 'none',
    }, previous)).rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
    expect(runtime.updateSessionSettings).not.toHaveBeenCalled();
  });

  it('defers returning to provider-default effort until the retained source is replaced', async () => {
    const runtime = createRuntime();
    runtime.hasSource.mockReturnValue(true);
    const execution = createTestCodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const previous = {
      model: 'gpt-6-astra',
      permissionMode: 'default',
      thinkingMode: 'high',
      settings: { ownerId: 'codex', schemaVersion: 1, values: {} },
      endpoint: null,
    };

    await execution.applySessionConfiguration('thread-1', {
      ...previous,
      thinkingMode: 'none',
    }, previous);

    expect(runtime.isRunning).toHaveBeenCalledWith('thread-1');
    expect(runtime.updateSessionSettings).not.toHaveBeenCalled();
  });

  it('allows returning to provider-default effort after the source is gone', async () => {
    const runtime = createRuntime();
    const execution = createTestCodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const previous = {
      model: 'gpt-6-astra',
      permissionMode: 'default',
      thinkingMode: 'high',
      settings: { ownerId: 'codex', schemaVersion: 1, values: {} },
      endpoint: null,
    };

    await execution.applySessionConfiguration('thread-1', {
      ...previous,
      model: 'gpt-5.5',
      permissionMode: 'manualBypass',
      thinkingMode: 'none',
    }, previous);

    expect(runtime.hasSource).toHaveBeenCalledWith('thread-1');
    expect(runtime.isRunning).not.toHaveBeenCalled();
    expect(runtime.updateSessionSettings).not.toHaveBeenCalled();
  });

  it('switches an established GPT-6 Astra Default session to GPT-6 Sol Default', async () => {
    const runtime = createRuntime();
    runtime.hasSource.mockReturnValue(true);
    const execution = createTestCodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const previous = {
      model: 'gpt-6-astra',
      permissionMode: 'default',
      thinkingMode: 'none',
      settings: { ownerId: 'codex', schemaVersion: 1, values: {} },
      endpoint: null,
    };

    await execution.applySessionConfiguration('thread-1', {
      ...previous,
      model: 'gpt-6-sol',
    }, previous);

    expect(runtime.updateSessionSettings).toHaveBeenCalledWith('thread-1', {
      model: 'gpt-6-sol',
      permissionMode: 'default',
      thinkingMode: 'none',
    });
  });

  it.each([
    'gpt-6-luna', 'gpt-5.5', 'gpt-5.4',
    'gpt-5.6', 'gpt-5.6-sol-custom', 'gpt-5.60-sol',
  ])('allows switching from Astra Default to %s Default', async (model) => {
    const runtime = createRuntime();
    runtime.hasSource.mockReturnValue(true);
    const execution = createTestCodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const previous = {
      model: 'gpt-6-astra',
      permissionMode: 'default',
      thinkingMode: 'none',
      settings: { ownerId: 'codex', schemaVersion: 1, values: {} },
      endpoint: null,
    };

    await execution.applySessionConfiguration('thread-1', {
      ...previous,
      model,
    }, previous);
    expect(runtime.updateSessionSettings).toHaveBeenCalledWith('thread-1', {
      model,
      permissionMode: 'default',
      thinkingMode: 'none',
    });
  });

  it('rejects live endpoint replacement and concrete reasoning-effort clearing', async () => {
    const runtime = createRuntime();
    runtime.isRunning.mockReturnValue(true);
    runtime.hasSource.mockReturnValue(true);
    const execution = createTestCodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const previous = {
      model: 'gpt-5.4-codex',
      permissionMode: 'default',
      thinkingMode: 'high',
      settings: { ownerId: 'codex', schemaVersion: 1, values: {} },
      endpoint: {
        apiProviderId: 'provider-1',
        endpointId: 'endpoint-1',
        protocol: 'openai-compatible',
      },
    };

    await expect(execution.applySessionConfiguration('thread-1', {
      ...previous,
      endpoint: { ...previous.endpoint, endpointId: 'endpoint-2' },
    }, previous)).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' });
    await expect(execution.applySessionConfiguration('thread-1', {
      ...previous,
      thinkingMode: 'none',
    }, previous)).rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
    expect(runtime.updateSessionSettings).not.toHaveBeenCalled();
  });
});
