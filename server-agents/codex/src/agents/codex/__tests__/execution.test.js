import { describe, expect, it, mock } from 'bun:test';
import { AssistantMessage, UserMessage } from '@garcon/common/chat-types';
import { renderCarriedContext } from '@garcon/common/transcript-seed';
import { AgentEventEmitterRuntime } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { AgentEventBus } from '../../../../../../server/agents/event-bus.ts';
import { QueueExecutionAttempt } from '../../../../../../server/chat-execution/execution-attempt.ts';
import { CodexExecution } from '../execution.ts';

function createRuntime() {
  const runtime = new AgentEventEmitterRuntime();
  runtime.startSession = mock(async (request) => {
    request.executionAdmission?.markStarted();
    request.onAbortable?.();
    return { agentSessionId: 'thread-1', nativePath: '/tmp/thread-1.jsonl' };
  });
  runtime.runTurn = mock(async () => undefined);
  runtime.submitGoalControl = mock(async () => true);
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
    carriedContext: null,
    ...overrides,
  };
}

async function commitHandoff(handoff) {
  handoff.validate();
  handoff.commit();
}

function goalControlRequest(operation, beforeDelivery = commitHandoff) {
  return startRequest({
    agentSessionId: 'thread-1',
    nativeSession: {
      ownerId: 'codex',
      schemaVersion: 1,
      value: { path: '/tmp/thread-1.jsonl', agentSessionId: 'thread-1' },
    },
    operation,
    beforeDelivery,
    carriedContext: undefined,
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
      nativeSeedReceipt: null,
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
    execution.subscribe((event) => events.push(event));

    await expect(execution.start(startRequest())).rejects.toThrow('did not materialize');
    expect(events.some((event) => event.type === 'session-created')).toBe(false);
  });

  it('keeps carried context separate when starting a Codex goal', async () => {
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
    }));

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
    it(`keeps the predecessor operation visible when goal control has a pre-boundary ${outcome}`, async () => {
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
      runtime.submitGoalControl.mockImplementation(async () => {
        runtime.emitFinished('chat-1', 0, {
          clientRequestId: predecessor.clientRequestId,
          turnId: predecessor.turnId,
        });
        if (outcome === 'failure') throw new Error('failed before delivery boundary');
        return false;
      });

      const activeInput = execution.submitGoalControl(goalControlRequest(successor));
      if (outcome === 'failure') await expect(activeInput).rejects.toThrow('failed before delivery boundary');
      else await expect(activeInput).resolves.toBe(false);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'finished',
        operation: predecessor,
      }));

      await execution.resume(goalControlRequest(next));
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
    runtime.submitGoalControl.mockImplementation(async (_request, beforeDelivery) => {
      await beforeDelivery({
        validate: () => undefined,
        commit: () => undefined,
      });
      throw new Error('delivery outcome unknown');
    });

    await expect(execution.submitGoalControl(goalControlRequest(successor)))
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

  it('commits retained, routed, tracked, and runtime ownership at one persistence boundary', async () => {
    const runtime = createRuntime();
    const execution = new CodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    const bus = new AgentEventBus({ list: () => [{ execution }] });
    const predecessor = startRequest().operation;
    const rejected = { ...predecessor, clientRequestId: 'request-rejected', turnId: 'turn-rejected' };
    const successor = { ...predecessor, clientRequestId: 'request-b', turnId: 'turn-b' };
    const attempt = new QueueExecutionAttempt(predecessor);
    const successorAbortable = mock(() => undefined);
    let runtimeMetadata = {
      clientRequestId: predecessor.clientRequestId,
      turnId: predecessor.turnId,
    };
    const trackedMessages = [];
    const routedMessages = [];
    execution.subscribe((event) => {
      if (event.type === 'messages') {
        trackedMessages.push({ content: event.messages[0].content, turnId: event.operation.turnId });
      }
    });
    bus.onMessages((_chatId, messages, metadata) => {
      routedMessages.push({ content: messages[0].content, turnId: metadata.turnId });
    });
    const emitOutput = (content) => runtime.emitMessages(
      'chat-1',
      [new AssistantMessage('2026-07-24T00:00:00.000Z', content)],
      runtimeMetadata,
    );
    const assertOwner = (turnId, content) => {
      expect(runtimeMetadata.turnId).toBe(turnId);
      expect(attempt.identity().turnId).toBe(turnId);
      expect(bus.getActiveTurn('chat-1').turnId).toBe(turnId);
      expect(trackedMessages.at(-1)).toEqual({ content, turnId });
      expect(routedMessages.at(-1)).toEqual({ content, turnId });
    };
    const composeHandoff = (operationHandoff, next) => attempt.handoffTurn(
      predecessor,
      next,
      bus.handoffTurn('chat-1', predecessor, next, operationHandoff),
    );

    bus.trackTurn('chat-1', predecessor);
    bus.markTurnAbortable('chat-1', predecessor);
    attempt.markAbortable();
    await execution.start(startRequest());
    runtime.submitGoalControl.mockImplementation(async (request, beforeDelivery) => {
      await beforeDelivery({
        validate: () => undefined,
        commit: () => {
          runtimeMetadata = {
            clientRequestId: request.clientRequestId,
            turnId: request.turnId,
          };
          request.onAbortable?.();
        },
      });
      return true;
    });

    await expect(execution.submitGoalControl(goalControlRequest(rejected, async (operationHandoff) => {
      const handoff = composeHandoff(operationHandoff, rejected);
      handoff.validate();
      await Promise.resolve();
      emitOutput('A while persistence fails');
      assertOwner('turn-1', 'A while persistence fails');
      throw new Error('persistence failed');
    }))).rejects.toThrow('persistence failed');
    emitOutput('A after persistence failed');
    assertOwner('turn-1', 'A after persistence failed');

    await expect(execution.submitGoalControl({
      ...goalControlRequest(successor, async (operationHandoff) => {
        const handoff = composeHandoff(operationHandoff, successor);
        handoff.validate();
        await Promise.resolve();
        emitOutput('A before persistence commits');
        assertOwner('turn-1', 'A before persistence commits');
        handoff.validate();
        handoff.commit();
        emitOutput('B after the atomic commit');
        assertOwner('turn-b', 'B after the atomic commit');
      }),
      admission: {
        signal: new AbortController().signal,
        markStarted: mock(() => undefined),
        markAbortable: successorAbortable,
      },
    })).resolves.toBe(true);
    expect(successorAbortable).toHaveBeenCalledTimes(1);
    await expect(bus.waitUntilTurnAbortable('chat-1', successor)).resolves.toBe(true);
  });
});
