import { resolveFileMentionsInCommand } from "../../../runtime/projects/file-mentions.ts";
import { describe, expect, it, mock } from 'bun:test';
import { AgentRuntimeRouter } from '../runtime-router.ts';
import { createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';
import { createProducerFixture } from './producer-fixture.ts';

function makeRouter(compaction, options = {}) {
  const producer = createProducerFixture();
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
    producers: producer.producers,
    transcript: { load: mock(async () => ({ messages: [], revision: 'r' })) },
    compaction,
    forking: null,
  };
  const router = new AgentRuntimeRouter({
    resolveFileMentions: resolveFileMentionsInCommand,
    registry: {
      getChat: mock(() => entry),
      updateChat: mock(async () => entry),
    },
    directory: {
      require: mock(() => integration),
      list: mock(() => [integration]),
    },
    endpointResolver: {
      describePrevious(input) { return this.resolveSelection(input); },
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
  return { router, execution, transcript, entry };
}

describe('AgentRuntimeRouter compaction', () => {
  it('repairs the session cache before compaction without a preceding history read', async () => {
    const compact = mock(async () => undefined);
    const { router, entry, transcript, execution } = makeRouter({ compact });
    entry.agentSessionId = null;
    const nativeSession = { ownerId: 'test', schemaVersion: 1, value: { id: 'current' } };
    transcript.adoption.ensure = mock(async () => {
      entry.agentSessionId = 'current';
      entry.nativeSession = nativeSession;
    });
    await router.compactSession('chat-1');
    expect(transcript.adoption.ensure).toHaveBeenCalledWith('chat-1', undefined);
    expect(compact.mock.calls[0][0]).toMatchObject({ agentSessionId: 'current', nativeSession });
    expect(execution.start).not.toHaveBeenCalled();
  });

  it('does not dispatch compaction after cancellation during adoption', async () => {
    const compact = mock(async () => undefined);
    const { router, transcript } = makeRouter({ compact });
    const controller = new AbortController();
    transcript.adoption.ensure = mock(async () => controller.abort());
    await expect(router.compactSession('chat-1', {
      executionAdmission: { signal: controller.signal, markStarted: async () => {} },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(compact).not.toHaveBeenCalled();
    expect(transcript.activeRunId()).toBeNull();
  });

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
