import { describe, expect, it, mock } from 'bun:test';
import { AssistantMessage, UserMessage } from '@garcon/common/chat-types';
import { renderTranscriptSeed } from '@garcon/common/transcript-seed';
import { AgentEventEmitterRuntime } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { CodexExecution } from '../execution.ts';

function createRuntime() {
  const runtime = new AgentEventEmitterRuntime();
  runtime.startSession = mock(async (request) => {
    request.executionAdmission?.markStarted();
    request.onAbortable?.();
    return { agentSessionId: 'thread-1', nativePath: '/tmp/thread-1.jsonl' };
  });
  runtime.runTurn = mock(async () => undefined);
  runtime.submitActiveInput = mock(async () => true);
  runtime.compact = mock(async () => undefined);
  runtime.abort = mock(async () => false);
  runtime.isRunning = mock(() => false);
  runtime.getRunningSessions = mock(() => []);
  runtime.updateSessionSettings = mock(() => undefined);
  runtime.resolvePermission = mock(async () => undefined);
  return runtime;
}

function createHost() {
  return {
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
    operation: {
      commandType: 'chat-start',
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    },
    admission: {
      signal: new AbortController().signal,
      markStarted: mock(() => undefined),
      markAbortable: mock(() => undefined),
    },
    prompt: 'hello',
    attachments: [],
    carryOver: [],
    ...overrides,
  };
}

function activeInputRequest(operation, beforeDelivery = async () => undefined) {
  return startRequest({
    agentSessionId: 'thread-1',
    nativeSession: {
      ownerId: 'codex',
      schemaVersion: 1,
      value: { path: '/tmp/thread-1.jsonl', agentSessionId: 'thread-1' },
    },
    operation,
    beforeDelivery,
    carryOver: undefined,
  });
}

describe('CodexExecution', () => {
  it('preserves admission, endpoint configuration, session identity, and event identity', async () => {
    const runtime = createRuntime();
    const host = createHost();
    const execution = new CodexExecution(
      host,
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const events = [];
    execution.subscribe((event) => events.push(event));
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

    await expect(execution.start(request)).resolves.toEqual({
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
    });
    expect(request.admission.markStarted).toHaveBeenCalledTimes(1);
    expect(request.admission.markAbortable).toHaveBeenCalledTimes(1);
    expect(runtime.startSession).toHaveBeenCalledWith(expect.objectContaining({
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      turnId: 'turn-1',
      envOverrides: { CODEX_HOME: '/tmp/codex-home' },
      codexConfig: expect.objectContaining({
        env: { GARCON_CODEX_PROVIDER_API_KEY_ENDPOINT_1: 'secret' },
      }),
    }));

    runtime.emitMessages('chat-1', [
      new AssistantMessage('2026-07-19T00:00:00.000Z', 'done'),
    ], { clientRequestId: 'request-1', turnId: 'turn-1' });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'messages',
      chatId: 'chat-1',
      operation: request.operation,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'session-created',
      chatId: 'chat-1',
      operation: request.operation,
    }));
  });

  it('keeps carried context separate when starting a Codex goal', async () => {
    const runtime = createRuntime();
    const execution = new CodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const carryOver = [new UserMessage('2026-07-19T00:00:00.000Z', 'earlier')];

    await execution.start(startRequest({
      prompt: '/goal ship the migration',
      carryOver,
    }));

    expect(runtime.startSession).toHaveBeenCalledWith(expect.objectContaining({
      command: 'ship the migration',
      codexGoalCommand: { kind: 'set', objective: 'ship the migration' },
      codexSeedContext: renderTranscriptSeed(carryOver),
    }));
  });

  it('rejects goal controls that cannot start a new thread', async () => {
    const execution = new CodexExecution(
      createHost(),
      createRuntime(),
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );

    await expect(execution.start(startRequest({ prompt: '/goal clear' })))
      .rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
  });

  for (const outcome of ['decline', 'failure']) {
    it(`keeps the predecessor operation visible when active input has a pre-boundary ${outcome}`, async () => {
      const runtime = createRuntime();
      const execution = new CodexExecution(
        createHost(),
        runtime,
        createPathNativeSessionCodec('codex'),
        createConfig(),
      );
      const predecessor = startRequest().operation;
      const successor = { ...predecessor, clientRequestId: 'request-2', turnId: 'turn-2' };
      const next = { ...predecessor, clientRequestId: 'request-3', turnId: 'turn-3' };
      const events = [];
      execution.subscribe((event) => events.push(event));
      await execution.start(startRequest());
      runtime.submitActiveInput.mockImplementation(async () => {
        runtime.emitFinished('chat-1', 0, {
          clientRequestId: predecessor.clientRequestId,
          turnId: predecessor.turnId,
        });
        if (outcome === 'failure') throw new Error('failed before delivery boundary');
        return false;
      });

      const activeInput = execution.submitActiveInput(activeInputRequest(successor));
      if (outcome === 'failure') await expect(activeInput).rejects.toThrow('failed before delivery boundary');
      else await expect(activeInput).resolves.toBe(false);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'finished',
        operation: predecessor,
      }));

      await execution.resume(activeInputRequest(next));
      expect(runtime.runTurn).toHaveBeenCalledOnce();
    });
  }

  it('retains successor ownership after a post-boundary delivery failure', async () => {
    const runtime = createRuntime();
    const execution = new CodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const predecessor = startRequest().operation;
    const successor = { ...predecessor, clientRequestId: 'request-2', turnId: 'turn-2' };
    const events = [];
    execution.subscribe((event) => events.push(event));
    await execution.start(startRequest());
    runtime.submitActiveInput.mockImplementation(async (_request, beforeDelivery) => {
      await beforeDelivery();
      throw new Error('delivery outcome unknown');
    });

    await expect(execution.submitActiveInput(activeInputRequest(successor)))
      .rejects.toThrow('delivery outcome unknown');
    runtime.emitFailed('chat-1', 'delivery failed', {
      clientRequestId: successor.clientRequestId,
      turnId: successor.turnId,
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'failed',
      operation: successor,
    }));
  });
});
