import { describe, expect, it, mock } from 'bun:test';
import { AgentRuntimeRouter } from '../runtime-router.ts';

function makeRouter(compaction) {
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
  const router = new AgentRuntimeRouter({
    registry: {
      getChat: mock(() => entry),
      updateChat: mock(async () => entry),
    },
    directory: {
      require: mock(() => integration),
      list: mock(() => [integration]),
    },
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
    loadCarriedContext: async () => null,
    getCarryOverMessageCount: async () => 0,
  });
  return { router, execution };
}

describe('AgentRuntimeRouter compaction', () => {
  it('calls the compaction facet when the integration provides one', async () => {
    const compact = mock(async () => undefined);
    const { router, execution } = makeRouter({ compact });

    await router.compactSession('chat-1', { instructions: 'focus on auth' });

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0][0]).toMatchObject({ prompt: '/compact focus on auth' });
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
