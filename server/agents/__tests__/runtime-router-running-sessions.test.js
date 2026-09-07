import { describe, expect, it, mock } from 'bun:test';

import { AgentRuntimeRouter } from '../runtime-router.ts';
import { resetServerConfigForTests } from '../../config.ts';
import { createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function makeRouter(execution) {
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
      getChatByAgentSessionId: mock(() => null),
    },
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
  });
  return { router, transcript };
}

describe('AgentRuntimeRouter execution handles', () => {
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
