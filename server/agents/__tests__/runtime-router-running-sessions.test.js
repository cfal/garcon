import { describe, expect, it, mock } from 'bun:test';

import { AgentRuntimeRouter } from '../runtime-router.ts';
import { resetServerConfigForTests } from '../../config.ts';
import { createRuntimeInstanceFixture, createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function makeRouter(execution, overrides = {}) {
  const transcript = createRuntimeTranscriptFixture();
  const entry = {
    id: 'chat-1',
    agentId: 'test',
    agentSessionId: null,
    nativeSession: null,
    agentOwnershipEpoch: 'epoch-1',
    agentSettingsById: {},
    projectPath: '/repo',
    model: 'model-a',
    apiProviderId: null,
    modelEndpointId: null,
    permissionMode: 'default',
    thinkingMode: 'none',
  };
  const integration = {
    descriptor: {
      id: 'test',
      supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'],
    },
    settings: {
      defaults: () => ({ ownerId: 'test', schemaVersion: 1, values: {} }),
      parse: (value) => value,
    },
    execution,
  };
  const router = new AgentRuntimeRouter({
    registry: {
      getChat: mock(() => entry),
      updateChat: mock((_chatId, patch) => Object.assign(entry, patch)),
    },
    instances: { requireFor: mock(() => integration), ...createRuntimeInstanceFixture(integration) },
    directory: {
      require: mock(() => integration),
      get: mock(() => integration),
      list: mock(() => [integration]),
    },
    endpointResolver: {
      resolveSelection: mock((request) => ({
        model: request.model,
        apiProviderId: null,
        endpointId: null,
        protocol: null,
        isLocal: false,
      })),
      resolveEndpointReference: mock(() => null),
    },
    events: {
      trackTurn: mock(() => undefined),
      getActiveTurn: mock(() => null),
    },
    getCarryOverRevision: () => 'carry-1',
    createCarriedContext: async () => ({ kind: 'no-history' }),
    ledger: transcript.ledger,
    hasPendingOwnershipTransfer: () => false,
    adoption: transcript.adoption,
    ...overrides,
  });
  return { router, transcript };
}

describe('AgentRuntimeRouter execution handles', () => {
  it('reports steering unavailable before an occurrence exists or its session is published', async () => {
    const entered = deferred();
    const ready = deferred();
    const execution = {
      start: mock(async () => { entered.resolve(); await ready.promise; return {}; }),
      resume: mock(async () => ({})), abort: mock(async () => false),
    };
    const { router } = makeRouter(execution);
    await expect(router.prepareSteerTarget('chat-1', router.captureSteerTarget('chat-1')))
      .rejects.toMatchObject({ code: 'STEER_TURN_CHANGED' });
    const pending = router.startSession('chat-1', 'synthetic input', { turnId: 'synthetic-turn' });
    await entered.promise;
    try {
      await expect(router.prepareSteerTarget('chat-1', router.captureSteerTarget('chat-1')))
        .rejects.toMatchObject({ code: 'STEER_TURN_UNAVAILABLE' });
    } finally { ready.resolve(); await pending; }
  });

  it('owns a consumed preparation while carried-context creation is pending', async () => {
    const entered = deferred();
    const ready = deferred();
    const execution = {
      start: mock(async () => ({})), resume: mock(async () => ({})), abort: mock(async () => false),
    };
    const { router } = makeRouter(execution, {
      createCarriedContext: async () => { entered.resolve(); await ready.promise; return { kind: 'no-history' }; },
    });
    const options = { turnId: 'synthetic-turn' };
    const preparedExecution = await router.prepareTurn('chat-1', options, new AbortController().signal);
    const pending = router.runAgentTurn('chat-1', 'synthetic input', { ...options, preparedExecution });
    await entered.promise;
    preparedExecution.release();
    ready.resolve();
    await pending;
    expect(execution.start).toHaveBeenCalledOnce();
  });

  it('reserves the session cap for concurrent preparations and releases unused capacity', async () => {
    const previousLimit = process.env.GARCON_MAX_SESSIONS;
    process.env.GARCON_MAX_SESSIONS = '1';
    resetServerConfigForTests();
    try {
      const execution = {
        start: mock(async () => ({})), resume: mock(async () => ({})), abort: mock(async () => false),
      };
      const { router } = makeRouter(execution);
      const first = await router.prepareTurn('chat-1', { turnId: 'synthetic-first' }, new AbortController().signal);
      try {
        await expect(router.prepareTurn('chat-2', { turnId: 'synthetic-second' }, new AbortController().signal))
          .rejects.toMatchObject({ code: 'SESSION_LIMIT', status: 429 });
      } finally { first.release(); }
      const second = await router.prepareTurn('chat-2', { turnId: 'synthetic-second' }, new AbortController().signal);
      second.release();
      expect(execution.start).not.toHaveBeenCalled();
    } finally {
      if (previousLimit === undefined) delete process.env.GARCON_MAX_SESSIONS;
      else process.env.GARCON_MAX_SESSIONS = previousLimit;
      resetServerConfigForTests();
    }
  });

  it('tracks only live core-owned execution handles', async () => {
    const execution = {
      start: mock(async () => ({ id: 'handle-1' })),
      resume: mock(async () => ({ id: 'handle-1' })),
      abort: mock(async () => undefined),
    };
    const { router, transcript } = makeRouter(execution);

    await router.startSession('chat-1', 'hello', { turnId: 'turn-1' });
    expect(router.getRunningChatIdsSnapshot()).toEqual(['chat-1']);
    expect(router.getRunningSessionCount()).toBe(1);

    transcript.sink.publish({ type: 'run-ended', runId: 'turn-1', outcome: 'finished' });
    expect(router.getRunningChatIdsSnapshot()).toEqual([]);
  });

  it('aborts the eventual handle when interruption wins during launch', async () => {
    const launchStarted = deferred();
    const handleReady = deferred();
    const handle = { id: 'handle-1' };
    const execution = {
      start: mock(async () => {
        launchStarted.resolve();
        return handleReady.promise;
      }),
      resume: mock(async () => handle),
      abort: mock(async () => undefined),
    };
    const { router } = makeRouter(execution);

    const launching = router.startSession('chat-1', 'hello', { turnId: 'turn-1' });
    await launchStarted.promise;
    expect(router.getRunningChatIdsSnapshot()).toEqual(['chat-1']);
    expect(router.getRunningSessionCount()).toBe(1);
    await expect(router.abortSession('chat-1')).resolves.toBe(true);
    handleReady.resolve(handle);
    await launching;

    expect(execution.abort).toHaveBeenCalledWith(handle);
    expect(router.getRunningChatIdsSnapshot()).toEqual([]);
  });

  it('reports the concurrent session cap with a typed domain error', async () => {
    const previousLimit = process.env.GARCON_MAX_SESSIONS;
    process.env.GARCON_MAX_SESSIONS = '1';
    resetServerConfigForTests();
    try {
      const execution = {
        start: mock(async () => ({ id: 'handle-1' })),
        resume: mock(async () => ({ id: 'handle-1' })),
        abort: mock(async () => undefined),
      };
      const { router } = makeRouter(execution);
      await router.startSession('chat-1', 'first', { turnId: 'turn-1' });

      await expect(router.startSession('chat-1', 'second', { turnId: 'turn-2' }))
        .rejects.toMatchObject({ code: 'SESSION_LIMIT', status: 429, retryable: true });
      expect(execution.start).toHaveBeenCalledTimes(1);
    } finally {
      if (previousLimit === undefined) delete process.env.GARCON_MAX_SESSIONS;
      else process.env.GARCON_MAX_SESSIONS = previousLimit;
      resetServerConfigForTests();
    }
  });
});
