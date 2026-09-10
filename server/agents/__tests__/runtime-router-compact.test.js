import { describe, expect, it, mock } from 'bun:test';
import { AgentRuntimeRouter } from '../runtime-router.ts';
import { createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';

function makeRouter(compaction, options = {}) {
  const transcript = createRuntimeTranscriptFixture({
    conversationMessages: options.conversationMessages,
  });
  const execution = {
    start: mock(async () => ({ agentSessionId: 'session-a', nativeSession: null })),
    resume: mock(async () => undefined),
    abort: mock(async () => true),
    runningSessions: mock(() => []),
  };
  const entry = {
    agentId: 'test',
    model: 'model-a',
    projectPath: '/workspace',
    agentSessionId: 'session-a',
    agentOwnershipEpoch: 'epoch-1',
  };
  const integration = {
    descriptor: {
      id: 'test',
      supportedEndpointProtocols: [],
      supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'],
    },
    settings: { parse: (value) => value ?? {}, defaults: () => ({}) },
    execution,
    transcript: { load: mock(async () => ({ messages: [], revision: 'r' })) },
    compaction,
    forking: null,
  };
  const directory = {
    require: mock(() => integration),
    list: mock(() => [integration]),
  };
  const router = new AgentRuntimeRouter({
    registry: {
      getChat: mock(() => entry),
      updateChat: mock(async () => entry),
    },
    directory,
    endpointResolver: {
      resolveSelection: mock(() => ({
        model: 'model-a',
        apiProviderId: null,
        endpointId: null,
        protocol: null,
        isLocal: false,
      })),
      resolveEndpointReference: mock(() => null),
    },
    events: { trackTurn: mock(() => undefined), clearTurn: mock(() => undefined) },
    projection: { open: mock(async () => ({ kind: 'ready', value: {} })) },
    getCarryOverRevision: () => 'carry-1',
    createCarriedContext: async () => ({ kind: 'no-history' }),
    getCarryOverMessageCount: async () => 0,
    ledger: transcript.ledger,
    hasPendingOwnershipTransfer: () => false,
    adoption: transcript.adoption,
  });
  return { router, execution, integration, directory };
}

describe('AgentRuntimeRouter compaction', () => {
  for (const delayed of [false, true]) {
    it(`retains the execution owner when compaction ${delayed ? 'launch is interrupted' : 'has started'}`, async () => {
      const launched = Promise.withResolvers();
      const completed = Promise.withResolvers();
      const handle = { id: 'synthetic-compaction-handle' };
      const { router, execution, integration, directory } = makeRouter({ compact: mock(() => {
        launched.resolve();
        return delayed ? completed.promise : Promise.resolve(handle);
      }) });
      const dispatch = router.compactSession('chat-1');
      if (delayed) await launched.promise;
      else await dispatch;
      const replacementAbort = mock(async () => true);
      directory.require.mockImplementation(() => ({
        ...integration, execution: { ...execution, abort: replacementAbort },
      }));

      expect(await router.abortSession('chat-1')).toBe(true);
      completed.resolve(handle);
      await dispatch;

      expect(execution.abort).toHaveBeenCalledWith(handle);
      expect(replacementAbort).not.toHaveBeenCalled();
    });
  }

  it('calls the compaction facet when the integration provides one', async () => {
    const compact = mock(async () => undefined);
    const conversationMessages = mock(() => {
      throw new Error('native compaction must not scan ledger context');
    });
    const { router, execution } = makeRouter({ compact }, { conversationMessages });

    await router.compactSession('chat-1', { instructions: 'focus on auth' });

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0][0]).toMatchObject({ prompt: '/compact focus on auth' });
    expect(compact.mock.calls[0][0]).not.toHaveProperty('priorContext');
    expect(conversationMessages).not.toHaveBeenCalled();
    expect(execution.resume).not.toHaveBeenCalled();
  });

  it('refuses instead of sending a literal /compact prompt without the facet', async () => {
    const { router, execution } = makeRouter(null);

    await expect(router.compactSession('chat-1')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    // Regression: this used to resume the session with the text `/compact`, which
    // left the context untouched and a stray message in the transcript.
    expect(execution.resume).not.toHaveBeenCalled();
  });

  it('points at the provider-agnostic alternative', async () => {
    const { router } = makeRouter(null);

    await expect(router.compactSession('chat-1')).rejects.toThrow('/handoff');
  });
});
