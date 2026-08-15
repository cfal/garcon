import { describe, expect, it, mock } from 'bun:test';
import { AssistantMessage, UserMessage } from '@garcon/common/chat-types';
import { renderCarriedContext } from '@garcon/common/transcript-seed';
import { AgentEventEmitterRuntime } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { CodexExecution } from '../execution.ts';

function createRuntime() {
  const runtime = new AgentEventEmitterRuntime();
  runtime.startSession = mock(async (request) => {
    request.executionAdmission?.markStarted();
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
    runId: 'run-1',
    priorContext: [],
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
      clientRequestId: 'run-1',
      turnId: 'run-1',
      envOverrides: { CODEX_HOME: '/tmp/codex-home' },
      codexConfig: expect.objectContaining({
        env: { GARCON_CODEX_PROVIDER_API_KEY_ENDPOINT_1: 'secret' },
      }),
    }));

    runtime.emitMessages('chat-1', [
      new AssistantMessage('2026-07-19T00:00:00.000Z', 'done'),
    ], { clientRequestId: 'run-1', turnId: 'run-1' });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'messages',
      runId: 'run-1',
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
        runtime.emitFinished('chat-1', 0, {
          clientRequestId: 'run-1',
          turnId: 'run-1',
        });
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
    runtime.submitGoalControl.mockImplementation(async (_request, beforeDelivery) => {
      await beforeDelivery({
        validate: () => undefined,
        commit: () => undefined,
      });
      throw new Error('delivery outcome unknown');
    });

    await expect(execution.submitGoalControl(goalControlRequest('run-2'), publish))
      .rejects.toThrow('delivery outcome unknown');
    runtime.emitFailed('chat-1', 'delivery failed', {
      clientRequestId: 'run-2',
      turnId: 'run-2',
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'run-ended',
      runId: 'run-2',
      outcome: 'failed',
    }));
  });

  it('changes runtime event correlation only when the goal handoff commits', async () => {
    const messages = [];
    // The publisher is the route, so a goal-control successor inheriting its predecessor's
    // route is observable as the run id its content carries.
    const publish = (event) => {
      if (event.type !== 'messages') return;
      messages.push({ content: event.rows[0].message.content, runId: event.runId });
    };
    const runtime = createRuntime();
    const execution = new CodexExecution(
      createHost(),
      runtime,
      createPathNativeSessionCodec('codex'),
      createConfig(),
    );
    await execution.start(startRequest(), publish);
    const emitOutput = (content) => runtime.emitMessages(
      'chat-1',
      [new AssistantMessage('2026-07-24T00:00:00.000Z', content)],
    );
    runtime.submitGoalControl.mockImplementation(async (request, beforeDelivery) => {
      emitOutput('before delivery');
      await beforeDelivery({
        validate: () => undefined,
        commit: () => undefined,
      });
      emitOutput('after delivery');
      return true;
    });

    await expect(execution.submitGoalControl(goalControlRequest('run-rejected', async (handoff) => {
      handoff.validate();
      emitOutput('while rejected handoff validates');
      throw new Error('persistence failed');
    }), publish)).rejects.toThrow('persistence failed');
    emitOutput('after rejected handoff');

    await expect(execution.submitGoalControl({
      ...goalControlRequest('run-2', async (handoff) => {
        handoff.validate();
        emitOutput('while accepted handoff validates');
        handoff.commit();
      }),
      admission: {
        signal: new AbortController().signal,
        markStarted: mock(() => undefined),
      },
    }, publish)).resolves.toBe(true);

    expect(messages).toEqual([
      { content: 'before delivery', runId: 'run-1' },
      { content: 'while rejected handoff validates', runId: 'run-1' },
      { content: 'after rejected handoff', runId: 'run-1' },
      { content: 'before delivery', runId: 'run-1' },
      { content: 'while accepted handoff validates', runId: 'run-1' },
      { content: 'after delivery', runId: 'run-2' },
    ]);
  });
});
