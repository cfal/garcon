import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UserMessage } from '../../../common/chat-types.js';
import { AgentRuntimeRouter } from '../runtime-router.ts';
import { createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';

let projectDir;

function makeRouter(overrides = {}) {
  const settings = { ownerId: 'test', schemaVersion: 1, values: {} };
  const entry = {
    id: 'chat-1',
    agentId: 'test',
    agentSessionId: null,
    nativeSession: null,
    nativeSeedReceipt: null,
    agentOwnershipEpoch: 'epoch-1',
    agentSettingsById: { test: settings },
    projectPath: projectDir,
    model: 'model-a',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'default',
    thinkingMode: 'none',
    tags: [],
    ...overrides.entry,
  };
  const priorContext = overrides.priorContext ?? [
    new UserMessage('2026-08-12T00:00:00.000Z', 'prior context'),
  ];
  const transcript = createRuntimeTranscriptFixture({ priorContext });
  const start = overrides.start ?? mock(async (request) => {
    request.sink.publish({
      type: 'session',
      session: {
        agentSessionId: 'native-1',
        nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
        nativeSeedReceipt: null,
      },
    });
    request.sink.publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
    return { id: 'start-handle' };
  });
  const resume = overrides.resume ?? mock(async (request) => {
    request.sink.publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
    return { id: 'resume-handle' };
  });
  const submitGoalControl = overrides.submitGoalControl ?? mock(async () => true);
  const steer = overrides.steer ?? mock(async () => ({ kind: 'accepted' }));
  const providerTarget = overrides.providerTarget ?? {};
  const captureTarget = overrides.captureTarget ?? mock(() => providerTarget);
  const integration = {
    descriptor: {
      id: 'test',
      supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'],
    },
    execution: {},
    producerExecution: {
      start,
      resume,
      abort: mock(async () => undefined),
    },
    steering: { captureTarget, steer },
    goals: { submitControl: submitGoalControl },
    settings: { defaults: () => settings, parse: (input) => input },
  };
  const registry = {
    getChat: mock(() => entry),
    updateChat: mock((_chatId, patch) => Object.assign(entry, patch)),
    getChatByAgentSessionId: mock(() => null),
  };
  let activeTurn = overrides.activeTurn;
  const events = {
    trackTurn: mock((_chatId, turn) => { activeTurn = turn; }),
    handoffTurn: mock((_chatId, predecessor, successor, downstream) => ({
      validate: () => {
        if (activeTurn?.turnId !== predecessor?.turnId) throw new Error('active turn changed');
        downstream.validate();
      },
      commit: () => {
        activeTurn = successor;
        downstream.commit();
      },
    })),
    clearTurn: mock(() => { activeTurn = undefined; }),
    getActiveTurn: mock(() => activeTurn),
    markTurnAbortable: mock(() => undefined),
  };
  const endpointResolver = {
    resolveSelection: mock((request) => ({
      model: request.model,
      apiProviderId: request.apiProviderId ?? null,
      endpointId: request.modelEndpointId ?? null,
      protocol: request.apiProviderId ? 'openai-compatible' : null,
      isLocal: false,
    })),
    resolveEndpointReference: mock(() => null),
  };
  const router = new AgentRuntimeRouter({
    registry,
    directory: {
      require: mock(() => integration),
      get: mock(() => integration),
      list: mock(() => [integration]),
    },
    endpointResolver,
    events,
    projection: {},
    getCarryOverRevision: () => 'carry-1',
    loadCarriedContext: async () => null,
    getCarryOverMessageCount: async () => 0,
    ledger: transcript.ledger,
    adoption: transcript.adoption,
  });
  return {
    router,
    start,
    resume,
    captureTarget,
    providerTarget,
    steer,
    registry,
    events,
    priorContext,
    endpointResolver,
    transcript,
  };
}

describe('AgentRuntimeRouter producer boundary', () => {
  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-runtime-router-'));
    await fs.writeFile(path.join(projectDir, 'notes.txt'), 'USER FILE BODY');
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('passes ledger context separately from the resolved prompt', async () => {
    const { router, start, priorContext } = makeRouter();

    await router.runAgentTurn('chat-1', 'review @notes.txt', {
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('USER FILE BODY'),
      priorContext,
      carriedContext: expect.objectContaining({
        prefix: expect.stringContaining('prior context'),
      }),
      runId: 'turn-1',
      sink: expect.objectContaining({ publish: expect.any(Function) }),
    }));
  });

  it('repairs the registry cache from a session row before resuming', async () => {
    const { router, registry, resume } = makeRouter();

    await router.runAgentTurn('chat-1', 'start', { turnId: 'turn-1' });
    await router.runAgentTurn('chat-1', 'resume', { turnId: 'turn-2' });

    expect(registry.updateChat).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      agentSessionId: 'native-1',
      nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
    }));
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: 'native-1',
      runId: 'turn-2',
    }));
  });

  it('persists one coherent endpoint selection after a lazy start', async () => {
    const { router, registry } = makeRouter({
      entry: {
        model: 'model-a',
        apiProviderId: 'provider-a',
        modelEndpointId: 'endpoint-a',
      },
    });

    await router.runAgentTurn('chat-1', 'start with override', {
      model: 'model-b',
      apiProviderId: 'provider-b',
      modelEndpointId: 'endpoint-b',
      turnId: 'turn-1',
    });

    expect(registry.updateChat).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      model: 'model-b',
      apiProviderId: 'provider-b',
      modelEndpointId: 'endpoint-b',
      modelProtocol: 'openai-compatible',
    }));
  });

  it('rejects a local-to-cloud override before provider dispatch', async () => {
    const { router, start, endpointResolver } = makeRouter({
      entry: {
        model: 'local-model',
        apiProviderId: 'local-provider',
        modelEndpointId: 'local-endpoint',
      },
    });
    endpointResolver.resolveSelection.mockImplementation((request) => ({
      model: request.model,
      apiProviderId: request.apiProviderId ?? null,
      endpointId: request.modelEndpointId ?? null,
      protocol: request.apiProviderId ? 'openai-compatible' : null,
      isLocal: request.apiProviderId === 'local-provider',
    }));

    await expect(router.runAgentTurn('chat-1', 'do not dispatch', {
      model: 'cloud-model',
      apiProviderId: 'cloud-provider',
      modelEndpointId: 'cloud-endpoint',
    })).rejects.toThrow('Cannot switch from local to cloud model mid-session');
    expect(start).not.toHaveBeenCalled();
  });

  it('does not invoke a producer after execution admission closes', async () => {
    const admission = new AbortController();
    admission.abort(new Error('server is shutting down'));
    const { router, start } = makeRouter();

    await expect(router.startSession('chat-1', 'do not start', {
      executionAdmission: { signal: admission.signal, markStarted: mock(), markAbortable: mock() },
    })).rejects.toThrow('server is shutting down');
    expect(start).not.toHaveBeenCalled();
  });

  it('routes steering through its facet without replacing the active run', async () => {
    const activeTurn = {
      agentOwnershipEpoch: 'epoch-1',
      clientRequestId: 'request-active',
      commandType: 'agent-run',
      turnId: 'turn-active',
      turnOwner: {
        agentOwnershipEpoch: 'epoch-1',
        commandType: 'agent-run',
        clientRequestId: 'request-active',
        turnId: 'turn-active',
      },
    };
    const { router, events, captureTarget, providerTarget, steer } = makeRouter({
      entry: { agentSessionId: 'native-1' },
      activeTurn,
    });
    const prepareDelivery = mock(async () => undefined);
    const target = router.captureSteerTarget('chat-1');

    await expect(router.steerInput('chat-1', 'guidance', {
      clientRequestId: 'request-steer',
      clientMessageId: 'message-steer',
    }, target, prepareDelivery)).resolves.toEqual({ kind: 'accepted' });

    expect(captureTarget).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat-1',
      agentSessionId: 'native-1',
    }));
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({
      target: providerTarget,
      input: 'guidance',
      prepareDelivery: expect.any(Function),
    }));
    expect(events.handoffTurn).not.toHaveBeenCalled();
    expect(events.getActiveTurn()).toEqual(activeTurn);
  });
});
