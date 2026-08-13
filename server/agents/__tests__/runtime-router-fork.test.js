import { describe, expect, it, mock } from 'bun:test';
import { UserMessage } from '../../../common/chat-types.js';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { AgentRuntimeRouter } from '../runtime-router.ts';
import { createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';

function makeRouter(fork) {
  const transcript = createRuntimeTranscriptFixture();
  const settings = { ownerId: 'test', schemaVersion: 1, values: {} };
  const entry = {
    id: 'source-chat',
    agentId: 'test',
    agentSessionId: 'session-1',
    nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'session-1' } },
    agentOwnershipEpoch: 'epoch-1',
    agentSettingsById: { test: settings },
    projectPath: '/repo',
    model: 'model-a',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'default',
    thinkingMode: 'none',
    tags: [],
  };
  const messages = [
    new UserMessage('2026-07-21T00:00:00.000Z', 'first'),
    new UserMessage('2026-07-21T00:00:01.000Z', 'second'),
  ];
  const execution = {
    start: mock(async () => ({
      agentSessionId: 'started-session',
      nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'started-session' } },
      nativeSeedReceipt: null,
    })),
    resume: mock(async () => undefined),
    abort: mock(async () => true),
    runningSessions: mock(() => []),
  };
  const integration = {
    descriptor: {
      id: 'test',
      supportedEndpointProtocols: [],
      supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'],
    },
    settings: { parse: (value) => value },
    execution,
    producerExecution: {
      start: async (request) => {
        await execution.start(request);
        return { id: 'started-session' };
      },
      resume: async (request) => {
        await execution.resume(request);
        return { id: request.agentSessionId };
      },
      abort: async () => undefined,
    },
    transcript: { load: mock(async () => ({ messages, revision: 'unused' })) },
    forking: {
      fork,
      discard: mock(async () => undefined),
    },
  };
  const projection = {
    open: mock(async () => ({
      kind: 'ready',
      value: {
        checkpoint: {
          projection: {
            contentEpoch: 'content-1',
            durableRevision: 'revision-1',
          },
        },
        entries: messages.map((message, index) => ({
          id: `entry-${index + 1}`,
          lifetime: 'durable',
          message,
        })),
      },
    })),
  };
  const entries = new Map([['source-chat', entry]]);
  const registry = {
    getChat: mock((chatId) => entries.get(chatId) ?? null),
    updateChat: mock(async (chatId, patch) => {
      const current = entries.get(chatId);
      if (!current) return null;
      const updated = { ...current, ...patch };
      entries.set(chatId, updated);
      return updated;
    }),
  };
  const router = new AgentRuntimeRouter({
    registry,
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
    projection,
    getCarryOverRevision: () => 'carry-1',
    loadCarriedContext: async () => null,
    ledger: transcript.ledger,
    adoption: transcript.adoption,
  });
  return { router, entry, entries, execution, messages, integration, projection };
}

describe('AgentRuntimeRouter forks', () => {
  it('binds a point fork to the selected native prefix', async () => {
    const fork = mock(async () => ({
      kind: 'materialized',
      session: {
        agentSessionId: 'forked-session',
        nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'forked-session' } },
      },
    }));
    const { router, entry, integration } = makeRouter(fork);

    await router.forkAgentSession({
      sourceSession: entry,
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      messageSequence: 1,
      providerMeta: { entryId: 'native-entry-1', withinSourceOrdinal: 0 },
    });

    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      providerMeta: { entryId: 'native-entry-1', withinSourceOrdinal: 0 },
      source: expect.objectContaining({ chatId: 'source-chat' }),
    }));
    expect(integration.forking).not.toHaveProperty('resolvePoint');
  });

  it('preserves a successful unmaterialized whole-session outcome', async () => {
    const fork = mock(async () => ({ kind: 'unmaterialized' }));
    const { router, entry, entries, execution } = makeRouter(fork);

    const outcome = await router.forkAgentSession({
      sourceSession: entry,
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
    });
    expect(outcome).toEqual({ kind: 'unmaterialized' });

    expect(fork).toHaveBeenCalledWith(expect.objectContaining({ providerMeta: null }));

    entries.set('target-chat', {
      ...entry,
      id: 'target-chat',
      agentSessionId: null,
      nativeSession: null,
    });
    await router.runAgentTurn('target-chat', 'child prompt');

    expect(execution.start).toHaveBeenCalledOnce();
    expect(execution.start).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'target-chat', prompt: 'child prompt' }),
    );
    expect(execution.resume).not.toHaveBeenCalled();
  });

  it('maps a changed selected prefix to a retryable conflict', async () => {
    const fork = mock(async () => {
      throw new AgentIntegrationError(
        'SOURCE_REVISION_CHANGED',
        'Source transcript changed while the fork was being created',
        true,
      );
    });
    const { router, entry } = makeRouter(fork);

    await expect(router.forkAgentSession({
      sourceSession: entry,
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      messageSequence: 1,
      providerMeta: { lineNumber: 1 },
    })).rejects.toMatchObject({
      code: 'SOURCE_REVISION_CHANGED',
      status: 409,
      retryable: true,
    });
  });

  it('maps a missing ledger provider position to the established retry-later error', async () => {
    const fork = mock(async () => null);
    const { router, entry } = makeRouter(fork);

    await expect(router.forkAgentSession({
      sourceSession: entry,
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      messageSequence: 1,
    })).rejects.toMatchObject({
      code: 'MESSAGE_NOT_IN_NATIVE_HISTORY',
      status: 409,
      retryable: true,
    });
    expect(fork).not.toHaveBeenCalled();
  });

  it('does not read the V4 projection for a native point fork', async () => {
    const fork = mock(async () => ({ kind: 'unmaterialized' }));
    const { router, entry, projection } = makeRouter(fork);

    await router.forkAgentSession({
      sourceSession: entry,
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      messageSequence: 1,
      providerMeta: { lineNumber: 1 },
    });

    expect(projection.open).not.toHaveBeenCalled();
  });
});
