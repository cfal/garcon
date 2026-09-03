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
  runtime.submitGoalControl = mock(async (request, beforeDelivery) => {
    await beforeDelivery({ validate: () => undefined, commit: () => capture(request) });
    return true;
  });
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
    openAiApiKey: () => null,
    openAiBaseUrl: () => null,
    home: () => '/tmp/codex-home',
    packageVersion: () => '1.0.0',
  };
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

async function commitHandoff(handoff) {
  handoff.validate();
  handoff.commit();
}

function goalControlRequest(runId, beforeDelivery = commitHandoff) {
  return startRequest({
    agentSessionId: 'thread-1',
    nativeSession: {
      ownerId: 'codex',
      schemaVersion: 1,
      value: { path: '/tmp/thread-1.jsonl', agentSessionId: 'thread-1' },
    },
    runId,
    beforeDelivery,
    carriedContext: undefined,
  });
}

describe('CodexExecution', () => {
  it('preserves admission, endpoint configuration, session identity, and run correlation', async () => {
    const runtime = createRuntime();
    const execution = new CodexExecution(
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

  it('does not emit a pathless session when transcript materialization fails', async () => {
    const runtime = createRuntime();
    runtime.startSession.mockImplementation(async () => {
      throw new Error('Codex thread did not materialize transcript');
    });
    const execution = new CodexExecution(
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

  it('keeps carried context separate when starting a Codex goal', async () => {
    const publish = () => {};
    const runtime = createRuntime();
    const execution = new CodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const prefix = renderCarriedContext([
      new UserMessage('2026-07-19T00:00:00.000Z', 'earlier'),
    ]).prefix;

    const started = await execution.start(startRequest({
      prompt: '/goal ship the migration',
      carriedContext: { prefix },
    }), publish);

    expect(runtime.startSession).toHaveBeenCalledWith(expect.objectContaining({
      command: 'ship the migration',
      codexGoalCommand: { kind: 'set', objective: 'ship the migration' },
      codexSeedContext: prefix,
    }));
    expect(started.nativeSeedReceipt).toMatchObject({
      agentSessionId: 'thread-1',
      placement: 'provider-context',
      format: 'v3-xml',
      codeUnitLength: prefix.length,
    });
  });

  it('rejects goal controls that cannot start a new thread', async () => {
    const publish = () => {};
    const execution = new CodexExecution(
      createHost(),
      createRuntime(),
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );

    await expect(execution.start(startRequest({ prompt: '/goal clear' }), publish))
      .rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
  });

  for (const outcome of ['decline', 'failure']) {
    it(`keeps the predecessor run active when goal control has a pre-boundary ${outcome}`, async () => {
      const runtime = createRuntime();
      const execution = new CodexExecution(
        createHost(),
        runtime,
        createPathNativeSessionCodec('codex'),
        createConfig(),
      );
      const events = [];
      const publish = (event) => events.push(event);
      await execution.start(startRequest(), publish);
      runtime.submitGoalControl.mockImplementation(async () => {
        runtime.emitFinished('chat-1', 'run-1');
        if (outcome === 'failure') throw new Error('failed before delivery boundary');
        return false;
      });

      const activeInput = execution.submitGoalControl(goalControlRequest('run-2'), publish);
      if (outcome === 'failure') await expect(activeInput).rejects.toThrow('failed before delivery boundary');
      else await expect(activeInput).resolves.toBe(false);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'run-ended',
        runId: 'run-1',
        outcome: 'finished',
      }));

      await execution.resume(goalControlRequest('run-3'), publish);
      expect(runtime.runTurn).toHaveBeenCalledOnce();
    });
  }

  it('retains successor correlation after a post-boundary delivery failure', async () => {
    const runtime = createRuntime();
    const execution = new CodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const events = [];
    const publish = (event) => events.push(event);
    await execution.start(startRequest(), publish);
    runtime.submitGoalControl.mockImplementation(async (request, beforeDelivery) => {
      await beforeDelivery({
        validate: () => undefined,
        commit: () => runtime.captureOperation(request),
      });
      throw new Error('delivery outcome unknown');
    });

    await expect(execution.submitGoalControl(goalControlRequest('run-2'), publish))
      .rejects.toThrow('delivery outcome unknown');
    runtime.emitFailed('chat-1', 'run-2', 'delivery failed');

    expect(events).toContainEqual(expect.objectContaining({
      type: 'run-ended',
      runId: 'run-2',
      outcome: 'failed',
    }));
  });

  it('changes runtime event correlation only when the goal handoff commits', async () => {
    const predecessorMessages = [];
    const rejectedMessages = [];
    const successorMessages = [];
    const collectRows = (messages) => (event) => {
      if (event.type !== 'rows') return;
      messages.push(...event.rows.map((row) => row.message.content));
    };
    const runtime = createRuntime();
    const execution = new CodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    await execution.start(startRequest(), collectRows(predecessorMessages));
    const emitOutput = (content, runId) => runtime.emitRows(
      'chat-1',
      runId,
      [new AssistantMessage('2026-07-24T00:00:00.000Z', content)],
    );
    runtime.submitGoalControl.mockImplementation(async (request, beforeDelivery) => {
      emitOutput('before delivery', 'run-1');
      await beforeDelivery({
        validate: () => undefined,
        commit: () => runtime.captureOperation(request),
      });
      emitOutput('after delivery', 'run-2');
      return true;
    });

    await expect(execution.submitGoalControl(goalControlRequest('run-rejected', async (handoff) => {
      handoff.validate();
      emitOutput('while rejected handoff validates', 'run-1');
      throw new Error('persistence failed');
    }), collectRows(rejectedMessages))).rejects.toThrow('persistence failed');
    emitOutput('after rejected handoff', 'run-1');

    await expect(execution.submitGoalControl({
      ...goalControlRequest('run-2', async (handoff) => {
        handoff.validate();
        emitOutput('while accepted handoff validates', 'run-1');
        handoff.commit();
      }),
      admission: {
        signal: new AbortController().signal,
        markStarted: mock(() => undefined),
      },
    }, collectRows(successorMessages))).resolves.toBe(true);

    expect(predecessorMessages).toEqual([
      'before delivery',
      'while rejected handoff validates',
      'after rejected handoff',
      'before delivery',
      'while accepted handoff validates',
    ]);
    expect(rejectedMessages).toEqual([]);
    expect(successorMessages).toEqual(['after delivery']);
  });

  it('[TLV5-L07.07-CODEX-UNIT-01] keeps the prior source route when a replacement start fails before activation', async () => {
    const host = createHost();
    const runtime = createRuntime(host);
    const execution = new CodexExecution(
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
    const execution = new CodexExecution(
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
    await execution.resume(goalControlRequest('run-2'), (event) => replacementEvents.push(event));
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
    const execution = new CodexExecution(
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

  it('rejects live endpoint replacement and concrete reasoning-effort clearing', async () => {
    const runtime = createRuntime();
    runtime.isRunning.mockReturnValue(true);
    runtime.hasSource.mockReturnValue(true);
    const execution = new CodexExecution(
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
